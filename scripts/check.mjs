/**
 * 语法自检：
 *   .mjs / .js  过一遍 node --check；
 *   .jsx        用随 Vite 一起装上的 rolldown 解析器过一遍
 *               （node --check 不认 JSX，以前这 11 个文件在自检里是完全没覆盖的）。
 *
 * 子进程用 stdio:'inherit'，不抓管道——某些受限环境里管道会被拒绝。
 *
 *   node scripts/check.mjs
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', 'data', '.git', 'dist'])
/** 运行时/测试数据目录（data-smoke-run、data-media-test…），里面不是源码 */
const isRuntimeDir = (name) => name.startsWith('data-')

function walk(dir, out = { js: [], jsx: [] }) {
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
      if (SKIP_DIRS.has(e.name) || isRuntimeDir(e.name)) continue
      walk(full, out)
    } else if (e.isFile()) {
      if (full.endsWith('.jsx')) out.jsx.push(full)
      else if (full.endsWith('.mjs') || full.endsWith('.js')) out.js.push(full)
    }
  }
  return out
}

const rel = (f) => path.relative(ROOT, f)
const files = walk(ROOT)
files.js.sort()
files.jsx.sort()
const failed = []

/* ---------- .mjs / .js：node 自己的语法检查 ---------- */
for (const file of files.js) {
  const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' })
  if (r.status !== 0) failed.push(rel(file))
}

/* ---------- .jsx：rolldown 解析器（没装依赖就跳过，不假装检查过） ---------- */
let parseAst = null
try {
  ;({ parseAst } = await import('rolldown/parseAst'))
} catch {
  console.log('\n  没找到 rolldown（npm ci 之后才有），.jsx 这轮跳过。')
}

if (parseAst) {
  for (const file of files.jsx) {
    try {
      parseAst(fs.readFileSync(file, 'utf8'), { lang: 'jsx', sourceType: 'module' }, file)
    } catch (err) {
      failed.push(rel(file))
      console.error(`\n✗ ${rel(file)}\n${err && err.message ? err.message : err}`)
    }
  }
}

const jsxNote = parseAst ? `${files.jsx.length} 个` : `${files.jsx.length} 个（跳过）`

/* ---------- Python 视觉后端的版本闸门 ----------
   纯逻辑（不联网、不起进程），所以放进闸门里守：哪些 Python 版本该放行、
   哪些该拦、拦下时说没说人话。背景见 scripts/vision-python-check.mjs 的头注释。
   注意**不**在这里跑 vision-python-matrix.mjs —— 那个要联网查 PyPI，
   没网时跑不了，塞进闸门就会把「离线」变成「失败」。它单独一条命令。 */
const pyGate = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'vision-python-check.mjs')], { stdio: 'inherit' })
if (pyGate.status !== 0) failed.push('scripts/vision-python-check.mjs')

console.log(`\n语法自检：.mjs/.js ${files.js.length} 个，.jsx ${jsxNote}，失败 ${failed.length} 个`)
if (failed.length) {
  for (const f of failed) console.log(`   ✗ ${f}`)
  process.exit(1)
}
console.log('全部通过')
