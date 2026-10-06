/* ============================================================
   Python 视觉进程（sidecar）的客户端 + 生命周期。

   Node 这边的职责边界（P1）：
     · 探测解释器、装依赖 → vision-deps.mjs
     · 起进程 / 探活 / 失败重启 / 退出清理 → 这里
     · 识别本身 → 这个文件只做「把图发给它、把词框拿回来」

   为什么要长驻而不是每次起一个脚本：见 integrations/screen-vision/server.py
   的注释（载模型 0.8s + 预热 4s，一次识别要 16 帧，每次起进程没法用）。

   失败一定降级：这个模块里任何一个函数失败，都只是让 python 后端「不在线」，
   src/ocr.mjs 会继续往旧引擎链（RapidOCR-json exe → Windows 自带 OCR）走。
   ============================================================ */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  ROOT,
  VISION_AUTOSTART,
  VISION_LOG,
  VISION_OCR_TIMEOUT_MS,
  VISION_PORT,
  VISION_PYTHON,
  VISION_SERVER,
  VISION_START_TIMEOUT_MS,
  VISION_TMP,
  VISION_TOKEN,
  VISION_URL,
  VISION_VENV,
} from './config.mjs'
import { visionDependencyStatus, visionDependencyStatusCached, visionVenvPython } from './vision-deps.mjs'

const ENGINE_ID = 'python'
const HEALTH_TTL_MS = 20 * 1000
/** 10 分钟内最多重启几次。超过就认输 —— 不能让一个坏掉的 sidecar 把 CPU 打满 */
const MAX_SPAWNS_PER_WINDOW = 4
const SPAWN_WINDOW_MS = 10 * 60 * 1000
const LOG_MAX_BYTES = 2 * 1024 * 1024

let child = null
let logFd = null
let starting = null
let stopping = false
let spawnTimes = []
let blockedReason = ''
let lastHealth = { ok: false, at: 0, payload: null, error: '' }

export function visionBaseUrl() {
  return VISION_URL || `http://127.0.0.1:${VISION_PORT}`
}

function authHeaders() {
  return VISION_TOKEN ? { Authorization: `Bearer ${VISION_TOKEN}` } : {}
}

