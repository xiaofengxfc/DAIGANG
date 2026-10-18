/**
 * 只读查看数据库里到底有什么。不会写入、不会修改、不会删除任何东西。
 *
 *   node scripts/checks/inspect.mjs                 # 看 data/console.db
 *   node scripts/checks/inspect.mjs path/to.db      # 看指定的库
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const file = process.argv[2] || path.join(process.cwd(), 'data', 'console.db')
if (!fs.existsSync(file)) {
  console.log(`没有找到数据库：${file}`)
  process.exit(0)
}

const db = new DatabaseSync(file, { readOnly: true })

const TABLES = [
  'settings', 'games', 'service_categories', 'services', 'service_tiers', 'service_options',
  'customers', 'credentials', 'orders', 'order_items', 'order_progress', 'payments', 'quotes', 'vault_audit',
]

console.log(`数据库：${file}\n`)
console.log('表'.padEnd(22) + '行数')
console.log('-'.repeat(30))
for (const t of TABLES) {
  let n = '—'
  try {
    n = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
  } catch {
    n = '(无此表)'
  }
  console.log(String(t).padEnd(22) + n)
}

const dump = (title, sql) => {
  let rows = []
  try {
    rows = db.prepare(sql).all()
  } catch (e) {
    console.log(`\n${title}: 读取失败 ${e.message}`)
    return
  }
  console.log(`\n${title}（${rows.length}）`)
  for (const r of rows) console.log('  ' + JSON.stringify(r))
}

console.log('\n' + '='.repeat(60))
dump('游戏', 'SELECT id, name, status, servers FROM games ORDER BY id')
dump('分类', 'SELECT id, game_id, name, status FROM service_categories ORDER BY id')
dump('服务项', 'SELECT id, category_id, game_id, name, price_type, base_price, status FROM services ORDER BY id')
dump('客户', 'SELECT id, name, phone, status FROM customers ORDER BY id')
dump('订单', 'SELECT id, order_no, customer_name, game_name, status, total FROM orders ORDER BY id')

const orphanCats = db.prepare('SELECT COUNT(*) AS n FROM services s LEFT JOIN service_categories c ON c.id = s.category_id WHERE s.category_id IS NOT NULL AND c.id IS NULL').get().n
const noCat = db.prepare('SELECT COUNT(*) AS n FROM services WHERE category_id IS NULL').get().n
const noGame = db.prepare('SELECT COUNT(*) AS n FROM services WHERE game_id IS NULL').get().n
console.log(`\n兼容性关注点：`)
console.log(`  分类已被删除、但服务项还挂着旧 category_id 的：${orphanCats} 条`)
console.log(`  完全没有分类的服务项：${noCat} 条`)
console.log(`  没有绑定游戏的服务项：${noGame} 条`)

db.close()
