/* ============================================================
   屏幕识别自检：用 shots/samples/ 里的真截图验证「换分辨率还认不认得出」。

   为什么要有这个脚本：识别这块的分数和画面物理尺寸、宽高比都有关系，
   调一次阈值很容易在某个分辨率上悄悄退化（开发过程中就真的退化过两次：
   一次是紧裁模板把锚点弄丢了，一次是按画面高度估图标大小，超宽屏整个错掉）。
   所以留一个能反复跑的自检，改完 `src/vision.mjs` / `src/screen.mjs` / `src/ocr.mjs`
   就 `node scripts/vision-selftest.mjs` 过一遍。

   一个游戏一条（现在两条：鸣潮的武器页、异环的背包页和地图页），
   每条带自己的期望值 —— 两个游戏的图标大小、画风、取数页面都不一样，
   混在一起比等于没比（异环的图标只有鸣潮的 65%，早期拿鸣潮的尺度去扫它，
   一个都找不到）。

   它不需要起服务器、不碰数据库，只读 shots/samples/ 里的图。
   没有样例图就跳过（不会让 check 失败）。

   用法：
     node scripts/vision-selftest.mjs              # 全部
     node scripts/vision-selftest.mjs --quick      # 每套只跑两个分辨率
     node scripts/vision-selftest.mjs --game=异环  # 只跑一个游戏
     node scripts/vision-selftest.mjs --json       # 输出 JSON（给别的脚本用）
     node scripts/vision-selftest.mjs --backend=python   # 只跑 Python 视觉后端
     node scripts/vision-selftest.mjs --backend=node     # 只跑旧的引擎链

   `--backend` 是把 XFC_OCR_ENGINE 设成那一个引擎（见 src/ocr.mjs 的 ocrImage），
   用来做「同一个后端在不同机器/版本上的对照」。scripts/vision-parity.mjs
   就是拿它把两个后端各跑一遍再逐档比的。
   ============================================================ */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { decodePNG } from '../src/imgmatch.mjs'
import { resampleBilinear } from '../src/vision.mjs'
import { recognizeFrame, recognizeImageFile, ocrTopBand, templateStatus, loadTemplates, grabScreen } from '../src/screen.mjs'
import { ensureEnginesProbed, ocrEngines } from '../src/ocr.mjs'
import { ensureVisionStarted } from '../src/vision-python.mjs'
import { scratchFile } from '../src/util.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const args = new Set(argv)
const QUICK = args.has('--quick')
const AS_JSON = args.has('--json')
const ONLY_GAME = (argv.find((a) => a.startsWith('--game=')) || '').split('=')[1] || ''
const BACKEND = (argv.find((a) => a.startsWith('--backend=')) || '').split('=')[1] || ''

/**
 * --backend=python → 强制走 Python 视觉后端（并先把 sidecar 拉起来）；
 * --backend=node   → 强制走旧引擎链里最强的那个（RapidOCR-json 优先，没有就用系统自带）。
 * 两者都靠 XFC_OCR_ENGINE 生效，所以 ocrImage 那一条路只认一个引擎，
 * 不会「说是 python 其实偷偷用了 rapidocr」。
 */
if (BACKEND === 'python') {
  process.env.XFC_OCR_ENGINE = 'python'
  const started = await ensureVisionStarted()
  if (!started.ok) {
    console.error(`Python 视觉后端起不来，没法按 --backend=python 自检：${started.error}`)
    console.error('（先在设置页点「一键安装依赖」，或者去掉 --backend 跑默认那条路）')
    process.exit(1)
  }
} else if (BACKEND === 'node') {
  const engines = ocrEngines().engines
  const pick = ['rapidocr', 'paddleocr', 'windows'].find((id) => engines.find((e) => e.id === id)?.available)
  if (!pick) {
    console.error('这台机器上旧引擎链里一个可用的都没有，没法按 --backend=node 自检')
    process.exit(1)
  }
  process.env.XFC_OCR_ENGINE = pick
} else if (BACKEND) {
  process.env.XFC_OCR_ENGINE = BACKEND
}

