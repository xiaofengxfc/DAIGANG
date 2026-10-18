/**
 * Python 版本适配核查
 *
 * 这个脚本回答一个问题：**依赖清单里那几包，到底在哪些 Python 版本上装得上？**
 *
 * 为什么需要它：这个后端以前是照着「我这台机器上的 Python」调的
 * （integrations/screen-vision/README.md 里写着实测于 3.14.8）。换一个
 * Python 版本就可能装不上，而失败现场是 pip 的一堆「找不到匹配的分发」
 * —— 用户看不出是版本不兼容，只看到「装依赖失败」。
 *
 * 判定方式：直接问 PyPI 每个包发布了哪些 wheel。纯 Python 包（rapidocr）
 * 只有 sdist 是正常的（源码包本来就跨版本）；**带 C 扩展的包**
 * （onnxruntime / numpy / opencv-python / pillow）必须有对应 cpXX 的
 * 二进制 wheel —— 没有的话 pip 要么放弃，要么现编，而现编在用户机器上
 * 基本等于失败（要 C++ 工具链 + 几十分钟）。
 *
 *   node scripts/checks/vision-matrix.mjs            # 打表
 *   node scripts/checks/vision-matrix.mjs --check    # 打表 + 断言声明的范围与事实相符
 *
 * 联网失败不会假报成功：直接退出码 2 说清「没网，这轮没结论」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const REQUIREMENTS = path.join(ROOT, 'integrations', 'screen-vision', 'requirements.txt')

/** 要在这些 Python 版本上都成立。3.15 列进来是为了让「不支持」这件事有据可依 */
const VERSIONS = ['3.10', '3.11', '3.12', '3.13', '3.14', '3.15']
/** cpXX 标签里那个 XX 和 Python 版本一一对应（cp310 → 3.10） */
const cpTag = (v) => `cp${v.replace('.', '')}`

const CHECK = process.argv.includes('--check')

/** 从 requirements.txt 里取出 (名字, 版本约束) —— 只认普通行，跳过注释和空行 */
function parseRequirements(text) {
  const out = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('-')) continue
    // rapidocr>=3.9,<4 / numpy>=2.0 / opencv-python>=4.10
    const m = /^([A-Za-z0-9_.\-]+)\s*(.*)$/.exec(line)
    if (!m) continue
    out.push({ name: m[1], spec: m[2].replace(/\s+/g, '') })
  }
  return out
}

/** 这个包里有带 C 扩展的东西吗（决定「必须有 wheel」还是「有 sdist 也行」） */
const NEEDS_WHEEL = new Set(['onnxruntime', 'numpy', 'opencv-python', 'pillow'])
/** rapidocr 拉进来的传递依赖，同样带扩展 */
const TRANSITIVE = ['shapely', 'pyclipper']

/**
 * 版本约束 → 一组候选版本。
 * 只支持 `>=x`、`<y`、`==z`、`~=a.b` 这几种写法（清单里就用这几种），
 * 够用且不用引 packaging。
 */
function satisfies(version, spec) {
  if (!spec) return true
  const parts = version.split('.').map(Number)
  const cmp = (a, b) => {
    const pa = a.split('.').map(Number)
    const pb = b.split('.').map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] || 0
      const y = pb[i] || 0
      if (x !== y) return x < y ? -1 : 1
    }
    return 0
  }
  for (const clause of spec.split(',').filter(Boolean)) {
    const m = /^(>=|<=|==|!=|>|<|~=)\s*(.+)$/.exec(clause)
    if (!m) continue
    const [, op, target] = m
    const c = cmp(version, target)
    if (op === '>=' && c < 0) return false
    if (op === '<=' && c > 0) return false
    if (op === '>' && c <= 0) return false
    if (op === '<' && c >= 0) return false
    if (op === '==' && c !== 0) return false
    if (op === '!=' && c === 0) return false
    if (op === '~=') {
      // ~=1.24.0 意思是 >=1.24.0 且 ==1.24.*
      const base = target.split('.').map(Number)
      if (c < 0) return false
      const upper = base.slice(0, -1)
      upper[upper.length - 1] += 1
      if (cmp(version, upper.join('.')) >= 0) return false
    }
  }
  return true
}

