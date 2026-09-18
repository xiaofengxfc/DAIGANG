import crypto from 'node:crypto'
import { db, getSetting, setSetting } from './db.mjs'
import { SESSION_TTL_MS } from './config.mjs'
import { bad, fail, nowISO, randomToken, safeEqual, scryptKey, sha256 } from './util.mjs'

const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

export const isSetUp = () => Boolean(getSetting('admin_hash', ''))

export function setPassword(password) {
  if (typeof password !== 'string' || password.length < 6) {
    bad('登录密码至少 6 位', 'weak_password')
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = scryptKey(password, salt, 32, SCRYPT).toString('hex')
  setSetting('admin_salt', salt)
  setSetting('admin_hash', hash)
}

export function verifyPassword(password) {
  const salt = getSetting('admin_salt', '')
  const hash = getSetting('admin_hash', '')
  if (!salt || !hash) return false
  const candidate = scryptKey(String(password ?? ''), salt, 32, SCRYPT).toString('hex')
  return safeEqual(candidate, hash)
}

/* ---------------- 登录失败限速 ---------------- */

const attempts = new Map()
const WINDOW_MS = 10 * 60 * 1000
const MAX_FAILS = 8

export function throttleKey(scope, ip) {
  return `${scope}:${ip || 'unknown'}`
}

export function assertNotThrottled(scope, ip) {
  const rec = attempts.get(throttleKey(scope, ip))
  if (!rec) return
  if (Date.now() - rec.first > WINDOW_MS) {
    attempts.delete(throttleKey(scope, ip))
    return
  }
  if (rec.count >= MAX_FAILS) {
    const waitMin = Math.max(1, Math.ceil((WINDOW_MS - (Date.now() - rec.first)) / 60000))
    fail(429, `尝试次数过多，请 ${waitMin} 分钟后再试`, 'throttled')
  }
}

export function noteFailure(scope, ip) {
  const k = throttleKey(scope, ip)
  const rec = attempts.get(k)
  if (!rec || Date.now() - rec.first > WINDOW_MS) {
    attempts.set(k, { count: 1, first: Date.now() })
  } else {
    rec.count += 1
  }
}

export function clearFailures(scope, ip) {
  attempts.delete(throttleKey(scope, ip))
}

/* ---------------- 会话 ---------------- */

export function createSession(ip = '', ua = '') {
  const token = randomToken(32)
  const now = new Date()
  const expires = new Date(now.getTime() + SESSION_TTL_MS)
  db.prepare(
    `INSERT INTO sessions (token, created_at, last_seen_at, expires_at, ip, ua)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(token, now.toISOString(), now.toISOString(), expires.toISOString(), String(ip).slice(0, 60), String(ua).slice(0, 300))
  return { token, expiresAt: expires }
}

export function readSession(token) {
  if (!token) return null
  const row = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token)
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
    return null
  }
  // 每 10 分钟续一次，避免每请求都写库
  if (Date.now() - new Date(row.last_seen_at).getTime() > 10 * 60 * 1000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(nowISO(), token)
  }
  return row
}

export function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

export function destroyAllSessions() {
  db.prepare('DELETE FROM sessions').run()
}

export function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowISO())
}

/** 审计里记录的"谁" —— 单人使用，取店名/管理员名 */
export function actorName() {
  return getSetting('admin_name', '') || getSetting('business_name', '') || '管理员'
}

export const hashOf = (s) => sha256(s)
