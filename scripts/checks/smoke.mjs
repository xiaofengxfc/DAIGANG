/**
 * 后端接口冒烟测试：从零初始化到下单、收款、保险箱取用、财务结算，全流程跑一遍。
 *
 * 两种跑法：
 *
 *   1. 一条命令（推荐，自己起干净实例、自己收尾）：
 *        npm run test
 *      等价于 node scripts/checks/smoke-run.mjs。
 *
 *   2. 对着已经开着的实例跑（调接口时用）：
 *        set XFC_DATA_DIR=./data-smoke && node server.mjs --port 8790 --local
 *        node scripts/checks/smoke.mjs
 *      实例地址可以用 XFC_BASE 覆盖，默认 http://127.0.0.1:8790。
 *
 * 本文件导出 run()，由 smoke-run.mjs 调用；直接执行时才自己跑一遍。
 */
import path from 'node:path'
import fs from 'node:fs'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'
// 纯函数，不连数据库，可以直接拿来验「凌晨 4 点换日」的边界
import { bizDate, localDate, DAY_START_HOUR } from '../../src/core/util.mjs'
// 资源文本的分段（一单多个游戏）也是纯函数，直接验
import { splitResourceSections, sectionText, joinResourceSections, deltaText, resourceDeltaList } from '../../shared/resources.js'
// 识别打分口径（掩码 NCC）和「按屏取键」也是纯函数：不连服务器就能验那两个踩过的坑
import { subImage, buildIntegral, compileTemplate, matchAt, findIcon, findIconTop, resampleBilinear } from '../../src/vision/vision.mjs'
import { recognizeFrame, CLUSTER_RATIO } from '../../src/vision/screen.mjs'
import { profileForGame } from '../../shared/game-profiles.js'
// 导出配色的定义处，断言从这里取色值，不再把十六进制写死在测试里
import { DOCX_PALETTE } from '../../src/export/docx.mjs'
// 静态资源断言要看 public/dist/ 在不在（没构建就跳过，不假装测过）
import { ROOT, stashTestFrame } from '../lib/test-app.mjs'

const BASE = process.env.XFC_BASE || 'http://127.0.0.1:8790'

let cookie = ''
let pass = 0
const failures = []

async function api(method, path, body) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await res.text()
  let json = raw
  try {
    json = JSON.parse(raw)
  } catch {}
  return { status: res.status, body: json, headers: res.headers }
}

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail !== undefined ? `  →  ${JSON.stringify(detail).slice(0, 300)}` : ''}`)
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`)
}

/* ---------- docx 断言的小工具 ---------- */

/** 取出 document.xml 里承载这段文字的那个段落（到最近的 </w:p> 为止） */
function paragraphOf(xml, text) {
  return xml.split('</w:p>').find((chunk) => chunk.includes(text)) || ''
}

/**
 * 这段文字所在的段落，是不是「左边一条细灰竖线」那种提示块。
 * 必须按段落判断：全文里只要出现过色值就通过的话，提示块样式丢了测试也看不出来。
 *
 * 提示块现在**没有底纹**（整套导出只剩黑白灰，不用色块去抢价格的注意力），
 * 所以这里反过来要求它不许出现 <w:shd> —— 有人手滑把底纹加回来就会红。
 */
function isNoticeBox(xml, text) {
  const para = paragraphOf(xml, text)
  return (
    para.includes('w:pBdr') &&
    para.includes('w:left') &&
    para.includes(`w:color="${DOCX_PALETTE.RULE_STRONG}"`) &&
    !para.includes('<w:shd')
  )
}

/**
 * 色值是不是「灰」的：R/G/B 三通道差别很小（近黑 1F2328 也算灰）。
 * 导出只允许黑白灰，任何彩色都会被这条挡住。
 */
function isNeutral(hex) {
  const h = String(hex).replace(/^#/, '')
  const rgb = h.length === 8 ? h.slice(2) : h
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) return false
  const r = parseInt(rgb.slice(0, 2), 16)
  const g = parseInt(rgb.slice(2, 4), 16)
  const b = parseInt(rgb.slice(4, 6), 16)
  return Math.max(r, g, b) - Math.min(r, g, b) <= 12
}

/* ---------- tar 断言的小工具（整包备份用） ---------- */

/**
 * 遍历 tar 的成员，交给回调。
 * 只认普通文件和 PAX 扩展头 —— 我们自己写出来的归档只有这两类会带内容。
 */
function tarWalk(tar, visit) {
  const BLOCK = 512
  let off = 0
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK)
    if (h.every((b) => b === 0)) break // 结尾的两个全零块
    const str = (o, l) => {
      const s = h.subarray(o, o + l)
      const end = s.indexOf(0)
      return s.subarray(0, end === -1 ? s.length : end).toString('utf8')
    }
    const size = parseInt(str(124, 12).trim() || '0', 8)
    const type = String.fromCharCode(h[156])
    const prefix = str(345, 155)
    const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100)
    const dataAt = off + BLOCK
    visit({ name, type, size, dataStart: dataAt })
    off = dataAt + size + (size % BLOCK === 0 ? 0 : BLOCK - (size % BLOCK))
  }
}

/** tar 里所有「真文件」的名字（跳过目录和 PAX 头） */
function tarEntries(tar) {
  const out = []
  tarWalk(tar, ({ name, type }) => {
    if (type === '0') out.push(name)
  })
  return out
}

/** 读 tar 里某个文件的内容；找不到返回 null */
function tarRead(tar, want) {
  let found = null
  tarWalk(tar, ({ name, type, size, dataStart }) => {
    if (type === '0' && name === want) found = tar.subarray(dataStart, dataStart + size)
  })
  return found
}

/**
 * 跑一遍全流程。返回 { pass, failures }，不自己退出进程——
 * 退出码由调用方决定（被 smoke-run.mjs 调用时由它定，直接执行时由下面的守卫定）。
 */
