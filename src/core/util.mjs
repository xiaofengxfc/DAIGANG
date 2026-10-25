import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR, ROOT } from './config.mjs'

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code || 'error'
  }
}

export const fail = (status, message, code) => {
  throw new HttpError(status, message, code)
}
export const bad = (message, code) => fail(400, message, code || 'bad_request')
export const notFound = (message = '没有找到这条记录') => fail(404, message, 'not_found')

/**
 * 解 URL 编码，解不开就原样返回。
 *
 * 为什么必须这么写：`decodeURIComponent('%')` 会抛 URIError。地址栏里一个手抖的
 * 百分号、请求头里一个畸形 cookie、别的程序拼出来的链接，都能让这个异常从
 * 请求处理里冒出去 —— 而在 node 的 http 回调里，未捕获异常等于整个进程退出
 * （界面全白，后台没了）。这类输入没有任何「正确结果」可言，唯一的要求是
 * 别把进程带走：解不开就当它是普通字符串，交给后面的校验去拒绝。
 */
export function safeDecode(value) {
  const text = String(value ?? '')
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/* ---------- 临时文件 ---------- */

const scratchProbe = new Map()
let scratchSeq = 0

/** 这个目录现在写得进去吗（真写一个再删掉，目录存在 ≠ 写得进去） */
function writable(dir) {
  if (scratchProbe.has(dir)) return scratchProbe.get(dir)
  let ok = false
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-test-${process.pid}`)
    fs.writeFileSync(probe, 'ok')
    fs.unlinkSync(probe)
    ok = true
  } catch {
    ok = false
  }
  scratchProbe.set(dir, ok)
  return ok
}

/**
 * 项目**旁边**的纯 ASCII 别名目录（Windows 目录联接），指向 data/tmp。
 *
 * 为什么非要有这么个东西：外部 exe（RapidOCR-json / PaddleOCR-json / Tesseract）
 * 读不了中文路径 —— 实测同一个 exe、同一张图，ASCII 路径 `code:100` 正常，
 * 项目路径 `code:300 JSON dump failed`。而项目目录本身就叫「代肝价格查询」，
 * 8.3 短名也不帮忙（实测本项目短名是 `D:\GITHUB~1\代肝价~1`，中文原样保留）。
 *
 * 唯一的出路是让**路径前缀**变英文：在项目外面建一个英文名的联接指回 data/tmp。
 * 放在项目外是因为前缀才算数；放在同一个盘是因为联接不能跨卷；
 * 用 'junction' 是因为它是 Windows 上唯一**普通用户就能建**的类型
 * （symlink 要管理员或开发者模式）。
 *
 * 建不出来、父目录也带中文、或者建好了写不进去 —— 一律返回空串，让调用方退到
 * data/tmp（那时只有 Python 后端能用，因为它读图走 np.fromfile，中文路径无所谓）。
 */
function asciiAliasDir() {
  const alias = path.join(path.dirname(ROOT), 'xfc-tmp')
  if (/[^\x20-\x7e]/.test(alias)) return ''
  const target = path.join(DATA_DIR, 'tmp')
  try {
    fs.mkdirSync(target, { recursive: true })
  } catch {
    return ''
  }
  try {
    if (!fs.existsSync(alias)) fs.symlinkSync(target, alias, 'junction')
  } catch {
    /* 已经存在、没权限、盘不支持联接 —— 都靠下面的可写性检查兜底 */
  }
  return writable(alias) ? alias : ''
}

/**
 * 临时文件放哪儿。两种偏好，都会互相兜底：
 *
 *   mode='project'（默认）—— 先 data/tmp，写不进再退系统临时目录。
 *     给「只被我们自己读」的临时文件用（Python 侧解图走 np.fromfile，中文路径没问题）。
 *
 *   mode='ascii' —— 先系统临时目录（纯 ASCII）；写不进就退到项目旁边的 ASCII 联接
 *     （见 asciiAliasDir，这样外部 exe 也还能用）；再不行才退 data/tmp。
 *     给**外部 exe** 读写的临时文件用。
 *
 * 为什么要这么绕：**别以为 os.tmpdir() 一定写得进去**。这是实测过的真实故障
 * （用户机器上）：往 %TEMP% 写一个 2×2 的 PNG 直接被拒（EPERM），
 * 「Python 视觉后端 → 自检一下」整个接口 500，截屏和每帧的带图也一样写不进去 ——
 * 而原因跟识别本身一点关系都没有。程序确定写得进去的只有项目自己的 data/
 * （数据库、日志、上传件都在那儿）。
 */
export function scratchDir({ mode = 'project' } = {}) {
  const project = path.join(DATA_DIR, 'tmp')
  const system = os.tmpdir()
  if (mode === 'ascii') {
    if (writable(system)) return system
    const alias = asciiAliasDir()
    if (alias) return alias
    return writable(project) ? project : system
  }
  if (writable(project)) return project
  return writable(system) ? system : project
}

/**
 * 一个临时文件的路径（只给路径，不创建文件）。
 * 名字里带进程号和自增序号：同一毫秒里连开两个（一帧里裁带 + 截图就是这种情况）
 * 光靠 Date.now() 会撞在同一个文件名上。
 */
export function scratchFile(prefix, ext = '.png', opts = {}) {
  scratchSeq += 1
  return path.join(scratchDir(opts), `${prefix}-${process.pid}-${Date.now()}-${scratchSeq.toString(36)}${ext}`)
}

/* ---------- 时间 ---------- */

export const nowISO = () => new Date().toISOString()

/** 服务器本地日期 YYYY-MM-DD */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 「干活的那一天」是从几点算起的。
 * 代肝经常干到后半夜，凌晨 1 点做完的日体不该算成第二天 ——
 * 所以凌晨 4 点之前都还算前一天。
 */
export const DAY_START_HOUR = 4

/**
 * 业务日期：跟 localDate 一样是 YYYY-MM-DD，但把凌晨 0:00–3:59 归到前一天。
 * 「今日已完成」全靠它 —— 存的、比的、筛的都是这个，所以刷新点是凌晨 4 点。
 */
export function bizDate(d = new Date(), cutoffHour = DAY_START_HOUR) {
  const x = new Date(d.getTime())
  if (x.getHours() < cutoffHour) x.setDate(x.getDate() - 1)
  return localDate(x)
}

export function localMonth(d = new Date()) {
  return localDate(d).slice(0, 7)
}

export function addDays(dateStr, days) {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setDate(d.getDate() + days)
  return d.toISOString()
}

/* ---------- 数值 ---------- */

export const money = (n) => Math.round((Number(n) || 0) * 100) / 100

export function num(v, fallback = 0) {
  if (v === '' || v === null || v === undefined) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export function int(v, fallback = 0) {
  return Math.trunc(num(v, fallback))
}

export function clampStr(v, max = 500) {
  if (v === null || v === undefined) return ''
  return String(v).slice(0, max)
}

export function bool01(v) {
  return v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0
}

/* ---------- JSON 列 ---------- */

export function parseJSON(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback
  if (typeof raw === 'object') return raw
  try {
    const v = JSON.parse(raw)
    return v === null || v === undefined ? fallback : v
  } catch {
    return fallback
  }
}

export const stringifyJSON = (v) => JSON.stringify(v === undefined ? null : v)

/** 把任意输入规整成字符串数组，去空去重 */
export function toStringArray(v, max = 60) {
  const arr = Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(/[,，\n]/) : []
  const out = []
  for (const item of arr) {
    const s = clampStr(item, 60).trim()
    if (s && !out.includes(s)) out.push(s)
    if (out.length >= max) break
  }
  return out
}

/* ---------- 随机 / 哈希 ---------- */

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex')

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/** 恒定时间比较，避免计时侧信道 */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

export function scryptKey(password, salt, length, opts) {
  return crypto.scryptSync(String(password), salt, length, opts)
}

/* ---------- 单号 ---------- */

export function makeNo(prefix, dateStr, seq, pad = 3) {
  const ymd = String(dateStr).replace(/-/g, '').slice(2)
  return `${prefix}${ymd}-${String(seq).padStart(pad, '0')}`
}

/* ---------- 排序 ---------- */

export function nextSortOrder(db, table) {
  const row = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM ${table}`).get()
  return num(row?.m, 0) + 10
}

/* ---------- 搜索串 ---------- */

export function likeTerm(q) {
  return `%${String(q || '').replace(/[%_\\]/g, (m) => '\\' + m)}%`
}
