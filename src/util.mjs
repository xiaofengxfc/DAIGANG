import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from './config.mjs'

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
 * 临时文件放哪儿。两种偏好，都会互相兜底：
 *
 *   mode='project'（默认）—— 先 data/tmp，写不进再退系统临时目录。
 *     给「只被我们自己读」的临时文件用（Python 侧解图走 np.fromfile，中文路径没问题）。
 *
 *   mode='ascii' —— 先系统临时目录（纯 ASCII），写不进再退 data/tmp。
 *     给**外部 exe** 读的临时文件用：实测 RapidOCR-json 读不了中文路径
 *     （src/ocr.mjs 里那个 asciiCopy 就是为这件事存在的），所以优先 ASCII。
 *     %TEMP% 万一写不进去，退到项目目录至少 Python 那条路还能用 ——
 *     那种情况下反正 exe 那条路本来也跑不起来。
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
  const order = mode === 'ascii' ? [system, project] : [project, system]
  for (const dir of order) if (writable(dir)) return dir
  return order[0]
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
