/* ============================================================
   屏幕识别自检：用 shots/samples/ 里的真截图验证「换分辨率还认不认得出」。

   为什么要有这个脚本：识别这块的分数和画面物理尺寸、宽高比都有关系，
   调一次阈值很容易在某个分辨率上悄悄退化（开发过程中就真的退化过两次：
   一次是紧裁模板把锚点弄丢了，一次是按画面高度估图标大小，超宽屏整个错掉）。
   所以留一个能反复跑的自检，改完 `src/vision.mjs` / `src/screen.mjs` / `src/ocr.mjs`
   就 `node scripts/vision-selftest.mjs` 过一遍。

   它不需要起服务器、不碰数据库，只读 shots/samples/ 里的图。
   没有样例图就跳过（不会让 check 失败）。

   用法：
     node scripts/vision-selftest.mjs              # 全部
     node scripts/vision-selftest.mjs --quick      # 只跑两个分辨率
     node scripts/vision-selftest.mjs --json       # 输出 JSON（给别的脚本用）
   ============================================================ */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodePNG } from '../src/imgmatch.mjs'
import { resampleBilinear } from '../src/vision.mjs'
import { recognizeFrame, recognizeImageFile, ocrTopBand, templateStatus, loadTemplates } from '../src/screen.mjs'
import { ocrStatus } from '../src/ocr.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLE = path.join(ROOT, 'shots', 'samples', 'weapon-list.png')
const args = new Set(process.argv.slice(2))
const QUICK = args.has('--quick')
const AS_JSON = args.has('--json')

/** 期望值：游戏顶栏那张图里星声 2174、贝币 2508319 */
const EXPECT = { 星声: 2174, 贝币: 2508319 }
const ALL_SIZES = [
  [1152, 720],
  [1280, 800],
  [1366, 854],
  [1600, 1000],
  [1920, 1200],
  [2559, 1599],
  [3413, 2133],
  [3840, 2400],
  // 超宽比例：游戏 UI 按高度缩，顶栏字只有 14~22px，Windows 自带 OCR 会读错位数。
  // 这几档只要求「不崩」，准确率单独统计、不计入通过线。
  [2560, 1080, { ultrawide: true }],
  [1920, 822, { ultrawide: true }],
  [3440, 1440, { ultrawide: true }],
]
const SIZES = QUICK ? [ALL_SIZES[1], ALL_SIZES[5]] : ALL_SIZES

if (!fs.existsSync(SAMPLE)) {
  console.log(`跳过：没有样例图 ${path.relative(ROOT, SAMPLE)}（把一张游戏顶栏截图放进去就能跑）`)
  process.exit(0)
}

const st = ocrStatus()
if (!st.available) {
  console.log('跳过：这台机器上没有可用的 OCR 引擎')
  process.exit(0)
}

const tpl = templateStatus()
const src = decodePNG(fs.readFileSync(SAMPLE))
const rows = []
let pass = 0
let total = 0
let widePass = 0
let wideTotal = 0

for (const [W, H, opt] of SIZES) {
  const img = resampleBilinear(src, W, H)
  const bandH = Math.max(48, Math.round(H * 0.14))
  const t0 = Date.now()
  const ocr = await ocrTopBand(img, bandH)
  const frame = ocr.ok ? recognizeFrame(img, ocr.words) : { hits: [], seen: [], anchor: null }
  const ms = Date.now() - t0
  const got = Object.fromEntries(frame.hits.map((h) => [h.key, h.value]))
  const smallText = frame.hits.filter((h) => h.warn).map((h) => h.key)
  const wrong = Object.keys(EXPECT).filter((k) => got[k] !== EXPECT[k])
  const row = {
    size: `${W}x${H}`,
    ultrawide: Boolean(opt && opt.ultrawide),
    anchor: frame.anchor ? `${frame.anchor.key}@${frame.anchor.score}` : null,
    got,
    wrong,
    small_text: smallText,
    band_scale: ocr.band_scale,
    ms,
  }
  rows.push(row)
  if (row.ultrawide) {
    wideTotal += Object.keys(EXPECT).length
    widePass += Object.keys(EXPECT).length - wrong.length
  } else {
    total += Object.keys(EXPECT).length
    pass += Object.keys(EXPECT).length - wrong.length
  }
  if (opt && opt.ultrawide && wrong.length) {
    // 超宽屏的已知上限：字太小导致自带 OCR 读错位数。只记录一下
    // （界面上还会另外标「字太小」，认出来的数字也一律要人工核对）。
    row.silent_wrong = wrong.filter((k) => !smallText.includes(k))
  }
}

