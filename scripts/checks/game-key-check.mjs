/**
 * game-key-check.mjs —— 按键注入的验收：窗口收到的按键必须有正确扫描码。
 *
 * 为什么要有这一条：老版本用 keybd_event(vk, 0, ...)，第二个参数（硬件扫描码）
 * 写死 0。实测游戏窗口收到的是 "WM_KEYDOWN vk=66 sc=0"，而按扫描码映射键位的
 * 输入路径（Raw Input / DirectInput，游戏用的就是这两种）直接丢掉这种事件 ——
 * 于是窗口切过来了、脚本还报成功、游戏里什么都没发生。这种毛病看代码看不出来，
 * 只能拿一个真的窗口去收消息，所以这里开一个探针窗口（scripts/checks/key-probe.ps1），
 * 跑真的 scripts/win32/game-key.ps1，然后核对窗口收到的 vk / sc。
 *
 * 断言（每个白名单按键）：
 *   1. game-key.ps1 返回 ok=true、sent=2（按下 + 抬起都被 Windows 接受）；
 *   2. 返回里的 scan 等于该键的真实扫描码；
 *   3. 探针窗口真的收到 DOWN/UP 两条消息；
 *   4. 收到的扫描码非 0，且 vk 与扫描码都对得上（sc=0 就是老 bug）。
 *
 * 跑法：npm run test:key（会短暂弹出一个 320x200 的小窗口抢一下焦点，这是必须的）
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const PROBE = path.join(HERE, 'key-probe.ps1')
const GAME_KEY = path.join(ROOT, 'scripts', 'win32', 'game-key.ps1')

/** vk 是 Windows 的虚拟键码，scan 是真实键盘发出来的硬件扫描码 */
const KEYS = [
  { key: 'B', vk: 0x42, scan: 48 },
  { key: 'M', vk: 0x4d, scan: 50 },
  { key: 'ESC', vk: 0x1b, scan: 1 },
  { key: 'F2', vk: 0x71, scan: 60 },
  { key: 'F12', vk: 0x7b, scan: 88 },
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function runGameKey(hwnd, pid, key) {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', GAME_KEY,
      '-WindowHandle', String(hwnd), '-ProcessId', String(pid), '-Key', key],
    { encoding: 'utf8', windowsHide: true }
  )
  const out = String(r.stdout || '').trim()
  let json = null
  try { json = JSON.parse(out) } catch { /* 下面统一报 */ }
  return { status: r.status, json, raw: out, err: String(r.stderr || '').trim() }
}

async function waitFor(file, timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) return true
    await sleep(100)
  }
  return false
}

function parseLog(text) {
  const rows = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(DOWN|UP) vk=(\d+) sc=(\d+)/.exec(line.trim())
    if (m) rows.push({ kind: m[1], vk: Number(m[2]), scan: Number(m[3]) })
  }
  return rows
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('跳过：按键注入只在 Windows 上有意义（game-key.ps1 本身也只支持 Windows）')
    return
  }
  if (!fs.existsSync(GAME_KEY)) throw new Error('找不到 ' + GAME_KEY)

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xfc-keycheck-'))
  const prefix = path.join(dir, 'probe')
  const hwndFile = prefix + '.hwnd'
  const logFile = prefix + '.log'
  const stopFile = prefix + '.stop'

  const probe = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PROBE, '-Out', prefix, '-Seconds', '40'],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  )
  let probeErr = ''
  probe.stderr.setEncoding('utf8')
  probe.stderr.on('data', (c) => { probeErr += c })

  const problems = []
  const results = []
  try {
    if (!(await waitFor(hwndFile, 20000))) {
      throw new Error('探针窗口没有起来（20 秒）' + (probeErr ? '：' + probeErr.trim() : ''))
    }
    const hwndPid = fs.readFileSync(hwndFile, 'utf8').trim().split('|')
    const hwnd = hwndPid[0]
    const pid = hwndPid[1]
    console.log('探针窗口 hwnd=' + hwnd + ' pid=' + pid + '\n')

    for (const spec of KEYS) {
      const r = runGameKey(hwnd, pid, spec.key)
      const got = r.json || {}
      const ok = r.status === 0
        && got.ok === true
        && got.sent === 2
        && got.scan === spec.scan
      if (!ok) {
        problems.push(spec.key + ': 脚本没成功（exit=' + r.status + ' ' + (r.raw || r.err || '无输出') + '）')
      }
      results.push({ spec: spec, got: got, status: r.status, ok: ok })
      await sleep(200)
    }

    await sleep(400)
    const rows = parseLog(fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '')

    for (const item of results) {
      const spec = item.spec
      const down = rows.find((x) => x.kind === 'DOWN' && x.vk === spec.vk)
      const up = rows.find((x) => x.kind === 'UP' && x.vk === spec.vk)
      if (!down) problems.push(spec.key + ': 窗口没收到按下消息（脚本报告成功但输入没到）')
      else if (down.scan !== spec.scan) problems.push(spec.key + ': 扫描码是 ' + down.scan + '，应为 ' + spec.scan)
      else if (down.scan === 0) problems.push(spec.key + ': 扫描码是 0（老 bug 回来了）')
      if (!up) problems.push(spec.key + ': 窗口没收到抬起消息（按键会卡在按下状态）')
      else if (up.scan !== spec.scan) problems.push(spec.key + ': 抬起的扫描码是 ' + up.scan + '，应为 ' + spec.scan)
    }

    const pad = (s, n) => String(s).padEnd(n)
    console.log(pad('按键', 6) + pad('期望 vk', 9) + pad('期望 scan', 11) + pad('脚本 ok', 9) + pad('sent', 6) + '窗口收到的 scan')
    for (const item of results) {
      const spec = item.spec
      const row = rows.find((x) => x.kind === 'DOWN' && x.vk === spec.vk)
      console.log(
        pad(spec.key, 6) + pad(spec.vk, 9) + pad(spec.scan, 11)
        + pad(String(item.got.ok), 9) + pad(String(item.got.sent), 6)
        + (row ? row.scan : '(没收到)')
      )
    }
  } finally {
    try { fs.writeFileSync(stopFile, '1') } catch { /* 探针自己也会超时退出 */ }
    await sleep(300)
    try { probe.kill() } catch { /* 已经退了 */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录，清不掉无所谓 */ }
  }

  console.log('')
  if (problems.length) {
    console.error('按键注入检查未通过：')
    for (const p of problems) console.error('  - ' + p)
    process.exitCode = 1
    return
  }
  console.log('按键注入检查通过：5 个白名单按键都送到了窗口，扫描码都不为 0。')
}

main().catch((err) => {
  console.error('按键注入检查出错：' + (err && err.message ? err.message : err))
  process.exitCode = 1
})