export async function run() {
  console.log(`目标：${BASE}`)

  /* ---------- 初始化 ---------- */
  section('初始化与登录')
  let r = await api('GET', '/api/auth/me')
  ok('未初始化时 setup=false', r.body.setup === false, r.body)

  r = await api('GET', '/api/dashboard')
  ok('未登录访问看板返回 401', r.status === 401, r.status)

  r = await api('POST', '/api/setup', { password: 'abc123', confirm: 'nope' })
  ok('两次密码不一致被拒', r.status === 400 && r.body.code === 'password_mismatch', r.body)

  r = await api('POST', '/api/setup', { password: '123', confirm: '123' })
  ok('弱密码被拒', r.status === 400 && r.body.code === 'weak_password', r.body)

  r = await api('POST', '/api/setup', {
    password: 'admin-pass-8888',
    confirm: 'admin-pass-8888',
    business_name: '夜班代肝',
    admin_name: '老板',
    vault_password: 'Vault-Secret-2024',
  })
  ok('初始化成功', r.status === 200 && r.body.ok === true, r.body)
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  const sidCookie = setCookies.find((c) => c.startsWith('xfc_sid='))
  ok('下发会话 Cookie', Boolean(sidCookie), setCookies)
  if (sidCookie) cookie = sidCookie.split(';')[0]

  r = await api('GET', '/api/auth/me')
  ok('初始化后已登录', r.body.authenticated === true, r.body)
  ok('保险箱已配置且已解锁', r.body.vault?.configured === true && r.body.vault?.unlocked === true, r.body.vault)

  r = await api('POST', '/api/setup', { password: 'x', confirm: 'x' })
  ok('重复初始化被拒', r.status === 409, r.body)

  /* ---------- 静态资源与前端产物 ---------- */
  // 白屏的老根因：静态文件找不到时一律回 index.html，于是 /dist/app.js
  // 以 text/html 返回，浏览器按 MIME 拒绝执行，页面就白了。
  // 这里把「资源缺了就 404、SPA 路由才回 index.html」钉死。
  section('静态资源 · 前端产物')
  const distApp = path.join(ROOT, 'public', 'dist', 'app.js')
  if (!fs.existsSync(distApp)) {
    console.log('  ⚠ public/dist/app.js 不存在（还没构建），跳过产物相关断言。先跑 npm run build。')
  }
  let raw = await fetch(`${BASE}/`)
  ok('根路径返回 index.html', raw.status === 200 && (raw.headers.get('content-type') || '').includes('text/html'), raw.headers.get('content-type'))
  if (fs.existsSync(distApp)) {
    raw = await fetch(`${BASE}/dist/app.js`)
    ok('/dist/app.js 以 JS 类型返回', raw.status === 200 && (raw.headers.get('content-type') || '').includes('javascript'), raw.status + ' ' + raw.headers.get('content-type'))

    raw = await fetch(`${BASE}/dist/app.css`)
    ok('/dist/app.css 以 CSS 类型返回', raw.status === 200 && (raw.headers.get('content-type') || '').includes('text/css'), raw.status + ' ' + raw.headers.get('content-type'))
  }
  raw = await fetch(`${BASE}/dist/not-built-yet.js`)
  ok('缺失的静态资源返回 404（不再拿 index.html 顶包）', raw.status === 404, raw.status)
  raw = await fetch(`${BASE}/dist/not-built-yet.css`)
  ok('缺失的样式也返回 404', raw.status === 404, raw.status)
  ok(
    '缺失资源不返回 HTML 内容类型',
    !(raw.headers.get('content-type') || '').includes('text/html'),
    raw.headers.get('content-type')
  )
  raw = await fetch(`${BASE}/orders/12`)
  ok('SPA 路由仍然回 index.html', raw.status === 200 && (raw.headers.get('content-type') || '').includes('text/html'), raw.status)

  /* ---------- 识别截图：暂存帧 → 取回 → 挂到进度上 ---------- */
  // 「识别画面」抓到的帧现在会暂存起来，用户点保存时取回、压缩、上传，
  // 最后挂到这条进度的 media 上（时间线据此渲染缩略图并支持下载）。
  // 这里守住「帧取得到 / 读不删 / 释放后失效 / 过期给 404 而不是 500」。
  // 「读不删」是后改的：取帧和上传是两件事，压缩或上传失败时用户点重试
  // 还要能再取一次，所以删除必须由调用方在上传成功后显式发起。
  {
    r = await api('GET', '/api/ocr/screen/frame')
    ok('取帧不给 token 时报 400', r.status === 400 && r.body.code === 'missing_token', r.body)

    r = await api('GET', '/api/ocr/screen/frame?token=nope')
    ok('取不存在的帧报 404（不是 500）', r.status === 404 && r.body.code === 'frame_gone', r.body)

    const token = await stashTestFrame()
    ok('暂存了一帧', Boolean(token), token)

    const got = await fetch(`${BASE}/api/ocr/screen/frame?token=${encodeURIComponent(token)}`, { headers: { cookie } })
    const frameBuf = Buffer.from(await got.arrayBuffer())
    ok(
      '取回这一帧是 PNG',
      got.status === 200 && frameBuf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
      `${got.status} ${frameBuf.subarray(0, 8).toString('hex')}`
    )
    ok('取帧响应声明 image/png', String(got.headers.get('content-type')).includes('image/png'), got.headers.get('content-type'))
    ok('取帧不允许缓存', String(got.headers.get('cache-control')).includes('no-store'), got.headers.get('cache-control'))

    const again = await fetch(`${BASE}/api/ocr/screen/frame?token=${encodeURIComponent(token)}`, { headers: { cookie } })
    ok('同一帧可以再取一次（上传失败要能重试，读不删）', again.status === 200, again.status)

    r = await api('DELETE', `/api/ocr/screen/frame?token=${encodeURIComponent(token)}`)
    ok('显式释放这一帧', r.status === 200 && r.body.released === true, r.body)

    const gone = await fetch(`${BASE}/api/ocr/screen/frame?token=${encodeURIComponent(token)}`, { headers: { cookie } })
    ok('释放之后再取就没了', gone.status === 404, gone.status)

    r = await api('DELETE', `/api/ocr/screen/frame?token=${encodeURIComponent(token)}`)
    ok('重复释放不报错（只是 released:false）', r.status === 200 && r.body.released === false, r.body)

    r = await api('DELETE', '/api/ocr/screen/frame')
    ok('释放不给 token 时报 400', r.status === 400 && r.body.code === 'missing_token', r.body)

    // 这里面是游戏画面，未登录绝不能取到
    const anonFrame = await fetch(`${BASE}/api/ocr/screen/frame?token=x`)
    ok('未登录取不到帧', anonFrame.status === 401, anonFrame.status)
  }

  /* ---------- 只截图不识别（F2） ---------- */
  // 这条路的重点是「不需要 OCR 引擎、也不碰游戏 UI」。
  // 断言的是**契约**，不是「这台机器上有没有游戏」：
  //   · 截图键只认 F2 / F12；
  //   · 成功 → 给一个能取回 PNG 的 frame_token；
  //   · 失败 → 400 + shot_failed 的人话；
  //   · 未登录 → 401。
  // 有没有游戏窗口决定了走哪一支，两种都算通过 —— 否则这个测试在装了游戏的
  // 机器上和在 CI 上结论相反（第一次写就踩到了：本机正好开着鸣潮）。
  {
    r = await api('POST', '/api/ocr/screen/shot', { key: 'F5' })
    ok('截图键只认 F2 / F12', r.status === 400 && r.body.code === 'bad_key', r.body)

    const t0 = Date.now()
    r = await api('POST', '/api/ocr/screen/shot', {})
    const elapsed = Date.now() - t0
    // 没找到游戏窗口时 focusGameWindow 是**立刻**返回的（不去扫窗口就报错），
    // 所以「毫秒级就回来 + 没有 frame_token」= 这台机器上没有在跑的游戏。
    const hadGame = Boolean(r.body && r.body.frame_token)

    if (hadGame) {
      ok('有游戏时截图成功并给出 frame_token', r.status === 200 && typeof r.body.frame_token === 'string', { status: r.status, token: r.body.frame_token })
      ok('截图响应说是哪个键、多大的图', r.body.key === 'F2' && Number(r.body.bytes) > 0, { key: r.body.key, bytes: r.body.bytes })
      ok('截图不该有 500 之外的怪状态', r.status === 200, r.status)

      const shot = await fetch(`${BASE}/api/ocr/screen/frame?token=${encodeURIComponent(r.body.frame_token)}`, { headers: { cookie } })
      const shotBuf = Buffer.from(await shot.arrayBuffer())
      ok(
        '按 F2 截到的是一张真 PNG（不是黑屏也不是空文件）',
        shot.status === 200 && shotBuf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' && shotBuf.length > 1000,
        `${shot.status} ${shotBuf.length} bytes`
      )
    } else {
      ok('没有游戏时截图失败且给的是 shot_failed', r.status === 400 && r.body.code === 'shot_failed', r.body)
      // 具体理由取决于这台机器的状态，两种都合法：
      //   「没找到游戏窗口」= 游戏没开；
      //   「没有允许切换到窗口」= 游戏开着但 Windows 拒绝了抢焦点。
      // 所以这里守的是「给的是能照做的人话」，而不是背某一条文案。
      ok(
        '失败理由是人话（说清是窗口没找到或切不过去）',
        /游戏窗口|窗口/.test(String(r.body.error || '')) && String(r.body.error).length > 6,
        r.body.error
      )
      ok('没有游戏时是立刻返回的（没在那儿死等窗口）', elapsed < 8000, `${elapsed}ms`)
    }

    const anonShot = await fetch(`${BASE}/api/ocr/screen/shot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    ok('未登录不能触发截图', anonShot.status === 401, anonShot.status)
  }

  /* ---------- 游戏 / 分类 / 服务 ---------- */
  section('游戏 · 分类 · 服务与价格')
  r = await api('POST', '/api/games', { name: '原神', short_name: 'YS', servers: ['天空岛', '世界树'], note: '主号在天空岛' })
  ok('新建游戏', r.status === 200 && r.body.id > 0, r.body)
  const gameId = r.body.id
  ok('区服存成数组', Array.isArray(r.body.servers) && r.body.servers.length === 2, r.body.servers)

  r = await api('POST', '/api/games', { name: '原神' })
  ok('重名游戏被拒', r.status === 400 && r.body.code === 'duplicate', r.body)

  r = await api('POST', '/api/games', { name: '崩坏：星穹铁道', short_name: '崩铁' })
  const game2 = r.body.id

  r = await api('POST', '/api/categories', { name: '日常', game_id: gameId })
  ok('新建分类', r.status === 200 && r.body.id > 0, r.body)
  const catId = r.body.id

  // 「日常」这种名字的大类，建的时候没传 is_daily 也要自动认出来
  ok('新建「日常」大类自动勾上每天做', r.body.is_daily === true, String(r.body.is_daily))
  r = await api('POST', '/api/categories/append', { name: '活动' })
  const tmpCatId = r.body.id
  ok('新建「活动」大类不会被误勾', r.body.is_daily === false, String(r.body.is_daily))
  // 引用列不给值要存成 NULL —— 存成 '' 会撞外键
  r = await api('POST', '/api/services/append', { name: '没指定游戏的临时项', category_id: catId, base_price: 1 })
  const tmpSvcId = r.body.id
  ok('新建服务项不给 game_id 也能成（外键不能再报错）', r.status === 200 && r.body.id > 0, `${r.status} ${JSON.stringify(r.body).slice(0, 70)}`)
  ok('没给 game_id 时确实是 null，不是空字符串', r.body.game_id === null, JSON.stringify(r.body.game_id))
  // 可空 bool 的 NULL 要保住：跟随大类 ≠ 否
  ok('服务项没设 is_daily 时是 null（跟随大类）', r.body.is_daily === null, JSON.stringify(r.body.is_daily))
  r = await api('POST', '/api/services/append', { name: '强制一次性的', category_id: catId, base_price: 1, is_daily: 0 })
  const tmpSvc2 = r.body.id
  ok('显式设成 0 就是 false，不被 NULL 混掉', r.body.is_daily === false, JSON.stringify(r.body.is_daily))
  r = await api('PATCH', `/api/services/${tmpSvc2}`, { is_daily: null })
  ok('还能改回 null（跟随大类）', r.body.is_daily === null, JSON.stringify(r.body.is_daily))
  // 全部清掉：留着会让后面「几个大类 / 几个服务项」的统计全对不上
  await api('DELETE', `/api/services/${tmpSvcId}?hard=1`)
  await api('DELETE', `/api/services/${tmpSvc2}?hard=1`)
  r = await api('DELETE', `/api/categories/${tmpCatId}?hard=1`)
  ok('临时大类和服务项都清理干净', r.status === 200, r.status)

  r = await api('POST', '/api/services', {
    name: '每日委托',
    category_id: catId,
    game_id: gameId,
    price_type: 'daily',
    base_price: 5,
    unit_label: '天',
    description: '每天清完 4 个委托 + 领取奖励',
    package_items: ['4 个每日委托', '派遣', '纪行经验'],
  })
  ok('新建服务项（按天）', r.status === 200 && r.body.base_price === 5, r.body)
  const svcDaily = r.body.id

  r = await api('POST', '/api/services', {
    name: '深渊 12 层',
    category_id: catId,
    game_id: gameId,
    price_type: 'per_unit',
    base_price: 30,
    unit_label: '层',
    min_qty: 1,
  })
  const svcAbyss = r.body.id
  ok('新建服务项（按数量）', r.status === 200, r.body)

  r = await api('POST', `/api/services/${svcAbyss}/tiers`, { min_qty: 1, max_qty: 5, unit_price: 30 })
  ok('加阶梯价 1-5 层 30 元', r.status === 200, r.body)
  r = await api('POST', `/api/services/${svcAbyss}/tiers`, { min_qty: 6, max_qty: 12, unit_price: 25 })
  ok('加阶梯价 6-12 层 25 元', r.status === 200, r.body)

  r = await api('POST', '/api/options', { service_id: svcDaily, kind: 'addon', name: '加急', price: 20, price_mode: 'percent', description: '插队优先做，加价 20%' })
  ok('新建增项（按百分比加价）', r.status === 200, r.body)
  const addonRush = r.body.id

  r = await api('POST', '/api/options', { service_id: null, kind: 'addon', name: '不动原石', price: 0, description: '全程不消耗原石' })
  ok('新建通用增项', r.status === 200, r.body)
  const addonNoGem = r.body.id

  r = await api('GET', '/api/pricebook')
  ok('价格总览返回分类', r.body.categories?.length === 1, r.body.categories?.length)
  ok('价格总览里服务带阶梯和增项', r.body.categories?.[0]?.services?.[0]?.tiers !== undefined, r.body.categories?.[0]?.services?.[0])

  r = await api('GET', `/api/services/${svcAbyss}/full`)
  ok('单服务完整视角含 2 档阶梯', r.body.tiers?.length === 2, r.body.tiers?.length)

  r = await api('GET', '/api/games')
  ok('游戏列表带服务数统计', r.body.items?.[0]?.service_count >= 1, r.body.items?.[0])

  /* ---------- 客户 ---------- */
  section('客户')
  r = await api('POST', '/api/customers', { name: '小王', phone: '13800138000', wechat: 'wang_ys', qq: '10001', source: '微信', tags: ['爽快', '老客户'], note: '只在晚上回复' })
  ok('新建客户', r.status === 200 && r.body.id > 0, r.body)
  const custId = r.body.id
  ok('标签存成数组', Array.isArray(r.body.tags) && r.body.tags.length === 2, r.body.tags)

  r = await api('POST', '/api/customers', { name: '冒名', phone: '13800138000' })
  ok('手机号重复被拒', r.status === 400 && r.body.code === 'duplicate', r.body)

  r = await api('POST', '/api/customers', { name: '没手机号的' })
  ok('没有手机号可以建多个', r.status === 200, r.body)

  /* ---------- 保险箱 ---------- */
  section('凭证保险箱')
  r = await api('POST', '/api/credentials', {
    customer_id: custId,
    game_id: gameId,
    label: '小王主号',
    login_type: 'password',
    server: '天空岛',
    role_name: '旅行者',
    secret: { account: 'wang_ys@qq.com', phone: '13800138000', password: 'SuperSecret123', bind_phone: '13800138000', security_question: '母亲姓名', security_answer: '张三', note: '不要动原石' },
  })
  ok('新建凭证', r.status === 200 && r.body.id > 0, r.body)
  const credId = r.body.id
  ok('列表只露脱敏提示', /^\w{2}\*+@qq\.com$/.test(r.body.masked_hint || ''), r.body.masked_hint)
  ok('返回体里没有密文字段', r.body.payload_enc === undefined, Object.keys(r.body))

  r = await api('GET', '/api/credentials')
  const credListRow = r.body.items?.[0]
  ok('凭证列表不含 payload_enc', credListRow && credListRow.payload_enc === undefined, Object.keys(credListRow || {}))
  ok('凭证列表带客户名', credListRow?.customer_name === '小王', credListRow?.customer_name)

  const dbRaw = await api('GET', `/api/credentials/${credId}`)
  ok('单条凭证详情也不含密文', dbRaw.body.payload_enc === undefined, Object.keys(dbRaw.body))

  r = await api('POST', '/api/vault/lock')
  ok('手动落锁', r.body.unlocked === false, r.body)

  r = await api('POST', `/api/credentials/${credId}/reveal`, {})
  ok('锁定状态下取用被拒 423', r.status === 423 && r.body.code === 'vault_locked', r.body)

  r = await api('POST', '/api/vault/unlock', { password: 'wrong-password' })
  ok('保险箱密码错误被拒', r.status === 400, r.body)

  r = await api('POST', '/api/vault/unlock', { password: 'Vault-Secret-2024' })
  ok('保险箱解锁成功', r.body.unlocked === true, r.body)

  r = await api('POST', `/api/credentials/${credId}/reveal`, { action: 'view' })
  ok('解锁后能取到明文', r.body.secret?.password === 'SuperSecret123', r.body.secret)
  ok('明文里带密保问题', r.body.secret?.security_question === '母亲姓名', r.body.secret)

  r = await api('POST', `/api/credentials/${credId}/reveal`, { action: 'copy', field: 'password' })
  ok('复制动作也能取到', r.body.secret?.password === 'SuperSecret123', r.body)

  r = await api('GET', '/api/vault/audit')
  const actions = (r.body.items || []).map((a) => a.action)
  ok('审计记录了 view', actions.includes('credential.view'), actions)
  ok('审计记录了 copy', actions.includes('credential.copy'), actions)
  ok('审计记录了解锁', actions.includes('vault.unlock'), actions)
  ok('审计里有操作人', r.body.items?.[0]?.actor === '老板', r.body.items?.[0]?.actor)

  r = await api('POST', '/api/vault/setup', { password: 'another-one-123' })
  ok('保险箱重复设置被拒', r.status === 400, r.body)

  /* ---------- 订单 ---------- */
  section('订单 · 快照 · 状态机')
  r = await api('POST', '/api/orders', {
    customer_id: custId,
    game_id: gameId,
    status: 'pending_pay',
    items: [
      { service_id: svcDaily, quantity: 30, option_ids: [addonRush, addonNoGem] },
      { service_id: svcAbyss, quantity: 8 },
    ],
    discount: 10,
    platform_fee: 6,
    cost: 40,
  })
  ok('新建订单', r.status === 200 && r.body.id > 0, r.body)
  const orderId = r.body.id
  const order = r.body
  ok('单号形如 DHyymmdd-NNN', /^DH\d{6}-\d{3}$/.test(order.order_no || ''), order.order_no)
  ok('每日委托 5×30=150 + 加急 20% 30 = 180', order.items?.[0]?.amount === 180, order.items?.[0])
  ok('深渊 8 层命中第二档 25 元 = 200', order.items?.[1]?.amount === 200, order.items?.[1])
  ok('小计 150+200=350', order.items_subtotal === 350, order.items_subtotal)
  ok('增项合计 30', order.addon_total === 30, order.addon_total)
  ok('总价 350+30-10=370', order.total === 370, order.total)
  ok('利润 370-6-40=324', order.profit === 324, order.profit)
  ok('快照记下套餐内容', order.package_contents?.length === 3, order.package_contents)
  ok('快照记下增项', order.addon_summary?.length === 2, order.addon_summary)
  ok('订单冻结了客户名', order.customer_name === '小王', order.customer_name)
  ok('订单冻结了游戏名', order.game_name === '原神', order.game_name)

  /* ---------- 订单的游戏：按明细自动推，不用手选，也能混 ---------- */
  section('订单 · 游戏按服务项自动推')
  {
    // 单游戏：不传 game_id，也要按服务项推出来（以前不传就是空串）
    r = await api('POST', '/api/orders', { customer_id: custId, items: [{ service_id: svcDaily, quantity: 1 }] })
    ok('没手选游戏时按服务项推出来', r.status === 200 && r.body.game_name === '原神', r.body.game_name)
    ok('单游戏时 game_id 仍是那个游戏', r.body.game_id === gameId, r.body.game_id)
    ok('详情里带本单游戏列表', Array.isArray(r.body.games) && r.body.games.length === 1 && r.body.games[0].name === '原神', r.body.games)
    await api('DELETE', `/api/orders/${r.body.id}?force=1`)
  }
  {
    // 混两个游戏：一张单装得下，头上写「A + B」，game_id 留空
    // （硬塞其中一个会让「按游戏筛选」说谎 —— 这单明明是两张游戏的）
    const cat2 = (await api('POST', '/api/categories', { name: '星穹日常', game_id: game2 })).body.id
    const svc2 = (await api('POST', '/api/services', { name: '星穹每日', category_id: cat2, game_id: game2, price_type: 'fixed', base_price: 3 })).body.id
    r = await api('POST', '/api/orders', {
      customer_id: custId,
      items: [
        { service_id: svcDaily, quantity: 1 },
        { service_id: svc2, quantity: 1 },
      ],
    })
    ok('一张单可以混两个游戏', r.status === 200 && r.body.items?.length === 2, r.body.items?.length)
    ok('混游戏时游戏名拼起来', r.body.game_name === '原神 + 崩坏：星穹铁道', r.body.game_name)
    ok('混游戏时 game_id 留空', r.body.game_id === null, r.body.game_id)
    ok('详情里列出两个游戏', r.body.games?.length === 2, r.body.games)

    // 明细改了，游戏跟着重推：把这个混单改成只剩原神一项
    r = await api('PATCH', `/api/orders/${r.body.id}`, { items: [{ service_id: svcDaily, quantity: 1 }] })
    ok('改完明细游戏跟着重推', r.body.game_name === '原神' && r.body.game_id === gameId, `${r.body.game_name} / ${r.body.game_id}`)

    await api('DELETE', `/api/orders/${r.body.id}?force=1`)
    await api('DELETE', `/api/services/${svc2}?hard=1`)
    await api('DELETE', `/api/categories/${cat2}?hard=1`)
  }

  /* ---------- 资源文本的分段（一单多个游戏时按【游戏】分开记） ---------- */
  section('资源 · 一单多游戏的分段存法')
  {
    const two = '【鸣潮】星声 2174 体力 255 贝币 2508319 【异环】甲硬币 929484 方斯 4116889 环石 3087'
    const secs = splitResourceSections(two)
    ok('分段文本拆成两段', secs && secs.length === 2, secs)
    ok('分段带游戏名', secs?.[0]?.game === '鸣潮' && secs?.[1]?.game === '异环', secs?.map((s) => s.game))
    ok('两段正文各自独立', sectionText(two, '异环') === '甲硬币 929484 方斯 4116889 环石 3087', sectionText(two, '异环'))
    ok('没分段的文本不算分段', splitResourceSections('星声 105 体力 86') === null, splitResourceSections('星声 105 体力 86'))

    // 单游戏订单存出来必须和以前**一模一样**（老记录、老报表都当没这回事）
    ok('只有一段时不加【】标记', joinResourceSections([{ game: '鸣潮', body: '星声 1' }, { game: '异环', body: '' }]) === '星声 1', joinResourceSections([{ game: '鸣潮', body: '星声 1' }, { game: '异环', body: '' }]))
    ok('两段都有内容时才分段', joinResourceSections([{ game: '鸣潮', body: '星声 1' }, { game: '异环', body: '环石 2' }]) === '【鸣潮】星声 1 【异环】环石 2', joinResourceSections([{ game: '鸣潮', body: '星声 1' }, { game: '异环', body: '环石 2' }]))

    // 分段文本的差值要按段各算一次：两个游戏都记了「体力」，不能混成一个数
    const twoAfter = '【鸣潮】星声 2154 体力 215 贝币 2508319 【异环】甲硬币 929000 方斯 4116889 环石 3000'
    const deltas = resourceDeltaList(two, twoAfter)
    ok('分段差值带游戏名', deltas.every((d) => d.game), deltas)
    ok(
      '鸣潮体力 −40、异环体力没记就不算',
      deltas.some((d) => d.game === '鸣潮' && d.key === '体力' && d.diff === -40) && !deltas.some((d) => d.game === '异环' && d.key === '体力'),
      deltas
    )
    ok('文案里也带游戏名', deltaText(two, twoAfter).includes('鸣潮 体力 −40'), deltaText(two, twoAfter))
    ok('老文本的文案一个字没变', deltaText('星声 105 体力 86', '星声 85 体力 60') === '本次消耗：星声 −20 · 体力 −26', deltaText('星声 105 体力 86', '星声 85 体力 60'))
    // 报表口径：认不出的标签也要照原文比（老数据里有原石、树脂这种）
    ok(
      '报表连认不出的标签一起比',
      resourceDeltaList('原石 12000', '原石 11900', { includeUnknown: true })[0]?.diff === -100,
      resourceDeltaList('原石 12000', '原石 11900', { includeUnknown: true })
    )
  }

  /* ============================================================
     屏幕识别 · 打分口径（掩码 NCC）与「按屏只找需要的图标」

     两条都是纯函数，不连服务器。放在这里是因为各自对应一次真踩过的坑：
       · 异环的甲硬币是锚点，旧口径下模板跟它自己匹配只有 0.52 → 锚点永远定不出来；
       · 每帧把整份模板表都扫一遍，地图页把体力的 255 挂到了甲硬币名下。
     ============================================================ */
  section('屏幕识别 · 掩码 NCC 与按屏取键')
  {
    // ---- 打分口径 ----
    // 造一张「又亮又光滑的图标压在暗背景上」的图，正是异环金币那种画风：
    // 图标内部几乎是一整块渐变，背景近黑。旧分母用整窗（含背景）的起伏，
    // 会被那点反差撑大，于是自己匹配自己也只有 0.5 上下。
    const W = 160
    const H = 80
    const px = new Uint8Array(W * H * 3)
    for (let i = 0; i < px.length; i += 3) {
      px[i] = 12
      px[i + 1] = 12
      px[i + 2] = 18
    }
    const cx = 60
    const cy = 36
    const r = 22
    for (let y = cy - r; y <= cy + r; y++) {
      for (let x = cx - r; x <= cx + r; x++) {
        const d = Math.hypot(x - cx, y - cy)
        if (d > r) continue
        const t = 1 - d / r
        const i = (y * W + x) * 3
        px[i] = Math.round(95 + 145 * t)
        px[i + 1] = Math.round(75 + 115 * t)
        px[i + 2] = Math.round(25 + 45 * t)
      }
    }
    const canvas = { width: W, height: H, px }
    // 模板比圆大一圈（和真实模板一样带一点背景），锚定位置 = (38,14)
    const box = { x: cx - 22, y: cy - 22, w: 44, h: 44 }
    const patch = subImage(canvas, box.x, box.y, box.w, box.h)
    const ii = buildIntegral(canvas)
    const region = { x: 0, y: 0, w: W, h: H }
    const oldHit = matchAt(canvas, ii, region, compileTemplate(patch), { step: 1 })
    const newHit = matchAt(canvas, ii, region, compileTemplate(patch, { maskedNcc: true }), { step: 1 })
    ok('掩码 NCC：自己匹配自己 ≈ 1', Math.abs(newHit.score - 1) < 0.02, newHit.score)
    ok('掩码 NCC 命中的正是模板抠出来的位置', newHit.x === box.x && newHit.y === box.y, `${newHit.x},${newHit.y}`)
    ok('旧口径在同一个位置只有 0.8 以下（异环金币就是这么认不出来的）', oldHit.score < 0.8, oldHit.score)
    ok('掩码 NCC 的分数到得了锚点线 0.85', newHit.score >= 0.85, newHit.score)

    // ---- 按屏取键 ----
    // 两个「图标」摆在同一条带上，只请求其中一个：另一个连 seen 里都不该出现。
    // 尺寸要像真的：识别会按「图标宽 = 画面宽的 0.0344」去估大小，
    // 给一张 120×40 的小图会被放大十几倍去扫，那测的是反缩放不是取键。
    const BW = 1280
    const BH = 400
    const board = { width: BW, height: BH, px: new Uint8Array(BW * BH * 3) }
    for (let i = 0; i < board.px.length; i += 3) {
      const v = 24 + (i % 9)
      board.px[i] = v
      board.px[i + 1] = v
      board.px[i + 2] = v + 4
    }
    const tile = (x0, rd, gd, bd) => {
      const side = 44
      for (let y = 8; y < 8 + side; y++) {
        for (let x = x0; x < x0 + side; x++) {
          const i = (y * BW + x) * 3
          board.px[i] = rd
          board.px[i + 1] = gd
          board.px[i + 2] = bd
        }
      }
      return { width: side, height: side, px: subImage(board, x0, 8, side, side).px }
    }
    const refs = [
      { key: '红块', img: tile(200, 220, 40, 40), anchor: true, allowZero: false, aliases: ['红块'] },
      { key: '蓝块', img: tile(600, 40, 60, 220), anchor: false, allowZero: false, aliases: ['蓝块'] },
    ]
    // 不限时：平色块本来就定不出锚点，给预算会走到「没锚点就到点收工」那条分支，
    // 结果 seen 是空的 —— 那是另一码事，不是取键的问题。
    const onlyRed = recognizeFrame(board, [], { refs, keys: ['红块'], profile: '鸣潮', timeBudgetMs: 0 })
    ok('只请求一个键时另一个键不会被找（seen 里也不出现）', onlyRed.seen.length === 1 && onlyRed.seen[0].key === '红块', onlyRed.seen.map((s) => s.key))
    const bothTiles = recognizeFrame(board, [], { refs, profile: '鸣潮', timeBudgetMs: 0 })
    ok('不传 keys 还是老行为：整份模板表都找', bothTiles.seen.length === 2, bothTiles.seen.map((s) => s.key))

    // ---- 簇半径换算 ----
    // 簇半径从「锚点图标宽的 6.5 倍」换成「画面宽度的比例」之后，
    // 鸣潮那套已经调好的数值必须一模一样（6.5 × 0.0344 = 0.2236）。
    const wuwa = profileForGame('鸣潮')
    ok('鸣潮的簇半径和旧的 6.5×图标宽等价', Math.abs(CLUSTER_RATIO - 6.5 * wuwa.iconWidthRatio) < 0.001, `${CLUSTER_RATIO} vs ${6.5 * wuwa.iconWidthRatio}`)
    ok('异环的簇半径更宽（图标只有鸣潮的 65%，顶栏资源还铺得更开）', profileForGame('异环').clusterRatio > CLUSTER_RATIO, profileForGame('异环').clusterRatio)
    ok('异环走掩码 NCC、鸣潮不走（不动它标定好的阈值）', profileForGame('异环').maskedNcc === true && !wuwa.maskedNcc, `${profileForGame('异环').maskedNcc}/${wuwa.maskedNcc}`)

    /* ---- findIconTop 的挖洞：洞必须是**原图坐标** ----
       这条对应一个反复踩的坑：findIcon 收到 exclude 之后自己会把它乘上 work.scale
       换算到工作图坐标，所以 findIconTop 传进去的必须是原图坐标。
       一旦这里再乘一次（或者用 work.img.height / screen.height 这种错比例），
       洞就挖到别处，topN 的第 2、3 个候选又命中同一个峰 —— 直接后果是
       pickStableCandidate 的 second_score 永远等于 best_score，
       confirmAnchor 会把锚点自己当成「伙伴图标」来确认。

       造一张 2560 宽的条带、贴两个同样的图标（低频渐变，缩到 0.56 倍还认得出），
       只保留「找到两个不同位置」和「原图坐标能排掉」这两条硬结论。 */
    {
      const SW = 2560
      const SH = 800
      const spx = new Uint8Array(SW * SH * 3)
      for (let i = 0; i < spx.length; i += 3) {
        const v = 20 + (i % 7)
        spx[i] = v
        spx[i + 1] = v
        spx[i + 2] = v + 3
      }
      const SIDE = 88
      const stamp = (x0) => {
        for (let y = 6; y < 6 + SIDE; y++) {
          for (let x = x0; x < x0 + SIDE; x++) {
            const d = Math.hypot(x - x0 - SIDE / 2, y - 6 - SIDE / 2)
            const t = Math.max(0, 1 - d / (SIDE / 2))
            const i = (y * SW + x) * 3
            spx[i] = Math.round(30 + 200 * t)
            spx[i + 1] = Math.round(25 + 70 * t)
            spx[i + 2] = Math.round(20 + 45 * t)
          }
        }
      }
      const atA = 600
      const atB = 1500
      stamp(atA)
      stamp(atB)
      const shot = { width: SW, height: SH, px: spx }
      const sh = Math.max(48, Math.round(SH * 0.14))
      const expectedW = SW * 0.0344
      const ws = Math.min(2600 / SW, Math.max(0.2, 49 / expectedW))
      const bandWork = {
        img: resampleBilinear(subImage(shot, 0, 0, SW, sh), Math.round(SW * ws), Math.round(sh * ws)),
        scale: ws,
      }
      const bandBox = { x: 0, y: 0, w: SW, h: sh }
      const tplAtA = subImage(shot, atA, 6, SIDE, SIDE)

      const top = findIconTop(shot, tplAtA, { region: bandBox, work: bandWork, minScore: 0.2, timeBudgetMs: 8000 }, 3)
      const xs = top.map((h) => h.x)
      const distinct = new Set(xs.map((x) => Math.round(x / 100)))
      ok(
        'findIconTop 在条带工作图下能找到两个不同位置的同款图标（挖洞有效）',
        distinct.size === 2 && xs.some((x) => Math.abs(x - atA) < 60) && xs.some((x) => Math.abs(x - atB) < 60),
        xs.map((x) => Math.round(x))
      )

      const hole = [{ cx: atA + SIDE / 2, cy: 6 + SIDE / 2, r: SIDE * 0.7 }]
      const afterHole = findIcon(shot, tplAtA, { region: bandBox, work: bandWork, minScore: 0.2, exclude: hole })
      ok(
        'exclude 用原图坐标能排掉左边那个、命中右边那个',
        Boolean(afterHole) && Math.abs(afterHole.x - atB) < 60,
        afterHole && Math.round(afterHole.x)
      )
    }

    /* ---- grab.ps1：读不到窗口像素时**不许**退回整屏抓取 ----
       这条对应一个会静默存错图的坑：窗口不在前台时，PrintWindow / BitBlt 全
       失败，老代码把 $method 落回 'CopyFromScreen' —— 那是从**屏幕**上拷，
       拷到的是盖在窗口上面的浏览器。图看着完全正常，covered 判据也过（窗口
       没占满屏），于是被当成游戏截图存进时间线。

       现在：三种办法都失败就 exit 6 + 写 <out>.error，由 src/vision/screen.mjs 翻成
       一句人话。这里守住三件事，任何一件被改回去都算回归：
         · 文件必须是纯 ASCII（PowerShell 5.1 拿 GBK 解无 BOM 的 UTF-8，
           中文注释会把后面的引号吃掉，整个脚本解析失败）；
         · exit 6 与错误码仍在；
         · '$method = ''CopyFromScreen''' 只出现一次，且在 if (-not $method) 之后。 */
    {
      const raw = fs.readFileSync(path.join(ROOT, 'scripts', 'win32', 'grab.ps1'))
      const nonAscii = [...raw].filter((b) => b > 0x7f)
      ok('grab.ps1 是纯 ASCII（否则 GBK 解码会把引号吃掉）', nonAscii.length === 0, `${nonAscii.length} 个非 ASCII 字节`)

      const text = raw.toString('utf8')
      ok('读不到窗口像素时以 exit 6 结束', /exit\s+6/.test(text) && text.includes('window_pixels_unavailable'))

      // 只数**有效赋值**（跳过注释行），再比行号 —— 注释里也写着这串字，
      // 用 indexOf 会被注释骗过去。
      const lines = text.split('\n')
      const guardLine = lines.findIndex((line) => line.includes('if (-not $method)'))
      const assignLines = lines
        .map((line, i) => ({ line: line.trim(), i }))
        .filter(({ line }) => !line.startsWith('#'))
        .filter(({ line }) => /\$method\s*=\s*'CopyFromScreen'/.test(line))
        .map(({ i }) => i)
      const onlyBehindGuard = assignLines.length === 1 && guardLine > 0 && assignLines[0] > guardLine
      ok('CopyFromScreen 只在「没选过方法」的兜底分支里赋值（catch 里不许回退）', onlyBehindGuard, `${assignLines.length} 处有效赋值，兜底在第 ${guardLine + 1} 行`)

      // 最小化的窗口也会返回一个「有面积」的矩形，只是原点在 (-32000,-32000)。
      // 照那个矩形抓就是一张黑图，下游会把它误诊成「独占全屏」。要单独报出来。
      ok('最小化的窗口单独报错（exit 7 / window_minimized）', /exit\s+7/.test(text) && text.includes('window_minimized'))
      const minimizedAt = text.indexOf('window_minimized')
      const createAt = text.indexOf('New-Object System.Drawing.Bitmap')
      ok('最小化判断在建位图之前', minimizedAt > 0 && createAt > minimizedAt, `minimized@${minimizedAt} create@${createAt}`)
    }

    /* ---------- 找不到窗口时，两条路径说同一套话 ----------
       focusGameWindow 会把 ps1 的 code / integrity / seen 翻成人话，而
       findGameWindow 曾经只丢一句 stderr —— 偏偏 find 是「抢焦点失败」时唯一的
       退路，用户在那里最需要知道为什么。以及那个 ps1 以前根本不报 seen。 */
    {
      const findPs1 = fs.readFileSync(path.join(ROOT, 'scripts', 'win32', 'find-game-window.ps1'), 'utf8')
      ok('find-game-window.ps1 报 seen（否则「进程名猜错」和「游戏没开」分不出来）', findPs1.includes('seen = @($seenGames)'))
      ok('find-game-window.ps1 报 integrity（低完整性看不到提权的游戏）', findPs1.includes("integrity = $integrity") && findPs1.includes('S-1-16-4096'))
      ok('find-game-window.ps1 是纯 ASCII', [...Buffer.from(findPs1)].filter((b) => b > 0x7f).length === 0)
      const gw = fs.readFileSync(path.join(ROOT, 'src', 'vision', 'game-window.mjs'), 'utf8')
      const calls = (gw.match(/describeWindowFailure\(/g) || []).length
      ok('两个入口共用同一套失败翻译（focus + find）', calls === 3, `${calls} 处（定义 1 + 调用 2）`)
    }

    /* ---------- 前端选图上限要和后端对齐 ----------
       后端 /api/ocr 收 12MB，前端却卡 1.5MB —— 2K 游戏截图的原始 PNG 就 2~3MB，
       用户选一张完全正常的截图会被直接拒掉。 */
    {
      const rf = fs.readFileSync(path.join(ROOT, 'client', 'forms', 'resource-field.jsx'), 'utf8')
      ok('「识别截图」的上限跟后端一致（12MB）', rf.includes('12 * 1024 * 1024') && !rf.includes('1.5 * 1024 * 1024'))
    }
  }

  // 改价格表，老订单不受影响
  await api('PATCH', `/api/services/${svcDaily}`, { base_price: 99 })
  r = await api('GET', `/api/orders/${orderId}`)
  ok('改价后老订单单价仍是 5', r.body.items?.[0]?.unit_price === 5, r.body.items?.[0]?.unit_price)
  ok('改价后老订单总价仍是 370', r.body.total === 370, r.body.total)
  // 验证完了把价格改回去，后面的报价单测试才有确定的数字
  await api('PATCH', `/api/services/${svcDaily}`, { base_price: 5 })

  r = await api('GET', '/api/orders?status=open')
  ok('按进行中筛选订单', (r.body.items || []).some((o) => o.id === orderId), r.body.items?.length)
  ok('列表带未收金额', r.body.items?.[0]?.due_total === 370, r.body.items?.[0]?.due_total)
  // 客户反复下单时，列表要能看出这是他的第几单
  ok(
    '列表带这个客户一共下过几单',
    r.body.items?.every((o) => typeof o.customer_order_count === 'number'),
    r.body.items?.map((o) => `${o.customer_name}:${o.customer_order_count}`).join(', ')
  )
  r = await api('GET', '/api/orders?sort=customer')
  ok('支持按客户排序', r.status === 200 && Array.isArray(r.body.items), r.status)
  const names = (r.body.items || []).map((o) => o.customer_name || '')
  ok('按客户排序后同名相邻', names.every((n, i) => i === 0 || n >= names[i - 1]), names.join(' | ').slice(0, 80))
  r = await api('GET', `/api/orders?customer_id=${custId}`)
  ok('支持按客户筛单', (r.body.items || []).every((o) => o.customer_id === custId), r.body.items?.length)

  // 列表里要能直接看到客户手机号
  const withCust = (r.body.items || []).find((o) => o.customer_id === custId)
  ok('订单行带客户手机号', withCust?.customer_phone === '13800138000', withCust?.customer_phone)

  /* ---- 今日已完成（日体那种天天要做的单） ---- */
  const statusBefore = (await api('GET', `/api/orders/${orderId}`)).body.status
  r = await api('POST', `/api/orders/${orderId}/daily-done`, { done: true })
  ok('能标成今日已完成', r.status === 200 && r.body.daily_done_today === true, `daily_done_on=${r.body.daily_done_on}`)
  ok('标今日完成不改订单状态（不是整单完成）', r.body.status === statusBefore && r.body.status !== 'done', `${statusBefore} → ${r.body.status}`)
  // 「今天」是凌晨 4 点换日的那个 bizDate，不是日历日期
  ok('标的是「干活的今天」，不是日历日期', r.body.daily_done_on === bizDate(), `${r.body.daily_done_on} vs bizDate=${bizDate()}`)
  r = await api('GET', '/api/orders?status=open&limit=300')
  ok('标完就从「在做」列表里挪走了', !(r.body.items || []).some((o) => o.id === orderId), `${r.body.items?.length} 张在做`)
  r = await api('GET', '/api/orders?status=daily_done&limit=300')
  ok('「今日已完成」列表里能找到', (r.body.items || []).some((o) => o.id === orderId), r.body.items?.length)
  r = await api('POST', `/api/orders/${orderId}/daily-done`, { done: false })
  ok('能撤销今日完成', r.body.daily_done_today === false && !r.body.daily_done_on, String(r.body.daily_done_on))
  r = await api('GET', '/api/orders?status=open&limit=300')
  ok('撤销后回到「在做」', (r.body.items || []).some((o) => o.id === orderId), '')

  // 换日点是凌晨 4 点：干到后半夜的人，凌晨 1 点做完的日体不该算第二天
  ok(`换日点是凌晨 ${DAY_START_HOUR} 点`, DAY_START_HOUR === 4, String(DAY_START_HOUR))
  ok('凌晨 0:30 归前一天', bizDate(new Date('2026-09-22T00:30:00')) === '2026-09-21', bizDate(new Date('2026-09-22T00:30:00')))
  ok('凌晨 3:59 还归前一天', bizDate(new Date('2026-09-22T03:59:00')) === '2026-09-21', bizDate(new Date('2026-09-22T03:59:00')))
  ok('凌晨 4:00 算新的一天', bizDate(new Date('2026-09-22T04:00:00')) === '2026-09-22', bizDate(new Date('2026-09-22T04:00:00')))
  ok('白天不受影响', bizDate(new Date('2026-09-22T12:00:00')) === '2026-09-22', bizDate(new Date('2026-09-22T12:00:00')))
  ok('跨年也对（1月1日凌晨2点 → 上一年12月31日）', bizDate(new Date('2026-01-01T02:00:00')) === '2025-12-31', bizDate(new Date('2026-01-01T02:00:00')))
  ok('localDate 还是老老实实的日历日期', localDate(new Date('2026-09-22T02:00:00')) === '2026-09-22', localDate(new Date('2026-09-22T02:00:00')))

  r = await api('POST', `/api/orders/${orderId}/status`, { status: 'done' })
  ok('待付款不能直接改已完成', r.status === 400 && r.body.code === 'bad_transition', r.body)

  // 整单做完之后就不该再让它标今日完成了。
  // 用一张临时单测，测完立刻删掉 —— 否则后面那些「一共几张单」的统计全会被带偏。
  r = await api('POST', '/api/orders', {
    customer_id: custId,
    game_id: gameId,
    items: [{ service_id: svcDaily, quantity: 1 }],
  })
  const closedOrderId = r.body.id
  await api('POST', `/api/orders/${closedOrderId}/status`, { status: 'in_progress' })
  await api('POST', `/api/orders/${closedOrderId}/status`, { status: 'done' })
  r = await api('POST', `/api/orders/${closedOrderId}/daily-done`, { done: true })
  ok('已完成的单不给标今日完成', r.status === 400 && r.body.code === 'order_closed', `${r.status} ${r.body.code}`)
  r = await api('DELETE', `/api/orders/${closedOrderId}`)
  ok('临时单已清理（不影响后面的统计）', r.status === 200, r.status)

  /* ---- 拆单：把一张单里的若干服务项挪到新单，两边各自结算 ---- */
  r = await api('POST', '/api/orders', {
    customer_id: custId,
    game_id: gameId,
    title: '待拆的单',
    items: [
      { service_id: svcDaily, quantity: 10 },
      { service_id: svcAbyss, quantity: 4 },
    ],
    discount: 10,
    platform_fee: 5,
    cost: 3,
  })
  const splitId = r.body.id
  const beforeSplit = r.body
  ok('建好待拆的单', beforeSplit.items.length === 2, `${beforeSplit.order_no} ¥${beforeSplit.total}`)
  const keepItem = beforeSplit.items.find((i) => i.ref_id === svcDaily)
  const moveItem = beforeSplit.items.find((i) => i.ref_id === svcAbyss)

  r = await api('POST', `/api/orders/${splitId}/split`, { item_ids: [moveItem.id] })
  ok('拆单返回新单和原单', r.status === 200 && !!r.body.created?.id && !!r.body.original?.id, `${r.status}`)
  const created = r.body.created
  const original = r.body.original
  ok('新单号跟原单不一样', created.order_no !== original.order_no, `${original.order_no} → ${created.order_no}`)
  ok('新单拿走了被勾的那一项', created.items.length === 1 && created.items[0].ref_id === svcAbyss, created.items.map((i) => i.name).join('、'))
  ok('原单只剩没勾的那一项', original.items.length === 1 && original.items[0].ref_id === svcDaily, original.items.map((i) => i.name).join('、'))
  ok('原单金额 = 剩下的项 - 折扣', Math.abs(original.total - Math.max(0, keepItem.amount - 10)) < 0.01, `¥${original.total}（项 ¥${keepItem.amount} - 折 10）`)
  ok('新单金额 = 拆走那一项的钱', Math.abs(created.total - moveItem.amount) < 0.01, `¥${created.total} vs ¥${moveItem.amount}`)
  ok('两边的项钱加起来没变', Math.abs(original.items_subtotal + created.items_subtotal - beforeSplit.items_subtotal) < 0.01, `${original.items_subtotal} + ${created.items_subtotal} vs ${beforeSplit.items_subtotal}`)
  ok('折扣/手续费/成本留在原单', original.discount === 10 && original.platform_fee === 5 && original.cost === 3, `${original.discount}/${original.platform_fee}/${original.cost}`)
  ok('新单这几项从 0 开始', created.discount === 0 && created.platform_fee === 0 && created.cost === 0, `${created.discount}/${created.platform_fee}/${created.cost}`)
  ok('客户/游戏/日期照抄过去', created.customer_id === beforeSplit.customer_id && created.game_id === beforeSplit.game_id && created.ordered_at === beforeSplit.ordered_at, '')
  ok('标题标了来源', /拆出/.test(created.title) && /拆自/.test(created.note || ''), `${created.title} / ${created.note}`)

  // 拆完两边各自走各自的
  r = await api('POST', `/api/orders/${created.id}/status`, { status: 'in_progress' })
  r = await api('POST', `/api/orders/${created.id}/status`, { status: 'done' })
  ok('拆出来的新单能单独标完成', r.body.status === 'done', r.body.status_label)
  const origAfter = (await api('GET', `/api/orders/${splitId}`)).body
  ok('原单状态不受影响', origAfter.status === beforeSplit.status, `${beforeSplit.status_label} → ${origAfter.status_label}`)
  r = await api('POST', '/api/payments', { order_id: created.id, kind: 'full', method: '微信', amount: created.total, paid_at: '2026-09-21' })
  ok('新单能单独收款', r.status === 200, r.status)
  ok('收的钱只算在新单上', (await api('GET', `/api/orders/${created.id}`)).body.paid_total === created.total, '')
  ok('原单一分钱没收（没被带过去）', (await api('GET', `/api/orders/${splitId}`)).body.paid_total === 0, '')

  // 边界
  r = await api('POST', `/api/orders/${splitId}/split`, { item_ids: [] })
  ok('一项都没勾会被拒', r.status === 400 && r.body.code === 'nothing_selected', r.body.code)
  r = await api('POST', `/api/orders/${splitId}/split`, { item_ids: [(await api('GET', `/api/orders/${splitId}`)).body.items[0].id] })
  ok('全拆走会被拒（原单不能空）', r.status === 400 && r.body.code === 'leaves_nothing', r.body.code)
  r = await api('POST', `/api/orders/${splitId}/split`, { item_ids: [999999] })
  ok('不属于这张单的明细会被拒', r.status === 400 && r.body.code === 'bad_item', r.body.code)
  r = await api('GET', `/api/orders/${splitId}`)
  ok('被拒之后原单毫发无损', r.body.items.length === 1 && r.body.total === original.total, `${r.body.items.length} 项 ¥${r.body.total}`)

  // 清掉拆出来的两张（新单有收款，得带 force）
  await api('DELETE', `/api/orders/${created.id}?force=1`)
  r = await api('DELETE', `/api/orders/${splitId}`)
  ok('拆单测试的临时单都清理了', r.status === 200, r.status)

  /* ---- 拆单：已经收过钱的单，收款要能跟着分（不然两张单的账都是错的） ---- */
  r = await api('POST', '/api/orders', {
    customer_id: custId,
    game_id: gameId,
    title: '收过钱再拆',
    items: [
      { service_id: svcDaily, quantity: 10 },
      { service_id: svcAbyss, quantity: 4 },
    ],
  })
  const paidSplitId = r.body.id
  const paidBefore = r.body
  await api('POST', '/api/payments', { order_id: paidSplitId, kind: 'full', method: '微信', amount: paidBefore.total, paid_at: '2026-09-21' })
  await api('POST', `/api/orders/${paidSplitId}/progress`, { happened_on: '2026-09-19', content: '拆之前记的进度' })
  const paidBefore2 = (await api('GET', `/api/orders/${paidSplitId}`)).body
  ok('先把这张单收满 + 记一条进度', Math.abs(paidBefore2.paid_total - paidBefore2.total) < 0.01 && paidBefore2.progress.length === 1, `已收 ¥${paidBefore2.paid_total} / 进度 ${paidBefore2.progress.length} 条`)
  ok('收款记录本来就该带单号', paidBefore2.payments.every((p) => p.order_no === paidBefore2.order_no), paidBefore2.payments.map((p) => p.order_no || '(空)').join(','))

  const moveIt = paidBefore2.items.find((i) => i.ref_id === svcAbyss)
  r = await api('POST', `/api/orders/${paidSplitId}/split`, { item_ids: [moveIt.id], progress: 'move' })
  const pOrig = r.body.original
  const pNew = r.body.created
  ok('默认按比例把收款分了', r.body.payments_moved === 1, `分了 ${r.body.payments_moved} 笔`)
  ok('★ 两张单的已收加起来 = 原来那笔', Math.abs(pOrig.paid_total + pNew.paid_total - paidBefore2.paid_total) < 0.02, `${pOrig.paid_total} + ${pNew.paid_total} vs ${paidBefore2.paid_total}`)
  ok('★ 原单正好结清（不再多收）', Math.abs(pOrig.paid_total - pOrig.total) < 0.02 && pOrig.overpaid < 0.01, `总 ¥${pOrig.total} 已收 ¥${pOrig.paid_total}`)
  ok('★ 新单也正好结清', Math.abs(pNew.paid_total - pNew.total) < 0.02 && pNew.overpaid < 0.01, `总 ¥${pNew.total} 已收 ¥${pNew.paid_total}`)
  ok('分出来的那笔标了来源', (pNew.payments[0]?.note || '').includes('拆自'), pNew.payments[0]?.note)
  ok('两边收款记录都带单号', pOrig.payments.every((p) => p.order_no === pOrig.order_no) && pNew.payments.every((p) => p.order_no === pNew.order_no), `${pOrig.payments[0]?.order_no} / ${pNew.payments[0]?.order_no}`)
  ok('★ 选了「跟到新单」，进度整批搬过去了', pNew.progress.length === 1 && pOrig.progress.length === 0, `原 ${pOrig.progress.length} / 新 ${pNew.progress.length}`)

  // 选「全留在原单」也行，但要老实告诉你多收了
  r = await api('POST', '/api/orders', {
    customer_id: custId,
    game_id: gameId,
    title: '收款留原单',
    items: [
      { service_id: svcDaily, quantity: 10 },
      { service_id: svcAbyss, quantity: 4 },
    ],
  })
  const keepPayId = r.body.id
  await api('POST', '/api/payments', { order_id: keepPayId, kind: 'full', method: '微信', amount: r.body.total, paid_at: '2026-09-21' })
  const keepCur = (await api('GET', `/api/orders/${keepPayId}`)).body
  r = await api('POST', `/api/orders/${keepPayId}/split`, { item_ids: [keepCur.items.find((i) => i.ref_id === svcAbyss).id], payments: 'keep' })
  ok('选「全留在原单」就不分收款', r.body.payments_moved === 0, String(r.body.payments_moved))
  ok('★ 原单因此变「多收」，返回里报了数', r.body.original_overpaid > 0.001, `多收 ¥${r.body.original_overpaid}`)
  ok('新单还欠全款', Math.abs(r.body.created.due_total - r.body.created.total) < 0.01, `还欠 ¥${r.body.created.due_total}`)

  await api('DELETE', `/api/orders/${pNew.id}?force=1`)
  await api('DELETE', `/api/orders/${pOrig.id}?force=1`)
  await api('DELETE', `/api/orders/${r.body.created.id}?force=1`)
  r = await api('DELETE', `/api/orders/${keepPayId}?force=1`)
  ok('收过钱再拆的临时单也清理了', r.status === 200, r.status)

  /* ---------- 收款 ---------- */
  section('收款与状态推进')
  r = await api('POST', '/api/payments', { order_id: orderId, amount: 200, method: 'wechat', kind: 'deposit', note: '定金' })
  ok('记一笔定金 200', r.status === 200 && r.body.id > 0, r.body)
  ok('没收满不推进状态', r.body.advanced_to === null, r.body.advanced_to)

  r = await api('GET', `/api/orders/${orderId}`)
  ok('已收 200，尾款 170', r.body.paid_total === 200 && r.body.due_total === 170, { paid: r.body.paid_total, due: r.body.due_total })

  r = await api('POST', '/api/payments', { order_id: orderId, amount: 170, method: 'alipay', kind: 'balance', note: '尾款' })
  ok('收满后自动推进到进行中', r.body.advanced_to === 'in_progress', r.body.advanced_to)

  r = await api('GET', `/api/orders/${orderId}`)
  ok('订单状态已是进行中', r.body.status === 'in_progress', r.body.status)
  ok('尾款归零', r.body.due_total === 0, r.body.due_total)

  r = await api('POST', '/api/payments', { order_id: orderId, amount: 50, method: 'wechat', kind: 'refund', note: '少打一层退了点' })
  ok('记一笔退款', r.status === 200, r.body)
  r = await api('GET', `/api/orders/${orderId}`)
  ok('退款后已收变 320', r.body.paid_total === 320, r.body.paid_total)

  /* ---------- 进度 ---------- */
  section('进度时间线')
  r = await api('POST', `/api/orders/${orderId}/progress`, {
    happened_on: '2024-06-01',
    content: '清完今日委托 + 派遣，深渊打到第 6 层',
    resources_before: '原石 12000 / 树脂 160',
    resources_after: '原石 12400 / 树脂 40',
    media: ['https://example.com/shot1.png', 'https://example.com/shot2.png'],
    note: '第 6 层差一颗星',
  })
  ok('新增进度', r.status === 200 && r.body.id > 0, r.body)
  ok('进度截图存成数组', Array.isArray(r.body.media) && r.body.media.length === 2, r.body.media)
  const progressId = r.body.id

  r = await api('PATCH', `/api/progress/${progressId}`, { content: '清完今日委托 + 派遣，深渊打到第 7 层' })
  ok('修改进度内容', r.body.content.includes('第 7 层'), r.body.content)

  r = await api('GET', `/api/orders/${orderId}`)
  ok('订单详情带进度', r.body.progress?.length === 1, r.body.progress?.length)

  r = await api('DELETE', `/api/progress/${progressId}`)
  ok('删除进度', r.body.deleted === true, r.body)

  /* ---------- 状态流转 ---------- */
  section('状态流转')
  r = await api('POST', `/api/orders/${orderId}/status`, { status: 'pending_accept', note: '做完了，等验收' })
  ok('进行中 → 待验收', r.body.status === 'pending_accept', r.body.status)
  ok('改状态自动补一条进度', r.body.progress?.some((p) => p.content.includes('待验收')), r.body.progress?.map((p) => p.content))

  r = await api('POST', `/api/orders/${orderId}/status`, { status: 'done' })
  ok('待验收 → 已完成', r.body.status === 'done' && r.body.completed_at, r.body.status)
  ok('已完成带完成时间', Boolean(r.body.completed_at), r.body.completed_at)

  r = await api('GET', `/api/customers/${custId}/profile`)
  ok('客户全景：订单/收款/凭证都在', r.body.orders?.length === 1 && r.body.payments?.length === 3 && r.body.credentials?.length === 1, {
    o: r.body.orders?.length,
    p: r.body.payments?.length,
    c: r.body.credentials?.length,
  })
  ok('客户全景汇总金额正确', r.body.summary?.order_total === 370 && r.body.summary?.paid_total === 320, r.body.summary)

  /* ---------- 报价单 ---------- */
  section('报价单')
  r = await api('POST', '/api/quotes/preview', {
    items: [{ service_id: svcDaily, quantity: 30 }, { service_id: svcAbyss, quantity: 12 }],
  })
  ok('报价试算：每日 5×30=150 + 深渊 12 层命中 25/层=300 → 450', r.body.total === 450, r.body.total)

  r = await api('POST', '/api/quotes', {
    customer_id: custId,
    game_id: gameId,
    title: '小王 6 月代肝报价',
    items: [{ service_id: svcDaily, quantity: 30 }, { service_id: svcAbyss, quantity: 12 }],
    note: '包月更划算',
    valid_days: 5,
  })
  ok('保存报价单', r.status === 200 && /^BJ\d{6}-\d{3}$/.test(r.body.quote_no || ''), r.body.quote_no)
  const quoteId = r.body.id
  ok('报价单总价 450', r.body.total === 450, r.body.total)

  r = await api('GET', `/api/quotes/${quoteId}/text`)
  ok('生成报价单文本', typeof r.body.text === 'string' && r.body.text.includes('合计：450'), r.body.text?.slice(0, 120))
  ok('报价单文本含服务明细', r.body.text.includes('每日委托') && r.body.text.includes('深渊 12 层'), r.body.text?.slice(0, 200))

  r = await api('POST', `/api/quotes/${quoteId}/convert`)
  ok('报价单转订单', r.body.ok === true && r.body.order_id > 0, r.body)
  const convertedOrderId = r.body.order_id
  r = await api('GET', `/api/orders/${convertedOrderId}`)
  ok('转出的订单带快照明细', r.body.items?.length === 2 && r.body.total === 450, { n: r.body.items?.length, t: r.body.total })
  // 转出来的明细必须还能对回价格表里的服务项，否则「改明细」整单一条都改不了
  ok(
    '转出的明细保留了服务项关联（ref_id）',
    r.body.items.every((i) => i.ref_id != null),
    r.body.items.map((i) => `${i.name}:ref_id=${i.ref_id}`).join(', ')
  )
  // 改一条明细的数量，确认真的存下去了（以前这种情况整单明细都发不出去）
  const convItems = r.body.items
  const convTotal = Number(r.body.total)
  const firstQty = Number(convItems[0].quantity)
  const firstPrice = Number(convItems[0].unit_price)
  const bumpQty = firstQty + 2
  // 单价要一起带上，否则服务端会当成「没有改价」而按价格表重算
  const withQty = (q) => ({
    items: convItems.map((i, idx) => ({ service_id: i.ref_id, quantity: idx === 0 ? q : i.quantity, unit_price: i.unit_price })),
  })
  r = await api('PATCH', `/api/orders/${convertedOrderId}`, withQty(bumpQty))
  ok('改明细能保存（不再被整单忽略）', r.status === 200, r.status)
  r = await api('GET', `/api/orders/${convertedOrderId}`)
  ok('数量改动同步到了订单', Number(r.body.items[0].quantity) === bumpQty, r.body.items.map((i) => `${i.name}×${i.quantity}`).join(', '))
  ok('总价跟着重算了', Number(r.body.total) === convTotal + 2 * firstPrice, `${convTotal} → ${r.body.total}`)
  ok('明细条数没变（没被删掉）', r.body.items.length === 2, `${r.body.items.length} 条`)
  // 改回原样，免得影响后面财务口径的断言
  await api('PATCH', `/api/orders/${convertedOrderId}`, withQty(firstQty))
  r = await api('GET', `/api/orders/${convertedOrderId}`)
  ok('改回原数量后金额复原', Number(r.body.total) === convTotal, `${r.body.total} vs ${convTotal}`)

  /* ---------- 客户：归档 / 真删 ---------- */
  section('客户归档与真删')
  r = await api('POST', '/api/customers', { name: '待处理客户' })
  const tmpCust = r.body.id
  r = await api('DELETE', `/api/customers/${tmpCust}`)
  ok('客户默认删除=归档', r.body.archived === true, r.body)
  r = await api('GET', `/api/customers/${tmpCust}`)
  ok('归档后客户还在（状态 archived）', r.body.status === 'archived', r.body.status)
  r = await api('PATCH', `/api/customers/${tmpCust}`, { status: 'active' })
  ok('客户能从归档恢复', r.body.status === 'active', r.body.status)
  r = await api('DELETE', `/api/customers/${tmpCust}?hard=1`)
  ok('客户带 hard=1 才是真删', r.body.deleted === true, r.body)
  r = await api('GET', `/api/customers/${tmpCust}`)
  ok('真删后客户没了', r.status === 404, String(r.status))

  /* ---------- 导出：图片模型 / Word 文档 / Excel 表格 ---------- */
  section('导出价格表')

  /* 配色：整套导出只允许黑白灰 —— 图片、Word、Excel 三处都查一遍。
     这条挡的是「有人手滑把彩色加回来」，比人眼看截图靠谱。 */
  ok('Word 调色板是纯灰阶', Object.values(DOCX_PALETTE).every(isNeutral), JSON.stringify(DOCX_PALETTE))
  const cardSrc = fs.readFileSync(new URL('../../public/js/pricecard.js', import.meta.url), 'utf8')
  const cardColors = [...cardSrc.matchAll(/'(#[0-9A-Fa-f]{6})'/g)].map((m) => m[1])
  ok('图片调色板是纯灰阶', cardColors.length > 0 && cardColors.every(isNeutral), cardColors.join(', '))
  ok(
    '图片去掉了顶部色条 / 外框 / 点线',
    !cardSrc.includes('strokeRect') && !cardSrc.includes('setLineDash'),
    `strokeRect=${cardSrc.includes('strokeRect')} setLineDash=${cardSrc.includes('setLineDash')}`
  )

  r = await api('GET', '/api/pricebook/export-model')
  ok('导出模型有抬头', typeof r.body.shopName === 'string' && r.body.shopName.length > 0, r.body.shopName)
  ok('导出模型带大类和服务项', (r.body.groups || []).length > 0 && r.body.itemCount > 0, `groups=${r.body.groups?.length} items=${r.body.itemCount}`)
  const flatItems = (r.body.groups || []).flatMap((g) => g.items || [])
  ok('每项都带了格式化好的价格', flatItems.every((i) => typeof i.price === 'string' && i.price.startsWith('¥')), flatItems[0]?.price)
  ok('模型列出了涉及的每个游戏', Array.isArray(r.body.gameOptions) && r.body.gameOptions.length >= 1, JSON.stringify(r.body.gameOptions))

  // 「深渊 12 层」配了阶梯价，导出里应该出现阶梯提示
  const tieredItem = flatItems.find((i) => i.name === '深渊 12 层')
  ok('阶梯价被转成价格提示', !!tieredItem?.hint, tieredItem?.hint || '(没有 hint)')
  // 「每日委托」挂了加急增项
  const addonItem = flatItems.find((i) => i.name === '每日委托')
  ok('增项被写进说明', (addonItem?.notes || []).some((n) => n.includes('增项')), JSON.stringify(addonItem?.notes))
  ok('套餐内容被写进说明', (addonItem?.notes || []).some((n) => n.startsWith('含 ')), JSON.stringify(addonItem?.notes))

  // 联系方式 / 页脚：不传就跟着设置走，传空串就是「真的不要这一行」。
  // 导出抽屉里把输入框清空后走的就是后面这条 —— 预览和真下载都得是同一个结果。
  const settings = await api('GET', '/api/settings')
  const settingModel = await api('GET', '/api/pricebook/export-model')
  ok('不传 contact 时用设置里的联系方式', settingModel.body.contact === settings.body.contact, `${JSON.stringify(settingModel.body.contact)} vs ${JSON.stringify(settings.body.contact)}`)
  const blankModel = await api('GET', '/api/pricebook/export-model?contact=&footer=')
  ok('contact 传空串就是真的清掉（不是回落到设置）', blankModel.body.contact === '', JSON.stringify(blankModel.body.contact))
  ok('footer 传空串也真的清掉', blankModel.body.footer === '', JSON.stringify(blankModel.body.footer))

  // 按游戏拆开：单独导一个游戏，不能混进别的游戏
  const gameKeys = (r.body.gameOptions || []).filter((g) => g.key)
  if (gameKeys.length) {
    const only = gameKeys[0]
    const one = await api('GET', `/api/pricebook/export-model?game_id=${only.key}`)
    const names = [...new Set((one.body.groups || []).map((g) => g.gameName))]
    ok('单独导出的那份不含别的游戏', names.length <= 1, names.join(' / '))
    ok('单独导出只统计这个游戏的服务项', one.body.totalServices === only.count, `${one.body.totalServices} vs ${only.count}`)
  } else {
    ok('单独导出的那份不含别的游戏', true, '(只有一个游戏)')
    ok('单独导出只统计这个游戏的服务项', true, '(只有一个游戏)')
  }

  // Word 文档
  const docRes = await fetch(`${BASE}/api/pricebook/export.docx`, { headers: cookie ? { cookie } : {} })
  ok('docx 返回 200', docRes.status === 200, String(docRes.status))
  ok('docx MIME 正确', (docRes.headers.get('content-type') || '').includes('wordprocessingml'), docRes.headers.get('content-type'))
  ok('docx 带中文文件名', (docRes.headers.get('content-disposition') || '').includes("filename*=UTF-8''"))
  const docBuf = Buffer.from(await docRes.arrayBuffer())
  ok('docx 是合法 ZIP（PK 头）', docBuf[0] === 0x50 && docBuf[1] === 0x4b && docBuf[2] === 0x03 && docBuf[3] === 0x04)
  ok('docx 有实际内容', docBuf.length > 1200, `${docBuf.length} bytes`)

  const readZip = (b) => {
    let eocd = -1
    for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    if (eocd < 0) return null
    const count = b.readUInt16LE(eocd + 10)
    let off = b.readUInt32LE(eocd + 16)
    const out = []
    for (let i = 0; i < count; i++) {
      const nameLen = b.readUInt16LE(off + 28)
      const extraLen = b.readUInt16LE(off + 30)
      const commentLen = b.readUInt16LE(off + 32)
      const method = b.readUInt16LE(off + 10)
      const compSize = b.readUInt32LE(off + 20)
      const localOff = b.readUInt32LE(off + 42)
      const name = b.slice(off + 46, off + 46 + nameLen).toString('utf8')
      const dataStart = localOff + 30 + b.readUInt16LE(localOff + 26) + b.readUInt16LE(localOff + 28)
      const raw = b.slice(dataStart, dataStart + compSize)
      out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw })
      off += 46 + nameLen + extraLen + commentLen
    }
    return out
  }
  const parts = readZip(docBuf)
  ok(
    'docx 三个必需部件都在',
    ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'].every((n) => parts?.some((e) => e.name === n)),
    (parts || []).map((e) => e.name).join(', ')
  )
  const docXml = parts?.find((e) => e.name === 'word/document.xml')?.data.toString('utf8') || ''
  ok('document.xml 是合法 XML', docXml.startsWith('<?xml') && docXml.includes('<w:document ') && docXml.includes('</w:document>'))
  ok('XML 转义正确（无裸 &）', !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(docXml))
  const docTexts = [...docXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])
  ok('文档里有服务名', docTexts.includes('每日委托'), docTexts.slice(0, 8).join(' | '))
  ok('文档里有价格文本', docTexts.some((t) => t.startsWith('¥')))
  ok('Word 里不再有底纹色块', !docXml.includes('<w:shd'), docXml.slice(docXml.indexOf('<w:shd'), docXml.indexOf('<w:shd') + 80))
  ok('Word 里不再有点线引导符', !docXml.includes('w:leader="dot"'))

  // Excel 表格
  const xlsRes = await fetch(`${BASE}/api/pricebook/export.xlsx`, { headers: cookie ? { cookie } : {} })
  ok('xlsx 返回 200', xlsRes.status === 200, String(xlsRes.status))
  ok('xlsx MIME 正确', (xlsRes.headers.get('content-type') || '').includes('spreadsheetml.sheet'), xlsRes.headers.get('content-type'))
  ok('xlsx 带中文文件名', (xlsRes.headers.get('content-disposition') || '').includes("filename*=UTF-8''"), xlsRes.headers.get('content-disposition'))
  const xlsBuf = Buffer.from(await xlsRes.arrayBuffer())
  ok('xlsx 是合法 ZIP（PK 头）', xlsBuf[0] === 0x50 && xlsBuf[1] === 0x4b && xlsBuf[2] === 0x03 && xlsBuf[3] === 0x04)
  ok('xlsx 有实际内容', xlsBuf.length > 1200, `${xlsBuf.length} bytes`)

  const xlsParts = readZip(xlsBuf) || []
  const needParts = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']
  ok('xlsx 必需部件都在', needParts.every((n) => xlsParts.some((e) => e.name === n)), xlsParts.map((e) => e.name).join(', '))
  const partText = (name) => xlsParts.find((e) => e.name === name)?.data.toString('utf8') || ''
  const wbXml = partText('xl/workbook.xml')
  const sheetAll = xlsParts
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .map((e) => e.data.toString('utf8'))
    .join('\n')
  ok('工作簿声明了工作表', /<sheet name="[^"]+" sheetId="1"/.test(wbXml), wbXml.slice(0, 200))
  ok('Excel 表头是这十列', ['大类', '服务项目', '单位', '起订', '档位', '单价(元)', '可得货币', '可得数量', '说明'].every((t) => sheetAll.includes(t)))
  ok('工作表里有服务名', sheetAll.includes('每日委托'))
  ok('单价是能算数的真数字（不是「¥」文本）', /<c r="F\d+" s="2"><v>[\d.]+<\/v><\/c>/.test(sheetAll), (sheetAll.match(/<c r="F\d+"[^>]*>[^<]*<v>[^<]*<\/v>/) || [''])[0])
  ok('首行是冻结的', sheetAll.includes('state="frozen"'))
  ok('开了自动筛选', sheetAll.includes('<autoFilter '))
  ok('工作表是合法 XML', sheetAll.startsWith('<?xml') && sheetAll.includes('</worksheet>'))
  const styleColors = [...partText('xl/styles.xml').matchAll(/rgb="([0-9A-Fa-f]{6,8})"/g)].map((m) => m[1])
  ok('Excel 调色板是纯灰阶', styleColors.length > 0 && styleColors.every(isNeutral), styleColors.join(', '))
  ok('Excel 里没有底纹填充（只有 none / gray125）', (partText('xl/styles.xml').match(/patternType="([a-z0-9]+)"/g) || []).join(',') === 'patternType="none",patternType="gray125"')

  /* 通用项（没绑游戏的服务项）单独一份导出：
     「每个游戏各出一份」里那份通用表是照 generic=1 单独取模型的 ——
     以前是拿整份模型顶替，文件名写着通用、内容却是所有游戏拼在一起的。 */
  const genCat = await api('POST', '/api/categories/append', { name: '冒烟通用大类' })
  const genSvc = await api('POST', '/api/services/append', { name: '冒烟通用服务项', category_id: genCat.body.id, base_price: 6 })
  ok('建得出通用大类 / 通用服务项', genCat.status === 200 && genSvc.status === 200, `${genCat.status}/${genSvc.status}`)

  const genModel = await api('GET', '/api/pricebook/export-model?generic=1')
  const genNames = (genModel.body.groups || []).flatMap((g) => (g.items || []).map((i) => i.name))
  ok('generic=1 里只有通用服务项', genNames.includes('冒烟通用服务项') && !genNames.includes('每日委托'), genNames.join(' / '))
  ok('generic=1 的每个大类都不挂游戏', (genModel.body.groups || []).every((g) => !g.gameName), JSON.stringify((genModel.body.groups || []).map((g) => g.gameName)))
  ok('generic=1 的抬头写的是通用', genModel.body.subtitle === '未指定游戏的通用项', genModel.body.subtitle)
  ok('generic=1 不会把某个游戏的提示顶到最上面', !genModel.body.notice, JSON.stringify(genModel.body.notice))
  ok(
    'generic=1 的可导出目标只剩通用那一项',
    (genModel.body.gameOptions || []).length === 1 && genModel.body.gameOptions[0].key === '',
    JSON.stringify(genModel.body.gameOptions)
  )

  const genRes = await fetch(`${BASE}/api/pricebook/export.docx?generic=1`, { headers: cookie ? { cookie } : {} })
  const genXml =
    readZip(Buffer.from(await genRes.arrayBuffer()))
      ?.find((e) => e.name === 'word/document.xml')
      ?.data.toString('utf8') || ''
  const genTexts = [...genXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])
  ok('通用 Word 里也只有通用服务项', genTexts.includes('冒烟通用服务项') && !genTexts.includes('每日委托'), genTexts.join(' | ').slice(0, 200))

  await api('DELETE', `/api/services/${genSvc.body.id}?hard=1`)
  await api('DELETE', `/api/categories/${genCat.body.id}?hard=1`)
  const genAfter = await api('GET', '/api/pricebook/export-model?generic=1')
  ok('通用项用完清理干净', (genAfter.body.groups || []).length === 0, JSON.stringify((genAfter.body.groups || []).map((g) => g.name)))

  /* 公告：每个游戏一条，导出时放在最上方（图片和 Word 共用一个模型） */
  const NOTICE = '冒烟测试公告：周一到周五下单送一天'
  r = await api('PATCH', `/api/games/${gameId}`, { notice: NOTICE })
  ok('游戏能存公告', r.body.notice === NOTICE, r.body.notice)

  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  ok('单游戏导出把公告取到了', r.body.notice === NOTICE, r.body.notice)
  ok('游戏提示提到最上方后，大类上就不再重复', (r.body.groups || []).every((g) => !g.gameNotice))

  const noticeRes = await fetch(`${BASE}/api/pricebook/export.docx?game_id=${gameId}`, {
    headers: cookie ? { cookie } : {},
  })
  const noticeXml =
    readZip(Buffer.from(await noticeRes.arrayBuffer()))
      ?.find((e) => e.name === 'word/document.xml')
      ?.data.toString('utf8') || ''
  const noticeTexts = [...noticeXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])
  const iNotice = noticeTexts.indexOf(NOTICE)
  const iFirstCat = noticeTexts.indexOf('日常')
  ok('docx 里不再出现「公告」两个字', !noticeTexts.includes('公告'), noticeTexts.slice(0, 8).join(' | '))
  ok('docx 里公告正文排在第一个大类之前', iNotice >= 0 && iFirstCat > iNotice, `正文@${iNotice} 大类@${iFirstCat}`)
  ok('公告段落只有一条细灰竖线，没有底纹', isNoticeBox(noticeXml, NOTICE), paragraphOf(noticeXml, NOTICE).slice(0, 200))

  // 清空之后不能有残留（老游戏的 notice 默认是空串）
  await api('PATCH', `/api/games/${gameId}`, { notice: '' })
  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  ok('公告清空后导出里就没有了', !r.body.notice && (r.body.groups || []).every((g) => !g.gameNotice), r.body.notice)

  /* 大类提示：排在这个大类的名字下面、服务项上面 */
  const CAT_NOTICE = '大类提示冒烟：按层数计价，10 层起接'
  r = await api('PATCH', `/api/categories/${catId}`, { notice: CAT_NOTICE })
  ok('大类能存提示', r.body.notice === CAT_NOTICE, r.body.notice)

  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const catGroup = (r.body.groups || []).find((g) => g.name === '日常')
  ok('导出模型里大类带上了自己的提示', catGroup?.catNotice === CAT_NOTICE, catGroup?.catNotice)
  ok('大类提示和游戏提示是两个字段', catGroup?.gameNotice === '', JSON.stringify(catGroup?.gameNotice))

  const catRes = await fetch(`${BASE}/api/pricebook/export.docx?game_id=${gameId}`, {
    headers: cookie ? { cookie } : {},
  })
  const catXml =
    readZip(Buffer.from(await catRes.arrayBuffer()))
      ?.find((e) => e.name === 'word/document.xml')
      ?.data.toString('utf8') || ''
  const catTexts = [...catXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])
  const iCat = catTexts.indexOf('日常')
  const iCatNotice = catTexts.indexOf(CAT_NOTICE)
  const iItem = catTexts.indexOf('每日委托')
  ok(
    'docx 里大类提示排在大类名之后、服务项之前',
    iCat >= 0 && iCatNotice > iCat && iItem > iCatNotice,
    `大类@${iCat} 提示@${iCatNotice} 服务项@${iItem}`
  )
  ok('大类提示也只有细灰竖线，没有底纹', isNoticeBox(catXml, CAT_NOTICE), paragraphOf(catXml, CAT_NOTICE).slice(0, 200))
  ok('docx 里同样不出现「公告」两个字', !catTexts.includes('公告'))

  await api('PATCH', `/api/categories/${catId}`, { notice: '' })
  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  ok('大类提示清空后导出里就没有了', (r.body.groups || []).every((g) => !g.catNotice))

  /* 游戏货币：名字配在游戏上，数量配在服务项上 */
  r = await api('PATCH', `/api/games/${gameId}`, { currency: '原石' })
  ok('游戏能存货币名', r.body.currency === '原石', r.body.currency)

  const m0 = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const firstName = (m0.body.groups || []).flatMap((g) => g.items)[0]?.name
  const svcList = await api('GET', '/api/services?limit=600')
  const target = (svcList.body.items || []).find((s) => s.name === firstName)
  ok('找得到一个能改的服务项', Boolean(target), firstName)

  r = await api('PATCH', `/api/services/${target.id}`, { currency_amount: 200 })
  ok('服务项能存可获得数量', Number(r.body.currency_amount) === 200, r.body.currency_amount)

  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const withGain = (r.body.groups || []).flatMap((g) => g.items).find((i) => i.name === firstName)
  ok('导出模型里带上「可得 原石 200」', withGain?.gain === '可得 原石 200', withGain?.gain)

  const gainRes = await fetch(`${BASE}/api/pricebook/export.docx?game_id=${gameId}`, {
    headers: cookie ? { cookie } : {},
  })
  const gainTexts =
    readZip(Buffer.from(await gainRes.arrayBuffer()))
      ?.find((e) => e.name === 'word/document.xml')
      ?.data.toString('utf8')
      .match(/<w:t[^>]*>([^<]*)<\/w:t>/g)
      ?.map((t) => t.replace(/<[^>]+>/g, '')) || []
  ok('docx 里也有这一行', gainTexts.includes('可得 原石 200'), gainTexts.filter((t) => t.includes('可得')).join(' | '))

  /* 下单时把「可得货币」一起冻进快照 —— 和价格一个道理，之后改价格表不影响老单 */
  const custList = await api('GET', '/api/customers?limit=10')
  const custId2 = (custList.body.items || [])[0]?.id
  r = await api('POST', '/api/orders', {
    customer_id: custId2,
    game_id: gameId,
    items: [{ service_id: target.id, quantity: 2 }],
  })
  ok('能下单（为了验货币快照）', r.status === 200 && r.body.id > 0, `${r.status}`)
  const od = await api('GET', `/api/orders/${r.body.id}`)
  const odItem = (od.body.items || [])[0]
  ok(
    '订单明细快照冻住了「可得货币」（存的是每个的数量）',
    odItem?.snapshot?.gain?.name === '原石' && Number(odItem?.snapshot?.gain?.amount) === 200,
    JSON.stringify(odItem?.snapshot?.gain)
  )
  ok('数量也冻住了（前端按数量翻倍显示）', Number(odItem?.quantity) === 2, odItem?.quantity)
  await api('DELETE', `/api/orders/${r.body.id}?force=1`)
  const afterDel = await api('GET', '/api/orders?limit=300&status=all')
  ok('验货币用的测试单已清理', !(afterDel.body.items || []).some((o) => o.id === r.body.id))

  // 游戏没配货币名 → 光有数量也不显示（免得出现一个没有单位的数字）
  await api('PATCH', `/api/games/${gameId}`, { currency: '' })
  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const noName = (r.body.groups || []).flatMap((g) => g.items).find((i) => i.name === firstName)
  ok('游戏没配货币名时不显示那个数', noName?.gain === '', JSON.stringify(noName?.gain))

  // 数量留空 → 也不显示
  await api('PATCH', `/api/games/${gameId}`, { currency: '原石' })
  await api('PATCH', `/api/services/${target.id}`, { currency_amount: null })
  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const noAmt = (r.body.groups || []).flatMap((g) => g.items).find((i) => i.name === firstName)
  ok('数量留空时不显示', noAmt?.gain === '', JSON.stringify(noAmt?.gain))

  // 收尾：别把货币名留给后面的用例
  await api('PATCH', `/api/games/${gameId}`, { currency: '' })

  /* ---------- 价格表 / 导出的逻辑修正 ---------- */
  section('价格表 · 逻辑修正')

  // 数字 / 数组列收到空白：'' 和只敲空格都算没填。声明了默认值的要用默认值，
  // 不然 min_qty 会被存成 0（导出里的「起订 N」就没了），json 列会存成字符串 '""'。
  r = await api('POST', '/api/services/append', {
    name: '冒烟空白字段',
    category_id: catId,
    game_id: gameId,
    base_price: 3,
    min_qty: '',
    max_qty: ' ',
    package_items: '',
  })
  ok('起订量留空存成默认的 1（不是 0）', Number(r.body.min_qty) === 1, r.body.min_qty)
  ok('封顶量只敲空格当成没填（NULL）', r.body.max_qty === null, JSON.stringify(r.body.max_qty))
  ok('套餐内容给空串存成空数组（不是字符串）', Array.isArray(r.body.package_items) && r.body.package_items.length === 0, JSON.stringify(r.body.package_items))
  const svcBlank = r.body.id
  r = await api('GET', '/api/services?q=冒烟空白字段')
  ok('列表里读回来也还是数组', Array.isArray(r.body.items?.[0]?.package_items), JSON.stringify(r.body.items?.[0]?.package_items))
  await api('DELETE', `/api/services/${svcBlank}?hard=1`)

  // 增项计数只数在架的：归档一个之后价格表里只剩 1 个，列表不能还说 2 个
  const cntSvc = await api('POST', '/api/services/append', { name: '冒烟计数服务项', category_id: catId, game_id: gameId, base_price: 5 })
  const cntOpt1 = await api('POST', '/api/options', { service_id: cntSvc.body.id, name: '冒烟增项甲', price: 1 })
  const cntOpt2 = await api('POST', '/api/options', { service_id: cntSvc.body.id, name: '冒烟增项乙', price: 2 })
  r = await api('GET', '/api/services?q=冒烟计数服务项')
  ok('两个增项时列表说 2 个', r.body.items?.[0]?.option_count === 2, r.body.items?.[0]?.option_count)
  await api('DELETE', `/api/options/${cntOpt2.body.id}`)
  r = await api('GET', '/api/services?q=冒烟计数服务项')
  ok('归档一个之后列表说 1 个（不是 2 个）', r.body.items?.[0]?.option_count === 1, r.body.items?.[0]?.option_count)
  r = await api('GET', '/api/pricebook')
  const cntBook = (r.body.categories || []).flatMap((c) => c.services || []).find((s) => s.name === '冒烟计数服务项')
  ok('价格表里也只剩 1 个增项', (cntBook?.options || []).filter((o) => String(o.name).startsWith('冒烟增项')).length === 1, JSON.stringify((cntBook?.options || []).map((o) => o.name)))
  await api('DELETE', `/api/options/${cntOpt1.body.id}?hard=1`)
  await api('DELETE', `/api/services/${cntSvc.body.id}?hard=1`)

  // bool 筛选：?is_daily=false 得真能筛出「否」的那些
  //（以前拿字符串去比整数列，SQLite 一条都匹配不上，看着像「没有这样的数据」）
  const flagSvc = await api('POST', '/api/services/append', { name: '冒烟非每日', category_id: catId, game_id: gameId, base_price: 5, is_daily: 0 })
  r = await api('GET', '/api/services?is_daily=false&limit=300')
  ok(
    '?is_daily=false 能筛出「否」的服务项',
    (r.body.items || []).length > 0 && (r.body.items || []).every((s) => s.is_daily === false),
    `n=${(r.body.items || []).length}`
  )
  ok('筛出来的里面有刚建的那条', (r.body.items || []).some((s) => s.id === flagSvc.body.id))
  await api('DELETE', `/api/services/${flagSvc.body.id}?hard=1`)

  // 阶梯价：数量比所有档的起量都小 → 按最低那一档算。
  // 以前会掉回基准价，而基准价填 0 的服务项就这么算出了 ¥0（白干一单）。
  const lowSvc = await api('POST', '/api/services/append', {
    name: '冒烟低于起量',
    category_id: catId,
    game_id: gameId,
    price_type: 'per_unit',
    unit_label: '层',
    base_price: 0,
    min_qty: 5,
  })
  await api('POST', `/api/services/${lowSvc.body.id}/tiers`, { min_qty: 5, max_qty: 10, unit_price: 9 })
  r = await api('POST', '/api/quotes/preview', { items: [{ service_id: lowSvc.body.id, quantity: 2 }] })
  ok('数量低于第一档起量时按第一档算（不是 ¥0）', r.body.total === 18, `total=${r.body.total}`)
  r = await api('POST', '/api/quotes/preview', { items: [{ service_id: lowSvc.body.id, quantity: 6 }] })
  ok('落在档里还是按档算', r.body.total === 54, `total=${r.body.total}`)

  // 不限上界的那一档要写「以上」：只写「11层」会被读成「就是 11 层」
  await api('POST', `/api/services/${lowSvc.body.id}/tiers`, { min_qty: 11, max_qty: null, unit_price: 7 })
  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const openTier = (r.body.groups || []).flatMap((g) => g.items).find((i) => i.name === '冒烟低于起量')
  ok('不限上界的档写成「11层以上」', (openTier?.tierLines || []).some((t) => String(t).startsWith('11层以上')), JSON.stringify(openTier?.tierLines))
  await api('DELETE', `/api/services/${lowSvc.body.id}?hard=1`)

  // 归档游戏的整节价格不能从导出里消失（价格表页面照常显示它们）
  const agGame = await api('POST', '/api/games', { name: '冒烟归档游戏', currency: '冒烟币' })
  const agCat = await api('POST', '/api/categories/append', { name: '冒烟归档大类', game_id: agGame.body.id })
  const agSvc = await api('POST', '/api/services/append', {
    name: '冒烟归档服务项',
    category_id: agCat.body.id,
    game_id: agGame.body.id,
    base_price: 12,
    currency_amount: 3,
  })
  await api('PATCH', `/api/games/${agGame.body.id}`, { status: 'archived' })

  r = await api('GET', '/api/pricebook/export-model?full=1')
  const agGroup = (r.body.groups || []).find((g) => g.name === '冒烟归档大类')
  ok('归档游戏的大类照样导出（不再整节消失）', Boolean(agGroup), JSON.stringify((r.body.groups || []).map((g) => g.name)))
  ok('归档游戏那一节带着游戏名', agGroup?.gameName === '冒烟归档游戏', agGroup?.gameName)
  ok('归档游戏的服务项也在里面', (r.body.groups || []).flatMap((g) => g.items).some((i) => i.name === '冒烟归档服务项'))
  const agSum = (r.body.groups || []).reduce((n, g) => n + g.total, 0)
  ok('各节的项数之和 = totalServices（数字和正文对得上）', agSum === r.body.totalServices, `${agSum} vs ${r.body.totalServices}`)
  ok(
    '没展开的项数 = 总数 − 真正排进去的',
    r.body.hiddenServices === r.body.totalServices - r.body.itemCount,
    JSON.stringify({ hidden: r.body.hiddenServices, total: r.body.totalServices, items: r.body.itemCount })
  )
  ok(
    'gameOptions 各项数量之和也等于 totalServices',
    (r.body.gameOptions || []).reduce((n, g) => n + g.count, 0) === r.body.totalServices,
    JSON.stringify(r.body.gameOptions)
  )

  // 单独导这一份（归档游戏）：抬头和货币名都得有
  const agOne = await api('GET', `/api/pricebook/export-model?game_id=${agGame.body.id}`)
  ok('按归档游戏导出的那一份有抬头', agOne.body.subtitle === '冒烟归档游戏', agOne.body.subtitle)
  ok(
    '那一份里的货币名没丢',
    (agOne.body.groups || []).flatMap((g) => g.items).some((i) => i.gain === '可得 冒烟币 3'),
    JSON.stringify((agOne.body.groups || []).flatMap((g) => g.items).map((i) => i.gain))
  )
  ok('归档游戏的这一份也把项数算全了', agOne.body.totalServices === 1, agOne.body.totalServices)

  // 价格表也要认得归档游戏的货币名：组标题和服务行上的「可得」都靠它
  r = await api('GET', '/api/pricebook?status=all')
  const agCatRow = (r.body.categories || []).find((c) => c.name === '冒烟归档大类')
  ok('价格表里归档游戏的大类带着货币名', agCatRow?.game_currency === '冒烟币', JSON.stringify(agCatRow?.game_currency))
  ok('它下面的服务项也带着货币名', agCatRow?.services?.[0]?.game_currency === '冒烟币', JSON.stringify(agCatRow?.services?.[0]?.game_currency))

  // 收尾：先删子记录再彻底删游戏，别给后面的用例留一个多余的游戏
  await api('DELETE', `/api/services/${agSvc.body.id}?hard=1`)
  await api('DELETE', `/api/categories/${agCat.body.id}?hard=1`)
  await api('DELETE', `/api/games/${agGame.body.id}?hard=1`)

  /* ---------- 财务 ---------- */
  section('财务')
  r = await api('GET', '/api/finance/summary?from=2020-01-01&to=2099-01-01')
  ok('财务汇总：订单额 820', r.body.totals?.order_total === 820, r.body.totals)
  ok('财务汇总：总收 370 / 退款 50 / 净收 320', r.body.totals?.received === 370 && r.body.totals?.refunded === 50 && r.body.totals?.net_received === 320, r.body.totals)
  ok('财务汇总：应收余额 500', r.body.totals?.due_total === 500, r.body.totals)
  ok('应收列表有未结清的单', r.body.receivables?.length >= 1, r.body.receivables?.length)
  ok('按支付方式分组', Array.isArray(r.body.by_method) && r.body.by_method.length >= 2, r.body.by_method)
  ok('按游戏分组', Array.isArray(r.body.by_game) && r.body.by_game[0]?.game_name === '原神', r.body.by_game)
  ok('按日序列非空', Array.isArray(r.body.daily) && r.body.daily.length > 2, r.body.daily?.length)

  /* ---------- 看板 / 搜索 ---------- */
  section('看板与搜索')
  r = await api('GET', '/api/dashboard')
  ok('看板统计各状态', typeof r.body.counts?.pending_confirm === 'number', r.body.counts)
  ok('看板有待收款单', r.body.unpaid_orders?.length >= 1, r.body.unpaid_orders?.length)
  ok('看板有进行中调度列表', Array.isArray(r.body.open_orders), r.body.open_orders?.length)
  ok('看板带本月利润', typeof r.body.month_money?.profit === 'number', r.body.month_money)

  r = await api('GET', '/api/search?q=小王')
  ok('搜客户命中', r.body.customers?.length === 1, r.body.customers)
  r = await api('GET', '/api/search?q=每日委托')
  ok('搜服务命中', r.body.services?.length >= 1, r.body.services)

  /* ---------- 上传 / 排序 / 归档 ---------- */
  section('上传 · 排序 · 归档')
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  r = await api('POST', '/api/uploads', { data_url: png, prefix: 'icon' })
  ok('上传图片返回可访问路径', r.status === 200 && r.body.url?.startsWith('/uploads/'), r.body)
  if (r.body.url) {
    const img = await fetch(BASE + r.body.url)
    ok('上传的图片能取回', img.status === 200 && img.headers.get('content-type') === 'image/png', img.status)
  }
  r = await api('POST', '/api/uploads', { data_url: 'data:text/html;base64,PHNjcmlwdD4=' })
  ok('非图片上传被拒', r.status === 400, r.body)

  r = await api('POST', '/api/games', { name: '绝区零' })
  const game3 = r.body.id
  r = await api('POST', '/api/reorder/games', { ids: [game3, gameId, game2] })
  ok('拖拽排序成功', r.body.count === 3, r.body)
  r = await api('GET', '/api/games')
  ok('排序生效', r.body.items?.[0]?.name === '绝区零', r.body.items?.map((g) => g.name))

  /**
   * 大类和服务项的排序（界面上是拖拽把手，接口是同一个）。
   *
   * 这里只验**接口**这一层：ids 的顺序真的落成 sort_order、读回来顺序跟着变。
   * 「拖到哪儿」那段算法在 `client/lib/sortable.js` 里，下面单独有一节测它 ——
   * 那才是最容易错的地方（先删后插的下标位移），而且是纯函数，好测。
   */
  section('排序：大类与服务项')
  r = await api('POST', '/api/categories', { game_id: gameId, name: '排序甲' })
  const sortCatA = r.body.id
  r = await api('POST', '/api/categories', { game_id: gameId, name: '排序乙' })
  const sortCatB = r.body.id
  r = await api('POST', '/api/reorder/categories', { ids: [sortCatB, sortCatA] })
  ok('大类排序接口返回条数', r.body.count === 2, r.body)
  r = await api('GET', `/api/categories?game_id=${gameId}`)
  const catOrder = (r.body.items || []).map((c) => c.id)
  ok('大类顺序按 ids 落库', catOrder.indexOf(sortCatB) < catOrder.indexOf(sortCatA), catOrder)

  // 服务项：排完读回来，同一个大类里顺序要跟着变
  r = await api('POST', '/api/services', { category_id: sortCatA, game_id: gameId, name: '排序服务甲', price_type: 'fixed', base_price: 10 })
  const sortSvcA = r.body.id
  r = await api('POST', '/api/services', { category_id: sortCatA, game_id: gameId, name: '排序服务乙', price_type: 'fixed', base_price: 20 })
  const sortSvcB = r.body.id
  r = await api('POST', '/api/reorder/services', { ids: [sortSvcB, sortSvcA] })
  ok('服务项排序接口返回条数', r.body.count === 2, r.body)
  r = await api('GET', `/api/services?category_id=${sortCatA}`)
  const svcOrder = (r.body.items || []).map((s) => s.id)
  ok('服务项顺序按 ids 落库', svcOrder.indexOf(sortSvcB) < svcOrder.indexOf(sortSvcA), svcOrder)

  // 排序不会顺手改别的东西 —— 价格、大类归属、别名都得不受影响
  r = await api('GET', `/api/services/${sortSvcA}`)
  ok('排序没动价格和归属',
    Number(r.body.base_price) === 10 && r.body.category_id === sortCatA,
    { price: r.body.base_price, category: r.body.category_id })

  r = await api('POST', '/api/reorder/nonsense', { ids: [1] })
  ok('不认识的对象被拒', r.status === 400, r.body)
  r = await api('POST', '/api/reorder/services', { ids: [] })
  ok('空 ids 被拒', r.status === 400, r.body)

  // 收摊：这几条是刚造的，不删掉会把下面「游戏用量统计」的数字顶高。
  // `hard` 是 **query 参数**（`?hard=1`），不是 body —— 不传就是「归档」，
  // 归档的照样被用量统计数进去。
  await api('DELETE', `/api/services/${sortSvcA}?hard=1`)
  await api('DELETE', `/api/services/${sortSvcB}?hard=1`)
  await api('DELETE', `/api/categories/${sortCatA}?hard=1`)
  await api('DELETE', `/api/categories/${sortCatB}?hard=1`)
  r = await api('GET', `/api/services?category_id=${sortCatA}`)
  ok('收摊干净了（不然后面的用例会被这几条污染）', (r.body.items || []).length === 0, r.body.items?.length)

  r = await api('GET', `/api/games/${gameId}/usage`)
  ok('游戏用量统计（2 个服务 / 2 张单）', r.body.services === 2 && r.body.orders === 2, r.body)

  r = await api('DELETE', `/api/games/${game3}`)
  ok('删除游戏=归档', r.body.archived === true, r.body)
  r = await api('GET', '/api/games')
  ok('归档的游戏状态是 archived', r.body.items?.find((g) => g.id === game3)?.status === 'archived', r.body.items?.map((g) => [g.name, g.status]))
  r = await api('GET', '/api/games?status=active')
  ok('按上架状态筛选', r.body.items?.every((g) => g.status === 'active'), r.body.items?.map((g) => g.status))

  /* ---------- 删除保护 / 备份 ---------- */
  section('删除保护与备份')
  r = await api('DELETE', `/api/orders/${orderId}`)
  ok('收过款的订单不允许直接删', r.status === 400 && r.body.code === 'has_payments', r.body)

  r = await api('GET', '/api/backup/export')
  ok('导出备份包含各表', r.body.data?.orders?.length === 2 && r.body.data?.credentials?.length === 1, r.body.counts)
  ok('备份说明里提示密文', String(r.body.note).includes('密文'), r.body.note)

  r = await api('POST', '/api/backup/import', { payload: r.body })
  ok('导入需要确认', r.status === 400 && r.body.code === 'need_confirm', r.body)

  /* ---------- 整包备份（数据库 + 上传文件 → tar.gz） ---------- */
  // 截图会留在时间线上，图片就成了业务数据的一部分，只导 JSON 不再算完整备份。
  // 这里守住「压缩包真的生成了、头对了、上传件真的进去了」。
  {
    const anon = await fetch(`${BASE}/api/backup/archive`)
    ok('未登录不给下载整包备份', anon.status === 401, anon.status)

    const res = await fetch(`${BASE}/api/backup/archive`, { headers: { cookie } })
    const buf = Buffer.from(await res.arrayBuffer())
    ok('整包备份返回 gzip', res.status === 200 && buf[0] === 0x1f && buf[1] === 0x8b, `${res.status} magic=${buf.subarray(0, 2).toString('hex')}`)
    ok('整包备份的内容类型是 gzip', String(res.headers.get('content-type')).includes('gzip'), res.headers.get('content-type'))
    // 中文文件名必须走 RFC 5987 的 filename*，只写 filename= 会被浏览器丢成乱码
    const disp = String(res.headers.get('content-disposition') || '')
    ok('下载头带 filename*（中文文件名）', disp.includes("filename*=UTF-8''") && disp.includes('.tar.gz'), disp)
    ok('整包备份不允许缓存', String(res.headers.get('cache-control')).includes('no-store'), res.headers.get('cache-control'))

    // 解开看一眼：必须有 console.db，而且之前上传的那张图也要在
    const entries = tarEntries(zlib.gunzipSync(buf))
    ok('归档里有数据库快照', entries.includes('backup/console.db'), entries)
    ok('归档里有上传的图片', entries.some((n) => n.startsWith('backup/uploads/') && n.endsWith('.png')), entries)
    ok('归档里有还原说明', entries.includes('backup/README.txt'), entries)

    // 快照要能被 SQLite 当数据库打开 —— 「拷了个坏文件」也算备份的话就没意义了
    const snap = tarRead(zlib.gunzipSync(buf), 'backup/console.db')
    ok('快照是合法 SQLite 文件', snap && snap.subarray(0, 15).toString('latin1') === 'SQLite format 3', snap ? snap.subarray(0, 16).toString('latin1') : 'missing')
  }

  /* ---------- 设置 / 改密 ---------- */
  section('设置与改密')
  r = await api('PATCH', '/api/settings', { business_name: '小枫代肝', contact: '微信 xiaofeng', evil_key: 'x' })
  ok('保存设置', r.body.business_name === '小枫代肝', r.body)
  ok('未声明的设置键被忽略', r.body.evil_key === undefined, Object.keys(r.body))

  r = await api('POST', '/api/vault/password', { current: 'Vault-Secret-2024', next: 'NewVaultPass-99' })
  ok('改保险箱密码并重加密', r.body.ok === true && r.body.reencrypted === 1, r.body)
  r = await api('POST', `/api/credentials/${credId}/reveal`, { action: 'view' })
  ok('改密后旧密文仍能解开', r.body.secret?.password === 'SuperSecret123', r.body.secret)

  /* ---------- Python 视觉后端（屏幕识别那一层） ---------- */
  section('屏幕识别 · Python 视觉后端')
  r = await api('GET', '/api/ocr/status')
  ok('OCR 状态里带后端快照', r.status === 200 && r.body.backend && typeof r.body.backend === 'object', Object.keys(r.body || {}))
  ok('后端快照说得出它排第几', r.body.engines?.[0]?.id === 'python', (r.body.engines || []).map((e) => e.id))
  ok('后端快照带 url 和 venv 路径', Boolean(r.body.backend.url) && Boolean(r.body.backend.venv?.path), r.body.backend)

  r = await api('GET', '/api/ocr/backend')
  ok('后端详情能拿到', r.status === 200 && Boolean(r.body.deps), r.body)
  ok('依赖清单文件在位', r.body.deps?.requirements?.exists === true, r.body.deps?.requirements)
  ok('给了手动安装命令', (r.body.deps?.install?.commands || []).length >= 1, r.body.deps?.install)
  ok('日志接口可用', r.body.log_tail && Array.isArray(r.body.log_tail.lines), r.body.log_tail)

  r = await api('GET', '/api/ocr/backend/install/status', undefined)
  ok('不存在的安装任务被识别', r.body.status === 'missing', r.body)

  // 自检：这台机器上装了依赖就必须通过；没装就得给一句能照做的失败原因，
  // 不能是 500。测试实例的 venv 在临时数据目录里，所以两种都算过。
  r = await api('POST', '/api/ocr/backend/health')
  ok('自检要么通过、要么说清楚为什么不行', r.status === 200 || (r.status === 400 && Boolean(r.body.code)), r.body)
  if (r.status === 200) ok('自检报告了每一步', Array.isArray(r.body.steps) && r.body.steps.length >= 3, r.body.steps)

  r = await api('POST', '/api/ocr/backend/stop')
  ok('停后端不报错（没在跑也算停好了）', r.status === 200, r.body)

  // 认完之后把前台还给浏览器那一步。没有可返回的窗口（还没识别过、或不在 Windows）
  // 必须当成功返回：它是省一次 Alt+Tab 的便利步骤，不该让流程看起来失败。
  r = await api('POST', '/api/ocr/screen/return')
  ok('没有可返回的窗口时不算失败', r.status === 200 && r.body.ok === true, r.body)

  /* ---------- 「识别画面」一次只能跑一条 ----------
     整条流程靠 game-window.mjs 里那两个**进程级**变量（activeWindow /
     previousWindow）串起来，而每个订单、每个游戏、每个标签页都能各自点
     「识别画面」。两条并发会互相抢窗口、按键打到别的游戏上，认出来的数字
     还会串到别的单上 —— 这比认不出来糟得多（认不出来用户会去核对）。

     这里守住三件事：
       · 第二条流程拿不到租约（409 screen_busy）；
       · 同一条流程重复拿 = 续期，不报错；
       · 不在任何流程里请求识别会被挡掉（409 screen_flow_gone）——
         否则流程结束后仍能抓一帧屏幕，那一帧没有归属。 */
  {
    const { beginScreenFlow, endScreenFlow, touchScreenFlow, currentScreenFlow } = await import('../../src/vision/game-window.mjs')
    // 纯函数那一层先验一轮，不依赖平台
    const a = beginScreenFlow({ id: 'smoke-flow-a', game: 'wuwa' })
    ok('第一条流程拿得到租约', a.ok === true && a.reused === false, a)
    const b = beginScreenFlow({ id: 'smoke-flow-b', game: 'nte' })
    ok('第二条流程被挡下并说清是谁在占用', b.ok === false && b.code === 'screen_busy' && b.active.id === 'smoke-flow-a', b)
    ok('被挡时的报错是能照做的人话', /上一条/.test(String(b.error)) && /识别画面/.test(String(b.error)), b.error)
    const again = beginScreenFlow({ id: 'smoke-flow-a', game: 'wuwa' })
    ok('同一条流程重复申请 = 续期，不算冲突', again.ok === true && again.reused === true, again)
    touchScreenFlow('smoke-flow-a')
    ok('续期不改占用者', currentScreenFlow()?.id === 'smoke-flow-a', currentScreenFlow())
    ok('别人拿着别的 id 解不开锁', endScreenFlow('smoke-flow-b') === false && currentScreenFlow()?.id === 'smoke-flow-a', currentScreenFlow())
    ok('自己释放得掉', endScreenFlow('smoke-flow-a') === true && currentScreenFlow() === null, currentScreenFlow())

    // HTTP 那一层：前端实际走的就是这三个接口
    r = await api('POST', '/api/ocr/screen/begin', { id: 'smoke-http-a', game: 'wuwa' })
    ok('开始一条流程', r.status === 200 && r.body.ok === true, r.body)

    r = await api('POST', '/api/ocr/screen/begin', { id: 'smoke-http-b', game: 'nte' })
    ok('第二条流程被 409 挡下（不是 500）', r.status === 409 && r.body.code === 'screen_busy', r.body)

    // 切窗口这一步也必须带当前流程的 id。不带就能切的话，任何页面（或者一条
    // 已经结束的老流程）都能把玩家正在玩的游戏窗口抢走。
    r = await api('POST', '/api/ocr/screen/focus', { game: 'wuwa' })
    ok('不在流程里不让切窗口（会抢走玩家正在玩的窗口）', r.status === 409 && r.body.code === 'screen_busy', r.body)

    r = await api('POST', '/api/ocr/screen/focus', { game: 'wuwa', flow: 'smoke-http-b' })
    ok('拿着别的流程的 id 也不让切窗口', r.status === 409 && r.body.code === 'screen_busy', r.body)

    r = await api('POST', '/api/ocr/screen/focus', { game: '异环', flow: 'smoke-http-a' })
    ok('一条流程只切它自己那个游戏', r.status === 409 && r.body.code === 'screen_game_mismatch', r.body)

    // 没配模板的游戏：不拿鸣潮的模板去认，也不切到鸣潮的窗口
    r = await api('POST', '/api/ocr/screen/focus', { game: '没配模板的游戏', flow: 'smoke-http-a' })
    ok('没配模板的游戏拒绝切窗口', r.status === 400 && r.body.code === 'game_profile_missing', r.body)
    ok('拒绝时说清现在能认哪些', /现在能认的是/.test(String(r.body.error)) && /鸣潮/.test(String(r.body.error)), r.body.error)

    r = await api('POST', '/api/ocr', { game: '没配模板的游戏', data_url: 'data:image/png;base64,iVBORw0KGgo=' })
    ok('截图识别同样拒绝没配模板的游戏', r.status === 400 && r.body.code === 'game_profile_missing', r.body)

    r = await api('POST', '/api/ocr/screen', { session: 'smoke-http-b', game: 'nte', flow: 'smoke-http-b' })
    ok('拿着别的流程的 id 去识别会被挡下', r.status === 409 && r.body.code === 'screen_busy', r.body)

    r = await api('POST', '/api/ocr/screen', { session: 'smoke-http-a', game: 'wuwa' })
    ok('不带流程 id 也挡（否则能蹭别人的租约抓一帧没归属的屏幕）', r.status === 409 && r.body.code === 'screen_busy', r.body)

    r = await api('POST', '/api/ocr/screen/shot', {})
    ok('流程正在跑时不允许抢窗口截图', r.status === 409 && r.body.code === 'screen_busy', r.body)

    r = await api('POST', '/api/ocr/screen/end', { id: 'smoke-http-a' })
    ok('释放租约', r.status === 200 && r.body.released === true, r.body)

    r = await api('POST', '/api/ocr/screen', { session: 'smoke-http-b', game: 'nte' })
    ok('没有流程在跑时拒绝识别（否则那一帧没有归属）', r.status === 409 && r.body.code === 'screen_flow_gone', r.body)

    // 截图那条也要判游戏：它是按游戏找窗口的，没配模板会切到鸣潮的窗口，
    // 截回来的是别的游戏的画面。（放这里是因为流程在跑时它会先报 screen_busy）
    r = await api('POST', '/api/ocr/screen/shot', { game: '没配模板的游戏' })
    ok('截图也拒绝没配模板的游戏（否则截的是鸣潮的窗口）', r.status === 400 && r.body.code === 'game_profile_missing', r.body)

    r = await api('POST', '/api/ocr/screen/end', { id: 'smoke-http-a' })
    ok('重复释放不报错', r.status === 200 && r.body.released === false, r.body)
  }

  /* ---------- 「识别画面」能中途停止 ----------
     以前只有组件卸载时才置 stop：用户点错了、或者发现自己选错了仓库，只能
     等两段各 8 帧全跑完（一分多钟），期间游戏窗口一直被占着。

     这里守的是**静态**约定，因为这条流程要真机和真游戏才跑得起来：
       · 界面上有「停止」按钮，点到的是 stopScreen；
       · 流程里的等待统一走 token.wake 能解开的 wait()，而不是裸 setTimeout ——
         否则点了停止还要干等 500~1400ms；
       · 停止后不是静默 return（那会让界面停在「识别中…」看着像卡死）。 */
  {
    const src = fs.readFileSync(path.join(ROOT, 'client', 'forms', 'resource-field.jsx'), 'utf8')
    ok('有「停止」按钮', /停止/.test(src) && /onClick=\{\(\) => stopScreen\(side\)\}/.test(src), '')
    ok('停止会置 stop 并解开正在等待的定时器', /token\.stop = true[\s\S]{0,200}token\.wake\(\)/.test(src), '')
    const rawSleeps = src.match(/setTimeout\(resolve\s*,/g) || []
    ok('流程里的等待不再用裸 setTimeout（sleep 统一走可打断的 wait）', rawSleeps.length === 0, `${rawSleeps.length} 处`)
    ok('停止后有交代（不是静默 return）', /已停止识别/.test(src), '')

    // 引擎状态是挂载时取的那一次。用户很可能刚在设置页装好引擎再回来点
    // 「识别画面」，所以 ocrOk=false 不能一次定终身 —— 点的时候要重新探一次。
    ok(
      '引擎状态不是一次定终身（点的时候会重新探一次）',
      /if \(ocrOk === false\) \{[\s\S]{0,400}api\.get\('\/api\/ocr\/status'\)/.test(src),
      ''
    )
    // 没配识别模板的游戏：以前静默套鸣潮的模板，认出来的数字看着像真的。
    ok('没配模板的游戏会说出来并列出能认哪些', /还没有识别模板/.test(src) && /supportedGameNames\(\)/.test(src), '')
  }

  /* ---------- 退出与登录 ---------- */
  section('退出与重新登录')
  r = await api('POST', '/api/auth/logout')
  ok('退出登录', r.body.ok === true, r.body)
  cookie = ''
  r = await api('GET', '/api/dashboard')
  ok('退出后访问被拒', r.status === 401, r.status)
  r = await api('POST', '/api/auth/login', { password: 'wrong' })
  ok('错误密码登录被拒', r.status === 400, r.body)
  r = await api('POST', '/api/auth/login', { password: 'admin-pass-8888' })
  ok('正确密码登录成功', r.body.ok === true, r.body)
  const sc = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).find((c) => c.startsWith('xfc_sid='))
  if (sc) cookie = sc.split(';')[0]
  r = await api('GET', '/api/auth/me')
  ok('重新登录后状态正常', r.body.authenticated === true, r.body)

  /* ---------- B站自动比价：解析与匹配 ----------
     这一段全是纯函数，不联网、不下视频、不 OCR —— 所以可以放进冒烟测试里跑。
     真正要联网的那条路（搜索/下载/抽帧/识别）不适合放进冒烟测试：
     它慢、依赖 B站 和登录态，而且结果会随视频更新而变。

     这里覆盖的是**从真实实拍帧里踩出来的坑**，每一条都对应一次实际误配：
     OCR 会把 `黎那汐塔` 认成 `黎娜西塔`，把声骸词条 `43311` 当成价格，
     把 WPS 功能区的字认成服务名，把「名字：说明」的说明部分当成名字……
     这些用例就是防止改解析器时把这些坑重新踩一遍。 */
  section('B站自动比价 · 价格解析')
  const { groupLines, parseLineCandidates, collapseWithinVideo, median, extractPriceCandidates } = await import('../../src/scan/price-parse.mjs')
  const { matchServices, similarity, effectiveName, expandParsedNames, unitGroup } = await import('../../src/scan/price-match.mjs')

  /** 造一行 OCR 词：按空格切开，每个词给个递增的 x，足够 groupLines 分成一行 */
  const wordsOf = (text) => text.split(/(\s+)/).filter((s) => s.trim()).map((t, i) => ({ text: t, x: i * 40, y: 0, w: 38, h: 20, cx: i * 40 + 19, cy: 10, score: 0.95 }))
  const parseOne = (text) => {
    const lines = groupLines(wordsOf(text))
    return lines.flatMap((line) => parseLineCandidates(line))
  }
  const pairs = (text) => parseOne(text).map((c) => [c.name, c.price, c.unit])

  const PARSE_CASES = [
    // [一行 OCR 原文, 期望的 (名字, 价格, 单位) 列表]
    ['本体25r 精炼材料15r/个', [['本体', 25, '元'], ['精炼材料', 15, '个']]],
    ['深塔15/期', [['深塔', 15, '期']]],
    ['木头2r/100个 翠华木4r/100个', [['木头', 2, '元'], ['翠华木', 4, '元']]],
    ['满级突破材料168个 25r', [['满级突破材料', 25, '元']]],
    ['雪山玉髓8级40r', [['雪山玉髓8级', 40, '元']]],
    ['尘歌壶1-10级100r 七圣召唤1-10级200r', [['尘歌壶1-10级', 100, '元'], ['七圣召唤1-10级', 200, '元']]],
    ['6.0-6.7满探索480r', [['6.0-6.7满探索', 480, '元']]],
    ['《白夜国晨昏记》30 《76只活爹（兰那罗）》40', [['白夜国晨昏记', 30, ''], ['活爹兰那罗', 40, '']]],
    // 加价子句：`+30r包后续《…》` 整条判为加价项丢掉，这是**有意保守** ——
    // 丢掉一个价用户不会知道，收下一个错价用户会照着开单。
    // 关键是括号里的 16 / 10 必须一起跳过，否则会漏成两个价格。
    ['《森林会记住一切》+30r包后续《16石锁机关+静态风景10照片》', []],
    // 声骸词条 43311 不是价格，后面的 800/月 才是。
    // 注意名字里保留整个「至尊全托：豪华全托+…」—— 冒号前面才是服务名，
    // 这一步交给匹配层的 effectiveName 处理，解析器保持忠实。
    ['至尊全托：豪华全托+刷主c声骸43311小毕业800/月', [['至尊全托：豪华全托+刷主c声骸43311小毕业', 800, '月']]],
    // `16图` 是 16 张图，400 才是价
    ['罗伊冰原16图：400', [['罗伊冰原16图', 400, '']]],
    // 「名字：说明」——冒号后面是解释，不是名字的一部分
    ['精托：日常体力+活动：238包月', [['精托：日常体力+活动', 238, '']]],
    // 同一行两个口径：第二个价沿用前一个名字（靠单位区分）
    ['周常：25r/周90r/月', [['周常', 25, '周'], ['周常', 90, '月']]],
    // 紧排版：名字价格名字价格，中间没有分隔符，靠第二个数字前的中文断名
    ['黎乔利群岛20下层金库20 阿维纽林25', [['黎乔利群岛', 20, ''], ['下层金库', 20, ''], ['阿维纽林', 25, '']]],
    // 加价项：`…需+15` 是附加费，不是基准价
    ['黎乔利群岛前置钓鱼解除风暴需+15', []],
    // WPS 功能区整行、字数统计、拼写检查都不能出候选
    ['格式刷粘贴 标题1 标题2 标题3 页牌 样式集 查找替换 选择 AI排版 公文模式', []],
    ['页面：1/6 字数：1132 拼写检查：打开', []],
    ['文 页面 引用 审阅 视图 工具 会员专享 WPSAI 分享', []],
    // WPS 的字体下拉被 OCR 认错字（等线 → 尊线），旁边那个 48 是字号不是价。
    // 所以不能只按「等线」这个正确写法挡，得认「正文」这个排版用词本身。
    ['尊线正文 48', []],
    ['AA要- 正文 标题 1', []],
    // 「套餐1：…」里的 1 是分档编号，不是价格
    ['套餐1：梦州满探索230（100%探索+前置任务+梁鸢）', [['梦州满探索', 230, '']]],
    // 评论区/买家秀截图
    ['【购代肝】360贝币冰原全收集得吃炭', []],
  ]
  for (const [text, expect] of PARSE_CASES) {
    const got = pairs(text)
    ok(`解析「${text.slice(0, 26)}」`, JSON.stringify(got) === JSON.stringify(expect), { got, expect })
  }

  // 全角数字要能认（OCR 偶尔吐全角）
  ok('全角数字能认出来', JSON.stringify(pairs('深塔１５/期')) === JSON.stringify([['深塔', 15, '期']]), pairs('深塔１５/期'))
  // 中位数：偶数个取中间两个的平均
  ok('中位数（奇数个）', median([400, 450, 350]) === 400, median([400, 450, 350]))
  ok('中位数（偶数个取平均）', median([400, 450]) === 425, median([400, 450]))
  ok('中位数（空）', median([]) === null)
  // 同一视频内同名收敛：取出现次数最多的价
  const collapsed = collapseWithinVideo([
    { name: '日体', price: 70, unit: '元', unitKind: 'currency', hits: 3, score: 4, line: 'x' },
    { name: '日体', price: 80, unit: '元', unitKind: 'currency', hits: 1, score: 5, line: 'y' },
  ])
  ok('同视频内同名取出现次数多的价', collapsed.length === 1 && collapsed[0].price === 70, collapsed)

  /* ---------------------------------------------------------------
     分节标题 → 大类候选。

     这一块最难的不是「认出标题」，是**不把别的东西认成标题**：价格表视频里
     到处都是「没有价格、后面紧跟着价格」的行 —— 说明句、关键词列表、
     换行了的服务项、播放器按钮。下面每一条都是实拍帧里踩出来的。
     --------------------------------------------------------------- */
  section('B站自动比价 · 大类候选')
  const { extractSections } = await import('../../src/scan/price-parse.mjs')

  /** 造一整页 OCR 词：每行给一个递增的 y，行内按 x 排 */
  const pageOf = (lines) => lines.flatMap((text, row) =>
    text.split(/(\s+)/).filter((s) => s.trim()).map((t, i) => ({
      text: t, x: i * 40, y: row * 30, w: 38, h: 20, cx: i * 40 + 19, cy: row * 30 + 10, score: 0.95,
    })))
  const sectionsOf = (lines) => extractSections(pageOf(lines))

  const SECTION_CASES = [
    // [整页的行, 期望认出来的标题]
    // 最常见的形态：标题没有冒号，下面直接是价格
    [['地图探索', '全图全收集1230', '珑满探索300全收集350'], ['地图探索']],
    // 标题带结尾冒号
    [['世界任务：', '风起风息5r', '酒庄大扫除5r'], ['世界任务']],
    // 版本前缀要剥掉 —— 实测很多标题长这样
    [['3.5版本梦州地图', '梦州满探索230', '梦州全收集280'], ['梦州地图']],
    [['3.0-3.4版本罗伊冰原地图', '罗伊冰原满探索450', '罗伊冰原全收集480'], ['罗伊冰原地图']],
    // 序号前缀要剥掉
    [['一：托管类：', '基础日常30', '包月150'], ['托管类']],
    // 结尾的箭头是装饰
    [['3.5版本梦州地图←', '梦州满探索230', '梦州全收集280'], ['梦州地图']],

    // —— 下面这些都不能认成标题 ——
    // 换行了的服务项：名字太长折到下一行，价在再下一行。它后面同样跟着有价行，
    // 而且中间带冒号，是最像标题的一类。
    [['主线：', '第二幕：为了没有眼泪的明天', '15r', '第三幕：巨龙与自由之歌15r', '满探索275r'], ['主线']],
    // 说明句：紧跟 3 条有价行，光看「后面有价」会认成标题
    [['包含危行任务+探图活动', '黑海岸40r全收集', '黑海岸群岛20 泰缇斯之底20', '怨鸟泽40'], []],
    [['不做危行任务探索度满不了，仅打满探索的话，需要带危行一起做', '黑海岸40r全收集', '怨鸟泽40'], []],
    // 关键词列表折行后的下半截：长度刚好合格、全汉字、后面就是价格表，
    // 只有结尾那个「等」能把它认出来
    [['声骸地图任务深渊等', '风起风息5r', '酒庄大扫除5r'], []],
    // 播放器 / 网站按钮
    [['退出', '荒石高地全收集40', '七丘全收集107'], []],
    [['充电烫TA', '贝币祝福100', '雨祝50'], []],
    // 没有价格跟着的，不是标题（文档标题、口号）
    [['梦州地图', '鸣潮代肝价格表', '全职个人代肝已结百单'], []],
    [['鸣潮代肝价格表', '半年个人全职小代直播录屏价格良心', '探索托管任务已结百单'], []],
    // 文档界面
    [['格式刷粘贴 正文 标题1 标题2 样式集 查找替换', '全图全收集1230', '怨鸟泽40'], []],
  ]
  for (const [lines, expect] of SECTION_CASES) {
    const got = sectionsOf(lines).map((s) => s.name)
    ok(`标题「${lines[0].slice(0, 24)}」`, JSON.stringify(got) === JSON.stringify(expect), { got, expect })
  }

  // 子项要挂到正确的标题下面（下一个标题之前的有价行）
  const grouped = sectionsOf(['地图探索', '全图全收集1230', '黎那汐塔满探索350', '世界任务：', '风起风息5r', '酒庄大扫除5r'])
  ok('子项挂在正确的标题下',
    grouped.length === 2 &&
    JSON.stringify(grouped[0].items) === JSON.stringify(['全图全收集', '黎那汐塔满探索']) &&
    JSON.stringify(grouped[1].items) === JSON.stringify(['风起风息', '酒庄大扫除']),
    grouped.map((s) => `${s.name}:[${s.items.join(',')}]`))

  // 标题和它下面第一个价之间隔着别的行也要认（换行导致的）
  const across = sectionsOf(['主线：', '第一幕：捕风的异乡人15r', '第二幕：为了没有眼泪的明天', '15r', '第三幕：巨龙与自由之歌15r'])
  ok('标题后面隔了行也能认', across.length === 1 && across[0].name === '主线', across.map((s) => s.name))

  // 空页不能炸
  ok('空页不炸', extractSections([]).length === 0)
  ok('只有一行不炸', extractSections(pageOf(['地图探索'])).length === 0)

  /* ---------------------------------------------------------------
     AI 接入的安全属性。

     这一组测的不是「AI 判得准不准」（那取决于模型，没法在这里测），
     而是**即使模型乱来，它也碰不到价格**。这是整个接入里最不能出错的地方：
     价格错了会开错单，而且在界面上看不出来。
     --------------------------------------------------------------- */
  section('B站自动比价 · AI 接入的安全边界')
  const { __testing: aiScanTesting, aiTriageVideo, aiMatchUnmatched } = await import('../../src/scan/ai-scan.mjs')
  const { __testing: aiTesting, aiStatus, saveAiConfig, aiConfig, aiProbe } = await import('../../src/scan/ai.mjs')
  const { __testing: scanTesting } = await import('../../src/scan/bili-scan.mjs')
  const { scopeCompatibility, groupByService } = await import('../../src/scan/price-match.mjs')

  /**
   * 缓存往返。
   *
   * 这一组是被一个真 bug 逼出来的：`aiTriageVideo` 返回的 `decisions`/`renames`
   * 是 Map，而 `JSON.stringify(new Map())` 得到 `{}` —— 写进缓存再读回来就成了
   * 普通对象，`for (const [k, v] of result.renames)` 直接抛
   * `object is not iterable`，**四个视频全挂，而且只在第二次扫描时才炸**。
   * 所以这里必须把「写进去再读出来」整条路走一遍。
   */
  const packed = scanTesting.packAiResult({
    ok: true,
    model: 'm',
    decisions: new Map([['1:3', { keep: false, scope: 'total', inclusions: '', why: '噪音' }]]),
    renames: new Map([['声厘', '声匣']]),
  })
  const unpacked = scanTesting.unpackAiResult(packed)
  ok('缓存往返后 decisions 还是 Map', unpacked.decisions instanceof Map, String(unpacked.decisions))
  ok('缓存往返后 renames 还是 Map', unpacked.renames instanceof Map, String(unpacked.renames))
  ok('缓存往返后还能迭代 renames', [...unpacked.renames].length === 1, JSON.stringify([...unpacked.renames]))
  ok('缓存往返后还能迭代 decisions', [...unpacked.decisions][0][0] === '1:3', JSON.stringify([...unpacked.decisions]))
  ok('缓存往返不丢判断内容', unpacked.decisions.get('1:3')?.why === '噪音', JSON.stringify(unpacked.decisions.get('1:3')))
  ok('缓存往返不丢改名', unpacked.renames.get('声厘') === '声匣')
  ok('缓存往返保住 model', unpacked.model === 'm')
  // 坏数据不该把扫描搞崩 —— 读缓存那条路上到处都是 try/catch
  ok('坏 JSON 读缓存不抛', (() => { try { scanTesting.unpackAiResult('{不是 json'); return false } catch { return true } })())

  /**
   * AI 缓存的签名必须覆盖「模型的判断依赖什么」：模型 + 库内服务名 + 解析版本。
   * 少一样就会出现「拿着旧库的判断套新库」—— 那是会写错价的。
   */
  process.env.XFC_AI_API_KEY = 'sk-signature-test'
  process.env.XFC_AI_MODEL = '模型甲'
  const sigNames = (list) => scanTesting.aiSignature(list)
  ok('配了 AI 时签名有内容', sigNames(['甲']).length > 0, sigNames(['甲']))
  ok('库内服务项变了，签名就变', sigNames(['甲', '乙']) !== sigNames(['甲', '乙', '丙']))
  ok('库内服务项顺序变了，签名不变', sigNames(['甲', '乙']) === sigNames(['乙', '甲']), '顺序不该导致重问模型')
  const sigModelA = sigNames(['甲'])
  process.env.XFC_AI_MODEL = '模型乙'
  ok('换模型签名就变', sigNames(['甲']) !== sigModelA, '换了模型就得重新问')
  delete process.env.XFC_AI_MODEL
  delete process.env.XFC_AI_API_KEY
  ok('没配 AI 时签名是空（等于不缓存）', scanTesting.aiSignature(['甲']) === '')

  /**
   * 重新识别过就必须把 AI 判断的缓存清掉。
   *
   * 签名只覆盖「模型 + 库内服务名 + 解析版本」，不覆盖识别结果本身。而 AI 是按
   * `帧:行` 指认的 —— 行号一挪，旧判断就安到了别的行上，等于随机删价。
   * 这条断言直接查库：写入新帧之后，ai_sig 必须是空的。
   */
  {
    const { db } = await import('../../src/core/db.mjs')
    const BV = 'BVtest-cache-clears-ai'
    db.prepare("INSERT INTO bili_video_cache (bvid, version, ocr_frames, frames, frames_dir, at, ai_sig, ai_result) VALUES (?, 'x', 1, '[]', '', '2020-01-01', 'sig', '{\"ok\":true}') ON CONFLICT(bvid) DO UPDATE SET ai_sig='sig', ai_result='{\"ok\":true}'").run(BV)
    scanTesting.writeVideoCacheForTest(BV, [{ file: 'f0001.jpg', ok: true, words: [] }], '/tmp')
    const row = db.prepare('SELECT ai_sig, ai_result FROM bili_video_cache WHERE bvid = ?').get(BV)
    ok('重扫写回新帧时清掉了 AI 判断缓存', row?.ai_sig === '' && row?.ai_result === '', JSON.stringify(row))
    db.prepare('DELETE FROM bili_video_cache WHERE bvid = ?').run(BV)
  }

  // —— 字段白名单：模型就算吐了 price，也进不来 ——
  const dirty = aiScanTesting.pickFields({
    frame: 1, line: 3, keep: true, name: '全图全收集',
    price: 99999, prices: [1, 2], suggested_price: 88888, delta: -500,
  })
  ok('白名单丢掉模型给的 price 字段', !('price' in dirty) && !('prices' in dirty) && !('suggested_price' in dirty) && !('delta' in dirty),
    Object.keys(dirty))
  ok('白名单丢掉模型给的名字（改名走 renames，不混在行判断里）', !('name' in dirty), Object.keys(dirty))
  ok('白名单只留该留的', JSON.stringify(Object.keys(dirty).sort()) === JSON.stringify(['frame', 'keep', 'line']), Object.keys(dirty))

  /**
   * 改名守卫。这是拿假端点试出来的洞：让模型把**整行原文**当名字返回，
   * `精托：日常体力+活动：238包月` 就成了「服务名」，匹配率从 34 项掉到 15 项，
   * 而且界面上看不出来是 AI 干的。
   */
  const { acceptRename } = await import('../../src/scan/ai-scan.mjs')
  const vocab = new Set(['声匣', '日常托管', '精托', '日体', '全托'])
  ok('库里有的写法：接受', acceptRename('声厘', '声匣', vocab) === true)
  ok('只差一个字：接受', acceptRename('声厘', '声匣', new Set()) === true)
  ok('黎娜西塔→黎那汐塔：接受', acceptRename('黎娜西塔', '黎那汐塔', new Set()) === true)
  ok('整行抄回来当名字：拒绝', acceptRename('精托', '精托：日常体力+活动：238包月', new Set()) === false)
  ok('把好几个价拼一起当名字：拒绝', acceptRename('云陵谷', '云陵谷20 今州城20 中曲台地50 荒石高地50', new Set()) === false)
  ok('超长名字：拒绝', acceptRename('深渊', '深'.repeat(30), new Set()) === false)
  ok('空名字：拒绝', acceptRename('声厘', '', vocab) === false)
  ok('名字没变：不算改名', acceptRename('声厘', '声厘', vocab) === false)
  ok('毫无关系的名字：拒绝', acceptRename('深渊', '每日委托', new Set()) === false)
  /**
   * 「库里有这个名字」**不能单独当作放行理由**。
   *
   * 实测：库里有 `瑝珑梦州 满探索`，模型把 `梦州全收集`、`梦州全包` 也改成了它 ——
   * 三个不同套餐挤成一项。库里有只说明目标合法，不说明这次改得对。
   */
  ok('库里有的名字、但完全不像：拒绝', acceptRename('深渊', '日常托管', vocab) === false)
  /**
   * OCR 抓了一整行、库内是短名字：这是托管类最常见的一种，而且很可靠 ——
   * 库里的名字原样出现在 OCR 名字里。也是唯一能救回这类改名的规则，
   * 因为长短差太多，字符相似度只有 0.2。
   */
  ok('OCR 抓了整行、库内是短名字：接受', acceptRename('精托套餐：日体套餐+期间活动+千道门扉', '精托', vocab) === true)
  ok('库内名字出现在原名开头也接受', acceptRename('日体套餐：每日活跃+每日体力', '日体', vocab) === true)
  ok('库内名字出现在原名中间也接受', acceptRename('3.6版本精托套餐', '精托', vocab) === true)
  // 库里有 `瑝珑梦州 满探索`：短名字被补全是对的，但共享前缀的两个套餐不是
  const mengzhou = new Set(['瑝珑梦州 满探索'])
  ok('OCR 只抓到后半截、库内是全名：接受', acceptRename('梦州满探索', '瑝珑梦州 满探索', mengzhou) === true)
  ok('共享前缀但其实是另一个套餐：拒绝', acceptRename('梦州全包', '瑝珑梦州 满探索', mengzhou) === false)
  ok('同理 `梦州全收集` 也要拒', acceptRename('梦州全收集', '瑝珑梦州 满探索', mengzhou) === false)
  /**
   * 「原名 + 一堆别的」是最阴的一种：相似度够高，但它其实是整行抄回来的。
   * 实测就是 `黑海岸群岛` 被改成了 `黑海岸群岛、泰缇斯之底`（一行两个候选挤在一起）。
   */
  ok('原名后面挂一串别的：拒绝', acceptRename('黑海岸群岛', '黑海岸群岛、泰缇斯之底', new Set()) === false)
  ok('原名前面挂一串别的：拒绝', acceptRename('泰缇斯之底', '黑海岸群岛、泰缇斯之底', new Set()) === false)
  ok('库里真有的长名字仍然接受', acceptRename('深渊', '深渊满星', new Set(['深渊满星'])) === true)

  // —— JSON 抽取：对方不一定听话 ——
  const J = aiTesting.extractJson
  ok('能剥 ```json 围栏', JSON.stringify(J('```json\n{"a":1}\n```')) === '{"a":1}')
  ok('能剥没标语言的围栏', JSON.stringify(J('```\n{"a":1}\n```')) === '{"a":1}')
  ok('能跳过前面的客套话', JSON.stringify(J('好的，结果如下：\n{"a":1}')) === '{"a":1}')
  ok('字符串里的花括号不会骗到它', JSON.stringify(J('{"a":"}"}')) === '{"a":"}"}')
  ok('数组也能抽', JSON.stringify(J('前言[1,2]后语')) === '[1,2]')
  ok('真不是 JSON 就返回 null', J('我觉得这个价格挺合理的') === null)
  ok('空字符串返回 null', J('') === null)

  /**
   * —— 取正文：各家的字段名不一样 ——
   *
   * 这一段是被一次真实故障逼出来的：探活只给 32 个 token，推理模型把额度花在
   * 「思考」上，返回 `content: ""` + `finish_reason: "length"`，而当时的报错是
   * 「模型没给出能解析的 JSON：」—— 冒号后面空的，用户完全无从下手。
   */
  const readText = aiTesting.readMessageText
  ok('普通回复取 content', readText({ choices: [{ message: { content: '{"a":1}' } }] }).field === 'content')
  ok('content 是分片数组也能取', readText({ choices: [{ message: { content: [{ type: 'text', text: '{"a"' }, { type: 'text', text: ':1}' }] } }] }).text === '{"a":1}')
  ok('正文空时退回 reasoning_content', readText({ choices: [{ message: { content: '', reasoning_content: '{"a":1}' } }] }).field === 'reasoning_content')
  ok('正文是空白串也算空', readText({ choices: [{ message: { content: '   ', reasoning_content: 'x' } }] }).field === 'reasoning_content')
  ok('全空就返回空', readText({ choices: [{ message: {} }] }).text === '')
  ok('没有 choices 也不炸', readText({ error: 'nope' }).text === '')

  const explain = aiTesting.explainNoJson
  const truncMsg = explain({ payload: { choices: [{ message: { content: '', reasoning_content: '想了很久' }, finish_reason: 'length' }] }, content: '', finish: 'length' })
  ok('截断的错要说清是被截断', truncMsg.includes('截断'), truncMsg)
  ok('截断的错要提到 max_tokens', truncMsg.includes('max_tokens'), truncMsg)
  ok('截断的错要点出推理模型这个原因', truncMsg.includes('推理模型'), truncMsg)
  ok('正文空但推理非空要说清', truncMsg.includes('reasoning_content'), truncMsg)
  const emptyMsg = explain({ payload: { choices: [{ message: {} }] }, content: '', finish: 'stop' })
  ok('两边都空要说清', emptyMsg.includes('都是空的'), emptyMsg)
  ok('两边都空时不谎报截断', !emptyMsg.includes('截断'), emptyMsg)
  const noChoice = explain({ payload: { error: 'bad gateway' }, content: '', finish: '' })
  ok('没有 choices 时提示地址可能不对', noChoice.includes('OpenAI 兼容'), noChoice)
  const garbage = explain({ payload: { choices: [{ message: { content: '我觉得可以' }, finish_reason: 'stop' }] }, content: '我觉得可以', finish: 'stop' })
  ok('有正文但解析不了要把正文带出来', garbage.includes('我觉得可以'), garbage)
  // 有 choices 的那几种都要报 finish_reason；「没有 choices」那种本来就没有，不算
  ok('有 choices 的诊断都带 finish_reason', [truncMsg, emptyMsg, garbage].every((m) => m.includes('finish_reason')), emptyMsg)

  /**
   * —— 探活的额度不能饿死推理模型 ——
   *
   * 这条是这次故障的回归测试：断言真的发出去的请求里 max_tokens 够大，
   * 而不是去 grep 源码。实测 `deepseek-v4.1-flash` 光思考就要 13～32 个 token，
   * 给 32 就会返回空 content。
   */
  const probeRealFetch = globalThis.fetch
  const seenBodies = []
  globalThis.fetch = async (url, init) => {
    seenBodies.push(JSON.parse(init.body))
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], model: 'probe-test' }),
    }
  }
  process.env.XFC_AI_API_KEY = 'sk-probe-budget-test'
  const probeResult = await aiProbe()
  ok('探活能成功', probeResult.ok === true, probeResult.error)
  ok('探活真的发出去了请求', seenBodies.length === 1, seenBodies.length)
  ok('探活的 max_tokens 够推理模型思考', Number(seenBodies[0]?.max_tokens) >= 1024, String(seenBodies[0]?.max_tokens))
  ok('探活仍然要 JSON', seenBodies[0]?.response_format?.type === 'json_object', JSON.stringify(seenBodies[0]?.response_format))
  delete process.env.XFC_AI_API_KEY
  globalThis.fetch = probeRealFetch

  // —— 密钥脱敏 ——
  process.env.XFC_AI_API_KEY = 'sk-abcdefghijklmnopqrstuvwxyz'
  ok('报错正文里的密钥会被打码', !aiTesting.redact('your key sk-abcdefghijklmnopqrstuvwxyz is invalid').includes('sk-abcdefghijklmnopqrstuvwxyz'),
    aiTesting.redact('your key sk-abcdefghijklmnopqrstuvwxyz is invalid'))
  const st = aiStatus()
  ok('状态接口不回密钥', !JSON.stringify(st).includes('sk-abcdefghijklmnopqrstuvwxyz'), JSON.stringify(st))
  ok('状态接口只给尾号', st.key_tail === 'wxyz' && st.key_set === true, st.key_tail)
  delete process.env.XFC_AI_API_KEY

  /**
   * 密钥不能从别的口子漏出去。
   *
   * key 存在 settings 表里，而 `/api/settings` 是公开的读接口 —— 如果它把
   * settings 表整个吐出来，key 就跟着出去了。`readSettings()` 是按
   * `SETTING_KEYS` 白名单取的，所以只要 AI 那几个键不在白名单里就安全。
   * 这条断言就是钉住这件事：以后谁往白名单里加键，加错地方会红。
   */
  const { readSettings, SETTING_KEYS, updateSettings } = await import('../../src/modules/settings/settings-service.mjs')
  saveAiConfig({ base_url: 'https://example.invalid/v1', model: 'leak-model', api_key: 'sk-leak-test-0123456789' })
  const settingsOut = JSON.stringify(readSettings())
  ok('设置接口吐不出密钥', !settingsOut.includes('sk-leak-test-0123456789'), settingsOut.slice(0, 160))
  ok('设置接口吐不出接口地址和模型名', !settingsOut.includes('example.invalid') && !settingsOut.includes('leak-model'))
  ok('白名单里没有 AI 的键', !SETTING_KEYS.some((k) => k.startsWith('ai_')))
  // 反向也不行：不能靠往设置接口写 ai_api_key 来塞一个密钥进去
  updateSettings({ ai_api_key: 'sk-via-settings-endpoint' })
  const after = JSON.stringify(readSettings())
  ok('设置接口也写不进密钥', !after.includes('sk-via-settings-endpoint'), after.slice(0, 160))
  saveAiConfig({ clear_key: true })

  // —— 口径判断是不对称的：一次性总价永远放行，带周期的要对得上 ——
  ok('total 永远放行', scopeCompatibility('total', '').ok && scopeCompatibility('total', '30天').ok)
  ok('per_day 撞上「30天」要挡', scopeCompatibility('per_day', '30天').ok === false)
  ok('per_day 撞上「天」放行', scopeCompatibility('per_day', '天').ok === true)
  ok('per_month 撞上「30天」放行', scopeCompatibility('per_month', '30天').ok === true)
  ok('per_month 撞上空单位要挡', scopeCompatibility('per_month', '').ok === false)
  ok('没有口径时不拦', scopeCompatibility('', '30天').ok === true && scopeCompatibility(undefined, '天').ok === true)

  /**
   * 口径冲突的样本**只在还剩得下别的样本时才剔**。
   * 整组都冲突时一条都不剔 —— 全剔掉等于这一项不给建议，用户连「有这么个价」
   * 都看不到，损失比给一个口径可能不对的价更大。
   */
  const mkRow = (over) => ({
    service_id: 1, service_name: '日常托管', service_unit: '30天', current_price: 300,
    parsed_name: '日常托管', price: 300, unit: '', score: 0.9, video: 'BV1', ...over,
  })
  const mixed = groupByService([
    mkRow({ price: 300, video: 'BV1' }),
    mkRow({ price: 320, video: 'BV2' }),
    mkRow({ price: 3, video: 'BV3', scope: 'per_day', parsed_name: '基础日常：一天' }),
  ], { minSamples: 1 })
  ok('每天价不会混进一次性价里',
    mixed[0].prices.length === 2 && !mixed[0].prices.includes(3),
    `prices=${JSON.stringify(mixed[0].prices)} excluded=${JSON.stringify(mixed[0].excluded.map((e) => e.reason))}`)
  ok('被挡掉的每天价给出了理由', mixed[0].excluded.some((e) => e.reason.includes('每天')), mixed[0].excluded.map((e) => e.reason))

  const allBad = groupByService([mkRow({ price: 3, scope: 'per_day', video: 'BV9' })], { minSamples: 1 })
  ok('整组口径都对不上时仍然给建议', allBad[0].prices.length === 1 && allBad[0].scope_unresolved === true,
    `prices=${JSON.stringify(allBad[0].prices)} unresolved=${allBad[0].scope_unresolved}`)

  /* —— 端到端：拿一个假的 OpenAI 端点跑一遍，验证价格一个字都没被动过 —— */
  section('B站自动比价 · AI 端到端（假端点）')
  process.env.XFC_AI_BASE_URL = 'http://127.0.0.1:5999/v1'
  process.env.XFC_AI_API_KEY = 'sk-test-key-for-smoke'
  process.env.XFC_AI_MODEL = 'fake-model'

  const realFetch = globalThis.fetch
  /** 记下我们发出去的请求，用来验证 prompt 里没有价格数字 */
  const sent = []
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body)
    sent.push({ url, body })
    // 这个回复是**故意使坏**的：带了 price / suggested_price 想改价
    const reply = {
      rows: [
        { frame: 1, line: 2, keep: false, why: '主播在说话', price: 1, suggested_price: 99999 },
        { frame: 1, line: 3, keep: true, scope: 'total', inclusions: '星声4.5w', price: 0 },
        { frame: 1, line: 4, keep: true, scope: 'per_day', price: 88888 },
      ],
      // 改名是按名字给的，不是按行 —— 一行两个候选时才不会互相串
      renames: [{ from: '声厘', to: '声匣' }, { from: '声厘', to: '声厘' }, { from: '', to: '空的' }],
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], model: 'fake-model', usage: { total_tokens: 42 } }),
    }
  }

  try {
    const triage = await aiTriageVideo({
      game: '鸣潮',
      serviceNames: ['声匣', '日常托管'],
      frames: [{
        frame: 1,
        lines: [
          { index: 1, text: '鸣潮代肝价格表', priced: false, names: [] },
          { index: 2, text: '半年个人全职小代直播录屏价格良心', priced: true, names: ['半年个人全职小代直播录屏价格良心'] },
          { index: 3, text: '声厘60（星声4.5w）', priced: true, names: ['声厘'] },
          { index: 4, text: '基础日常：一天 3', priced: true, names: ['基础日常'] },
        ],
      }],
    })
    ok('假端点跑通了', triage.ok === true, triage.error)
    ok('三行都有判断', triage.decisions.size === 3, triage.decisions.size)
    ok('判定剔掉的拿得到', triage.decisions.get('1:2')?.keep === false && triage.decisions.get('1:2')?.why === '主播在说话')
    ok('改名按名字给', triage.renames.get('声厘') === '声匣', JSON.stringify([...triage.renames]))
    ok('名字没变的不进改名表', !triage.renames.has('声厘 '), JSON.stringify([...triage.renames.keys()]))
    ok('空名字的改名被丢掉', [...triage.renames.values()].every((v) => v), JSON.stringify([...triage.renames]))
    ok('口径判断生效', triage.decisions.get('1:4')?.scope === 'per_day')
    ok('包含内容带回来了', triage.decisions.get('1:3')?.inclusions === '星声4.5w')

    // 最关键的两条
    const allDecisionKeys = [...triage.decisions.values()].flatMap((d) => Object.keys(d))
    ok('判断结果里没有任何价格字段', !allDecisionKeys.some((k) => /price|价/.test(k)), [...new Set(allDecisionKeys)].join(','))
    ok('判断结果里也没有名字字段（改名单独走 renames）', !allDecisionKeys.includes('name'), [...new Set(allDecisionKeys)].join(','))
    /**
     * 这里测的是**标记**不带金额，不是「prompt 里没有数字」。
     *
     * OCR 原文本身就含数字（`声厘60`），不写进 prompt 模型就没法判断那行是什么，
     * 所以数字必然在。真正要保证的是：不告诉模型「程序认出来的价是 60」——
     * 说了它就会在回复里复述，而我们要的是它永远不产出数字。
     * 它碰不到价的最终保障在输出侧（白名单），这条只是减少诱导。
     */
    const sentText = sent.map((s) => JSON.stringify(s.body)).join('\n')
    ok('发给模型的 prompt 里确实有价格标记', sentText.includes('[价→'))
    ok('标记里带了程序认成的名字（模型才能纠正而不是重猜）', sentText.includes('[价→声厘]') || sentText.includes('[价→基础日常]'), (sentText.match(/\[价→[^\]]*\]/g) || []).join(' '))
    ok('标记里不带金额', !/\[价→[^\]]*\d/.test(sentText), (sentText.match(/\[价→[^\]]*\]/g) || []).join(' '))

    // 非法口径要落回 unknown 而不是照抄
    ok('口径白名单挡住乱填的值', triage.decisions.get('1:2')?.scope === 'unknown', triage.decisions.get('1:2')?.scope)
  } finally {
    globalThis.fetch = realFetch
  }

  // —— 兜底匹配：模型不能编出库里没有的 id ——
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ picks: [
        { name: '声厘', service_id: 7, confidence: 'high' },
        { name: '不存在的东西', service_id: 99999, confidence: 'high' },
        { name: '另一个', service_id: null, confidence: 'low' },
      ] }) } }],
    }),
  })
  try {
    const services = [{ id: 7, name: '声匣' }, { id: 8, name: '日常托管' }]
    const picked = await aiMatchUnmatched({ game: '鸣潮', services, names: [{ name: '声厘' }, { name: '不存在的东西' }, { name: '另一个' }] })
    ok('兜底匹配跑通', picked.ok === true, picked.error)
    ok('库内存在的 id 保留', picked.picks.find((p) => p.name === '声厘')?.service_id === 7)
    ok('库内不存在的 id 被拒掉', picked.picks.find((p) => p.name === '不存在的东西')?.service_id === null,
      JSON.stringify(picked.picks.find((p) => p.name === '不存在的东西')))
    ok('模型说没有就是没有', picked.picks.find((p) => p.name === '另一个')?.service_id === null)
  } finally {
    globalThis.fetch = realFetch
    delete process.env.XFC_AI_BASE_URL
    delete process.env.XFC_AI_API_KEY
    delete process.env.XFC_AI_MODEL
  }

  /**
   * AI 复核建议价：**唯一允许模型产出价格数字的地方**。
   *
   * 所以这里的断言全是「模型说的话不能直接信」—— 它回什么都得先过校验。
   * 破例的前提是「用户逐条看着原价和建议才点确认」，那建议价本身就必须干净。
   */
  section('B站自动比价 · AI 复核建议价')
  const { aiReviewPrices } = await import('../../src/scan/ai-scan.mjs')
  const REVIEW_ROWS = [1, 2, 3, 4, 5, 6].map((n) => ({
    service_id: n,
    service_name: `测试项${n}`,
    unit: '',
    current_price: 100,
    suggested_price: 200 + n,
    samples: [{ video: 'BV1', price: 200 + n, unit: '', score: 1, line: `测试项${n} ${200 + n}` }],
    excluded: [],
  }))

  process.env.XFC_AI_BASE_URL = 'http://127.0.0.1:1/v1'
  process.env.XFC_AI_API_KEY = 'smoke-key'
  process.env.XFC_AI_MODEL = 'smoke-model'
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ reviews: [
        // 正常的：给一个样本里没有的价
        { index: 1, verdict: 'suspect', suggested_price: 288, why: 'OCR 原文写的是 288' },
        // 编号越界 / 为零 —— 都得丢掉
        { index: 99, verdict: 'suspect', suggested_price: 1, why: '越界' },
        { index: 0, verdict: 'suspect', suggested_price: 1, why: '零' },
        // 非整数编号 —— 丢掉
        { index: 2.5, verdict: 'suspect', suggested_price: 1, why: '小数' },
        // 负数 / 超上限 / 非数字 —— 建议价丢掉
        { index: 2, verdict: 'suspect', suggested_price: -1, why: '负数' },
        { index: 3, verdict: 'suspect', suggested_price: 999999, why: '太大' },
        { index: 4, verdict: 'suspect', suggested_price: '两百', why: '不是数' },
        // 和程序算的一模一样（第 5 行建议价是 205）—— 一样就没有「改价」可言，丢掉
        { index: 5, verdict: 'suspect', suggested_price: 205, why: '一样' },
        // 没见过的 verdict —— 归一成 ok
        { index: 6, verdict: '也许吧', suggested_price: null, why: '' },
      ] }) } }],
    }),
  })
  try {
    const reviewed = await aiReviewPrices({ game: '鸣潮', rows: REVIEW_ROWS })
    ok('复核跑通', reviewed.ok === true, reviewed.error)
    ok('发出去几行就复核几行', reviewed.reviewed === REVIEW_ROWS.length, String(reviewed.reviewed))
    ok('越界编号被丢掉', reviewed.reviews.get(99) === undefined && reviewed.reviews.get(0) === undefined)
    ok('非整数编号被丢掉', reviewed.reviews.get(3) === undefined || reviewed.reviews.get(3).suggested_price === null)
    ok('负数建议价被丢掉', reviewed.reviews.get(2)?.suggested_price === null, JSON.stringify(reviewed.reviews.get(2)))
    ok('超上限建议价被丢掉', reviewed.reviews.get(3)?.suggested_price === null, JSON.stringify(reviewed.reviews.get(3)))
    ok('非数字建议价被丢掉', reviewed.reviews.get(4)?.suggested_price === null, JSON.stringify(reviewed.reviews.get(4)))
    ok('和程序算的一样的建议价被丢掉', reviewed.reviews.get(5)?.suggested_price === null, JSON.stringify(reviewed.reviews.get(5)))
    ok('样本里没有的价可以保留（这是它存在的理由）', reviewed.reviews.get(1)?.suggested_price === 288,
      JSON.stringify(reviewed.reviews.get(1)))
    ok('没见过的 verdict 归一成 ok', reviewed.reviews.get(6)?.verdict === 'ok', reviewed.reviews.get(6)?.verdict)
    ok('复核结果里没有价格以外的杂物',
      [...reviewed.reviews.values()].every((r) => Object.keys(r).sort().join(',') === 'suggested_price,verdict,why'))
  } finally {
    globalThis.fetch = realFetch
  }

  // 没配 AI 时不许假装复核过
  delete process.env.XFC_AI_BASE_URL
  delete process.env.XFC_AI_API_KEY
  delete process.env.XFC_AI_MODEL
  const noAi = await aiReviewPrices({ game: '鸣潮', rows: REVIEW_ROWS })
  ok('没配 AI 时复核直接说没配，不编结果', noAi.ok === false && noAi.skipped === true, JSON.stringify(noAi))
  const noRows = await aiReviewPrices({ game: '鸣潮', rows: [] })
  ok('没有要复核的行时也不编结果', noRows.ok === false && noRows.skipped === true, JSON.stringify(noRows))

  // —— AI 挂了必须降级，不能少给结果 ——
  globalThis.fetch = async () => { throw new Error('connection refused') }
  try {
    const dead = await aiTriageVideo({ game: '鸣潮', serviceNames: [], frames: [{ frame: 1, lines: [{ index: 1, text: '深渊35', priced: true }] }] })
    ok('AI 连不上时返回失败而不是抛异常', dead.ok === false && typeof dead.error === 'string', dead.error)
    const deadMatch = await aiMatchUnmatched({ game: '鸣潮', services: [{ id: 1, name: '深渊' }], names: [{ name: '深塔' }] })
    ok('兜底匹配连不上时也返回失败', deadMatch.ok === false, deadMatch.error)
  } finally {
    globalThis.fetch = realFetch
  }
  ok('AI 没配置时 aiConfig 说没启用', (() => { const c = aiConfig(); return c.enabled === false })())
  saveAiConfig({ clear_key: true })



  section('B站自动比价 · 名字匹配')
  // 拿几个真实形状的服务项当靶子
  const POOL = [
    { id: 1, name: '日体', unit_label: '30天', base_price: 70 },
    { id: 2, name: '精托', unit_label: '30天', base_price: 150 },
    { id: 3, name: '全托', unit_label: '30天', base_price: 218 },
    { id: 4, name: '黑海岸', unit_label: '', base_price: 40 },
    { id: 5, name: '黑海岸群岛', unit_label: '', base_price: 20 },
    { id: 6, name: '黎那汐塔', unit_label: '', base_price: 350 },
    { id: 7, name: '罗伊冰原', unit_label: '', base_price: 330 },
    { id: 8, name: '瑝珑梦州 满探索', unit_label: '', base_price: 90 },
    { id: 9, name: '周常', unit_label: '', base_price: 18 },
    { id: 10, name: '中曲台地', unit_label: '', base_price: 50 },
    { id: 11, name: '荒石高地', unit_label: '', base_price: 50 },
    { id: 12, name: '下层金库', unit_label: '', base_price: 20 },
  ]
  const matchOne = (name, price, unit = '', unitKind = 'bare') =>
    matchServices([{ name, price, unit, unitKind, video: `v-${name}-${price}` }], POOL).matched.map((m) => m.service_name)

  const MATCH_CASES = [
    ['精托', 238, '', 'bare', ['精托']],
    ['精托：日常体力+活动', 238, '', 'bare', ['精托']],
    // 错别字：那→娜、汐→西，两个字都错，靠编辑距离 + 首字一致救回来
    ['黎娜西塔全图探索', 400, '', 'bare', ['黎那汐塔']],
    // 库内名字是解析名的后缀
    ['梦州满探索', 230, '', 'bare', ['瑝珑梦州 满探索']],
    // 前缀噪声
    ['重黎那汐塔', 350, '', 'bare', ['黎那汐塔']],
    ['通黑海岸', 40, '', 'bare', ['黑海岸']],
    // 歧义组各归各位
    ['黑海岸', 40, '', 'bare', ['黑海岸']],
    ['黑海岸群岛', 20, '', 'bare', ['黑海岸群岛']],
    // 打包价（不带 /单位）不摊给单项
    ['黎娜西塔加珑十一图+黑海岸', 800, '', 'bare', []],
    ['珑十一图+黑海岸全图探索', 400, '', 'bare', []],
    // 带 /单位 的是单价，可以拆段
    ['中曲台地、荒石高地', 50, '期', 'slash', ['中曲台地', '荒石高地']],
    // 首字不同的「同后缀」名字绝不能混
    ['危行任务', 20, '', 'bare', []],
  ]
  for (const [name, price, unit, kind, expect] of MATCH_CASES) {
    const got = matchOne(name, price, unit, kind).sort()
    ok(`匹配「${name}」`, JSON.stringify(got) === JSON.stringify([...expect].sort()), { got, expect })
  }

  ok('effectiveName 取冒号前那段', effectiveName('精托：日常体力+活动') === '精托', effectiveName('精托：日常体力+活动'))
  ok('effectiveName 不动没有冒号的', effectiveName('日体') === '日体')
  ok('打包短语能拆段', JSON.stringify(expandParsedNames([{ name: '中曲台地、荒石高地', price: 50, unit: '期', unitKind: 'slash', video: 'x' }]).map((p) => p.name)) === JSON.stringify(['中曲台地', '荒石高地']))
  ok('单位口径：月 与 30天 同组', unitGroup('月') === unitGroup('30天'), [unitGroup('月'), unitGroup('30天')])
  ok('单位口径：天 与 30天 不同组', unitGroup('天') !== unitGroup('30天'), [unitGroup('天'), unitGroup('30天')])
  ok('相似度：错别字能过阈值', similarity('黎娜西塔全图探索', '黎那汐塔') >= 0.5, similarity('黎娜西塔全图探索', '黎那汐塔'))
  ok('相似度：同后缀不同前缀不该高', similarity('危行任务', '潮汐任务') < 0.62, similarity('危行任务', '潮汐任务'))

  /**
   * 新游戏冷启动：库里一个服务项都没有时，比价必然 0 匹配 —— 不是坏了，
   * 是没东西可以匹配。这一节验的是补那一步的两块砖：**别名**和**原话精确匹配**。
   *
   * 为什么必须有别名：视频里写 `挪德卡莱满探+前置任务+神瞳`，用户价格表上想写
   * `挪德卡莱满探`。前者含 `+`，算打包价，按规矩只认同名服务项（防止把一个
   * 打包价摊给单项）。所以短名字**永远**匹不上 —— 除非把原话记下来当别名。
   */
  section('B站自动比价 · 新游戏冷启动（别名与建服务项）')
  const { serviceNames, unmatchedGroups, proposeServicesFromScan } = await import('../../src/scan/price-match.mjs')
    .then(async (pm) => ({ serviceNames: pm.serviceNames, ...(await import('../../src/scan/bili-scan.mjs')) }))
    .catch(() => ({}))

  ok('serviceNames 把别名也算进来',
    JSON.stringify(serviceNames({ name: '挪德卡莱满探', aliases: '挪德卡莱满探+前置任务+神瞳\n' })) === JSON.stringify(['挪德卡莱满探', '挪德卡莱满探+前置任务+神瞳']),
    JSON.stringify(serviceNames({ name: '挪德卡莱满探', aliases: '挪德卡莱满探+前置任务+神瞳\n' })))
  ok('别名里的空行和重复会去掉',
    JSON.stringify(serviceNames({ name: '甲', aliases: '\n甲\n乙\n\n' })) === JSON.stringify(['甲', '乙']),
    JSON.stringify(serviceNames({ name: '甲', aliases: '\n甲\n乙\n\n' })))
  ok('没有别名时只有正式名字', JSON.stringify(serviceNames({ name: '甲' })) === JSON.stringify(['甲']))

  const aliasPool = [{ id: 1, name: '挪德卡莱满探', aliases: '挪德卡莱满探+前置任务+神瞳', unit_label: '', base_price: 0 }]
  const viaAlias = matchServices([{ name: '挪德卡莱满探+前置任务+神瞳', price: 500, video: 'v1' }], aliasPool).matched
  ok('打包价的长写法靠别名匹上短名字', viaAlias.length === 1 && viaAlias[0].matched_via === 'alias',
    JSON.stringify(viaAlias.map((m) => ({ n: m.service_name, via: m.matched_via }))))
  ok('别名匹上时分数是满分（本来就是同一句原话）', viaAlias[0]?.score === 1, viaAlias[0]?.score)

  // 没记别名的同名短名字：打包价只认同名，所以匹不上 —— 这正是别名存在的理由
  const noAlias = matchServices([{ name: '挪德卡莱满探+前置任务+神瞳', price: 500, video: 'v1' }], [{ id: 1, name: '挪德卡莱满探', unit_label: '', base_price: 0 }]).matched
  ok('没记别名就匹不上（打包价只认同名）', noAlias.length === 0, JSON.stringify(noAlias.map((m) => m.service_name)))

  /**
   * `effectiveName` 会把 `套餐①：至东国满探索…` 削成 `套餐①`（「名字：说明」这条
   * 规则对 `日体：5R/天` 是对的，对 `套餐①：…` 就把真名字削掉了）。
   * 所以原话还要能**精确**参与匹配 —— 但**只能精确**：拿原话做模糊匹配的话，
   * `全包：主线+前置+全宝箱` 会误匹到库里的「主线」。
   */
  ok('effectiveName 确实把套餐①削掉了（这是既有行为）', effectiveName('套餐①：至东国满探索100%探索+神瞳') === '套餐①')
  const labelPool = [{ id: 1, name: '至东国满探索', aliases: '套餐①：至东国满探索100%探索+神瞳', unit_label: '', base_price: 0 }]
  const viaLabel = matchServices([{ name: '套餐①：至东国满探索100%探索+神瞳', price: 240, video: 'v1' }], labelPool).matched
  ok('被削掉的原话仍能靠别名精确匹上', viaLabel.length === 1 && viaLabel[0].matched_via === 'alias',
    JSON.stringify(viaLabel.map((m) => ({ n: m.service_name, via: m.matched_via }))))
  const fuzzyLabel = matchServices([{ name: '全包：主线+前置+全宝箱+神瞳', price: 400, video: 'v1' }], [{ id: 1, name: '主线', unit_label: '', base_price: 0 }]).matched
  ok('原话只做精确匹配，不会把「全包：主线+…」模糊匹到「主线」', fuzzyLabel.length === 0,
    JSON.stringify(fuzzyLabel.map((m) => m.service_name)))

  /**
   * 整包价必须**带着 `strictExact` 一起**出现在「没匹上」里。
   *
   * AI 兜底匹配要拿这个标记决定「这一条不许送去问模型」——
   * 实测真出过事：`黎娜西塔加珑十一图+黑海岸800` 被模型热心匹到了
   * 库里的单项「黎那汐塔」，800 摊成了单项价，建议价从 350 涨到 575。
   * 界面上只显示「AI 判的，置信度 medium」，看不出那是整包价。
   */
  const bundleUnmatched = matchServices(
    [{ name: '黎娜西塔加珑十一图+黑海岸', price: 800, video: 'v1' }],
    POOL,
  ).unmatched
  ok('整包价落在「没匹上」里', bundleUnmatched.length === 1, JSON.stringify(bundleUnmatched.map((u) => u.parsed_name)))
  ok('整包价带着 strictExact 标记（AI 兜底靠它决定不许匹）', bundleUnmatched[0]?.strictExact === true,
    JSON.stringify({ strictExact: bundleUnmatched[0]?.strictExact, reason: bundleUnmatched[0]?.reason }))
  ok('普通没匹上的项不带这个标记', (() => {
    const plain = matchServices([{ name: '某个不存在的东西', price: 10, video: 'v1' }], POOL).unmatched
    return plain.length === 1 && plain[0].strictExact === false
  })())

  /** `unmatchedGroups`：按名字归并 + 算建议价，价格绝不能交给 AI */
  const fakeJob = {
    unmatched: [
      { parsed_name: '甲项', price: 100, video: 'v1' },
      { parsed_name: '甲项', price: 120, video: 'v2' },
      { parsed_name: '乙项', price: 50, video: 'v1' },
      // 同一个视频给了两个不同价 —— 口径不明，这一票要整票弃用
      { parsed_name: '丙项', price: 10, video: 'v1' },
      { parsed_name: '丙项', price: 99, video: 'v1' },
      { parsed_name: '丙项', price: 30, video: 'v2' },
    ],
  }
  const groups = unmatchedGroups(fakeJob)
  const g = (name) => groups.find((x) => x.name === name)
  ok('归并后按名字去重', groups.length === 3, groups.map((x) => x.name))
  ok('建议价取中位数', g('甲项').price === 110, g('甲项').price)
  ok('同一个视频给了两个价就整票弃用', g('丙项').price === 30 && g('丙项').dropped_videos === 1,
    JSON.stringify({ price: g('丙项').price, dropped: g('丙项').dropped_videos }))
  ok('归并结果里没有价格以外的 AI 字段', groups.every((x) => !('why' in x) && !('category' in x)))

  /**
   * 存成「待添加」的安全边界，以及「添加」这一步真的进了价格表。
   *
   * 这条路上的规矩和以前「直接建服务项」完全一样（名字必须来自这次扫描、价格必须
   * 合法、重名跳过），只是落点从 `services` 换成了 `service_drafts`。所以边界断言
   * 照旧，只是看的是草稿表。
   */
  section('B站自动比价 · 待添加的服务项（比价与价格表的中转站）')
  {
    const { db } = await import('../../src/core/db.mjs')
    const { listDrafts, updateDraft, acceptDraft, deleteDraft, clearDrafts, validateProposal } =
      await import('../../src/catalog/service-drafts.mjs')
    const { saveDraftsFromScan } = await import('../../src/scan/bili-scan.mjs')

    const jobId = 'scan-smoke-drafts'
    const job = {
      id: jobId, game_id: null, game_name: '冒烟游戏', status: 'done',
      unmatched: [{ parsed_name: '原话写法', price: 88, video: 'v1' }],
      sections: [], matched: [], videos: [], progress: {}, summary: {}, ai: {}, applied: [], log: [],
    }
    db.prepare('INSERT INTO price_scan_jobs (id, game_id, game_name, keyword, status, result, error_msg, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)')
      .run(job.id, job.game_name, 'k', 'done', JSON.stringify(job), '', '2020-01-01', '2020-01-01')

    const saved = saveDraftsFromScan(jobId, [{ name: '待添加的项', price: 88, sources: ['原话写法'] }])
    ok('能存成待添加', saved.created.length === 1, JSON.stringify(saved.skipped))
    ok('存的时候把原话记成了别名', saved.created[0]?.aliases === '原话写法', saved.created[0]?.aliases)
    ok('存成待添加时**没有**建服务项',
      db.prepare("SELECT COUNT(*) AS n FROM services WHERE name = '待添加的项'").get().n === 0)

    const draftId = saved.created[0].id
    ok('待添加在列表里能查到', listDrafts().some((d) => d.id === draftId))

    // 来源校验、价格校验和以前一模一样 —— 只是拒绝的是草稿
    ok('来源不在扫描结果里 → 存不进去',
      saveDraftsFromScan(jobId, [{ name: '编的', price: 1, sources: ['扫描里没有'] }]).created.length === 0)
    ok('负价格 → 存不进去',
      saveDraftsFromScan(jobId, [{ name: '负数', price: -1, sources: ['原话写法'] }]).created.length === 0)
    ok('超过上限的价格 → 存不进去',
      saveDraftsFromScan(jobId, [{ name: '天价', price: 1e9, sources: ['原话写法'] }]).created.length === 0)
    ok('没有来源字段 → 存不进去',
      saveDraftsFromScan(jobId, [{ name: '空的', price: 5 }]).skipped[0]?.reason === 'not_in_scan')

    /**
     * 存是**累加**的，不能把上一批冲掉。
     *
     * 这是个真实的坑：界面存完一批会把它们从勾选列表里去掉，用户接着勾第二批
     * 再存 —— 如果实现是「先删掉这个任务的旧草稿再写」，第一批就**悄悄没了**，
     * 而且不报错。用户会以为是自己没勾上。
     */
    const second = saveDraftsFromScan(jobId, [{ name: '第二批', price: 66, sources: ['原话写法'] }])
    ok('第二批能存进去', second.created.length === 1, JSON.stringify(second.skipped))
    ok('存第二批**不会**冲掉第一批（真的踩过这个坑）',
      listDrafts().some((d) => d.id === draftId),
      `第一批还在？${listDrafts().some((d) => d.id === draftId)}`)

    // 同名的再存一次是「更新那一行」，不是再摆一条
    const again = saveDraftsFromScan(jobId, [{ name: '第二批', price: 99, sources: ['原话写法'] }])
    ok('同名的重存是更新，不是再摆一条',
      again.created.length === 0 && again.updated.length === 1 && again.updated[0].price === 99,
      JSON.stringify({ created: again.created.length, updated: again.updated.length, price: again.updated[0]?.price }))
    ok('更新之后库里也只有一条同名的',
      listDrafts().filter((d) => d.name === '第二批').length === 1)

    const secondId = again.updated[0].id

    // 已经在价格表里的名字不该再摆成「待添加」
    const { db: _db } = await import('../../src/core/db.mjs')
    _db.prepare("INSERT INTO services (category_id, game_id, name, price_type, unit_label, base_price, min_qty, package_items, status, sort_order, note, aliases, created_at, updated_at) VALUES (NULL, NULL, '已经有的', 'fixed', '', 10, 1, '[]', 'active', 999, '', '', '2020-01-01', '2020-01-01')").run()
    ok('价格表里已经有同名的 → 不再摆成待添加',
      saveDraftsFromScan(jobId, [{ name: '已经有的', price: 10, sources: ['原话写法'] }]).skipped[0]?.reason === 'already_in_pricebook')
    _db.prepare("DELETE FROM services WHERE name = '已经有的'").run()

    // 改名 / 改价 —— 落库之前还能调
    const renamed = updateDraft(secondId, { name: '改过的名字', price: 77 })
    ok('待添加能改名改价', renamed.draft.name === '改过的名字' && renamed.draft.price === 77,
      JSON.stringify(renamed.draft))
    ok('空名字被挡住', (() => { try { updateDraft(secondId, { name: '   ' }); return false } catch { return true } })())
    ok('非法价格被挡住', (() => { try { updateDraft(secondId, { price: -5 }); return false } catch { return true } })())

    // 真正落库
    const accepted = acceptDraft(secondId)
    ok('添加后建出了服务项', accepted.ok && accepted.service.id > 0)
    const made = db.prepare('SELECT name, base_price, aliases FROM services WHERE id = ?').get(accepted.service.id)
    ok('名字和价都写对了', made?.name === '改过的名字' && Number(made?.base_price) === 77, JSON.stringify(made))
    ok('别名跟着进了价格表（下次比价才匹得上）', made?.aliases === '原话写法', made?.aliases)
    ok('添加之后草稿就没了', !listDrafts().some((d) => d.id === secondId))
    ok('重复添加同一条会报「不在了」',
      (() => { try { acceptDraft(secondId); return false } catch { return true } })())

    // 删掉 / 清空
    const third = saveDraftsFromScan(jobId, [{ name: '不要的', price: 12, sources: ['原话写法'] }]).created[0]
    ok('删掉一条待添加', deleteDraft(third.id).ok && !listDrafts().some((d) => d.id === third.id))
    ok('删不存在的会报错', (() => { try { deleteDraft(third.id); return false } catch { return true } })())

    saveDraftsFromScan(jobId, [{ name: '清空甲', price: 1, sources: ['原话写法'] }])
    const cleared = clearDrafts()
    ok('能一次清空', cleared.ok && !listDrafts().some((d) => d.name === '清空甲'), JSON.stringify(cleared))

    db.prepare('DELETE FROM services WHERE id = ?').run(accepted.service.id)
    db.prepare('DELETE FROM service_drafts WHERE source_job = ?').run(jobId)
    db.prepare('DELETE FROM price_scan_jobs WHERE id = ?').run(jobId)

    /**
     * `validateProposal` 是这条路上**唯一一份**校验。
     * 以前「直接建服务项」和「存成待添加」各写一份 —— 那种重复正是整包价 bug 的
     * 成因（两处匹配，一处漏了规矩）。这条断言是在钉住「只有一份」这件事：
     * 一旦有人再抄一份出去，上面那些边界断言就会有一条不再覆盖新代码。
     */
    const known = new Set(['原话写法'])
    const v = (raw) => validateProposal(raw, { known, existingNames: new Set(), categoryIds: new Set() })
    ok('校验器：合法输入原样通过', v({ name: '甲', price: 5, sources: ['原话写法'] }).ok)
    ok('校验器：价格四舍五入到分', v({ name: '甲', price: 5.005, sources: ['原话写法'] }).price === 5.01,
      v({ name: '甲', price: 5.005, sources: ['原话写法'] }).price)
    ok('校验器：不认识的 category_id 退回未归类',
      v({ name: '甲', price: 5, sources: ['原话写法'], category_id: 99999 }).categoryId === null)
    ok('校验器：别名里不会出现正式名字',
      v({ name: '原话写法', price: 5, sources: ['原话写法'] }).aliases === '')
  }

  /**
   * 拖拽排序的**纯算法**。
   *
   * 这段是最容易写错、又最难看出来的地方：拖完顺序不对，用户只会觉得「没拖准」，
   * 不会怀疑是代码算错了。所以它被抽到 `client/lib/sortable.js`（没有 React、没有
   * JSX），在这里直接 import 进来测。
   */
  section('拖拽排序的算法')
  {
    const { moveId, nudgeId, reorderInPlace } = await import('../../client/lib/sortable.js')

    ok('往前拖：c 落到 a 前面', JSON.stringify(moveId([1, 2, 3, 4], 3, 1, false)) === JSON.stringify([3, 1, 2, 4]),
      moveId([1, 2, 3, 4], 3, 1, false))
    ok('往后拖：a 落到 c 后面', JSON.stringify(moveId([1, 2, 3, 4], 1, 3, true)) === JSON.stringify([2, 3, 1, 4]),
      moveId([1, 2, 3, 4], 1, 3, true))

    /**
     * 这条是**先删后插**那个坑的钉子。
     *
     * 把 a 拿掉之后 c 的下标从 2 变成 1。如果沿用删除前的下标去插，
     * 结果会是 [b, c, a, d] 之外的东西 —— 往右拖永远差一格。
     */
    ok('往右拖不会差一格（先删后插的下标位移）',
      JSON.stringify(moveId(['a', 'b', 'c', 'd'], 'a', 'c', false)) === JSON.stringify(['b', 'a', 'c', 'd']),
      moveId(['a', 'b', 'c', 'd'], 'a', 'c', false))
    ok('往左拖不会差一格',
      JSON.stringify(moveId(['a', 'b', 'c', 'd'], 'd', 'b', false)) === JSON.stringify(['a', 'd', 'b', 'c']),
      moveId(['a', 'b', 'c', 'd'], 'd', 'b', false))

    ok('拖到自己身上：原样返回（界面上也不会走到这儿，这是兜底）',
      JSON.stringify(moveId([1, 2, 3], 2, 2, false)) === JSON.stringify([1, 2, 3]),
      moveId([1, 2, 3], 2, 2, false))
    ok('找不到 id 时原样返回（拖的过程中数据被刷新过）',
      JSON.stringify(moveId([1, 2, 3], 99, 1, false)) === JSON.stringify([1, 2, 3]),
      moveId([1, 2, 3], 99, 1, false))
    ok('目标找不到时原样返回', JSON.stringify(moveId([1, 2, 3], 1, 99, false)) === JSON.stringify([1, 2, 3]))
    // 接口回来的是数字，DOM 上是字符串 —— 比的时候一律按字符串比，
    // 但放回去的是**原来那个对象**，类型不能顺手改掉
    ok('数字和字符串混着也能对上',
      moveId(['1', '2', '3'], 3, '1', false).map(String).join(',') === '3,1,2',
      moveId(['1', '2', '3'], 3, '1', false))

    ok('键盘下移一格', JSON.stringify(nudgeId([1, 2, 3], 1, 1)) === JSON.stringify([2, 1, 3]))
    ok('键盘上移一格', JSON.stringify(nudgeId([1, 2, 3], 3, -1)) === JSON.stringify([1, 3, 2]))
    // 到头了要原样返回**同一个引用** —— useSortable 靠 `next === ids` 判断「没动就不发请求」
    ok('已经在头 / 尾就不动，而且是同一个引用（不然会白发一次请求）', (() => {
      const list = [1, 2, 3]
      return nudgeId(list, 1, -1) === list && nudgeId(list, 3, 1) === list && moveId(list, 1, 1, false) === list
    })())

    /**
     * `reorderInPlace`：大类那一份是**所有游戏混在一起**的扁平数组。
     * 重排某个游戏的大类时，别的游戏的位置一动不能动 —— 这是这段存在的全部理由。
     */
    const flat = [
      { id: 1, game_id: 10, name: '甲-1' }, { id: 2, game_id: 20, name: '乙-1' },
      { id: 3, game_id: 10, name: '甲-2' }, { id: 4, game_id: 20, name: '乙-2' },
      { id: 5, game_id: 10, name: '甲-3' },
    ]
    const onlyGame10 = (item) => item.game_id === 10
    const after = reorderInPlace(flat, onlyGame10, [5, 1, 3])
    ok('重排游戏 10 的大类：它自己的顺序变了',
      after.filter(onlyGame10).map((c) => c.id).join(',') === '5,1,3',
      after.filter(onlyGame10).map((c) => c.id))
    ok('重排游戏 10 的大类：**别的游戏一动没动**',
      after.filter((c) => c.game_id === 20).map((c) => c.id).join(',') === '2,4',
      after.filter((c) => c.game_id === 20).map((c) => c.id))
    ok('重排游戏 10 的大类：占的还是原来那几个位置',
      after.map((c) => c.id).join(',') === '5,2,1,4,3',
      after.map((c) => c.id))

    ok('条数对不上就原样返回（拖的过程中数据刷新过）',
      reorderInPlace(flat, onlyGame10, [5, 1]) === flat)
    ok('有条数对得上但 id 不存在时也原样返回',
      reorderInPlace(flat, onlyGame10, [5, 1, 999]) === flat)
    ok('空列表不炸', Array.isArray(reorderInPlace([], onlyGame10, [])))
  }

  /* ---------- 结果 ---------- */
  console.log(`\n${'═'.repeat(52)}`)
  console.log(`  通过 ${pass} 项，失败 ${failures.length} 项`)
  if (failures.length) {
    console.log('  失败清单：')
    for (const f of failures) console.log(`    · ${f}`)
  }
  console.log(`${'═'.repeat(52)}\n`)
  return { pass, failures }
}

/* 直接执行（node scripts/checks/smoke.mjs）时才自己跑；被 smoke-run.mjs import 时只导出 run() */
const isDirect = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirect) {
  run()
    .then(({ failures }) => {
      process.exit(failures.length ? 1 : 0)
    })
    .catch((err) => {
      console.error('\n冒烟测试崩了：', err)
      process.exit(2)
    })
}
