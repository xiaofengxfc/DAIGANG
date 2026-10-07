/**
 * B站比价那套东西的验证脚手架。
 *
 * 为什么单独一份、不进 scripts/lib/test-app.mjs：
 * 那两个冒烟测试用的是**全新空库**，而比价必须跑在**真实数据**上才有意义 ——
 * 它要 B站 登录态、要这个游戏真实的 65 个服务项、要真实的 OCR 引擎。
 * 所以这里的策略正相反：数据用真的，但**写入落到副本上**。
 *
 * 关键顺序：XFC_DATA_DIR 必须在 import src/config.mjs 之前设好，
 * 因为配置是模块加载时读环境变量的，import 之后再设就晚了（会落到真实 data/ 上）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const REAL_DATA = path.join(ROOT, 'data')

/** 起 sidecar 用的端口。刻意避开 5410 —— 那是你自己那份实例的，抢它会把正在用的识别搞挂 */
export const CHECK_VISION_PORT = 5419

/* ============================================================
   数据目录
   ============================================================ */

/**
 * 把真实数据目录里比价真正需要的东西复制一份出来：库 + B站 登录态。
 *
 * 不复制 uploads（几百 MB）和 vision-venv（几百 MB）—— 前者用不上，
 * 后者的解释器路径改用 XFC_VISION_PYTHON / XFC_BILI_YTDLP_PYTHON 指回真实那份。
 *
 * SQLite 的库要连 -wal / -shm 一起复制：只复制主库会丢掉最近一次 checkpoint
 * 之后的写入（比如刚加的 B站 登录态），而且打开时会报库损坏。
 */
export function copyRealData(dest) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(dest, { recursive: true })
  const copied = []
  for (const name of ['console.db', 'console.db-wal', 'console.db-shm']) {
    const from = path.join(REAL_DATA, name)
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(dest, name))
      copied.push(name)
    }
  }
  const cookies = path.join(REAL_DATA, 'media-cookies')
  if (fs.existsSync(cookies)) {
    fs.cpSync(cookies, path.join(dest, 'media-cookies'), { recursive: true })
    copied.push('media-cookies/')
  }
  fs.mkdirSync(path.join(dest, 'bili-tmp'), { recursive: true })
  return copied
}

/** 真实 venv 里的 python —— 副本里没有 venv，靠这两个环境变量把解释器指回去 */
function realVenvPython() {
  const name = process.platform === 'win32' ? 'python.exe' : 'python'
  return path.join(REAL_DATA, 'vision-venv', process.platform === 'win32' ? 'Scripts' : 'bin', name)
}

/* ============================================================
   环境与实例
   ============================================================ */

/**
 * 设好环境变量并起一个**同进程**的实例。
 *
 * 同进程是关键：视觉后端的 token 是 src/config.mjs 在模块加载时随机生成的，
 * 只有同进程才拿得到同一个 token。跨进程起实例的话，要么去猜 token，
 * 要么就得手工先跑一个 sidecar 再告诉脚本 —— 那样这脚本就没法「一条命令跑完」。
 */
