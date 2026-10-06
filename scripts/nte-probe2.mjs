/* 临时探针：异环图标模板到底能打多少分 —— 暴力扫一遍，看最高分和位置。
   用来区分「尺度没覆盖」还是「模板本身不像」。 */
import fs from 'node:fs'
import { decodePNG } from '../src/imgmatch.mjs'
import { findIcon, sweepScales, compileTemplate } from '../src/vision.mjs'
import { loadTemplates } from '../src/screen.mjs'
import { profileForGame } from '../shared/game-profiles.js'

const profile = profileForGame('异环')
const refs = loadTemplates({ profile, force: true })
const src = decodePNG(fs.readFileSync('shots/samples/nte-bag.png'))
const bandH = Math.max(48, Math.round(src.height * 0.14))
const region = { x: 0, y: 0, w: src.width, h: bandH }
console.log(`图 ${src.width}x${src.height}  条带高 ${bandH}  期望图标宽 ${Math.round(src.width * profile.iconWidthRatio)}px`)

// 图标在截图里的真实位置（前面连通域量出来的），用来判断命中落在不在真位置
const TRUTH = { 甲硬币: 1608, 方斯: 1852, 环石: 2132 }

for (const r of refs) {
  // 不设下限，把所有分数都打出来；尺度铺得很宽，先确认「模板本身像不像」
  const hit = findIcon(src, r.img, { region, scales: sweepScales(1, 6, 25), minScore: 0, coarseStep: 3 })
  const best = hit && hit.score !== undefined ? hit : null
  const truth = TRUTH[r.key]
  console.log(
    `${r.key.padEnd(5)} 模板${r.img.width}x${r.img.height}  最高分=${best ? best.score.toFixed(3) : '—'}` +
      `  位置 x=${best ? best.x : '—'}（真位置 ${truth}，差 ${best ? Math.abs(best.x - truth) : '—'}px）` +
      `  缩放=${best ? best.scale : '—'}  → 实际图标宽 ${best ? Math.round(r.img.width * best.scale) : '—'}px`
  )
  if (best && best.weak) console.log('        （弱命中，分数没过默认线）')
}
void compileTemplate