/** 带超时的 JSON 请求。失败一律返回 {ok:false, error}，绝不抛 —— 调用方全在识别路径上 */
async function requestJSON(url, { method = 'GET', body = null, timeoutMs = 5000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: { ...authHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      return { ok: false, error: `返回值不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}` }
    }
    if (!res.ok) return { ok: false, error: (json && json.error) || `HTTP ${res.status}`, payload: json }
    return { ok: true, payload: json }
  } catch (err) {
    const reason = err.name === 'AbortError' ? `超时（${timeoutMs}ms）` : err.message
    return { ok: false, error: reason }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 探一次 /health。
 * `warm` 才算真的能用：进程活着但模型还没载完（loading）时，识别会 503，
 * 那种状态不能算「在线」，否则第一帧会白等一个超时。
 */
export async function probeVisionHealth({ timeoutMs = 1500, force = false } = {}) {
  if (!force && lastHealth.at && Date.now() - lastHealth.at < HEALTH_TTL_MS) return lastHealth
  const r = await requestJSON(`${visionBaseUrl()}/health`, { timeoutMs })
  const payload = r.payload || null
  const online = Boolean(r.ok && payload && payload.ok && payload.warm)
  lastHealth = {
    ok: online,
    at: Date.now(),
    payload: online ? payload : payload || null,
    error: online ? '' : r.error || (payload && payload.loading ? '模型还在加载' : (payload && payload.error) || '没连上'),
  }
  return lastHealth
}

/** 同步快照，给 ocrEngines() / 状态接口用（**不**触发任何探测，不会阻塞事件循环） */
export function visionBackendStatus() {
  const deps = visionDependencyStatusCached()
  return {
    mode: 'python',
    engine: ENGINE_ID,
    url: visionBaseUrl(),
    external: Boolean(VISION_URL),
    autostart: VISION_AUTOSTART,
    running: Boolean(child),
    online: Boolean(lastHealth.ok),
    warm: Boolean(lastHealth.payload && lastHealth.payload.warm),
    health_at: lastHealth.at || 0,
    error: lastHealth.error || blockedReason || '',
    blocked: blockedReason,
    // 依赖状态只在「已经探过」时给 —— 同步接口里不能跑 python 探测
    deps_checked: Boolean(deps),
    deps_ready: deps ? Boolean(deps.ready) : null,
    venv: deps ? deps.venv : { path: VISION_VENV, exists: Boolean(visionVenvPython()), python: visionVenvPython() },
    interpreter: deps ? deps.interpreter : { available: null, bin: VISION_PYTHON || '', version: '' },
    models: lastHealth.payload ? lastHealth.payload.models || null : null,
    load_ms: lastHealth.payload ? lastHealth.payload.load_ms ?? null : null,
    warm_ms: lastHealth.payload ? lastHealth.payload.warm_ms ?? null : null,
    last_ms: lastHealth.payload ? lastHealth.payload.last_ms ?? null : null,
    python: lastHealth.payload ? lastHealth.payload.python || '' : '',
    log: VISION_LOG,
    pid: child ? child.pid : (lastHealth.payload ? lastHealth.payload.pid : null),
  }
}

/* ============================================================
   起进程
   ============================================================ */

function rotateLogIfHuge() {
  try {
    const st = fs.statSync(VISION_LOG)
    if (st.size > LOG_MAX_BYTES) fs.renameSync(VISION_LOG, `${VISION_LOG}.1`)
  } catch {
    /* 文件不存在就算了 */
  }
}

function openLog() {
  try {
    fs.mkdirSync(path.dirname(VISION_LOG), { recursive: true })
    rotateLogIfHuge()
    return fs.openSync(VISION_LOG, 'a')
  } catch {
    return null
  }
}

function note(message) {
  try {
    fs.appendFileSync(VISION_LOG, `[node ${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* 写不进去就算了 */
  }
}

/**
 * 起一个 sidecar 进程（不等它就绪）。
 * 解释器优先级：venv 里的 python（依赖装在它里面）→ XFC_VISION_PYTHON → 系统 python。
 */
export function spawnVisionSidecar({ force = false } = {}) {
  if (child) return { ok: true, already: true, pid: child.pid }
  if (VISION_URL) return { ok: false, error: '配置了 XFC_VISION_URL，交给外部进程，这里不起' }
  // force：用户明确点了「启动」，那就无视「不自动启动」这条设置
  if (!force && !VISION_AUTOSTART) return { ok: false, error: 'XFC_VISION_AUTOSTART=0，不自动启动' }
  if (!fs.existsSync(VISION_SERVER)) return { ok: false, error: `找不到 sidecar 脚本：${VISION_SERVER}` }

  const recent = spawnTimes.filter((t) => Date.now() - t < SPAWN_WINDOW_MS)
  if (recent.length >= MAX_SPAWNS_PER_WINDOW) {
    blockedReason = `10 分钟内已经重启 ${recent.length} 次，先不自动重启了（看 ${VISION_LOG} 里的报错，或者手动点「启动」）`
    return { ok: false, error: blockedReason }
  }

  const deps = visionDependencyStatusCached()
  const python = visionVenvPython() || (deps && deps.interpreter && deps.interpreter.bin) || VISION_PYTHON
  if (!python) return { ok: false, error: '没找到 Python 解释器（先在设置页点「一键安装依赖」）' }

  try {
    fs.mkdirSync(VISION_TMP, { recursive: true })
  } catch {
    /* 建不了就用系统 TEMP */
  }

  logFd = openLog()
  const env = {
    ...process.env,
    XFC_VISION_ROOT: ROOT,
    XFC_VISION_PORT: String(VISION_PORT),
    XFC_VISION_TOKEN: VISION_TOKEN,
    // 让 sidecar 盯着 stdin：父进程一死它就自己退（见 server.py 的 watch_parent_stdin）
    XFC_VISION_WATCH_STDIN: '1',
    // 中文路径 + 中文日志：不让 python 按系统 GBK 编解码
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
  }
  if (fs.existsSync(VISION_TMP)) {
    env.TEMP = VISION_TMP
    env.TMP = VISION_TMP
    env.TMPDIR = VISION_TMP
  }

  try {
    child = spawn(python, [VISION_SERVER], {
      cwd: ROOT,
      env,
      // 日志落文件而不是 ignore：载模型失败、onnxruntime 缺 DLL 这些
      // 只有 stderr 里才有，设置页要能翻到。
      // stdin 给一个管道是**故意的**：server.py 有个线程在读它，父进程一死
      // 管道就 EOF，sidecar 自己退出。少了这道保险，程序被强杀之后
      // 会留下一个占着 5410 端口的 python，下次启动就抢不到端口了。
      stdio: ['pipe', logFd === null ? 'ignore' : logFd, logFd === null ? 'ignore' : logFd],
      windowsHide: true,
    })
  } catch (err) {
    child = null
    return { ok: false, error: `起不了 sidecar：${err.message}` }
  }

  // 别让它把 Node 的事件循环拖住：脚本（自检/对照）跑完就该退出，
  // 不能因为「还挂着一个子进程」卡在那儿不动。
  child.unref()
  try {
    child.stdin?.on('error', () => {})
  } catch {
    /* 管道关了就关了 */
  }

  spawnTimes.push(Date.now())
  note(`启动 sidecar pid=${child.pid} python=${python} port=${VISION_PORT}`)
  child.once('error', (err) => note(`sidecar 进程错误：${err.message}`))
  child.once('exit', (code, signal) => {
    note(`sidecar 退出 code=${code} signal=${signal}`)
    child = null
    lastHealth = { ok: false, at: 0, payload: null, error: `进程退出了（code=${code}）` }
    if (logFd !== null) {
      try {
        fs.closeSync(logFd)
      } catch {
        /* 已经关了 */
      }
      logFd = null
    }
  })
  return { ok: true, pid: child.pid, python }
}

async function waitForWarm(deadline) {
  let last = null
  while (Date.now() < deadline) {
    last = await probeVisionHealth({ timeoutMs: 2000, force: true })
    if (last.ok) return last
    // 进程已经死了就别再等了
    if (!child && !VISION_URL) return last
    await new Promise((r) => setTimeout(r, 500))
  }
  return last || { ok: false, error: '等就绪超时' }
}

/**
 * 确保 sidecar 在线且**预热完成**。并发调用只会起一个进程。
 * 这是唯一会「等」的函数，调用点都在后台（启动时、设置页点按钮），
 * 识别路径上不会等它。
 *
 * force=true 表示「用户明确要起」（设置页的「启动」按钮）—— 那种情况下
 * 无视 XFC_VISION_AUTOSTART=0。测试实例会把自启关掉，免得去抢真实例的端口。
 */
export async function ensureVisionStarted({ timeoutMs = VISION_START_TIMEOUT_MS, force = false } = {}) {
  if (stopping) return { ok: false, error: '正在关闭' }
  const quick = await probeVisionHealth({ timeoutMs: 1200, force: true })
  if (quick.ok) return { ok: true, ...quick.payload, reused: true }
  if (!force && !VISION_AUTOSTART) return { ok: false, error: '没开自启（XFC_VISION_AUTOSTART=0）；要起就在设置页点「启动」' }
  if (VISION_URL) return { ok: false, error: `外部 sidecar 没响应：${quick.error}` }
  /**
   * 端口上已经有东西在监听，但 token 对不上 —— 那是**上一次留下的 sidecar**
   * （或者别人占了这个端口）。这时候再 spawn 一个只会绑不上端口、白等一轮超时，
   * 所以直接说清楚，让用户去结束那个 python 或换个端口。
   */
  if (/token/i.test(String(quick.error || ''))) {
    return {
      ok: false,
      error: `${visionBaseUrl()} 上已经有一个视觉进程，但 token 对不上（多半是上一次被强杀留下的 python.exe）。在任务管理器里结束它，或者用 XFC_VISION_PORT 换个端口。`,
    }
  }

  if (starting) return starting

  starting = (async () => {
    const deps = visionDependencyStatus()
    if (!deps.ready) {
      return {
        ok: false,
        error: deps.interpreter.available
          ? 'Python 有了，但依赖没装齐（设置 → 屏幕识别 → Python 视觉后端 → 一键安装依赖）'
          : '这台机器上没有 Python 3（装一个再来，或者继续用旧的 OCR 引擎）',
        deps,
      }
    }
    const spawned = spawnVisionSidecar({ force })
    if (!spawned.ok) return { ok: false, error: spawned.error }
    const warm = await waitForWarm(Date.now() + timeoutMs)
    if (!warm.ok) return { ok: false, error: `sidecar 起来了但没就绪：${warm.error}` }
    return { ok: true, ...warm.payload }
  })().finally(() => {
    starting = null
  })

  return starting
}

export function stopVisionSidecar() {
  stopping = true
  if (!child) return { ok: true, stopped: false }
  const pid = child.pid
  try {
    child.kill()
  } catch {
    /* 可能已经退了 */
  }
  child = null
  lastHealth = { ok: false, at: 0, payload: null, error: '已停止' }
  if (logFd !== null) {
    try {
      fs.closeSync(logFd)
    } catch {
      /* 已经关了 */
    }
    logFd = null
  }
  return { ok: true, stopped: true, pid }
}

/** 允许再次自动启动（用户手动点了「启动」之后用） */
export function resetVisionBlock() {
  blockedReason = ''
  spawnTimes = []
  stopping = false
  return { ok: true }
}

/**
 * sidecar 日志的最后几行。
 * 载模型失败、onnxruntime 缺 DLL、模型文件对不上 —— 这些只有它自己的 stderr 里有，
 * 设置页要能直接看到，而不是让用户去猜「为什么起不来」。
 */
export function visionLogTail(lines = 40) {
  try {
    const text = fs.readFileSync(VISION_LOG, 'utf8')
    const all = text.split(/\r?\n/).filter(Boolean)
    return { path: VISION_LOG, lines: all.slice(-Math.max(1, Math.min(200, lines))), truncated: all.length > lines }
  } catch (err) {
    return { path: VISION_LOG, lines: [], truncated: false, error: err.code === 'ENOENT' ? '还没有日志（sidecar 没启动过）' : err.message }
  }
}

/* ============================================================
   识别
   ============================================================ */

/**
 * 认一张图（走 det+rec，和旧引擎链里其它引擎同一个语义）。
 *
 * 返回形状刻意和别的引擎对齐：{ ok, engine, words, ms, size }。
 * **不在这里算 lines**：那是显示用的行分组，在 src/ocr.mjs 里做 ——
 * 让这个模块只依赖 config/deps，不反向依赖 ocr.mjs（不然就是循环 import）。
 */
export async function visionOcr(imagePath, { timeoutMs = VISION_OCR_TIMEOUT_MS, useCls = null } = {}) {
  const body = { image_path: path.resolve(imagePath) }
  if (useCls !== null) body.use_cls = Boolean(useCls)
  const r = await requestJSON(`${visionBaseUrl()}/ocr`, { method: 'POST', body, timeoutMs })
  if (!r.ok) {
    lastHealth = { ...lastHealth, ok: false, error: r.error }
    return { ok: false, error: `Python 视觉后端：${r.error}`, engine: ENGINE_ID }
  }
  const payload = r.payload || {}
  return {
    ok: true,
    engine: ENGINE_ID,
    engine_name: 'Python / RapidOCR-ONNX',
    words: Array.isArray(payload.words) ? payload.words : [],
    size: payload.size || null,
    ms: Number(payload.ms) || 0,
  }
}

/**
 * 只对一小块跑识别分支（不 det）。
 *
 * 这是 P2 要用的接口：实测同一块数字，整图 det 在 2560×1080 上读成 `TE`、
 * 3440×1440 上读成 `E`，而裁出来放大 3 倍走 rec-only 就稳定读回 `2174`，
 * 而且只要 15ms。P1 先把它做出来并自检，识别流程还没接。
 */
export async function visionOcrCrop(imagePath, box, { upscale = 3, timeoutMs = 20000 } = {}) {
  const body = { image_path: path.resolve(imagePath), box, upscale }
  const r = await requestJSON(`${visionBaseUrl()}/ocr/crop`, { method: 'POST', body, timeoutMs })
  if (!r.ok) return { ok: false, error: `Python 视觉后端：${r.error}`, engine: ENGINE_ID }
  const payload = r.payload || {}
  return { ok: true, engine: ENGINE_ID, text: String(payload.text || ''), score: Number(payload.score) || 0, ms: Number(payload.ms) || 0, crop: payload.crop || null }
}

/* ============================================================
   自检：真认一张图，别只看「进程活着」
   ============================================================ */

/** 2×2 纯色 PNG（和 ocr-install.mjs 里那张一样，用来验「解图 + 推理」这条路不炸） */
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGOQAwMGCAUACeYBadT3gZgAAAAASUVORK5CYII='

/**
 * 环境自检（设置页「自检一下」走这条）：
 *   1. /health 要 ok 且 warm；
 *   2. 喂一张 2×2 小图，要能正常返回（0 个词也算成功 —— 验的是解图和推理不炸）；
 *   3. 有 shots/samples/weapon-list.png 的话，再认一次，必须读出顶栏那三个数；
 *   4. 再把星声那个数字块裁出来走 rec-only —— 这条是 P2 要用的路，
 *      现在先自检着，免得等到真接进识别流程才发现它不好使。
 * 四条都过才算这个引擎真的能用。
 */
export async function visionHealthCheck() {
  const started = await ensureVisionStarted()
  if (!started.ok) return { ok: false, engine: ENGINE_ID, error: started.error, steps: [] }
  const steps = []
  const health = await probeVisionHealth({ timeoutMs: 3000, force: true })
  steps.push({ step: '探活 /health', ok: health.ok, detail: health.ok ? `预热完成（载模型 ${health.payload.load_ms}ms / 预热 ${health.payload.warm_ms}ms）` : health.error })
  if (!health.ok) return { ok: false, engine: ENGINE_ID, error: health.error, steps }

  const tmp = path.join(os.tmpdir(), `xfc-vision-health-${process.pid}-${Date.now()}.png`)
  try {
    fs.writeFileSync(tmp, Buffer.from(TINY_PNG, 'base64'))
    const tiny = await visionOcr(tmp, { timeoutMs: 30000 })
    steps.push({ step: '认一张 2×2 小图', ok: tiny.ok, detail: tiny.ok ? `返回 ${tiny.words.length} 个词（0 个也正常）` : tiny.error })
    if (!tiny.ok) return { ok: false, engine: ENGINE_ID, error: tiny.error, steps }

    const sample = path.join(ROOT, 'shots', 'samples', 'weapon-list.png')
    if (!fs.existsSync(sample)) {
      steps.push({ step: '认真截图', ok: true, detail: '跳过（shots/samples/weapon-list.png 不在）' })
      return { ok: true, engine: ENGINE_ID, engine_name: 'Python / RapidOCR-ONNX', steps, note: '没有样例图，只验到「引擎能跑」这一层' }
    }
    const real = await visionOcr(sample, { timeoutMs: 120000 })
    const texts = (real.words || []).map((w) => w.text)
    const found = ['2174', '2508319'].filter((t) => texts.includes(t))
    steps.push({
      step: '认样例图（2559×1599）',
      ok: real.ok && found.length === 2,
      detail: real.ok ? `认出 ${texts.length} 个词，其中 ${found.join(' / ') || '没有目标数字'}` : real.error,
    })

    // 星声那个数字块在样例图上的位置（和 scripts/vision-selftest.mjs 里
    // 期望的 2174 是同一个数）。放大 3 倍走 rec-only —— P2 复核数字就靠这条。
    const crop = await visionOcrCrop(sample, [1955, 60, 145, 55], { upscale: 3 })
    steps.push({
      step: '数字块 rec-only（P2 要用的路）',
      ok: Boolean(crop.ok && crop.text === '2174'),
      detail: crop.ok ? `认出 ${JSON.stringify(crop.text)}（分 ${crop.score}，${crop.ms}ms）` : crop.error,
    })

    const ok = Boolean(real.ok && found.length === 2 && crop.ok && crop.text === '2174')
    return {
      ok,
      engine: ENGINE_ID,
      engine_name: 'Python / RapidOCR-ONNX',
      ms: real.ms,
      steps,
      error: ok ? '' : '样例图里的 2174 / 2508319 没全认出来，或者数字块 rec-only 没读对',
    }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 清不掉就算了 */
    }
  }
}

export const VISION_ENGINE_ID = ENGINE_ID
