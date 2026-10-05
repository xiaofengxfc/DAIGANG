/**
 * 冒烟测试的运行器：自己起一个干净实例，跑完自己收尾。
 *
 *   npm run test
 *
 * 为什么要它：scripts/smoke.mjs 以前必须先在另一个终端手工起实例
 * （set XFC_DATA_DIR=./data-smoke && node server.mjs --port 8790 --local），
 * 于是没人顺手跑，测试红了两项也没人发现。现在一条命令就够。
 *
 * 起实例、分端口、数据目录安检都在 scripts/lib/test-app.mjs 里（UI 冒烟共用同一份）。
 *
 * 全绿就删掉数据目录；有失败就留着，方便进目录里翻库和上传件。
 */
import fs from 'node:fs'
import { resolveDataDir, startTestApp } from './lib/test-app.mjs'

const KEEP = process.env.XFC_SMOKE_KEEP === '1'

let dataDir = ''
try {
  dataDir = resolveDataDir()
} catch (err) {
  console.error(`\n  ${err.message}\n`)
  process.exit(2)
}

const app = await startTestApp({ dataDir })
process.env.XFC_BASE = app.base

console.log(`\n  冒烟测试实例：${app.base}（数据目录 ${app.dataDir}）`)

let result = null
let crashed = null
try {
  const { run } = await import('./smoke.mjs')
  result = await run()
} catch (err) {
  crashed = err
}

await app.stop()

const failed = Boolean(crashed) || !result || result.failures.length > 0
if (crashed) console.error('\n冒烟测试崩了：', crashed)

if (failed || KEEP) console.log(`\n  数据目录保留在 ${app.dataDir}（不需要就删掉）\n`)
else fs.rmSync(app.dataDir, { recursive: true, force: true })

process.exitCode = failed ? 1 : 0
