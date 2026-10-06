/* 临时探针：拿两张异环截图跑一遍识别，看图标分数和数字对不对得上。
   验完就删 —— 正式的那份断言要进 scripts/vision-selftest.mjs。 */
import fs from 'node:fs'
import { decodePNG } from '../src/imgmatch.mjs'
import { resampleBilinear } from '../src/vision.mjs'
import { ocrTopBand, recognizeFrame, templateStatus, loadTemplates } from '../src/screen.mjs'
import { ensureEnginesProbed } from '../src/ocr.mjs'
import { profileForGame } from '../shared/game-profiles.js'

const st = await ensureEnginesProbed()
console.log(`引擎：${st.engine_name || st.engine}（可用=${st.available}）`)
const profile = profileForGame('异环')
console.log(`模板：${JSON.stringify(templateStatus('异环').items)}`)
console.log(`图标宽比例：${profile.iconWidthRatio}`)
console.log('')

const CASES = [
  { title: '背包', file: 'shots/samples/nte-bag.png', want: { 甲硬币: 929484, 方斯: 4116889, 环石: 3087 } },
  { title: '地图', file: 'shots/samples/nte-map.png', want: { 都市活力: 0, 体力: 255 } },
]

for (const c of CASES) {
  if (!fs.existsSync(c.file)) {
    console.log(`跳过 ${c.title}：没有 ${c.file}`)
    continue
  }
  const src = decodePNG(fs.readFileSync(c.file))
  console.log(`=== ${c.title} ${c.file} ${src.width}x${src.height} ===`)
  // 按 0.6 / 1 / 1.5 三档缩放各跑一次，看尺度不变量成不成立
  for (const scale of [1, 0.6, 1.5]) {
    const img = scale === 1 ? src : resampleBilinear(src, Math.round(src.width * scale), Math.round(src.height * scale))
    const bandH = Math.max(48, Math.round(img.height * 0.14))
    const ocr = await ocrTopBand(img, bandH)
    if (!ocr.ok) {
      console.log(`  ${img.width}x${img.height}  OCR 失败：${ocr.error}`)
      continue
    }
    const t0 = Date.now()
    const frame = recognizeFrame(img, ocr.words, { profile })
    const ms = Date.now() - t0
    const got = Object.fromEntries(frame.hits.map((h) => [h.key, h.value]))
    const bad = Object.keys(c.want).filter((k) => got[k] !== c.want[k])
    console.log(`  ${String(img.width).padStart(4)}x${img.height}  锚点=${frame.anchor ? `${frame.anchor.key}@${frame.anchor.score}` : '无'}  ${ms}ms  ${bad.length ? '✗' : '✓'}`)
    for (const h of frame.hits) {
      console.log(`      ${h.key} = ${h.value}（文字「${h.text}」分 ${h.score}${h.warn ? ' · ' + h.warn : ''}）${c.want[h.key] !== undefined && c.want[h.key] !== h.value ? `  ✗ 期望 ${c.want[h.key]}` : ''}`)
    }
    for (const s of frame.seen.filter((x) => !x.found || x.value === null)) {
      console.log(`      没成：${s.key} 分=${s.score ?? '—'}${s.why ? ' · ' + s.why : ''}`)
    }
    console.log(`      数字块：${frame.blocks.map((b) => `[${b.text}]@x${Math.round(b.x)}`).join(' ')}`)
  }
  console.log('')
}
void loadTemplates
