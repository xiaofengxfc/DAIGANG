/**
 * 语法自检：把项目里所有 .mjs / .js 过一遍 node --check。
 * 子进程用 stdio:'inherit'，不抓管道——某些受限环境里管道会被拒绝。
 *
 *   node scripts/check.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', 'data', '.git', 'dist'])

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(full, out)
    } else if (e.isFile() && (full.endsWith('.mjs') || full.endsWith('.js'))) {
      out.push(full)
    }
  }
  return out
}

const files = walk(ROOT).sort()
const failed = []

for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (r.status !== 0) failed.push(path.relative(ROOT, file))
}

console.log(`\n语法自检：共 ${files.length} 个文件，失败 ${failed.length} 个`)
if (failed.length) {
  for (const f of failed) console.log(`   ✗ ${f}`)
  process.exit(1)
}
console.log('全部通过')
