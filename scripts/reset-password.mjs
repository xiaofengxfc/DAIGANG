/**
 * 登录密码救援工具。
 *
 *   node scripts/reset-password.mjs                 清掉登录密码，下次启动回到初始化引导
 *   node scripts/reset-password.mjs 我的新密码       直接设一个新密码（至少 6 位）
 *   node scripts/reset-password.mjs --data ./data-test   指向别的数据目录
 *
 * 只动 settings 表里的 admin_salt / admin_hash 两行，
 * 游戏、价格表、客户、订单、凭证一概不碰。
 * 注意：清掉登录密码不会影响保险箱——保险箱密码是另一套。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const args = process.argv.slice(2)
const dataIdx = args.findIndex((a) => a === '--data')
let dataDir = path.join(process.cwd(), 'data')
if (dataIdx >= 0) {
  dataDir = path.resolve(process.cwd(), args[dataIdx + 1] || 'data')
  args.splice(dataIdx, 2)
}
const newPassword = args[0] || ''

const dbFile = path.join(dataDir, 'console.db')
if (!fs.existsSync(dbFile)) {
  console.error(`没有找到数据库：${dbFile}`)
  process.exit(1)
}

const db = new DatabaseSync(dbFile)
const before = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n

if (!newPassword) {
  const info = db.prepare("DELETE FROM settings WHERE key IN ('admin_salt', 'admin_hash')").run()
  console.log(`已清除登录密码（删除 ${info.changes} 行）。`)
  console.log('下次启动会回到初始化引导，重新设一个登录密码即可。')
} else {
  if (newPassword.length < 6) {
    console.error('新密码至少 6 位。')
    db.close()
    process.exit(1)
  }
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(newPassword, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex')
  const put = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  )
  const now = new Date().toISOString()
  put.run('admin_salt', salt, now)
  put.run('admin_hash', hash, now)
  console.log(`登录密码已设为：${newPassword}`)
}

const after = db.prepare('SELECT COUNT(*) AS n FROM settings').get().n
const games = db.prepare('SELECT COUNT(*) AS n FROM games').get().n
const cats = db.prepare('SELECT COUNT(*) AS n FROM service_categories').get().n
const svcs = db.prepare('SELECT COUNT(*) AS n FROM services').get().n
const orders = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n
console.log('')
console.log(`库：${dbFile}`)
console.log(`settings 行数 ${before} → ${after}`)
console.log(`其它数据原封不动：${games} 个游戏 / ${cats} 个大类 / ${svcs} 个服务项 / ${orders} 张订单`)
db.close()
