/**
 * B站自动比价的外部依赖：yt-dlp（下载视频）和 ffmpeg（抽帧）。
 *
 * 为什么只装 yt-dlp 这一个包：解析价格用的 OCR 是项目里现成的 Python 视觉
 * sidecar，抽帧用系统 ffmpeg，都不需要额外东西。真正缺的只有「把 B站 视频
 * 下到本地」这一步，而这件事目前没有比 yt-dlp 更省事的做法。
 *
 * 装到哪：复用视觉后端那个项目内 venv（data/vision-venv）。它已经是「项目自己的
 * Python 环境」这个角色了，再开一个 venv 只会多一份几百 MB 的副本。yt-dlp 是
 * 纯 Python 包，和 onnxruntime / cv2 互不干扰；data/ 也已经在 .gitignore 里。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  BILI_INSTALL_TIMEOUT_MS,
  BILI_YTDLP_PACKAGE,
  BILI_YTDLP_PYTHON,
  DATA_DIR,
  ROOT,
  VISION_VENV,
} from '../core/config.mjs'

const jobs = new Map()
let cachedProbe = null

function run(bin, args, timeoutMs = 20000) {
  try {
    return spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  } catch (error) {
    return { status: -1, stdout: '', stderr: error.message || '' }
  }
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** 找一个能用来建 venv 的基础 Python（不能是 WindowsApps 那个 alias，它建不出 venv） */
function basePythonCandidates() {
  const raw = [
    process.env.XFC_BILI_PYTHON,
    process.env.XFC_PYTHON,
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
    'python',
  ].filter(Boolean)
  const out = []
  for (const bin of raw) {
    if (path.isAbsolute(bin)) {
      if (isFile(bin)) out.push(bin)
      continue
    }
    const probe = run(bin, ['-c', 'import sys; print(sys.executable)'])
    const resolved = String(probe.stdout || '').trim().split(/\r?\n/).pop() || ''
    // WindowsApps 下的 python.exe 是个转发 alias：能打印版本，但 -m venv 会失败。
    if (resolved && path.isAbsolute(resolved) && isFile(resolved) && !/WindowsApps/i.test(resolved)) out.push(resolved)
    out.push(bin)
  }
  return [...new Set(out)]
}

/** venv 里的 python 在不在 */
export function venvPythonPath() {
  return BILI_YTDLP_PYTHON
}

function venvPython() {
  return isFile(BILI_YTDLP_PYTHON) ? BILI_YTDLP_PYTHON : null
}