/* 分辨率档位：从 720p 到 4K 都来一遍，再加几档超宽比例。 */
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

/**
 * 异环只跑常规比例那几档。
 *
 * 它的样例图是 2559×1599 的真截图，缩到超宽比例等于把画面横向压扁
 * （自检不保留宽高比，只按给定尺寸重采样），图标跟着变形 —— 那测的就不是
 * 「异环认不认得出」，而是「变形到什么程度会认不出」。超宽那条上限
 * 由鸣潮那套覆盖就够了（它本来就是按「UI 按高度缩」写的）。
 */
const NTE_SIZES = [
  [1280, 800],
  [1920, 1200],
  [2559, 1599],
  [3840, 2400],
]

/* ============================================================
   每一套：一个游戏的一张真截图 + 期望值。
   keys 是这一屏实际会有哪几个资源 —— 前端也是这么传的（见 /api/ocr/screen），
   传了它识别就只找这几个，所以自检也要按同样的姿势跑。
   ============================================================ */
const CASES = [
  {
    game: '鸣潮',
    sample: 'weapon-list.png',
    keys: null,
    expect: { 星声: 2174, 贝币: 2508319 },
    sizes: ALL_SIZES,
    note: '鸣潮顶栏（武器页）：星声 2174、贝币 2508319',
  },
  {
    game: '异环',
    sample: 'nte-bag.png',
    keys: ['甲硬币', '方斯', '环石'],
    expect: { 甲硬币: 929484, 方斯: 4116889, 环石: 3087 },
    sizes: NTE_SIZES,
    note: '异环背包页：甲硬币 929484、方斯 4116889、环石 3087（画风亮而光滑，走 maskedNcc 口径）',
  },
  {
    game: '异环',
    sample: 'nte-map.png',
    keys: ['都市活力', '体力'],
    expect: { 都市活力: 0, 体力: 255 },
    sizes: NTE_SIZES,
    note: '异环地图页：都市活力 0/700 取 0（allowZero）、体力 255/320 取 255',
  },
].filter((c) => !ONLY_GAME || c.game === ONLY_GAME)

/* ============================================================
   截屏自检：截出来的必须是**整屏**，不能是被 DPI 虚拟化裁掉的一块。

   为什么单独有这一条：scripts/grab.ps1 以前没做 DPI 感知，在 150% 缩放的
   2560x1600 屏上它以为屏幕是 1707x1067，CopyFromScreen 就只抓了左上角那一块
   （不是整屏缩小）。而游戏顶栏的资源图标在画面宽度 ~89% 处，正好全落在被裁掉的
   部分里 —— 于是一个数字都认不出来。上面那些分辨率全对也没用，因为自检喂的是
   图片文件、界面冒烟也不会真去截屏，这个 bug 一直没被测到。

   判据：用 scripts/screen-info.ps1 问系统要主屏的**真实显示模式**
   （EnumDisplaySettings，不受 DPI 虚拟化影响 —— 而 GetSystemMetrics / Screen.Bounds
   在不感知 DPI 的进程里给的是 1707x1067 这种虚拟值，拿它比对等于自己跟自己比），
   再和截出来的图比。不一致就说明截屏那条路又退回虚拟化了。
   截不了屏（无桌面 / 权限）就跳过，不算失败。
   ============================================================ */

const SCREEN_INFO_PS1 = path.join(ROOT, 'scripts', 'screen-info.ps1')

function physicalScreenSize() {
  if (process.platform !== 'win32') return null
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCREEN_INFO_PS1], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  })
  const m = /(\d+)\s*x\s*(\d+)/.exec(String(ps.stdout || ''))
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

