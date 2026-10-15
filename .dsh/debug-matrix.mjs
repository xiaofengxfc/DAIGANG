/* 独立复刻 matrix 的判定逻辑，定位「支持范围为空」 */
const VERSIONS = ['3.10', '3.11', '3.12', '3.13', '3.14', '3.15']

function satisfies(version, spec) {
  if (!spec) return true
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
      const base = target.split('.').map(Number)
      if (c < 0) return false
      const upper = base.slice(0, -1)
      upper[upper.length - 1] += 1
      if (cmp(version, upper.join('.')) >= 0) return false
    }
  }
  return true
}

function wheelMatrix(data, spec) {
  const out = { ok: new Set(), anyWheel: false, sdist: false }
  const versions = Object.keys(data.releases)
    .filter((v) => satisfies(v, spec))
    .filter((v) => !/rc|a\d|b\d|dev/i.test(v))
  const addFrom = (minStr) => {
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
      if (!/win_amd64/.test(f.filename)) continue
      out.anyWheel = true
      const abi3 = /-(cp3\d+)-abi3-/.exec(f.filename)
      if (abi3) { addFrom(`${abi3[1].slice(2, 3)}.${abi3[1].slice(3)}`); continue }
      const cp = /-(cp3\d+)-/.exec(f.filename)
      if (cp) { out.ok.add(`${cp[1].slice(2, 3)}.${cp[1].slice(3)}`); continue }
      if (/-(py3|py2\.py3)-/.test(f.filename)) for (const ver of VERSIONS) out.ok.add(ver)
    }
  }
  return out
}

console.log('satisfies 1.24.3 ">=1.20,<2" :', satisfies('1.24.3', '>=1.20,<2'))
console.log('satisfies 4.11.0.86 ">=4.10":', satisfies('4.11.0.86', '>=4.10'))
console.log('satisfies 1.4.0 ">=1.2,<2"   :', satisfies('1.4.0', '>=1.2,<2'))

const cases = [
  ['rapidocr', '>=3.9,<4', false],
  ['onnxruntime', '>=1.20,<2', true],
  ['numpy', '>=2.0', true],
  ['opencv-python', '>=4.10', true],
  ['pillow', '>=10', true],
  ['shapely', '', true],
  ['pyclipper', '', true],
]
const supported = new Set(VERSIONS)
for (const [pkg, spec, needsWheel] of cases) {
  const j = await (await fetch(`https://pypi.org/pypi/${pkg}/json`)).json()
  const wm = wheelMatrix(j, spec)
  const drop = []
  for (const v of VERSIONS) {
    const has = wm.ok.has(v)
    const usable = needsWheel ? has : wm.sdist || wm.anyWheel
    if (!usable) { drop.push(v); supported.delete(v) }
  }
  console.log(`${pkg.padEnd(15)} ok=[${[...wm.ok].sort().join(',')}] sdist=${wm.sdist} drops: ${drop.join(',') || '(none)'}`)
}
console.log('supported =', [...supported].sort().join(',') || '(empty)')
