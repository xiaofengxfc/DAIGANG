import { db, stamp } from './db.mjs'

const TABLE_TO_ENTITY = Object.freeze({
  games: 'game',
  service_categories: 'category',
  services: 'service',
  customers: 'customer',
  quotes: 'quotation',
  orders: 'sales_order',
  payments: 'payment',
})

const EVENT_TYPES = new Set(['upsert', 'delete'])
const STATUSES = new Set(['pending', 'processing', 'failed', 'done'])

export function entityTypeForTable(table) {
  return TABLE_TO_ENTITY[table] || ''
}

/**
 * 只把「表名 + 原始 ID」放入队列，后续同步时再从本地数据库读取最新安全数据。
 * 这样不会把凭证密文、登录信息或任何请求体副本写进队列。
 */
export function enqueueERPNextChange(table, sourceId, eventType = 'upsert') {
  const entityType = entityTypeForTable(table)
  const id = Number(sourceId)
  if (!entityType || !Number.isInteger(id) || id <= 0) return null
  if (!EVENT_TYPES.has(eventType)) throw new Error(`Unsupported outbox event: ${eventType}`)

  const now = stamp()
  const payload = JSON.stringify({ source_table: table, source_id: id })
  const info = db
    .prepare(
      `INSERT INTO integration_outbox
         (provider, entity_type, source_id, event_type, status, attempts, payload, last_error, next_attempt_at, created_at, updated_at, processed_at)
       VALUES ('erpnext', ?, ?, ?, 'pending', 0, ?, '', NULL, ?, ?, NULL)
       ON CONFLICT(provider, entity_type, source_id) DO UPDATE SET
         event_type = excluded.event_type,
         status = 'pending',
         attempts = 0,
         payload = excluded.payload,
         last_error = '',
         next_attempt_at = NULL,
         updated_at = excluded.updated_at,
         processed_at = NULL`
    )
    .run(entityType, id, eventType, payload, now, now)
  return Number(info.lastInsertRowid)
}

function parsePayload(row) {
  if (!row) return row
  let payload = {}
  try {
    payload = JSON.parse(row.payload || '{}')
  } catch {
    payload = {}
  }
  return { ...row, payload }
}

export function listOutbox({ status = '', limit = 200 } = {}) {
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 200))
  const rows = status && STATUSES.has(status)
    ? db.prepare('SELECT * FROM integration_outbox WHERE provider = ? AND status = ? ORDER BY id ASC LIMIT ?').all('erpnext', status, safeLimit)
    : db.prepare('SELECT * FROM integration_outbox WHERE provider = ? ORDER BY id ASC LIMIT ?').all('erpnext', safeLimit)
  return rows.map(parsePayload)
}

export function outboxSummary() {
  const rows = db
    .prepare('SELECT status, COUNT(*) AS count FROM integration_outbox WHERE provider = ? GROUP BY status')
    .all('erpnext')
  const counts = Object.fromEntries([...STATUSES].map((status) => [status, 0]))
  for (const row of rows) counts[row.status] = Number(row.count)
  const oldest = db
    .prepare("SELECT MIN(created_at) AS created_at FROM integration_outbox WHERE provider = 'erpnext' AND status <> 'done'")
    .get()
  return { provider: 'erpnext', counts, total: Object.values(counts).reduce((sum, count) => sum + count, 0), oldest_pending_at: oldest?.created_at || null }
}

export function markOutboxStatus(id, status, { error = '', nextAttemptAt = null } = {}) {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) return false
  if (!STATUSES.has(status)) throw new Error(`Unsupported outbox status: ${status}`)
  const now = stamp()
  const processedAt = status === 'done' ? now : null
  const info = db
    .prepare(
      `UPDATE integration_outbox
       SET status = ?, last_error = ?, next_attempt_at = ?, updated_at = ?, processed_at = ?
       WHERE id = ? AND provider = 'erpnext'`
    )
    .run(status, String(error || '').slice(0, 2000), nextAttemptAt, now, processedAt, n)
  return Number(info.changes) > 0
}

export function retryOutbox(id = null) {
  const now = stamp()
  if (id !== null && id !== undefined && id !== '') {
    const n = Number(id)
    if (!Number.isInteger(n) || n <= 0) return 0
    const info = db
      .prepare(
        `UPDATE integration_outbox
         SET status = 'pending', attempts = 0, last_error = '', next_attempt_at = NULL, updated_at = ?, processed_at = NULL
         WHERE id = ? AND provider = 'erpnext' AND status <> 'done'`
      )
      .run(now, n)
    return Number(info.changes)
  }
  const info = db
    .prepare(
      `UPDATE integration_outbox
       SET status = 'pending', attempts = 0, last_error = '', next_attempt_at = NULL, updated_at = ?, processed_at = NULL
       WHERE provider = 'erpnext' AND status IN ('failed', 'processing')`
    )
    .run(now)
  return Number(info.changes)
}