async function pypi(pkg) {
  const res = await fetch(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, {
    headers: { 'user-agent': 'daigan-ops-console/vision-matrix' },
  })
  if (!res.ok) throw new Error(`${pkg}: HTTP ${res.status}`)
  return res.json()
}

/**
 * 某个包在「符合约束的版本」里，最高能给出哪些 cpXX wheel。
 * 只看 win_amd64：这是本项目唯一支持的平台（截屏那块本来就是 Windows 专属）。
 *
 * 两种特殊 wheel 要认出来，否则会误报「没有轮子」：
 *   · `cp37-abi3` —— 稳定 ABI，3.7 及以后的解释器通用（opencv-python 就是这条）；
 *   · `py3`       —— 纯 Python 的「通用 wheel」。
 * packagetype 用 bdist_wheel / sdist，**不要**去看文件名 ——
 * PyPI 会把发行版名规范化（opencv-python → opencv_python），按文件名匹配会漏。
 */
/**
 * 从 PyPI 的 releases 里挑出「符合约束、且不是预发布」的版本，从小到大排好。
 *
 * 预发布的判定**必须锚定结尾**：不锚定的话 `a\d` 会匹配到包名里的
 * 字母 a 后面紧跟的版本数字（实测把 rapidocr 的 3.10.0 / 3.9.2 … 全判成了
 * alpha，于是整张表算成「全都不支持」——一个自制的假警报）。
 */
function pickVersions(releases, spec) {
  return Object.keys(releases)
    .filter((v) => satisfies(v, spec))
    .filter((v) => !/(rc|dev|alpha|beta)\d*$/i.test(v) && !/[ab]\d+$/.test(v))
    .sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] || 0
        const y = pb[i] || 0
        if (x !== y) return x - y
      }
      return 0
    })
}

function wheelMatrix(data, spec) {
  const out = { ok: new Set(), anyWheel: false, sdist: false }
  const versions = pickVersions(data.releases, spec)
  if (process.env.XFC_MATRIX_DEBUG === '1') {
    console.log(`      [wheelMatrix] spec="${spec}" picked=${versions.join(',')}`)
  }

  const addFrom = (v) => (minStr) => {
    const [maj, min] = minStr.split('.').map(Number)
    for (const ver of VERSIONS) {
      const [vmaj, vmin] = ver.split('.').map(Number)
      if (vmaj > maj || (vmaj === maj && vmin >= min)) out.ok.add(ver)
    }
  }

  for (const v of versions) {
    for (const f of data.releases[v] || []) {
      if (f.yanked) continue
      if (f.packagetype === 'sdist') out.sdist = true
      if (f.packagetype !== 'bdist_wheel') continue
      /* 平台判定要认「通用 wheel」：`py3-none-any` 没有 win_amd64 字样，
         但它本来就跨平台可用（rapidocr 发布的就是这种 —— 一开始按
         win_amd64 过滤，把它的文件全丢了，于是整张表算成「无支持版本」）。 */
      const universal = /-(py3|py2\.py3|cp3\d+)-none-any\.whl$/.test(f.filename) || /-none-any\.whl$/.test(f.filename)
      if (!universal && !/win_amd64/.test(f.filename)) continue
      out.anyWheel = true
      // cp3X-abi3（及更新的写法）→ 3.X 起的解释器通用
      const abi3 = /-(cp3\d+)-abi3-/.exec(f.filename)
      if (abi3) {
        addFrom(v)(`${abi3[1].slice(2, 3)}.${abi3[1].slice(3)}`)
        continue
      }
      const cp = /-(cp3\d+)-/.exec(f.filename)
      if (cp) {
        out.ok.add(`${cp[1].slice(2, 3)}.${cp[1].slice(3)}`)
        continue
      }
      const py3 = /-(py3|py2\.py3)-/.exec(f.filename)
      if (py3) for (const ver of VERSIONS) out.ok.add(ver)
    }
  }
  return out
}