// 截屏自检自己也得能在「系统临时目录写不进去」的环境里跑 ——
// 它正是用来判断截屏对不对的那个工具，不能比被测的程序更娇气。
const grabTmp = scratchFile('xfc-selftest-grab', '.png', { mode: 'ascii' })
let captured = null
let grabError = ''
try {
  const g = await grabScreen(grabTmp)
  if (!g.ok) grabError = g.error || '截屏失败'
  else {
    try {
      captured = decodePNG(fs.readFileSync(grabTmp))
    } catch (err) {
      grabError = `截到的图自己解不了像素：${err.message}`
    }
  }
} catch (err) {
  grabError = err.message
} finally {
  try {
    fs.unlinkSync(grabTmp)
  } catch {
    /* 清不掉就算了 */
  }
}

const phys = captured ? physicalScreenSize() : null
const virtualized =
  captured && phys && captured.width < phys.width && [1.25, 1.5, 1.75, 2, 2.25, 2.5, 3].some((f) => Math.abs(phys.width / captured.width - f) < 0.05)
let captureFailure = ''
if (!captured) {
  console.log(`截屏自检：跳过（${grabError}）`)
} else if (virtualized) {
  captureFailure =
    `截出来的画面只有 ${captured.width}x${captured.height}，而这块屏的物理分辨率是 ${phys.width}x${phys.height}` +
    `（差 ${(phys.width / captured.width).toFixed(2)} 倍）—— 截屏没做 DPI 感知，只抓到了左上角一块。` +
    '游戏顶栏的资源图标在画面宽度 ~89% 处，会被整个裁掉，一个数字都认不出来。检查 scripts/grab.ps1 的 DPI 那一段。'
  console.log(`截屏自检：失败 —— ${captureFailure}`)
} else {
  console.log(
    `截屏自检：截到 ${captured.width}x${captured.height}` +
      (phys ? `，物理屏 ${phys.width}x${phys.height} —— 整屏，DPI 感知正常` : '（问不到物理屏尺寸，跳过比对）')
  )
}
console.log('')

if (!CASES.length) {
  console.log(`跳过：--game=${ONLY_GAME} 没有对应的样例（现在有 ${[...new Set(['鸣潮', '异环'])].join('、')}）`)
  process.exit(captureFailure ? 1 : 0)
}

// 真探一次（Umi-OCR 在不在只有发过请求才知道），这样自检用的引擎
// 和实际识别时用的引擎是同一个 —— 不然冷启动时会拿着 RapidOCR 跑，
// 报出来的引擎名也是错的。
const st = await ensureEnginesProbed()
if (!st.available) {
  console.log('跳过：这台机器上没有可用的 OCR 引擎')
  process.exit(captureFailure ? 1 : 0)
}

const tpl = templateStatus()
const report = []
let pass = 0
let total = 0
let widePass = 0
let wideTotal = 0
let ranCases = 0

