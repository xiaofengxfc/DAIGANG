import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DATA_DIR, MEDIA_COOKIE_DIR, MEDIA_EXECUTOR_AUTO_START, MEDIA_EXECUTOR_PORT, MEDIA_EXECUTOR_SCRIPT, MEDIA_EXECUTOR_TOKEN, MEDIA_EXECUTOR_URL, MEDIA_PUBLISH_ROOT, MEDIA_REQUIREMENTS_FILE, MEDIA_EXECUTOR_REQUIREMENTS_FILE, MEDIA_PYTHON, ROOT } from '../core/config.mjs'

const jobs = new Map()
let cachedProbe = null
let executorProcess = null
let executorUrl = ''

function run(bin, args, timeoutMs = 8000) {
  try {
    return spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  } catch (error) {
    return { status: -1, stdout: '', stderr: error.message || '' }
  }
}

function pythonCandidates() {
  const raw = [...new Set([MEDIA_PYTHON, process.env.XFC_PYTHON, process.platform === 'win32' ? 'python' : 'python3', 'python3', 'python'].filter(Boolean))]
  const resolved = []
  for (const bin of raw) {
    // WindowsApps' python.exe is an alias. Resolve it before spawning Playwright;
    // the alias can pass import probes but fails when Playwright creates artifacts.
    if (!path.isAbsolute(bin)) {
      const probe = run(bin, ['-c', 'import sys; print(sys.executable)'])
      const executable = String(probe.stdout || '').trim().split(/\r?\n/).pop() || ''
      if (executable && path.isAbsolute(executable) && fs.existsSync(executable)) resolved.push(executable)
    }
    resolved.push(bin)
  }
  return [...new Set(resolved)]
}

function probePython() {
  const tried = []
  let firstPython = null
  let best = null
  for (const bin of pythonCandidates()) {
    const version = run(bin, ['--version'])
    const text = `${version.stdout || ''}${version.stderr || ''}`.trim()
    tried.push({ bin, output: text, status: version.status })
    if (version.status !== 0 || !/^Python\s+3\./i.test(text)) continue
    if (!firstPython) firstPython = { available: true, bin, version: text.replace(/^Python\s+/i, ''), dependencies: false, playwright: false, browser: false, browser_path: '' }
    const imports = run(bin, ['-c', 'import flask, playwright; print("ok")'], 12000)
    const playwright = imports.status === 0 && /ok/.test(`${imports.stdout || ''}`)
    if (!playwright) continue
    const browserProbe = run(bin, ['-c', 'from playwright.sync_api import sync_playwright; p=sync_playwright().start(); print(p.chromium.executable_path); p.stop()'], 12000)
    const browserPath = String(browserProbe.stdout || '').trim().split(/\r?\n/).pop() || ''
    const browser = browserProbe.status === 0 && (() => { try { return fs.statSync(browserPath).isFile() } catch { return false } })()
    best = { available: true, bin, version: text.replace(/^Python\s+/i, ''), dependencies: true, playwright: true, browser, browser_path: browser ? browserPath : '' }
    if (browser) return { ...best, tried }
  }
  if (best) return { ...best, tried }
  if (firstPython) return { ...firstPython, tried }
  return { available: false, bin: '', version: '', dependencies: false, playwright: false, browser: false, browser_path: '', tried }
}

function probeChrome() {
  const candidates = [
    process.env.XFC_MEDIA_CHROME_PATH,
    process.env.CHROME_PATH,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.platform === 'darwin' && '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.platform !== 'win32' && '/usr/bin/google-chrome',
  ].filter(Boolean)
  const hit = candidates.find((candidate) => { try { return fs.statSync(candidate).isFile() } catch { return false } })
  return { available: Boolean(hit), path: hit || '', candidates }
}

export function mediaDependencyStatus({ force = false } = {}) {
  if (!force && cachedProbe) return cachedProbe
  const python = probePython()
  const chrome = probeChrome()
  cachedProbe = {
    python,
    chrome,
    requirements: { exists: fs.existsSync(MEDIA_REQUIREMENTS_FILE), path: MEDIA_REQUIREMENTS_FILE },
    executor_requirements: { exists: fs.existsSync(MEDIA_EXECUTOR_REQUIREMENTS_FILE), path: MEDIA_EXECUTOR_REQUIREMENTS_FILE },
    source: { exists: fs.existsSync(path.join(MEDIA_PUBLISH_ROOT, 'sau_backend')), path: path.join(MEDIA_PUBLISH_ROOT, 'sau_backend') },
    executor: { ready: Boolean(python.available && python.dependencies && python.playwright && (python.browser || chrome.available)) },
    install: {
      requirements: MEDIA_EXECUTOR_REQUIREMENTS_FILE,
      commands: python.available ? [`${python.bin} -m pip install -r "${MEDIA_EXECUTOR_REQUIREMENTS_FILE}"`, `${python.bin} -m playwright install chromium`] : ['安装 Python 3.10 或更高版本后，再回到这里安装依赖'],
      python_download: 'https://www.python.org/downloads/windows/',
    },
  }
  return cachedProbe
}

function appendJob(job, text) {
  if (!text) return
  job.log = `${job.log}${text}`.slice(-12000)
}

function spawnStep(job, bin, args, label) {
  return new Promise((resolve) => {
    job.step = label
    const child = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => appendJob(job, chunk.toString()))
    child.stderr.on('data', (chunk) => appendJob(job, chunk.toString()))
    child.on('error', (error) => resolve({ code: -1, error: error.message }))
    child.on('close', (code) => resolve({ code: code ?? -1 }))
  })
}

