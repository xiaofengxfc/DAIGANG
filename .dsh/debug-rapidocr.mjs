/* rapidocr 在 PyPI 上到底发布了什么 */
const j = await (await fetch('https://pypi.org/pypi/rapidocr/json')).json()
console.log('latest:', j.info.version)
console.log('requires_python:', j.info.requires_python)
const vers = Object.keys(j.releases)
console.log('release count:', vers.length)
console.log('last 10 releases:', vers.slice(-10).join(', '))
const v = j.info.version
console.log(`\nfiles for ${v}:`)
for (const f of j.releases[v] || []) {
  console.log('  ', f.filename, '| packagetype =', f.packagetype)
}
console.log('\nfiles for 3.4.2:')
for (const f of j.releases['3.4.2'] || []) {
  console.log('  ', f.filename, '| packagetype =', f.packagetype)
}
console.log('\nany release with a file at all?')
let withFiles = 0
for (const k of vers) if ((j.releases[k] || []).length) withFiles++
console.log('  releases with >=1 file:', withFiles, '/', vers.length)
