/* ============================================================
   屏幕识别的后端对照（P0）：同一批样例图 × 同一批分辨率，
   把「旧引擎链」和「Python 视觉后端」各跑一遍，逐档比。

   为什么要有这个脚本：换 OCR 后端这件事**不能靠感觉**。识别这块的分数
   和画面尺寸、宽高比都有关系，凭「我试了几张都对」很容易在某档悄悄退化
   （README 里记过两次这种回归）。所以先用同一条自检路径把两个后端的结果
   并排列出来，谁在哪一档退化了当场就能看见。

   它不自己起 sidecar，而是让每次自检去起自己的 —— 两次运行是隔离的，
   不会互相抢 5410 端口。跑完各自会收掉（sidecar 盯着父进程的管道，
   父进程一退它就退）。

   用法：
     node scripts/checks/vision-parity.mjs              # 全部 11 档
     node scripts/checks/vision-parity.mjs --quick      # 只跑两档（快，看个大概）
     node scripts/checks/vision-parity.mjs --json       # 输出 JSON

   退出码：Python 后端在**常规比例**上不如旧引擎链 → 1（这条是切默认的门槛）。
   ============================================================ */

import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ocrEngines } from '../../src/vision/ocr.mjs'
import { visionDependencyStatusCached } from '../../src/vision/vision-deps.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SELFTEST = path.join(ROOT, 'scripts', 'vision-selftest.mjs')
const argv = process.argv.slice(2)
const QUICK = argv.includes('--quick')
const AS_JSON = argv.includes('--json')
const TIMEOUT_MS = 15 * 60 * 1000

/** 跑一次自检，把它的 --json 结果捞出来 */
function runBackend(backend) {
  const args = [SELFTEST, '--json']
  if (QUICK) args.push('--quick')
  args.push(`--backend=${backend}`)
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
  const stdout = String(r.stdout || '')
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) {
    return { ok: false, backend, error: `${String(r.stderr || '').trim().slice(-500) || '没有 JSON 输出'}`, stdout: stdout.slice(-500) }
  }
  try {
    return { ok: true, backend, data: JSON.parse(stdout.slice(start, end + 1)) }
  } catch (err) {
    return { ok: false, backend, error: `JSON 读不了：${err.message}` }
  }
}

/** 把某一档的命中结果压成一行文字 */
function cells(row) {
  return Object.entries(row.got)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
}