for (const c of CASES) {
  const samplePath = path.join(ROOT, 'shots', 'samples', c.sample)
  const tplForGame = templateStatus(c.game)
  // 样例图是本地东西（shots/ 不进库），缺了就跳过这一套，不算失败 ——
  // 但一张都没有时整个脚本等于什么都没验，那就该说清楚（见下面的收尾）。
  if (!fs.existsSync(samplePath)) {
    console.log(`跳过 ${c.game} / ${c.sample}：没有这张样例图（放进 shots/samples/ 就能跑）`)
    continue
  }
  ranCases += 1
  const wantKeys = Object.keys(c.expect)
  const sizes = QUICK ? c.sizes.filter((_, i) => i === 1 || i === 2).slice(0, 2) : c.sizes
  const src = decodePNG(fs.readFileSync(samplePath))

  console.log(`── ${c.game} · ${c.sample} ──`)
  console.log(`   ${c.note}`)
  console.log(`   模板：${tplForGame.items.map((i) => `${i.key}(${i.w}×${i.h},${i.from})`).join(' ')}`)
  console.log('')
  console.log('   分辨率        锚点                结果                              带缩放  冷态     热态')

  const rows = []
  for (const [W, H, opt] of sizes) {
    const img = resampleBilinear(src, W, H)
    const bandH = Math.max(48, Math.round(H * 0.14))
    const t0 = Date.now()
    const ocr = await ocrTopBand(img, bandH)
    const frame = ocr.ok ? recognizeFrame(img, ocr.words, { profile: c.game, keys: c.keys }) : { hits: [], seen: [], anchor: null }
    const ms = Date.now() - t0
    /**
     * 再来一遍，记「热态」耗时。
     *
     * 为什么要两遍：第一遍是冷启动 —— 锚点没定过标（要整条带扫一遍所有尺度），
     * OCR 也可能撞上新形状。实测冷 2.8s / 热 1.1s，差两倍多。
     * 用户点一次「识别画面」会连认好几帧，所以**热态那个数才是他日常感受到的速度**，
     * 而冷态那个数是「第一次点要等多久」。两个都报，别只报好看的那个。
     */
    const t1 = Date.now()
    const ocr2 = await ocrTopBand(img, bandH)
    const frame2 = ocr2.ok ? recognizeFrame(img, ocr2.words, { profile: c.game, keys: c.keys }) : { hits: [], seen: [], anchor: null }
    const msWarm = Date.now() - t1
    const got = Object.fromEntries(frame.hits.map((h) => [h.key, h.value]))
    const smallText = frame.hits.filter((h) => h.warn).map((h) => h.key)
    const wrong = wantKeys.filter((k) => got[k] !== c.expect[k])
    const row = {
      game: c.game,
      sample: c.sample,
      size: `${W}x${H}`,
      ultrawide: Boolean(opt && opt.ultrawide),
      anchor: frame.anchor ? `${frame.anchor.key}@${frame.anchor.score}` : null,
      got,
      wrong,
      small_text: smallText,
      band_scale: ocr.band_scale,
      ocr_ms: ocr.ms,
      ms,
      ms_warm: msWarm,
      warm_got: Object.fromEntries(frame2.hits.map((h) => [h.key, h.value])),
    }
    rows.push(row)
    if (row.ultrawide) {
      wideTotal += wantKeys.length
      widePass += wantKeys.length - wrong.length
    } else {
      total += wantKeys.length
      pass += wantKeys.length - wrong.length
    }
    if (opt && opt.ultrawide && wrong.length) {
      // 超宽屏的已知上限：字太小导致自带 OCR 读错位数。只记录一下
      // （界面上还会另外标「字太小」，认出来的数字也一律要人工核对）。
      row.silent_wrong = wrong.filter((k) => !smallText.includes(k))
    }
  }

  for (const r of rows) {
    const cells = wantKeys.map((k) => `${k}=${r.got[k] ?? '—'}${r.got[k] === c.expect[k] ? '' : ' ✗'}`)
    const tag = r.ultrawide ? ' (超宽)' : ''
    const note = r.small_text.length ? `  [字太小:${r.small_text.join(',')}]` : ''
    console.log(
      `   ${(r.size + tag).padEnd(14)}${(r.anchor || '无锚点').padEnd(19)} ${cells.join('  ').padEnd(34)} ${String(r.band_scale ?? '-').padStart(5)}x ${String(r.ms).padStart(6)}ms ${String(r.ms_warm).padStart(6)}ms${note}`
    )
  }

  // 真实入口（含 PNG 解码、只 OCR 顶栏那条带）
  let entry = null
  try {
    const r = await recognizeImageFile(samplePath, { game: c.game, keys: c.keys })
    entry = { resources: r.resources, anchor: r.anchor, engine: r.engine, pixel: r.pixel }
  } catch (err) {
    entry = { error: err.message }
  }
  // 真实入口也压进通过线：它多走了解码和「只认顶栏那条带」两步，
  // 分辨率那一圈全对、这条路却挂了的事发生过，所以两边都要管住。
  const entryWrong = entry.error ? wantKeys : wantKeys.filter((k) => entry.resources?.[k] !== c.expect[k])
  total += wantKeys.length
  pass += wantKeys.length - entryWrong.length
  const caseRows = rows.filter((r) => !r.ultrawide)
  const casePass = caseRows.reduce((n, r) => n + (wantKeys.length - r.wrong.length), 0)
  const caseTotal = caseRows.length * wantKeys.length
  console.log('')
  console.log(`   真实入口 recognizeImageFile：${entry.error ? '失败 ' + entry.error : JSON.stringify(entry.resources)}`)
  console.log(`   ${c.game} / ${c.sample} 常规比例准确率：${casePass}/${caseTotal}，真实入口 ${wantKeys.length - entryWrong.length}/${wantKeys.length}`)
  console.log('')
  report.push({ ...c, rows, entry })
}