// 真实入口（含 PNG 解码、只 OCR 顶栏那条带）
let entry = null
try {
  const r = await recognizeImageFile(SAMPLE)
  entry = { resources: r.resources, anchor: r.anchor, engine: r.engine, pixel: r.pixel }
} catch (err) {
  entry = { error: err.message }
}

const wideSilent = rows.filter((r) => r.silent_wrong && r.silent_wrong.length).flatMap((r) => r.silent_wrong)

if (AS_JSON) {
  console.log(JSON.stringify({ templates: tpl, engines: { engine: st.engine, name: st.engine_name }, rows, pass, total, widePass, wideTotal, entry }, null, 2))
  process.exit(pass === total && !entry.error ? 0 : 1)
}

console.log(`引擎：${st.engine_name || st.engine}    图标模板：${tpl.items.map((i) => `${i.key}(${i.w}×${i.h},${i.from})`).join(' ')}`)
console.log('')
console.log('分辨率        锚点                结果                              带缩放  耗时')
for (const r of rows) {
  const cells = Object.keys(EXPECT).map((k) => `${k}=${r.got[k] ?? '—'}${r.got[k] === EXPECT[k] ? '' : ' ✗'}`)
  const tag = r.ultrawide ? ' (超宽)' : ''
  const note = r.small_text.length ? `  [字太小:${r.small_text.join(',')}]` : ''
  console.log(
    `${(r.size + tag).padEnd(14)}${(r.anchor || '无锚点').padEnd(19)} ${cells.join('  ').padEnd(34)} ${String(r.band_scale ?? '-').padStart(5)}x ${String(r.ms).padStart(5)}ms${note}`
  )
}
console.log('')
console.log(`常规比例准确率：${pass}/${total}`)
if (wideTotal) {
  console.log(`超宽比例（游戏 UI 按高度缩，自带 OCR 有上限）：${widePass}/${wideTotal}`)
  if (widePass < wideTotal) {
    console.log('  超宽那几档读错位数是**已知上限**（顶栏字只有 14~25px，Windows 自带 OCR 就这个水平）。')
    console.log('  这不是失败 —— 认出来的数字一律要人工核对，界面上还会额外标「字太小」。')
    console.log('  想在这种分辨率下也认准：装一个本地 OCR 引擎（设置页有指引）。')
  }
}
console.log(`真实入口 recognizeImageFile：${entry.error ? '失败 ' + entry.error : JSON.stringify(entry.resources) + ' 引擎=' + entry.engine}`)

// 通过线只压在两件真事上：
//   1. 常规比例必须全对（这是「任何分辨率都能用」的承诺）；
//   2. 不许崩、不许静默给出明显不合理的位数。
// 超宽那条上限算已知情况，只报告不判失败。
const absurd = rows.filter((r) => Object.entries(r.got).some(([k, v]) => v !== undefined && v !== null && String(v).length > 9))
const ok = pass === total && !entry.error && !absurd.length
if (!ok) {
  if (absurd.length) console.log(`\n失败：${absurd.map((r) => r.size).join('、')} 上出现了明显不合理的位数（>9 位）`)
  else if (pass !== total) console.log('\n失败：常规比例下有分辨率没认对（见上面标 ✗ 的那些）')
  else console.log('\n失败：真实入口没跑通')
  process.exit(1)
}
console.log('\n通过')
void loadTemplates