/** 探测 yt-dlp：优先项目 venv，其次看 PATH 里有没有（用户可能自己装过） */
export function probeYtDlp() {
  const venv = venvPython()
  const attempts = []
  if (venv) attempts.push({ source: 'venv', bin: venv })
  attempts.push({ source: 'path', bin: process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp' })
  attempts.push({ source: 'path', bin: 'yt-dlp' })

  for (const attempt of attempts) {
    if (attempt.source === 'venv' || path.isAbsolute(attempt.bin)) {
      if (!isFile(attempt.bin)) continue
      const probe = run(attempt.bin, ['-m', 'yt_dlp', '--version'], 30000)
      const version = String(probe.stdout || '').trim().split(/\r?\n/).pop() || ''
      if (probe.status === 0 && /^\d{4}\./.test(version)) {
        return { available: true, source: attempt.source, python: attempt.bin, version, package: BILI_YTDLP_PACKAGE }
      }
      continue
    }
    const probe = run(attempt.bin, ['--version'], 30000)
    const version = String(probe.stdout || '').trim().split(/\r?\n/).pop() || ''
    if (probe.status === 0 && /^\d{4}\./.test(version)) {
      return { available: true, source: 'binary', python: '', binary: attempt.bin, version, package: BILI_YTDLP_PACKAGE }
    }
  }
  return { available: false, source: '', python: venv || '', version: '', package: BILI_YTDLP_PACKAGE }
}

/**
 * 探测 ffmpeg。
 * 除了 PATH，也认几个 Windows 上常见的安装位置 —— 装完 ffmpeg 忘了加 PATH
 * 是最常见的情况，直接报「没装」会让人白折腾。
 */
export function probeFfmpeg() {
  const which = run(process.platform === 'win32' ? 'where.exe' : 'which', ['ffmpeg'])
  const fromPath = String(which.stdout || '')
    .trim()
    .split(/\r?\n/)[0]
  if (which.status === 0 && fromPath && isFile(fromPath)) {
    return { available: true, bin: fromPath }
  }
  const candidates = [
    process.env.XFC_FFMPEG,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'ffmpeg', 'bin', 'ffmpeg.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'ffmpeg', 'bin', 'ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  ].filter(Boolean)
  const hit = candidates.find((p) => isFile(p))
  return { available: Boolean(hit), bin: hit || '' }
}

export function biliDependencyStatus({ force = false } = {}) {
  if (!force && cachedProbe) return cachedProbe
  const ytdlp = probeYtDlp()
  const ffmpeg = probeFfmpeg()
  cachedProbe = {
    ytdlp,
    ffmpeg,
    ready: Boolean(ytdlp.available && ffmpeg.available),
    venv: { path: VISION_VENV, exists: isFile(BILI_YTDLP_PYTHON) },
    install: {
      // 一键安装要跑两步：venv 不在就先建，然后 pip 装 yt-dlp
      needs_venv: !isFile(BILI_YTDLP_PYTHON),
      package: BILI_YTDLP_PACKAGE,
      base_python: basePythonCandidates()[0] || '',
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
    let child
    try {
      child = spawn(bin, args, { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: -1, error: error.message })
      return
    }
    child.stdout.on('data', (chunk) => appendJob(job, chunk.toString()))
    child.stderr.on('data', (chunk) => appendJob(job, chunk.toString()))
    child.on('error', (error) => resolve({ code: -1, error: error.message }))
    child.on('close', (code) => resolve({ code: code ?? -1 }))
  })
}

export function biliDependencyInstallStatus(id) {
  const job = jobs.get(String(id || ''))
  return job || { status: 'missing', error: '安装任务不存在' }
}

/**
 * 一键安装 yt-dlp 到项目 venv。
 * 已经装了就直接返回成功，不重复跑 pip（pip 每次都要解析依赖，白等十几秒）。
 */
export function startBiliDependencyInstall() {
  const probe = biliDependencyStatus({ force: true })
  if (probe.ytdlp.available) {
    return { ok: true, already: true, status: probe, message: `yt-dlp 已就绪（${probe.ytdlp.version}）` }
  }
  if (!probe.ffmpeg.available) {
    // ffmpeg 没法替用户自动装（各平台分发方式差别太大），但要说清楚
    return {
      ok: false,
      code: 'ffmpeg_missing',
      error: '没找到 ffmpeg。抽帧要用它，请先安装 ffmpeg 并确保 ffmpeg 命令在 PATH 里。',
      status: probe,
    }
  }
  const active = [...jobs.values()].find((job) => job.status === 'running')
  if (active) return { ok: true, job: active.id }

  const id = `bili-deps-${Date.now().toString(36)}`
  const job = {
    id,
    status: 'running',
    step: '准备安装',
    log: '',
    started_at: new Date().toISOString(),
    finished_at: null,
    error: '',
  }
  jobs.set(id, job)

  void (async () => {
    const finish = (status, error = '') => {
      job.status = status
      job.error = error
      job.finished_at = new Date().toISOString()
      cachedProbe = null
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      // 第一步：venv 不在就先建（复用视觉后端那个，所以只在它也没建的时候才跑）
      if (!isFile(BILI_YTDLP_PYTHON)) {
        const base = probe.install.base_python
        if (!base) {
          finish('failed', '没有找到可用的 Python 3。请先安装 Python 3.10 或更高版本。')
          return
        }
        const created = await spawnStep(job, base, ['-m', 'venv', VISION_VENV], '创建项目 Python 环境')
        if (created.code !== 0 || !isFile(BILI_YTDLP_PYTHON)) {
          finish('failed', '创建项目 Python 环境失败，请查看安装日志。')
          return
        }
      }
      // 第二步：装 yt-dlp
      const python = venvPython()
      const pip = await spawnStep(
        job,
        python,
        ['-m', 'pip', 'install', '--disable-pip-version-check', '--upgrade', BILI_YTDLP_PACKAGE],
        `安装 ${BILI_YTDLP_PACKAGE}`,
      )
      if (pip.code !== 0) {
        finish('failed', 'pip 安装 yt-dlp 失败，请查看安装日志。')
        return
      }
      const after = probeYtDlp()
      if (!after.available) {
        finish('failed', '装完了但探测不到 yt-dlp，可能是 pip 装到了别处。')
        return
      }
      finish('success')
    } catch (error) {
      finish('failed', error?.message || '安装过程出错')
    }
  })()

  return { ok: true, job: id }
}

/** 供任务编排用：拿到「怎么调 yt-dlp」这一条命令前缀 */
export function ytDlpInvocation() {
  const probe = probeYtDlp()
  if (!probe.available) return null
  if (probe.source === 'binary') return { bin: probe.binary, prefix: [], version: probe.version }
  return { bin: probe.python, prefix: ['-m', 'yt_dlp'], version: probe.version }
}

export const __testing = { basePythonCandidates, venvPython, BILI_INSTALL_TIMEOUT_MS }
