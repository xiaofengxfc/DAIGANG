import fs from 'node:fs'
import path from 'node:path'
import { buildERPNextBundle } from '../src/erpnext-map.mjs'

const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '')
const outDir = path.resolve(`backups/erpnext-preview-${stamp}`)
fs.mkdirSync(outDir, { recursive: true })
const preview = buildERPNextBundle()
fs.writeFileSync(path.join(outDir, 'preview.json'), JSON.stringify(preview, null, 2) + '\n', 'utf8')
for (const [name, rows] of Object.entries(preview.doctypes)) {
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(rows, null, 2) + '\n', 'utf8')
}
console.log(`ERPNext 映射预览：${outDir}`)
console.log(JSON.stringify(preview.source, null, 2))
console.log(`问题与提示：${preview.issues.length}`)
