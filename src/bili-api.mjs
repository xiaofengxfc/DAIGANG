/**
 * B站 Web API 客户端 —— 只做自动比价需要的那几件事：搜视频、取详情、拿 wbi 密钥。
 *
 * 为什么要自己签 wbi：匿名或未签名的搜索请求一律 HTTP 412（风控）。
 * 官方前端每次搜索都会带 wbi 签名 —— 从 nav 接口取 img_key/sub_key，
 * 按固定置换表混出 mixin_key，再对「参数 + mixin_key」做 md5。
 * 这套算法公开且稳定，不需要开浏览器。
 *
 * 登录态直接复用自媒体模块存在 data/media-cookies 里的 Playwright storage_state，
 * 用户不必为这个功能再登录一次。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { db } from './db.mjs'
import { MEDIA_COOKIE_DIR } from './config.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** wbi 的固定置换表（B站 前端 mixinKeyEncTab 原样搬过来，顺序不能动） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
  36, 20, 34, 44, 52,
]

export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i]).join('').slice(0, 32)
}

/**
 * 按 wbi 规则签一组参数。
 * 注意两个细节，错了就会一直 412：
 *   1. value 里要滤掉 !'()* 这四个字符（前端就是这么做的）
 *   2. 参数要按 key 排序后再拼 query，wts 参与签名但不在 query 里重复
 */
