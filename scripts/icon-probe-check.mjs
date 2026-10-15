/**
 * 图标识别体检自检
 *
 * 这个脚本守的是「识别不准的时候我们有没有能力说清为什么」。
 *
 * 为什么值得单独一个文件：识别失败时用户只看到一句「还差体力」，但这背后
 * 至少三种毛病 —— 模板跟画面不是一个版本、分数差一点没过阈值、图标找到了
 * 但取数字那步失败。probeIcons() 就是把每个模板的真实分数摆出来的那个工具。
 * 它本身要是算错了，后面的排查全是误导，所以它自己得先被测住。
 *
 * 做法：**合成一张顶栏截图**（把真实的图标模板按 iconWidthRatio 贴到画面里），
 * 然后要求 probeIcons 能把这些图标认出来、分数明显高于没贴的那些。
 * 合成图不依赖任何现成的游戏截图，CI 里也能跑。
 *
 *   node scripts/icon-probe-check.mjs
 */
import fs from 'node:fs'
import { decodePNG, resize, encodePNG } from '../src/imgmatch.mjs'
import { probeIcons } from '../src/screen.mjs'
import { profileForGame } from '../shared/game-profiles.js'

let pass = 0
const failures = []

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail === undefined ? '' : `  →  ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  }
}

const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`)

/* ---------------- 合成一张「像顶栏」的截图 ---------------- */

function canvas(w, h, fill = [24, 28, 34]) {
  const px = new Uint8Array(w * h * 3)
  for (let i = 0; i < w * h; i++) {
    px[i * 3] = fill[0]
    px[i * 3 + 1] = fill[1]
    px[i * 3 + 2] = fill[2]
  }
  return { width: w, height: h, px }
}

function blit(dst, src, x, y, scale = 1) {
  const w = Math.max(1, Math.round(src.width * scale))
  const h = Math.max(1, Math.round(src.height * scale))
  const scaled = scale === 1 ? src : resize(src, w, h)
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const dx = x + i
      const dy = y + j
      if (dx < 0 || dy < 0 || dx >= dst.width || dy >= dst.height) continue
      const s = (j * w + i) * 3
      const d = (dy * dst.width + dx) * 3
      dst.px[d] = scaled.px[s]
      dst.px[d + 1] = scaled.px[s + 1]
      dst.px[d + 2] = scaled.px[s + 2]
    }
  }
}

/** 画几个白条冒充数字（probe 不认数字，这里只是让画面别太空） */
function digitBars(dst, x, y, w, h) {
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      if (i >= dst.width || j >= dst.height) continue
      if ((i - x) % 7 < 4) {
        const d = (j * dst.width + i) * 3
        dst.px[d] = 235
        dst.px[d + 1] = 238
        dst.px[d + 2] = 242
      }
    }
  }
}

const loadIcon = (name) => decodePNG(fs.readFileSync(`public/resource-icons/${name}.png`))

const profile = profileForGame('鸣潮')
const W = 1920
const H = 1080
const iconW = Math.round(profile.iconWidthRatio * W)

/* 贴星声和贝币，故意**不贴体力** —— 复现「还差体力」那张画面 */
function buildScreenshot({ withTili }) {
  const img = canvas(W, H)
  const placed = {}
  let x = Math.round(W * 0.26)
  for (const [name, key] of [['xingsheng', '星声'], ['beibi', '贝币']]) {
    const icon = loadIcon(name)
    blit(img, icon, x, 22, iconW / icon.width)
    digitBars(img, x + iconW + 10, 30, 110, 30)
    placed[key] = x
    x += iconW + 150
  }
  if (withTili) {
    const icon = loadIcon('tili')
    const tx = Math.round(W * 0.62)
    blit(img, icon, tx, 22, iconW / icon.width)
    digitBars(img, tx + iconW + 10, 30, 90, 30)
    placed['体力'] = tx
  }
  return { img, placed }
}

/* ---------------- 断言 ---------------- */

section('体检能认出贴进画面的图标')
const full = buildScreenshot({ withTili: true })
fs.mkdirSync('shots/icon-probe', { recursive: true })
fs.writeFileSync('shots/icon-probe/with-tili.png', encodePNG(full.img))

const t0 = Date.now()
const probeFull = probeIcons(full.img, { profile: '鸣潮' })
const elapsed = Date.now() - t0
console.log(`  （体检耗时 ${elapsed}ms，${probeFull.size.join('×')}，band_h=${probeFull.band_h}）`)

const byKey = Object.fromEntries(probeFull.items.map((it) => [it.key, it]))
ok('体检把每个模板都报了出来', probeFull.items.length === profile.resources.length, probeFull.items.map((i) => i.key))
ok('体检带上了阈值（不然分数没法解读）', typeof probeFull.min_score === 'number' && typeof probeFull.anchor_min_score === 'number', probeFull)
ok(
  '贴进去的图标分数明显高于没贴的',
  byKey['星声'].score > 0.5,
  `星声 ${byKey['星声'].score} / 体力 ${byKey['体力'].score}`
)
ok(
  '找到的星声位置和贴的位置差不多（误差 < 120px）',
  Math.abs(byKey['星声'].x - full.placed['星声']) < 120,
  `报告 x=${byKey['星声'].x}，实际贴 x=${full.placed['星声']}`
)
ok('体检跑得完（10 秒内），不至于让用户以为卡死', elapsed < 10000, `${elapsed}ms`)
ok('体检不设阈值门槛（passes 只管有没有过线，没过的也要报）', probeFull.items.some((it) => !it.passes), probeFull.items.map((i) => `${i.key}:${i.passes}`))

section('体力缺失时能如实报出来')
const missing = buildScreenshot({ withTili: false })
fs.writeFileSync('shots/icon-probe/no-tili.png', encodePNG(missing.img))
const probeMissing = probeIcons(missing.img, { profile: '鸣潮' })
const missByKey = Object.fromEntries(probeMissing.items.map((it) => [it.key, it]))

ok('没有体力的画面里，体力依然是最后一名', probeMissing.items[probeMissing.items.length - 1].key === '体力', probeMissing.items.map((i) => `${i.key}:${i.score}`))
ok('而且它没过阈值', missByKey['体力'].passes === false, missByKey['体力'])
ok('同一张图里星声照样认得出（不是整张图都废了）', missByKey['星声'].score > 0.5, missByKey['星声'].score)
ok(
  '两次体检结论一致：体力分数没有被「贴没贴别的图标」影响太多',
  Math.abs(byKey['体力'].score - missByKey['体力'].score) < 0.35,
  `${byKey['体力'].score} vs ${missByKey['体力'].score}`
)

section('边界情况')
ok('空图不炸', (() => {
  try {
    const r = probeIcons(canvas(1920, 1080), { profile: '鸣潮' })
    return r.items.length === profile.resources.length && r.items.every((it) => it.score <= 0.2)
  } catch {
    return false
  }
})())
ok('只问一个资源时只报一个', probeIcons(full.img, { profile: '鸣潮', keys: ['星声'] }).items.length === 1, probeIcons(full.img, { profile: '鸣潮', keys: ['星声'] }).items.map((i) => i.key))

console.log(`\n${'═'.repeat(52)}`)
console.log(`  通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length) {
  for (const f of failures) console.log(`    · ${f}`)
}
console.log(`${'═'.repeat(52)}\n`)
console.log(`  合成图存到 shots/icon-probe/，可以自己打开看看分成这样合不合理\n`)

process.exitCode = failures.length ? 1 : 0