export async function startBiliCheck({ dataDir, copyFrom = false, label = 'B站比价验证' } = {}) {
  const dir = path.resolve(dataDir)
  const copied = copyFrom ? copyRealData(dir) : []
  if (!copyFrom) fs.mkdirSync(path.join(dir, 'bili-tmp'), { recursive: true })

  process.env.XFC_DATA_DIR = dir
  process.env.XFC_VISION_PORT = String(CHECK_VISION_PORT)
  process.env.XFC_VISION_AUTOSTART = '1'
  // 自己拉 sidecar，别去用 XFC_VISION_URL 指的那个（那个的 token 我们不知道）
  delete process.env.XFC_VISION_URL
  delete process.env.XFC_VISION_TOKEN
  if (!process.env.XFC_VISION_PYTHON) process.env.XFC_VISION_PYTHON = realVenvPython()
  if (!process.env.XFC_BILI_YTDLP_PYTHON) process.env.XFC_BILI_YTDLP_PYTHON = realVenvPython()
  process.env.XFC_BILI_DIR = path.join(dir, 'bili-tmp')
  // 别让验证脚本顺手把媒体执行器、定时发布也拉起来
  process.env.XFC_MEDIA_EXECUTOR_AUTOSTART = '0'
  process.env.XFC_MEDIA_SCHEDULER_INTERVAL_MS = '0'
  // 本地模式：不校验局域网来源
  process.env.XFC_LOCAL = '1'

  const { createApplication } = await import('../../src/server/app.mjs')
  const { createSession } = await import('../../src/auth.mjs')
  const { sessionCookie } = await import('../../src/http.mjs')
  const { db } = await import('../../src/db.mjs')

  const app = createApplication()
  await new Promise((resolve, reject) => {
    app.server.once('error', reject)
    app.server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = app.server.address()
  const base = `http://127.0.0.1:${port}`

  const { token } = createSession('127.0.0.1', 'bili-check')
  const cookie = sessionCookie(token, Date.now() + 3600_000).split(';')[0]

  const stop = async () => {
    await new Promise((resolve) => app.server.close(resolve))
    try { db.close() } catch { /* 进程马上要退，关不掉就算了 */ }
  }

  console.log(`${label}\n  实例 ${base}   数据目录 ${dir}${copied.length ? `（复制了 ${copied.join('、')}）` : ''}\n`)

  return { base, port, dir, cookie, stop }
}

/** 把视觉后端拉起来。没有它 OCR 一步都跑不了，所以起不来就直接报清楚 */
export async function ensureVision() {
  const { ensureVisionStarted } = await import('../../src/vision-python.mjs')
  const started = await ensureVisionStarted({ force: true })
  if (!started.ok) {
    throw new Error(
      `视觉后端起不来：${started.error}\n` +
        `  比价要靠它做 OCR。可以在设置页点「一键安装依赖」，或先确认 data/vision-venv 是好的。`
    )
  }
  return started
}

/* ============================================================
   断言
   ============================================================ */

export function makeChecker() {
  const state = { pass: 0, failures: [] }
  const check = (label, cond, detail = '') => {
    if (cond) {
      state.pass += 1
      console.log(`  ✓ ${label}${detail ? `  ${detail}` : ''}`)
    } else {
      state.failures.push(label)
      console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`)
    }
  }
  const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 44 - title.length))}`)
  const finish = () => {
    console.log(`\n${state.failures.length ? `✗ 通过 ${state.pass} 项，失败 ${state.failures.length} 项` : `✓ 全部通过（${state.pass} 项）`}`)
    for (const f of state.failures) console.log(`    · ${f}`)
    return state.failures.length
  }
  return { check, section, finish, state }
}

export function makeCaller(base, cookie) {
  return async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let data = null
    try { data = JSON.parse(text) } catch { data = text }
    return { status: res.status, data }
  }
}

/** 轮询一个扫描任务到结束 */
export async function waitForJob(call, jobId, { timeoutMs = 10 * 60_000, onTick } = {}) {
  const t0 = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000))
    const job = (await call('GET', `/api/price-scan/jobs/${jobId}`)).data
    if (onTick) onTick(job)
    if (job?.status !== 'running') return { job, ms: Date.now() - t0 }
    if (Date.now() - t0 > timeoutMs) return { job, ms: Date.now() - t0, timedOut: true }
  }
}

/** 直接读库里的服务项价格，用来确认「到底写进去没有」*/
export async function readPrices(dbFile, gameName) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const rows = db.prepare(
    'select s.id, s.name, s.base_price from services s join games g on g.id = s.game_id where g.name = ?'
  ).all(gameName)
  db.close()
  return new Map(rows.map((r) => [r.id, r]))
}

/** 找游戏；顺带把列表返回给调用方复用 */
export async function findGame(call, name) {
  const res = await call('GET', '/api/games')
  const list = Array.isArray(res.data) ? res.data : res.data?.items || []
  return { game: list.find((g) => String(g.name).includes(name)), list }
}
