/**
 * Python 版本适配自检
 *
 * 守两件事：
 *   1. **版本闸门**（pythonVersionSupport）—— 哪些版本该放行、哪些该拦，
 *      以及拦下来时给的是不是人话。这个闸门存在的理由：以前不拦，用户会一路
 *      走到 pip，然后看到「找不到匹配的分发」一长串，看不出是 Python 版本的事。
 *      实测背景：onnxruntime 的 win_amd64 轮子只覆盖 3.10~3.14，3.15 装不上。
 *   2. **解释器发现**（findVisionInterpreter）—— 能不能找到「不在 PATH 里」的
 *      Python。官方安装器默认不勾 Add to PATH，只查 PATH 就等于「用户装了
 *      Python 但程序说没装」（这台机器上实测就是这种情况）。
 *
 *   node scripts/checks/vision-python-check.mjs
 */
import { pythonVersionSupport, SUPPORTED_PYTHON, findVisionInterpreter } from '../../src/vision/vision-deps.mjs'

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

const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 46 - t.length))}`)

section('版本闸门：该放行的')
for (const v of ['3.10.0', '3.10.11', '3.11.9', '3.12.7', '3.13.0', '3.14.0', '3.14.8']) {
  const r = pythonVersionSupport(v)
  ok(`Python ${v} 放行`, r.ok === true, r)
}

section('版本闸门：该拦下来的')
for (const v of ['3.9.13', '3.8.10', '3.7.9']) {
  const r = pythonVersionSupport(v)
  ok(`Python ${v} 拦下（太旧）`, r.ok === false && r.code === 'python_too_old', r)
}
// 3.15 是这台机器的真实情况：装了，但依赖还没有适配它的轮子
{
  const r = pythonVersionSupport('3.15.0')
  ok('Python 3.15.0 拦下（太新）', r.ok === false && r.code === 'python_too_new', r)
  ok('拦下 3.15 时说的是人话（提 onnxruntime 和怎么办）', /onnxruntime/.test(r.message) && /3\.1[0-9]/.test(r.message), r.message)
  ok('拦下 3.15 时给出了推荐版本', r.message.includes(SUPPORTED_PYTHON.recommended), r.message)
}
{
  const r = pythonVersionSupport('3.16.0')
  ok('Python 3.16 也拦下（未来版本同样没轮子）', r.ok === false && r.code === 'python_too_new', r)
}
{
  const r = pythonVersionSupport('')
  ok('版本号读不出来时不当成通过', r.ok === false && r.code === 'python_version_unknown', r)
}
{
  const r = pythonVersionSupport('Python 3.14.8')
  ok('带前缀的版本串也能解析', r.ok === true, r)
}

section('声明的范围要和实测一致')
ok('支持范围下界是 3.10', SUPPORTED_PYTHON.min.join('.') === '3.10', SUPPORTED_PYTHON.min)
ok('支持范围上界是 3.14', SUPPORTED_PYTHON.max.join('.') === '3.14', SUPPORTED_PYTHON.max)
ok('推荐版本落在范围内', pythonVersionSupport(SUPPORTED_PYTHON.recommended).ok === true, SUPPORTED_PYTHON.recommended)

section('解释器发现')
{
  const i = findVisionInterpreter()
  if (!i.available) {
    console.log('  · 这台机器上没有 Python，跳过「发现」相关断言（不是失败）')
  } else {
    ok('找到了解释器且给的是绝对路径', Boolean(i.bin) && /[\\/]/.test(i.bin), i.bin)
    ok('报了版本号', /^\d+\.\d+/.test(i.version), i.version)
    ok('带上了 support 结论', i.support && typeof i.support.ok === 'boolean', i.support)
    ok('support 结论和版本号自洽', i.support.ok === pythonVersionSupport(i.version).ok, `${i.version} -> ${i.support.ok}`)
    ok(
      '每个试过的候选都记了 supported（排查用）',
      Array.isArray(i.tried) && i.tried.every((t) => typeof t.supported === 'boolean'),
      i.tried
    )
    // 这条是「不在 PATH 里也能找到」的回归：这台机器上 python/python3 都不在 PATH
    const fromPath = i.tried.filter((t) => t.bin === 'python' || t.bin === 'python3')
    const foundBeyondPath = i.tried.some((t) => /[\\/]/.test(t.bin) && t.status === 0)
    if (fromPath.length) {
      ok('PATH 里没有 python 时，仍能从别处找到', foundBeyondPath, i.tried.map((t) => `${t.bin}:${t.status}`))
    }
  }
}

console.log(`\n${'═'.repeat(52)}`)
console.log(`  通过 ${pass} 项，失败 ${failures.length} 项`)
if (failures.length) for (const f of failures) console.log(`    · ${f}`)
console.log(`${'═'.repeat(52)}\n`)

process.exitCode = failures.length ? 1 : 0
