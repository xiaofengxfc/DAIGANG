/* 临时探针：把时间预算放大，看异环的锚点到底能不能定出来（验证「预算不够」这个猜想）。 */
import fs from 'node:fs'
import { decodePNG } from '../src/imgmatch.mjs'
import { ocrTopBand, recognizeFrame } from '../src/screen.mjs'
import { ensureEnginesProbed } from '../src/ocr.mjs'
import { profileForGame } from '../shared/game-profiles.js'

await ensureEnginesProbed()
const profile = profileForGame('异环')

for (const [title, file, want] of [
  ['背包', 'shots/samples/nte-bag.png', { 甲硬币: 929484, 方斯: 4116889, 环石: 3087 }],
  ['地图', 'shots/samples/nte-map.png', { 都市活力: 0, 体力: 255 }],
]) {
  const img = decodePNG(fs.readFileSync(file))
  const bandH = Math.max(48, Math.round(img.height * 0.14))
  const ocr = await ocrTopBand(img, bandH)
  console.log(`\n=== ${title} ${img.width}x${img.height}  条带 ${img.width}x${bandH} ===`)
  for (const budget of [1500, 8000, 30000]) {
    const t0 = Date.now()
    const frame = recognizeFrame(img, ocr.words, { profile, timeBudgetMs: budget })
    const ms = Date.now() - t0
    const got = Object.fromEntries(frame.hits.map((h) => [h.key, h.value]))
    const bad = Object.keys(want).filter((k) => got[k] !== want[k])
    console.log(`  预算${String(budget).padStart(5)}ms  实际${String(ms).padStart(5)}ms  锚点=${frame.anchor ? `${frame.anchor.key}@${frame.anchor.score}` : '无'}  ${bad.length ? '✗' : '✓'} ${JSON.stringify(got)}`)
    for (const h of frame.hits) console.log(`      ${h.key}=${h.value} 文字「${h.text}」分${h.score}`)
    const missed = frame.seen.filter((s) => !frame.hits.some((h) => h.key === s.key))
    for (const m of missed) console.log(`      没成：${m.key} 分=${m.score ?? '—'}${m.why ? ' · ' + m.why : ''}`)
  }
}
