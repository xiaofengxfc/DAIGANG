/**
 * 对比两个迁移数据包，检查迁移前后业务数据是否发生意外变化。
 *
 * 用法：
 *   node scripts/migration-compare.mjs --before <目录> --after <目录>
 */
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const valueOf = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : ''
}
const beforeDir = path.resolve(valueOf('--before'))
const afterDir = path.resolve(valueOf('--after'))
if (!fs.existsSync(beforeDir) || !fs.existsSync(afterDir)) {
  throw new Error('请同时提供存在的 --before 和 --after 目录')
}

const tables = [
  'games',
  'service_categories',
  'services',
  'service_tiers',
  'service_options',
  'customers',
  'credentials',
  'vault_audit',
  'orders',
  'order_items',
  'order_progress',
  'payments',
  'quotes',
]

const keyOf = (table, row) => {
  if (table === 'orders') return `order_no:${row.order_no}`
  return `id:${row.id}`
}

const fields = {
  games: ['id', 'name', 'short_name', 'servers', 'status', 'sort_order', 'notice', 'currency'],
  service_categories: ['id', 'game_id', 'name', 'status', 'sort_order', 'is_daily', 'notice'],
  services: ['id', 'category_id', 'game_id', 'name', 'price_type', 'unit_label', 'base_price', 'min_qty', 'max_qty', 'package_items', 'status', 'sort_order', 'is_daily', 'currency_amount'],
  service_tiers: ['id', 'service_id', 'min_qty', 'max_qty', 'unit_price', 'sort_order'],
  service_options: ['id', 'service_id', 'kind', 'name', 'description', 'price', 'price_mode', 'default_selected', 'status', 'sort_order'],
  customers: ['id', 'name', 'phone', 'wechat', 'qq', 'source', 'tags', 'note', 'status', 'avatar'],
  credentials: ['id', 'customer_id', 'game_id', 'label', 'login_type', 'server', 'role_name', 'masked_hint', 'payload_enc', 'status'],
  vault_audit: ['id', 'credential_id', 'customer_id', 'action', 'target', 'actor', 'created_at'],
  orders: ['order_no', 'customer_id', 'game_id', 'title', 'status', 'customer_name', 'game_name', 'items_subtotal', 'addon_total', 'discount', 'total', 'platform_fee', 'cost', 'ordered_at', 'due_at', 'completed_at', 'note', 'internal_note', 'daily_done_on'],
  order_items: ['id', 'order_id', 'kind', 'ref_id', 'name', 'spec', 'price_type', 'unit_label', 'unit_price', 'quantity', 'amount', 'snapshot', 'sort_order'],
  order_progress: ['id', 'order_id', 'happened_on', 'content', 'resources_before', 'resources_after', 'media', 'note'],
  payments: ['id', 'order_id', 'customer_id', 'kind', 'amount', 'method', 'status', 'paid_at', 'note'],
  quotes: ['id', 'quote_no', 'customer_id', 'game_id', 'title', 'items', 'total', 'note', 'valid_until'],
}

const readRows = (dir, table) => {
  const file = path.join(dir, `${table}.json`)
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
}
const project = (table, row) => Object.fromEntries((fields[table] || Object.keys(row)).map((field) => [field, row[field] ?? null]))
const mapRows = (table, dir) => new Map(readRows(dir, table).map((row) => [keyOf(table, row), JSON.stringify(project(table, row))]))

let changed = 0
for (const table of tables) {
  const before = mapRows(table, beforeDir)
  const after = mapRows(table, afterDir)
  const added = [...after.keys()].filter((key) => !before.has(key))
  const removed = [...before.keys()].filter((key) => !after.has(key))
  const modified = [...before.keys()].filter((key) => after.has(key) && before.get(key) !== after.get(key))
  if (added.length || removed.length || modified.length) {
    changed += added.length + removed.length + modified.length
    console.log(`${table}: 新增 ${added.length}，删除 ${removed.length}，变更 ${modified.length}`)
  } else {
    console.log(`${table}: 一致（${before.size}）`)
  }
}

console.log(`\n迁移差异总数：${changed}`)
if (changed) process.exit(1)