const wideSilent = report.flatMap((c) => c.rows.filter((r) => r.silent_wrong && r.silent_wrong.length).flatMap((r) => r.silent_wrong))

if (!ranCases) {
  console.log(`跳过：shots/samples/ 里一张对的上的样例图都没有（这一遍等于什么都没验）`)
  process.exit(captureFailure ? 1 : 0)
}

if (AS_JSON) {
  console.log(JSON.stringify({ templates: tpl, engines: { engine: st.engine, name: st.engine_name }, backend: BACKEND || 'auto', forced_engine: process.env.XFC_OCR_ENGINE || '', cases: report, pass, total, widePass, wideTotal }, null, 2))
  process.exit(pass === total && !captureFailure ? 0 : 1)
}

console.log('（冷态＝第一次点「识别画面」要等多久；热态＝同一分辨率再认一帧要多久。识别一屏会连认好几帧。）')
console.log(`引擎：${st.engine_name || st.engine}${BACKEND ? `（--backend=${BACKEND} 强制：${process.env.XFC_OCR_ENGINE}）` : ''}`)
console.log(`常规比例准确率（含真实入口）：${pass}/${total}`)
if (wideTotal) {
  console.log(`超宽比例（游戏 UI 按高度缩，自带 OCR 有上限）：${widePass}/${wideTotal}`)
  if (widePass < wideTotal) {
    console.log('  超宽那几档读错位数是**已知上限**（顶栏字只有 14~25px，Windows 自带 OCR 就这个水平）。')
    console.log('  这不是失败 —— 认出来的数字一律要人工核对，界面上还会额外标「字太小」。')
    console.log('  想在这种分辨率下也认准：装一个本地 OCR 引擎（设置页有指引）。')
  }
}

// 通过线压在三件真事上：
//   1. 常规比例必须全对（这是「任何分辨率都能用」的承诺）；
//   2. 不许崩、不许静默给出明显不合理的位数；
//   3. 截屏必须是整屏（不然上面全对也没用，真用起来一个都认不出来）。
// 超宽那条上限算已知情况，只报告不判失败。
const absurd = report.flatMap((c) => c.rows).filter((r) => Object.entries(r.got).some(([, v]) => v !== undefined && v !== null && String(v).length > 9))
const ok = pass === total && !absurd.length && !captureFailure && ranCases > 0
if (!ok) {
  if (captureFailure) console.log(`\n失败（截屏）：${captureFailure}`)
  if (absurd.length) console.log(`\n失败：${absurd.map((r) => `${r.game}/${r.size}`).join('、')} 上出现了明显不合理的位数（>9 位）`)
  if (pass !== total) console.log('\n失败：常规比例下有分辨率没认对（见上面标 ✗ 的那些）')
  if (!ranCases) console.log('\n失败：一张样例图都没跑（无从判断识别有没有退化）')
  process.exit(1)
}
console.log('\n通过')
void loadTemplates