function median(list) {
  if (!list.length) return 0
  const s = [...list].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const engines = ocrEngines().engines
const nodeEngine = ['rapidocr', 'paddleocr', 'windows'].find((id) => engines.find((e) => e.id === id)?.available) || ''
const deps = visionDependencyStatusCached()

console.log('屏幕识别后端对照')
console.log(`  旧引擎链（--backend=node）会用：${nodeEngine || '(这台机器上没有可用的旧引擎)'}`)
console.log(`  Python 视觉后端：${deps ? (deps.ready ? '依赖已就绪' : '依赖没装齐') : '依赖状态还没探过（这次会现探）'}`)
console.log('')

const nodeRun = nodeEngine ? runBackend('node') : { ok: false, backend: 'node', error: '没有可用的旧引擎' }
const pyRun = runBackend('python')

if (!nodeRun.ok) console.log(`旧引擎链这一轮没跑成：${nodeRun.error}`)
if (!pyRun.ok) console.log(`Python 视觉后端这一轮没跑成：${pyRun.error}`)

if (!nodeRun.ok || !pyRun.ok) {
  if (AS_JSON) console.log(JSON.stringify({ node: nodeRun, python: pyRun }, null, 2))
  console.log('\n没法对照：两个后端都得跑起来才能比。')
  console.log('  · Python 那边起不来 → 设置 → 屏幕识别 → Python 视觉后端 → 「一键安装依赖」')
  console.log('  · 旧引擎链那边起不来 → 设置 → 屏幕识别 → 安装选项，装一个 RapidOCR-json')
  process.exit(2)
}

const nodeRows = new Map(nodeRun.data.rows.map((r) => [r.size, r]))
const pyRows = new Map(pyRun.data.rows.map((r) => [r.size, r]))
const sizes = [...nodeRows.keys()]

const table = []
for (const size of sizes) {
  const a = nodeRows.get(size)
  const b = pyRows.get(size)
  const same = cells(a) === cells(b)
  table.push({
    size,
    ultrawide: Boolean(a.ultrawide),
    node: { got: a.got, wrong: a.wrong, ms: a.ms, ms_warm: a.ms_warm, ocr_ms: a.ocr_ms },
    python: { got: b.got, wrong: b.wrong, ms: b.ms, ms_warm: b.ms_warm, ocr_ms: b.ocr_ms },
    same,
  })
}

const nodeMs = table.map((r) => r.node.ms_warm || r.node.ms)
const pyMs = table.map((r) => r.python.ms_warm || r.python.ms)
const nodeOcr = table.map((r) => r.node.ocr_ms).filter((v) => typeof v === 'number')
const pyOcr = table.map((r) => r.python.ocr_ms).filter((v) => typeof v === 'number')
const nodeWrong = table.filter((r) => r.node.wrong.length).length
const pyWrong = table.filter((r) => r.python.wrong.length).length
const pyBetter = table.filter((r) => r.python.wrong.length < r.node.wrong.length).length
const pyWorse = table.filter((r) => r.python.wrong.length > r.node.wrong.length).length

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        node_engine: nodeEngine,
        node: { pass: nodeRun.data.pass, total: nodeRun.data.total, wide_pass: nodeRun.data.widePass, wide_total: nodeRun.data.wideTotal, engine: nodeRun.data.engines },
        python: { pass: pyRun.data.pass, total: pyRun.data.total, wide_pass: pyRun.data.widePass, wide_total: pyRun.data.wideTotal, engine: pyRun.data.engines },
        table,
      },
      null,
      2
    )
  )
} else {
  console.log(`旧引擎链：${nodeRun.data.engines.name || nodeEngine}     Python 后端：${pyRun.data.engines.name || 'python'}`)
  console.log('')
  console.log('分辨率         旧引擎链                             Python 后端                          冷/热(旧)        冷/热(Py)')
  for (const r of table) {
    const tag = r.ultrawide ? '(超宽)' : ''
    const a = `${cells(r.node) || '(没认出来)'}${r.node.wrong.length ? ' ✗' : ''}`
    const b = `${cells(r.python) || '(没认出来)'}${r.python.wrong.length ? ' ✗' : ''}`
    const ta = `${r.node.ms}/${r.node.ms_warm}`
    const tb = `${r.python.ms}/${r.python.ms_warm}`
    console.log(`${(r.size + tag).padEnd(14)} ${a.padEnd(35)} ${b.padEnd(35)} ${ta.padStart(8)}ms ${tb.padStart(8)}ms`)
  }
  console.log('')
  console.log(`常规比例：旧 ${nodeRun.data.pass}/${nodeRun.data.total}    Python ${pyRun.data.pass}/${pyRun.data.total}`)
  if (nodeRun.data.wideTotal) {
    console.log(`超宽比例：旧 ${nodeRun.data.widePass}/${nodeRun.data.wideTotal}    Python ${pyRun.data.widePass}/${pyRun.data.wideTotal}`)
  }
  console.log(`有错的档数：旧 ${nodeWrong}    Python ${pyWrong}    （Python 更好 ${pyBetter} 档 / 更差 ${pyWorse} 档）`)
  console.log(`热态整帧中位数：旧 ${median(nodeMs)}ms    Python ${median(pyMs)}ms`)
  if (nodeOcr.length && pyOcr.length) {
    console.log(`光看 OCR 那一段中位数：旧 ${median(nodeOcr)}ms    Python ${median(pyOcr)}ms`)
  }
  console.log('')
  console.log('冷/热：冷＝第一次点「识别画面」（锚点没定过标，要整条带扫一遍尺度）；热＝同一分辨率再认一帧。')
  console.log('     识别一屏会连认好几帧，所以日常感受到的是「热」那个数；「冷」是第一次点要等多久。')
  console.log('')
  if (pyWorse > 0) {
    console.log(`结论：Python 后端在 ${pyWorse} 档上比旧引擎链差 —— 先别切默认，去上面标 ✗ 的那几档查原因。`)
  } else if (pyBetter > 0) {
    console.log(`结论：Python 后端在 ${pyBetter} 档上比旧引擎链好，且没有更差的档 —— 可以切默认。`)
  } else {
    console.log('结论：两个后端打平。Python 那边的价值在别处（置信度、数字块 rec-only、少几个外部依赖）。')
  }
}

process.exit(pyWorse > 0 ? 1 : 0)