export function startMediaDependencyInstall() {
  const probe = mediaDependencyStatus({ force: true })
  if (!probe.python.available) return { ok: false, code: 'python_missing', error: '没有找到 Python 3，请先安装 Python 3.10 或更高版本', status: probe }
  const active = [...jobs.values()].find((job) => job.status === 'running')
  if (active) return { ok: true, job: active.id }
  const id = `media-deps-${Date.now().toString(36)}`
  const job = { id, status: 'running', step: '准备安装', log: '', started_at: new Date().toISOString(), finished_at: null, error: '' }
  jobs.set(id, job)
  ;(async () => {
    const pip = await spawnStep(job, probe.python.bin, ['-m', 'pip', 'install', '-r', MEDIA_EXECUTOR_REQUIREMENTS_FILE], '安装执行器依赖')
    if (pip.code !== 0) {
      job.status = 'failed'
      job.error = 'Python 依赖安装失败，请查看安装日志'
      job.finished_at = new Date().toISOString()
      cachedProbe = null
      return
    }
    const browser = await spawnStep(job, probe.python.bin, ['-m', 'playwright', 'install', 'chromium'], '安装 Playwright Chromium')
    job.status = browser.code === 0 ? 'success' : 'failed'
    job.error = browser.code === 0 ? '' : 'Chromium 安装失败，请查看安装日志'
    job.finished_at = new Date().toISOString()
    cachedProbe = null
  })()
  return { ok: true, job: id }
}

export function mediaDependencyInstallStatus(id) {
  const job = jobs.get(String(id || ''))
  return job || { status: 'missing', error: '安装任务不存在' }
}

export function startMediaExecutor() {
  if (MEDIA_EXECUTOR_URL || !MEDIA_EXECUTOR_AUTO_START || executorProcess || !fs.existsSync(MEDIA_EXECUTOR_SCRIPT)) return mediaExecutorInfo()
  const probe = mediaDependencyStatus()
  if (!probe.executor.ready) return mediaExecutorInfo()
  const executorTempDir = path.join(DATA_DIR, 'media-tmp')
  fs.mkdirSync(executorTempDir, { recursive: true })
  const env = {
    ...process.env,
    TEMP: executorTempDir,
    TMP: executorTempDir,
    TMPDIR: executorTempDir,
    XFC_MEDIA_SOURCE_ROOT: ROOT,
    XFC_MEDIA_COOKIE_DIR: MEDIA_COOKIE_DIR,
    XFC_MEDIA_EXECUTOR_PORT: String(MEDIA_EXECUTOR_PORT),
    XFC_MEDIA_EXECUTOR_TOKEN: MEDIA_EXECUTOR_TOKEN,
    XFC_MEDIA_CHROME_PATH: process.env.XFC_MEDIA_CHROME_PATH || probe.python.browser_path || probe.chrome.path || '',
  }
  try {
    executorProcess = spawn(probe.python.bin, [MEDIA_EXECUTOR_SCRIPT], { cwd: MEDIA_PUBLISH_ROOT, env, stdio: 'ignore', windowsHide: true })
    executorProcess.unref()
    /**
     * 这个子进程的两条失败路径都要接住。
     *
     * 'error'：spawn 本身失败（python 被卸载、EACCES、ENOENT）。ChildProcess 的
     *   'error' 没有监听器时是**未捕获异常**，会把整个后端进程带走；而且这时候
     *   不会触发 'exit'，executorProcess 会一直是真值，函数开头那句
     *   `if (executorProcess) return` 就永久短路，自动启动再也拉不起来。
     * 'exit'：进程退出，清掉状态，下次还能重新拉起来。
     */
    executorProcess.on('error', (err) => {
      console.error('[media-executor] 启动失败：', err?.message || err)
      executorProcess = null
      executorUrl = ''
    })
    executorProcess.once('exit', () => { executorProcess = null; executorUrl = '' })
    executorUrl = `http://127.0.0.1:${MEDIA_EXECUTOR_PORT}`
  } catch {
    executorProcess = null
    executorUrl = ''
  }
  return mediaExecutorInfo()
}

export function stopMediaExecutor() {
  if (!executorProcess) return
  try { executorProcess.kill() } catch {}
  executorProcess = null
  executorUrl = ''
}

export function mediaExecutorInfo() {
  const url = MEDIA_EXECUTOR_URL || executorUrl
  return { configured: Boolean(url), auto_started: Boolean(executorUrl), url: url ? `${url}/tasks` : '', health: url ? `${url}/health` : '' }
}

export function mediaExecutorBaseUrl() {
  return (MEDIA_EXECUTOR_URL || executorUrl).replace(/\/+$/, '')
}

/**
 * 等执行器真的能应答（最多 timeoutMs）。
 *
 * 为什么需要：`startMediaExecutor()` 只把进程拉起来就返回，Flask 还要几秒才
 * bind 端口。派发流程紧接着就 POST /tasks，撞上的必然是 ECONNREFUSED ——
 * 任务从 queued 被改成 failed，定时发布更是静默错过发布时刻。
 * 所以派发前在这里等一下（健康检查带 token，见 media_executor.py 的 /health）。
 */
export async function waitMediaExecutorReady(timeoutMs = 8000) {
  const base = (MEDIA_EXECUTOR_URL || executorUrl).replace(/\/+$/, '')
  if (!base) return false
  const headers = MEDIA_EXECUTOR_TOKEN ? { authorization: `Bearer ${MEDIA_EXECUTOR_TOKEN}` } : {}
  const deadline = Date.now() + Math.max(0, timeoutMs)
  for (;;) {
    try {
      const res = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
    } catch {
      /* 端口还没 bind，继续等 */
    }
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
