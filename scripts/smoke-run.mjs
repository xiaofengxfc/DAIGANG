/**
 * 冒烟测试的运行器：自己起一个干净实例，跑完自己收尾。
 *
 *   npm run test
 *
 * 为什么要它：scripts/smoke.mjs 以前必须先在另一个终端手工起实例
 * （set XFC_DATA_DIR=./data-smoke && node server.mjs --port 8790 --local），
 * 于是没人顺手跑，测试红了两项也没人发现。现在一条命令就够。
 *
 * 做法：
 *   1. 先把 XFC_DATA_DIR 指到一个一次性目录，再动态 import 应用
 *      （配置在模块加载时读环境变量，所以顺序不能反）；
 *   2. 用 createApplication() 建应用，listen(0) 让系统分配空闲端口，
 *      不跟正在运行的 8787 实例抢端口；
 *   3. 把地址通过 XFC_BASE 交给 smoke.mjs，跑完关服务、关库、删数据目录。
 *
 * 全绿就删掉数据目录；有失败就留着，方便进目录里翻库和上传件。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = path.resolve(process.env.XFC_SMOKE_DATA_DIR || path.join(ROOT, 'data-smoke-run'))
const KEEP = process.env.XFC_SMOKE_KEEP === '1'

/**
 * 这个脚本干的第一件事就是**递归删掉数据目录**，所以目录得先过安检。
 *
 * 两条都过才算安全：
 *   1. 不在项目根目录或它的上级（含盘符根——注意不能简单地 d + path.sep，
 *      盘符根本身就带分隔符，拼出来是两个反斜杠，反而放行了）；
 *   2. 要么在系统临时目录里，要么目录名以 data-smoke 开头
 *      （这个脚本只该碰自己那类一次性目录；想放别处就用临时目录）。
 */
function unsafeReason(dir) {
  if (dir === ROOT) return '它就是项目根目录'
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep
  if (ROOT.startsWith(prefix)) return '它是项目根目录的上级'
  const inTemp = dir.startsWith(path.resolve(os.tmpdir()) + path.sep)
  if (!inTemp && !path.basename(dir).startsWith('data-smoke')) return '目录名不以 data-smoke 开头，也不在系统临时目录里'
  return ''
}

const reason = unsafeReason(DATA_DIR)
if (reason) {
  console.error(`\n  拒绝把「${DATA_DIR}」当作冒烟测试的数据目录：${reason}。\n  这个目录会被整个删掉重建，换个名字（data-smoke-xxx）或用 XFC_SMOKE_DATA_DIR 指到临时目录。\n`)
  process.exit(2)
}

// 每次都要一个没初始化过的库：第一项断言就是「未初始化时 setup=false」
fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.mkdirSync(DATA_DIR, { recursive: true })

// 必须在 import 应用之前设好（src/config.mjs 在模块加载时读环境变量）
process.env.XFC_DATA_DIR = DATA_DIR
process.env.XFC_LOCAL = '1'
process.env.XFC_MEDIA_EXECUTOR_AUTOSTART = '0' // 别让冒烟测试顺手拉起 Python 执行器
process.env.XFC_MEDIA_SCHEDULER_INTERVAL_MS = '0' // 关掉定时发布轮询，测试里不需要

const { createApplication } = await import('../src/server/app.mjs')
const { db } = await import('../src/db.mjs')

const app = createApplication()
await new Promise((resolve, reject) => {
  app.server.once('error', reject)
  app.server.listen(0, '127.0.0.1', resolve)
})
const { port } = app.server.address()
process.env.XFC_BASE = `http://127.0.0.1:${port}`

console.log(`\n  冒烟测试实例：http://127.0.0.1:${port}（数据目录 ${DATA_DIR}）`)

let result = null
let crashed = null
try {
  const { run } = await import('./smoke.mjs')
  result = await run()
} catch (err) {
  crashed = err
}

await new Promise((resolve) => app.server.close(resolve))
try {
  db.close()
} catch {
  /* 关不掉就算了，进程马上要退 */
}

const failed = Boolean(crashed) || !result || result.failures.length > 0
if (crashed) console.error('\n冒烟测试崩了：', crashed)

if (failed || KEEP) console.log(`\n  数据目录保留在 ${DATA_DIR}（不需要就删掉）\n`)
else fs.rmSync(DATA_DIR, { recursive: true, force: true })

process.exitCode = failed ? 1 : 0