export function wbiSign(params, mixin, now = Date.now()) {
  const filtered = {}
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    filtered[key] = String(value).replace(/[!'()*]/g, '')
  }
  const query = Object.keys(filtered)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(filtered[key])}`)
    .join('&')
  const wts = Math.floor(now / 1000)
  const signed = `${query}&wts=${wts}`
  const w_rid = crypto.createHash('md5').update(`${signed}${mixin}`).digest('hex')
  return { query: signed, w_rid, wts }
}

/* ------------------------------------------------------------------
   Cookie：Playwright storage_state → 请求头 + Netscape cookies.txt
   ------------------------------------------------------------------ */

export function storageStateToNetscape(state, { domainFilter = 'bilibili' } = {}) {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : []
  const lines = []
  const seen = new Set()
  for (const cookie of cookies) {
    const domain = String(cookie?.domain || '')
    const name = String(cookie?.name || '')
    if (!domain || !name) continue
    if (domainFilter && !domain.includes(domainFilter)) continue
    const cookiePath = String(cookie.path || '/')
    // 同名同域同路径只留一条：storage_state 里偶有重复，重复会让 yt-dlp 取到旧值
    const key = `${domain}\t${cookiePath}\t${name}`
    if (seen.has(key)) continue
    seen.add(key)
    const expires = Number(cookie.expires)
    const expiresAt = Number.isFinite(expires) && expires > 0 ? Math.floor(expires) : 0
    lines.push(
      [
        domain,
        domain.startsWith('.') ? 'TRUE' : 'FALSE',
        cookiePath,
        cookie.secure ? 'TRUE' : 'FALSE',
        expiresAt,
        name,
        String(cookie.value ?? ''),
      ].join('\t'),
    )
  }
  return ['# Netscape HTTP Cookie File', '# 由 B站比价功能自动生成，请勿手工编辑。', '', ...lines].join('\n') + '\n'
}

/** 判断一份 storage_state 是不是「真登录」—— 只有 buvid 之类的匿名 cookie 会被风控挡 */
export function isLoggedInState(state) {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : []
  return cookies.some((c) => c?.name === 'SESSDATA' && String(c.value || '').length > 8)
}

/**
 * 找一份可用的 B站登录态。
 *
 * 优先用自媒体模块里 platform='bilibili' 且 auth_state='ready' 的账号；
 * 找不到就退而求其次，扫一遍 cookie 目录里任何一份含 SESSDATA 的文件 ——
 * 用户可能导了登录态但没在「账号管理」里把状态点成 ready，
 * 这时候因为一个状态字段就拒绝服务太苛刻了。
 */
export function resolveBiliCookieFile() {
  const rows = db
    .prepare("SELECT id, account_name, auth_state, cookie_path FROM media_accounts WHERE platform = 'bilibili' ORDER BY CASE WHEN auth_state = 'ready' THEN 0 ELSE 1 END, id ASC")
    .all()
  for (const row of rows) {
    if (!row.cookie_path) continue
    const file = path.join(MEDIA_COOKIE_DIR, row.cookie_path)
    if (!fs.existsSync(file)) continue
    try {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (isLoggedInState(state)) return { file, account: row, state }
    } catch {
      /* 这个文件坏了就试下一个 */
    }
  }
  // 兜底：目录里任何一份带 SESSDATA 的登录态
  try {
    for (const name of fs.readdirSync(MEDIA_COOKIE_DIR)) {
      if (!name.endsWith('.json')) continue
      const file = path.join(MEDIA_COOKIE_DIR, name)
      try {
        const state = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (isLoggedInState(state)) return { file, account: null, state }
      } catch {
        /* 忽略坏文件 */
      }
    }
  } catch {
    /* 目录不存在 = 没登录过 */
  }
  return null
}

/** 登录态概览，给前端显示「能不能用、用哪个账号」 */
export function biliAuthStatus() {
  const found = resolveBiliCookieFile()
  if (!found) {
    return {
      ok: false,
      message: '没有可用的 B站 登录态。去「自媒体 → 账号管理」添加 B站 账号并点「打开登录」，登录一次即可。',
    }
  }
  return {
    ok: true,
    account: found.account ? found.account.account_name : path.basename(found.file),
    accountId: found.account ? found.account.id : null,
    file: path.basename(found.file),
    message: `使用 B站 账号「${found.account ? found.account.account_name : path.basename(found.file)}」的登录态`,
  }
}

/* ------------------------------------------------------------------
   请求层
   ------------------------------------------------------------------ */

export class BiliClient {
  constructor({ cookieHeader = '', timeoutMs = 15000 } = {}) {
    this.cookieHeader = cookieHeader
    this.timeoutMs = timeoutMs
    /** nav 拿到的 wbi 密钥缓存（B站 每天轮换一次，进程内缓存足够） */
    this._mixin = null
    this._mixinAt = 0
  }

  static fromStorageState(state, opts = {}) {
    const cookies = (Array.isArray(state?.cookies) ? state.cookies : []).filter((c) =>
      String(c?.domain || '').includes('bilibili'),
    )
    return new BiliClient({ cookieHeader: cookies.map((c) => `${c.name}=${c.value}`).join('; '), ...opts })
  }

  async request(url, { params = {} } = {}) {
    const target = new URL(url)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') target.searchParams.set(key, String(value))
    }
    const headers = {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    }
    if (this.cookieHeader) headers.Cookie = this.cookieHeader
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(target, { headers, signal: controller.signal })
      const text = await res.text()
      if (res.status === 412) {
        throw new Error('B站 返回 412（风控）。多半是登录态过期了，去「自媒体 → 账号管理」重新登录一次 B站 账号。')
      }
      if (!res.ok) throw new Error(`B站 接口 HTTP ${res.status}（${target.pathname}）`)
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(`B站 接口返回的不是 JSON（${target.pathname}）`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 取 wbi 密钥。nav 接口匿名也能拿到 img_key/sub_key（它们本身是公开值） */
  async ensureMixin(force = false) {
    if (this._mixin && !force && Date.now() - this._mixinAt < 6 * 60 * 60 * 1000) return this._mixin
    const payload = await this.request('https://api.bilibili.com/x/web-interface/nav')
    const wbi = payload?.data?.wbi_img
    if (!wbi?.img_url || !wbi?.sub_url) throw new Error('拿不到 B站 wbi 密钥（nav 接口没返回 wbi_img）')
    const pick = (url) => String(url).split('/').pop().split('.')[0]
    this._mixin = mixinKey(pick(wbi.img_url), pick(wbi.sub_url))
    this._mixinAt = Date.now()
    return this._mixin
  }

  /** 关键词搜视频，page 从 1 开始 */
  async searchVideos(keyword, { page = 1, pageSize = 20, order = 'totalrank' } = {}) {
    const mixin = await this.ensureMixin()
    const { query, w_rid } = wbiSign(
      { search_type: 'video', keyword, page, page_size: pageSize, order, platform: 'pc' },
      mixin,
    )
    const payload = await this.request(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}&w_rid=${w_rid}`)
    if (payload.code !== 0) throw new Error(`B站 搜索失败：${payload.message || payload.code}`)
    const list = Array.isArray(payload?.data?.result) ? payload.data.result : []
    return list
      .filter((item) => item && item.bvid)
      .map((item) => ({
        bvid: item.bvid,
        title: cleanHtml(item.title),
        author: item.author || '',
        duration: parseDuration(item.duration),
        play: Number(item.play) || 0,
        danmaku: Number(item.video_review) || 0,
        pubdate: Number(item.pubdate) || 0,
        description: cleanHtml(item.description),
        url: `https://www.bilibili.com/video/${item.bvid}`,
      }))
  }
}

/** 搜索结果标题里带 <em class="keyword"> 高亮标签，去掉标签和 HTML 实体 */
export function cleanHtml(text) {
  return String(text || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

/** B站 搜索返回的 duration 是 "MM:SS" 或 "HH:MM:SS" */
export function parseDuration(value) {
  if (typeof value === 'number') return value
  const parts = String(value || '')
    .split(':')
    .map((n) => Number(n) || 0)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return 0
}
