import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { DB_FILE, DATA_DIR, UPLOAD_DIR } from './config.mjs'
import { localDate, makeNo } from './util.mjs'

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(UPLOAD_DIR, { recursive: true })

export const db = new DatabaseSync(DB_FILE)

db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA busy_timeout = 5000')

/**
 * 迁移按顺序执行，一次只前进不后退。
 * 加字段就往数组末尾追加一条，不要改历史条目。
 */
const MIGRATIONS = [
  // ---- v1 初始结构 ----
  `
  CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE sessions (
    token        TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    ip           TEXT DEFAULT '',
    ua           TEXT DEFAULT ''
  );
  CREATE INDEX idx_sessions_expires ON sessions (expires_at);

  CREATE TABLE games (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    short_name  TEXT NOT NULL DEFAULT '',
    icon        TEXT NOT NULL DEFAULT '',
    servers     TEXT NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'active',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_games_status ON games (status, sort_order);

  CREATE TABLE service_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER REFERENCES games (id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_categories_game ON service_categories (game_id, sort_order);

  CREATE TABLE services (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id   INTEGER REFERENCES service_categories (id) ON DELETE SET NULL,
    game_id       INTEGER REFERENCES games (id) ON DELETE SET NULL,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    price_type    TEXT NOT NULL DEFAULT 'fixed',
    unit_label    TEXT NOT NULL DEFAULT '',
    base_price    REAL NOT NULL DEFAULT 0,
    min_qty       REAL NOT NULL DEFAULT 1,
    max_qty       REAL,
    package_items TEXT NOT NULL DEFAULT '[]',
    status        TEXT NOT NULL DEFAULT 'active',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    note          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX idx_services_cat ON services (category_id, sort_order);
  CREATE INDEX idx_services_game ON services (game_id, status);

  CREATE TABLE service_tiers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id  INTEGER NOT NULL REFERENCES services (id) ON DELETE CASCADE,
    min_qty     REAL NOT NULL DEFAULT 1,
    max_qty     REAL,
    unit_price  REAL NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_tiers_service ON service_tiers (service_id, sort_order);

  CREATE TABLE service_options (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id       INTEGER REFERENCES services (id) ON DELETE CASCADE,
    kind             TEXT NOT NULL DEFAULT 'addon',
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    price            REAL NOT NULL DEFAULT 0,
    price_mode       TEXT NOT NULL DEFAULT 'fixed',
    default_selected INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active',
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX idx_options_service ON service_options (service_id, sort_order);

  CREATE TABLE customers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL DEFAULT '',
    wechat      TEXT NOT NULL DEFAULT '',
    qq          TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',
    note        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_customers_phone ON customers (phone);
  CREATE INDEX idx_customers_name ON customers (name);

  CREATE TABLE credentials (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    game_id      INTEGER REFERENCES games (id) ON DELETE SET NULL,
    label        TEXT NOT NULL DEFAULT '',
    login_type   TEXT NOT NULL DEFAULT 'qrcode',
    server       TEXT NOT NULL DEFAULT '',
    role_name    TEXT NOT NULL DEFAULT '',
    masked_hint  TEXT NOT NULL DEFAULT '',
    payload_enc  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX idx_credentials_customer ON credentials (customer_id, status);

  CREATE TABLE vault_audit (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    credential_id INTEGER,
    customer_id   INTEGER,
    action        TEXT NOT NULL,
    target        TEXT NOT NULL DEFAULT '',
    actor         TEXT NOT NULL DEFAULT '',
    ip            TEXT NOT NULL DEFAULT '',
    ua            TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_audit_created ON vault_audit (created_at DESC);

  CREATE TABLE orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no       TEXT NOT NULL UNIQUE,
    customer_id    INTEGER REFERENCES customers (id) ON DELETE SET NULL,
    game_id        INTEGER REFERENCES games (id) ON DELETE SET NULL,
    title          TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'pending_confirm',
    customer_name  TEXT NOT NULL DEFAULT '',
    game_name      TEXT NOT NULL DEFAULT '',
    items_subtotal REAL NOT NULL DEFAULT 0,
    addon_total    REAL NOT NULL DEFAULT 0,
    discount       REAL NOT NULL DEFAULT 0,
    total          REAL NOT NULL DEFAULT 0,
    platform_fee   REAL NOT NULL DEFAULT 0,
    cost           REAL NOT NULL DEFAULT 0,
    ordered_at     TEXT NOT NULL,
    due_at         TEXT,
    completed_at   TEXT,
    note           TEXT NOT NULL DEFAULT '',
    internal_note  TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX idx_orders_status ON orders (status, ordered_at DESC);
  CREATE INDEX idx_orders_customer ON orders (customer_id, ordered_at DESC);

  CREATE TABLE order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    kind         TEXT NOT NULL DEFAULT 'service',
    ref_id       INTEGER,
    name         TEXT NOT NULL,
    spec         TEXT NOT NULL DEFAULT '',
    price_type   TEXT NOT NULL DEFAULT 'fixed',
    unit_label   TEXT NOT NULL DEFAULT '',
    unit_price   REAL NOT NULL DEFAULT 0,
    quantity     REAL NOT NULL DEFAULT 1,
    amount       REAL NOT NULL DEFAULT 0,
    snapshot     TEXT NOT NULL DEFAULT '{}',
    sort_order   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_order_items_order ON order_items (order_id, sort_order);

  CREATE TABLE order_progress (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id          INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    happened_on       TEXT NOT NULL,
    content           TEXT NOT NULL,
    resources_before  TEXT NOT NULL DEFAULT '',
    resources_after   TEXT NOT NULL DEFAULT '',
    media             TEXT NOT NULL DEFAULT '[]',
    note              TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL
  );
  CREATE INDEX idx_progress_order ON order_progress (order_id, happened_on DESC);

  CREATE TABLE payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER REFERENCES orders (id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers (id) ON DELETE SET NULL,
    kind        TEXT NOT NULL DEFAULT 'deposit',
    amount      REAL NOT NULL DEFAULT 0,
    method      TEXT NOT NULL DEFAULT 'wechat',
    status      TEXT NOT NULL DEFAULT 'confirmed',
    paid_at     TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_payments_order ON payments (order_id);
  CREATE INDEX idx_payments_paid ON payments (paid_at DESC);

  CREATE TABLE quotes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_no    TEXT NOT NULL UNIQUE,
    customer_id INTEGER REFERENCES customers (id) ON DELETE SET NULL,
    game_id     INTEGER REFERENCES games (id) ON DELETE SET NULL,
    title       TEXT NOT NULL DEFAULT '',
    items       TEXT NOT NULL DEFAULT '[]',
    total       REAL NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    valid_until TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_quotes_created ON quotes (created_at DESC);
  `,

  // v2：客户头像
  `ALTER TABLE customers ADD COLUMN avatar TEXT NOT NULL DEFAULT '';`,
]

export function migrate() {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0)
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[i])
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  return MIGRATIONS.length
}

/* ---------------- settings ---------------- */

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : fallback
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value ?? ''), new Date().toISOString())
}

export function getSettings(keys) {
  const out = {}
  for (const k of keys) out[k] = getSetting(k, '')
  return out
}

/** 每次写入业务表都要更新 updated_at，这里统一取时间 */
export const stamp = () => new Date().toISOString()

/**
 * 生成 DH250714-001 形式的单号：前缀 + 年月日 + 当日流水号。
 * 从 1 开始往上找一个没被占用的号，当日超过 9999 单才退化成随机串。
 */
export function nextSerialNo(prefix, table, column) {
  const day = localDate()
  for (let seq = 1; seq <= 9999; seq++) {
    const candidate = makeNo(prefix, day, seq)
    const hit = db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${column} = ?`).get(candidate)
    if (!hit) return candidate
  }
  return `${prefix}${day.replace(/-/g, '').slice(2)}-${Date.now().toString(36).toUpperCase()}`
}
