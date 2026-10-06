/* 临时探针：同一个图标，几种裁法各能打多少分（都限制在真位置附近、只试少数尺度）。
   目的是把「搜索没覆盖到」和「模板本身不像」分开 —— 顺便挑出最好的裁法。 */
import fs from 'node:fs'
import { decodePNG } from '../src/imgmatch.mjs'
import { findIcon, compileTemplate } from '../src/vision.mjs'
import { crop } from '../src/imgmatch.mjs'

const src = decodePNG(fs.readFileSync('shots/samples/nte-bag.png'))
const bandH = Math.max(48, Math.round(src.height * 0.14))

// 连通域量出来的图标外接框（左上角 + 宽高）
const BLOBS = [
  { key: '甲硬币', x: 1608, y: 54, w: 57, h: 57 },
  { key: '方斯', x: 1852, y: 54, w: 62, h: 49 },
  { key: '环石', x: 2132, y: 54, w: 60, h: 58 },
]

for (const b of BLOBS) {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  console.log(`\n=== ${b.key}  外接框 ${b.w}x${b.h} 中心 (${cx}, ${cy}) ===`)
  // 三种裁法：紧贴外接框 / 外扩 12%（现在用的）/ 外扩 40%（带更多药丸底）
  const variants = [
    { name: '紧贴', side: Math.max(b.w, b.h) },
    { name: '外扩12%', side: Math.round(Math.max(b.w, b.h) * 1.12) },
    { name: '外扩40%', side: Math.round(Math.max(b.w, b.h) * 1.4) },
  ]
  for (const v of variants) {
    const x0 = Math.round(cx - v.side / 2)
    const y0 = Math.round(cy - v.side / 2)
    const img = crop(src, x0, y0, v.side, v.side)
    const tpl = compileTemplate(img, { name: b.key })
    // 只在这个图标真位置附近找，尺度试 0.8~1.15（模板就是原尺寸抠的，真值应该在 1.0 附近）
    const region = { x: Math.max(0, b.x - 30), y: 0, w: b.w + 60, h: bandH }
    const scales = [0.8, 0.85, 0.9, 0.95, 1.0, 1.05, 1.1, 1.15]
    const hit = findIcon(src, img, { region, scales, minScore: 0, coarseStep: 2, refine: 10 })
    const off = hit ? Math.abs(hit.x - b.x) : null
    console.log(
      `  ${v.name.padEnd(8)} ${String(v.side).padStart(3)}x${v.side}  core=${tpl.count}像素(${Math.round((tpl.count / (v.side * v.side)) * 100)}%)` +
        `  最高分=${hit ? hit.score.toFixed(3) : '—'}  位置x=${hit ? hit.x : '—'}(差${off})  缩放=${hit ? hit.scale : '—'}`
    )
  }
}
