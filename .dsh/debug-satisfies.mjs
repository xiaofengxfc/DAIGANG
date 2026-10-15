/* 直接验 satisfies 和那个预发布过滤器，对 rapidocr 的真实版本列表 */
const j = await (await fetch('https://pypi.org/pypi/rapidocr/json')).json()
const all = Object.keys(j.releases)
const spec = '>=3.9,<4'

// 从真脚本里抠出 satisfies
import fs from 'node:fs'
const src = fs.readFileSync('scripts/vision-python-matrix.mjs', 'utf8')
const s = src.indexOf('function satisfies(')
const e = src.indexOf('/** 某个包在「符合约束的版本」里')
const satisfies = new Function(`${src.slice(s, e)}; return satisfies`)()

const passSpec = all.filter((v) => satisfies(v, spec))
console.log('total releases:', all.length)
console.log('satisfies(">=3.9,<4"):', passSpec.join(', '))

const notPrerelease = passSpec.filter((v) => !/(rc|dev|alpha|beta)\d*$/i.test(v) && !/[ab]\d+$/.test(v))
console.log('after prerelease filter:', notPrerelease.join(', '))
console.log('\nwhich ones did the prerelease filter drop?')
for (const v of passSpec) {
  const dropped = /(rc|dev|alpha|beta)\d*$/i.test(v) || /[ab]\d+$/.test(v)
  if (dropped) console.log('   DROPPED:', v)
}
console.log('\nspecific checks:')
for (const v of ['3.9.0', '3.9.2', '3.10.0', '3.4.2', '3.8.0']) {
  console.log(`  ${v}: satisfies=${satisfies(v, spec)} prereleaseDrop=${/(rc|dev|alpha|beta)\d*$/i.test(v) || /[ab]\d+$/.test(v)} inReleases=${all.includes(v)}`)
}