async function main() {
  if (!fs.existsSync(REQUIREMENTS)) {
    console.error(`找不到依赖清单：${REQUIREMENTS}`)
    process.exit(2)
  }
  const reqs = parseRequirements(fs.readFileSync(REQUIREMENTS, 'utf8'))
  console.log(`\n依赖清单：${path.relative(ROOT, REQUIREMENTS)}`)
  for (const r of reqs) console.log(`  · ${r.name}${r.spec}`)
  console.log('')

  let data
  try {
    data = new Map()
    for (const name of [...new Set([...reqs.map((r) => r.name), ...TRANSITIVE])]) {
      data.set(name, await pypi(name))
    }
  } catch (err) {
    console.error(`  ✗ 连不上 PyPI（${err.message}）—— 这轮没有结论，不当成通过。\n`)
    process.exit(2)
  }

  const specOf = (name) => (reqs.find((r) => r.name === name) || {}).spec || ''
  const rows = []
  const supported = new Set(VERSIONS)

  for (const [name, info] of data) {
    const matrix = wheelMatrix(info, specOf(name))
    const needsWheel = NEEDS_WHEEL.has(name) || TRANSITIVE.includes(name)
    for (const v of VERSIONS) {
      const has = matrix.ok.has(v)
      // 纯 Python 包只要有 sdist 就能在任何版本上装
      const usable = needsWheel ? has : matrix.sdist || matrix.anyWheel
      if (!usable) supported.delete(v)
    }
    rows.push({ name, needsWheel, matrix, latest: info.info.version })
    if (process.env.XFC_MATRIX_DEBUG === '1') {
      console.log(
        `  [debug] ${name}: needsWheel=${needsWheel} sdist=${matrix.sdist} anyWheel=${matrix.anyWheel} ok=[${[...matrix.ok].sort().join(',')}] → supported=[${[...supported].sort().join(',')}]`
      )
    }
  }

  // 打表
  const head = ['包'.padEnd(16), ...VERSIONS.map((v) => v.padStart(6))].join(' ')
  console.log(head)
  console.log('-'.repeat(head.length))
  for (const row of rows) {
    const cells = VERSIONS.map((v) => {
      const has = row.matrix.ok.has(v)
      const mark = has ? 'wheel' : row.needsWheel ? '  --' : 'sdist'
      return mark.padStart(6)
    })
    console.log([row.name.padEnd(16), ...cells].join(' '))
  }

  console.log(`\n支持范围（win_amd64，按上面几张表取交集）：${[...supported].sort().join(', ') || '（无）'}`)
  const unsupported = VERSIONS.filter((v) => !supported.has(v))
  if (unsupported.length) console.log(`不支持：${unsupported.join(', ')}`)

  if (CHECK) {
    console.log('\n── 断言 ────────────────────────────────────────────')
    let failed = 0
    const claim = (label, cond, detail) => {
      if (cond) console.log(`  ✓ ${label}`)
      else {
        failed++
        console.log(`  ✗ ${label}${detail ? `  →  ${detail}` : ''}`)
      }
    }
    // 这四条是「这个后端至少要在这些版本上能用」的底线：
    // 3.11~3.14 是当前 onnxruntime 有 wheel 的全部范围（见 onnxruntime 的发布表）
    for (const v of ['3.12', '3.13', '3.14']) {
      claim(`Python ${v} 上依赖装得上`, supported.has(v), `可用轮子：${[...rows].map((r) => `${r.name}:${r.matrix.ok.has(v) ? 'Y' : 'N'}`).join(' ')}`)
    }
    // 3.15 目前注定装不上（onnxruntime 还没发 cp315 轮子）。这条断言的作用是
    // 「承认它」，逼着代码去**明确报错**，而不是让 pip 抛一堆看不懂的日志。
    claim('Python 3.15 被认成不支持（好让界面给出人话）', !supported.has('3.15'), '如果这条红了，说明 onnxruntime 已经发了 cp315 —— 那就该把支持范围扩上去')
    if (failed) {
      console.log(`\n  失败 ${failed} 项`)
      process.exit(1)
    }
  }
  console.log('')
}

main().catch((err) => {
  console.error('核查脚本自己出错了：', err)
  process.exit(2)
})
