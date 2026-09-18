import crypto from 'node:crypto'
import { db, getSetting, setSetting } from './db.mjs'
import { VAULT_IDLE_MS } from './config.mjs'
import { bad, fail, nowISO, safeEqual, scryptKey, sha256 } from './util.mjs'
import { actorName } from './auth.mjs'

const SCRYPT_VAULT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }
const KEY_LEN = 32
const VERIFY_LEN = 32

/**
 * 保险箱密钥只活在内存里，落盘的一律是密文。
 * 服务器重启、手动落锁、闲置超时都会让密钥消失。
 */
let activeKey = null
let lastUse = 0
let lockReason = 'locked'

export const isConfigured = () => Boolean(getSetting('vault_verifier', ''))

function derive(password, salt) {
  const out = scryptKey(password, salt, KEY_LEN + VERIFY_LEN, SCRYPT_VAULT)
  return {
    key: out.subarray(0, KEY_LEN),
    verifier: sha256(out.subarray(KEY_LEN)).toString('hex'),
  }
}

function newSalt() {
  return crypto.randomBytes(16).toString('hex')
}

/** 首次设置保险箱密码；设置完直接就是解锁状态 */
export function configure(password) {
  assertStrong(password)
  const salt = newSalt()
  const { key, verifier } = derive(password, salt)
  setSetting('vault_salt', salt)
  setSetting('vault_verifier', verifier)
  activeKey = key
  lastUse = Date.now()
  lockReason = 'unlocked'
  audit('vault.setup', { target: '设置保险箱密码' })
}

function assertStrong(password) {
  if (typeof password !== 'string' || password.length < 8) {
    bad('保险箱密码至少 8 位', 'weak_password')
  }
  if (/^\d+$/.test(password)) {
    bad('保险箱密码不能是纯数字', 'weak_password')
  }
}

export function unlock(password) {
  if (!isConfigured()) fail(409, '保险箱还没有设置密码', 'vault_unconfigured')
  const salt = getSetting('vault_salt', '')
  const stored = getSetting('vault_verifier', '')
  const { key, verifier } = derive(String(password ?? ''), salt)
  if (!safeEqual(verifier, stored)) return false
  activeKey = key
  lastUse = Date.now()
  lockReason = 'unlocked'
  return true
}

export function lock(reason = 'manual') {
  const wasUnlocked = Boolean(activeKey)
  if (activeKey) activeKey.fill(0)
  activeKey = null
  lockReason = reason
  return wasUnlocked
}

function checkIdle() {
  if (activeKey && Date.now() - lastUse > VAULT_IDLE_MS) lock('idle')
}

export function status() {
  checkIdle()
  return {
    configured: isConfigured(),
    unlocked: Boolean(activeKey),
    idle_ms: VAULT_IDLE_MS,
    expires_in_ms: activeKey ? Math.max(0, VAULT_IDLE_MS - (Date.now() - lastUse)) : 0,
    lock_reason: lockReason,
  }
}

/** 每次用到密钥都续期，并把闲置倒计时推后 */
export function requireKey() {
  checkIdle()
  if (!activeKey) fail(423, '保险箱已锁定，请先解锁', 'vault_locked')
  lastUse = Date.now()
  return activeKey
}

export function touch() {
  if (activeKey) lastUse = Date.now()
}

/* ---------------- 加解密 ---------------- */

export function encrypt(plainObject) {
  const key = requireKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify(plainObject), 'utf8'), cipher.final()])
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  })
}

export function decrypt(blob) {
  if (!blob) return {}
  const key = requireKey()
  let parsed
  try {
    parsed = JSON.parse(blob)
  } catch {
    fail(500, '凭证密文格式损坏', 'vault_corrupt')
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'))
    const out = Buffer.concat([decipher.update(Buffer.from(parsed.ct, 'base64')), decipher.final()])
    return JSON.parse(out.toString('utf8'))
  } catch {
    fail(500, '凭证解密失败，可能是保险箱密码被改过', 'vault_decrypt_failed')
  }
}

/* ---------------- 改密码：必须重加密全部密文 ---------------- */

export function changePassword(currentPassword, nextPassword) {
  assertStrong(nextPassword)
  if (!unlock(currentPassword)) bad('当前保险箱密码不对', 'bad_password')
  const rows = db.prepare('SELECT id, payload_enc FROM credentials WHERE payload_enc <> ?').all('')
  const plain = rows.map((r) => ({ id: r.id, data: decrypt(r.payload_enc) }))

  const salt = newSalt()
  const { key, verifier } = derive(nextPassword, salt)
  const oldKey = activeKey
  activeKey = key // encrypt() 会用新密钥
  try {
    const update = db.prepare('UPDATE credentials SET payload_enc = ?, updated_at = ? WHERE id = ?')
    const ts = nowISO()
    db.exec('BEGIN')
    for (const row of plain) update.run(encrypt(row.data), ts, row.id)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    activeKey = oldKey
    throw err
  }
  setSetting('vault_salt', salt)
  setSetting('vault_verifier', verifier)
  lastUse = Date.now()
  audit('vault.password_changed', { target: `重加密 ${plain.length} 条凭证` })
  return plain.length
}

/* ---------------- 审计留痕 ---------------- */

export function audit(action, { credentialId = null, customerId = null, target = '', ip = '', ua = '' } = {}) {
  db.prepare(
    `INSERT INTO vault_audit (credential_id, customer_id, action, target, actor, ip, ua, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    credentialId,
    customerId,
    action,
    String(target).slice(0, 200),
    actorName(),
    String(ip).slice(0, 60),
    String(ua).slice(0, 300),
    nowISO()
  )
}

export function auditLog(limit = 200) {
  return db
    .prepare(
      `SELECT a.*, c.name AS customer_name, g.name AS game_name
       FROM vault_audit a
       LEFT JOIN customers c ON c.id = a.customer_id
       LEFT JOIN credentials cred ON cred.id = a.credential_id
       LEFT JOIN games g ON g.id = cred.game_id
       ORDER BY a.id DESC LIMIT ?`
    )
    .all(Math.min(1000, Math.max(1, limit)))
}

/* ---------------- 脱敏提示 ---------------- */

/** 列表里只露一点点，够认出来，不够拿去用 */
export function maskHint(account, phone) {
  const a = String(account || '').trim()
  if (a) {
    if (a.includes('@')) {
      const [name, domain] = a.split('@')
      const head = name.slice(0, 2)
      return `${head}${'*'.repeat(Math.max(2, Math.min(6, name.length - 2)))}@${domain}`
    }
    if (a.length <= 3) return a[0] + '**'
    return `${a.slice(0, 2)}${'*'.repeat(Math.max(2, Math.min(6, a.length - 2)))}`
  }
  const p = String(phone || '').trim()
  if (p.length >= 7) return `${p.slice(0, 3)}****${p.slice(-4)}`
  return p ? '已登记' : '未填写'
}
