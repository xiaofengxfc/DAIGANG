/**
 * 迁移前后只读校验。
 *
 * 用法：
 *   node scripts/migration-check.mjs
 *   XFC_DATA_DIR=... node scripts/migration-check.mjs
 *
 * 这个脚本不写数据库、不解密凭证、不修改业务数据。
 * 每替换一个功能组件前后都可以执行一次，对比输出的数量和金额。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_FILE, DATA_DIR, UPLOAD_DIR } from '../src/config.mjs'

const db = new DatabaseSync(DB_FILE)
db.exec('PRAGMA foreign_keys = ON')

const tables = [
  'settings',
  'games',
  'service_categories',
  'services',
  'service_tiers',
  'service_options',
  'customers',
  'credentials',
  'orders',
  'order_items',
  'order_progress',
  'payments',
  'quotes',
  'vault_audit',
]

const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n)
const money = (sql) => Number(db.prepare(sql).get()?.value || 0)
const warnings = []
const failures = []

const fk = db.prepare('PRAGMA foreign_key_check').all()
if (fk.length) failures.push(`外键校验失败：${fk.length} 条`) 

const counts = Object.fromEntries(tables.map((table) => [table, count(table)]))
const ordersTotal = money('SELECT COALESCE(SUM(total), 0) AS value FROM orders')
const paymentsTotal = money("SELECT COALESCE(SUM(CASE WHEN kind = 'refund' THEN -amount ELSE amount END), 0) AS value FROM payments WHERE status = 'confirmed'")
const orderItemsWithoutSnapshot = Number(
  db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE snapshot IS NULL OR trim(snapshot) = ''").get().n
)
const credentialsWithoutCiphertext = Number(
  db.prepare("SELECT COUNT(*) AS n FROM credentials WHERE payload_enc IS NULL OR trim(payload_enc) = ''").get().n
)

if (orderItemsWithoutSnapshot) warnings.push(`订单明细缺少快照：${orderItemsWithoutSnapshot} 条`)
if (credentialsWithoutCiphertext) failures.push(`凭证缺少密文：${credentialsWithoutCiphertext} 条`)

const uploads = fs.existsSync(UPLOAD_DIR)
  ? fs.readdirSync(UPLOAD_DIR, { withFileTypes: true }).filter((entry) => entry.isFile()).length
  : 0

console.log(`数据库：${DB_FILE}`)
console.log(`数据目录：${DATA_DIR}`)
console.log(`数据库文件：${fs.existsSync(DB_FILE) ? fs.statSync(DB_FILE).size : 0} bytes`)
console.log(`上传文件：${uploads}`)
console.log('')
console.log('数据数量：')
for (const table of tables) console.log(`  ${table.padEnd(20)} ${counts[table]}`)
console.log('')
console.log(`订单总额：${ordersTotal}`)
console.log(`已确认收款净额：${paymentsTotal}`)
console.log(`外键错误：${fk.length}`)
console.log(`迁移警告：${warnings.length}`)
console.log(`迁移失败：${failures.length}`)

for (const message of warnings) console.log(`  ⚠ ${message}`)
for (const message of failures) console.log(`  ✗ ${message}`)

db.close()

if (failures.length) process.exit(1)
