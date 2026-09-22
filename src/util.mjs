import crypto from 'node:crypto'

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
