/**
 * 导出迁移用业务数据包。
 *
 * 只读数据库，不修改源库。
 * - 保留业务表、原始 ID、订单快照、审计记录和凭证密文
 * - 不导出登录密码哈希、保险箱校验材料等安全密钥
 * - 凭证 payload_enc 仍是密文，不能脱离原保险箱密码直接解密
 *
 * 用法：
 *   node scripts/migration-export.mjs
 *   node scripts/migration-export.mjs --out backups/my-export
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_FILE } from '../src/config.mjs'

const args = process.argv.slice(2)
const outArgIndex = args.indexOf('--out')
const outDir = path.resolve(outArgIndex >= 0 ? args[outArgIndex + 1] || '' : `backups/migration-export-${stamp()}`)

if (!outDir || outDir === path.parse(outDir).root) throw new Error('导出目录不合法')
fs.mkdirSync(outDir, { recursive: true })

const db = new DatabaseSync(DB_FILE)
const tables = [
  'settings',
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
  'integration_outbox',
]

const redactSetting = (key) => {
  const k = String(key || '').toLowerCase()
  return k.includes('hash') || k.includes('salt') || k.includes('verifier') || k.includes('secret')
}

const counts = {}
for (const table of tables) {
  let rows = db.prepare(`SELECT * FROM ${table}`).all()
  if (table === 'settings') rows = rows.filter((row) => !redactSetting(row.key))
  counts[table] = rows.length
  fs.writeFileSync(path.join(outDir, `${table}.json`), JSON.stringify(rows, null, 2) + '\n', 'utf8')
}

const manifest = {
  format: 1,
  exported_at: new Date().toISOString(),
  source_db: DB_FILE,
  source_db_bytes: fs.statSync(DB_FILE).size,
  tables: counts,
  redactions: [
    'settings 中的登录密码哈希、保险箱 salt/verifier 等安全材料未导出',
    'sessions 未导出，迁移后应让用户重新登录',
  ],
  credential_note: 'credentials.payload_enc 保持原密文；只有原保险箱密码和兼容的解密实现才能恢复明文。',
  rollback_note: '完整回滚源是原始 console.db 与 data/uploads，不是本 JSON 数据包。',
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
db.close()

console.log(`迁移数据包：${outDir}`)
for (const [table, n] of Object.entries(counts)) console.log(`  ${table.padEnd(20)} ${n}`)
console.log('已排除登录/保险箱密钥材料；凭证仅保留密文。')

function stamp() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
