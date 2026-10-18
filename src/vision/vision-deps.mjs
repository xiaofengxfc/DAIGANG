/* ============================================================
   Python 视觉后端的依赖：探测解释器 → 建 venv → 装依赖 → 报告状态。

   这一层是照着 media-deps.mjs（媒体执行器那套）写的，因为要解决的问题
   一模一样：用户机器上有没有 Python、装没装依赖、装到哪儿、装的时候
   给不给得出进度。差别只有一处 —— **依赖装在项目内的 venv 里**
   （data/vision-venv），不动用户系统里的 Python：
     · onnxruntime + opencv 装起来 200MB 上下，不该往全局 site-packages 里塞；
     · 版本互相打架的代价太高（这台机器上就踩过 pip 缓存的权限问题）；
     · data/ 已经在 .gitignore 里，换台机器重新点一次就行。

   两个实测踩过的坑，写在这儿免得再犯：
     1. `pip install` 在这台机器上会去写 %LOCALAPPDATA%\pip\cache 然后
        WinError 5（拒绝访问）—— 所以一律加 `--no-cache-dir`。
     2. WindowsApps 下的 python.exe 是个「应用商店别名」，`--version` 能过、
        真跑起来就出问题。所以先用 `-c "import sys;print(sys.executable)"`
        把它解析成真实路径再用（这段逻辑和 media-deps 一致）。
   ============================================================ */

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DATA_DIR, ROOT, VISION_PYTHON, VISION_REQUIREMENTS, VISION_TMP, VISION_VENV } from '../core/config.mjs'

/** 依赖探测脚本：一次问清 Python 版本 + 五个模块在不在、什么版本 */
const PROBE_SRC = [
  'import json, sys, importlib.metadata as md',
  'mods = {}',
  'for name in ("rapidocr", "onnxruntime", "cv2", "numpy", "PIL"):',
  '    try:',
  '        __import__(name)',
  '        pkg = {"cv2": "opencv-python", "PIL": "pillow"}.get(name, name)',
  '        try:',
  '            mods[name] = md.version(pkg)',
  '        except Exception:',
  '            mods[name] = "?"',
  '    except Exception as exc:',
  '        mods[name] = None',
  'print(json.dumps({"python": sys.version.split()[0], "executable": sys.executable, "mods": mods}))',
].join('\n')

let cachedProbe = null

function run(bin, args, timeoutMs = 15000) {
  try {
    return spawnSync(bin, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  } catch (error) {
    return { status: -1, stdout: '', stderr: error.message || '' }
  }
}

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** venv 里的解释器路径（建过才有） */
export function visionVenvPython() {
  const p = process.platform === 'win32' ? path.join(VISION_VENV, 'Scripts', 'python.exe') : path.join(VISION_VENV, 'bin', 'python3')
  return exists(p) ? p : ''
}

/**
 * 依赖能装上的 Python 范围（win_amd64）。
 *
 * 这个数字**不是猜的**，是 scripts/checks/vision-matrix.mjs 去 PyPI 把每个包
 * 的 win_amd64 轮子按 cpXX 打表取交集算出来的。当前事实：
 *   · onnxruntime（OCR 的推理引擎，绕不开）轮子只到 cp314；
 *   · cp310 在 onnxruntime 1.24 之后就没有了；
 *   · 3.15 至今没有任何一个 onnxruntime 轮子。
 * 所以 3.10~3.14 可用，**3.15 装不上**。
 * 改了 requirements.txt 的版本区间就要重跑那张表。
 */
export const SUPPORTED_PYTHON = { min: [3, 10], max: [3, 14], recommended: '3.14' }

/** 把 "3.14.8" / "3.15.0" 解析成 [3, 14]；解析不出来返回 null */
function versionPair(text) {
  const m = /(\d+)\.(\d+)/.exec(String(text || ''))
  return m ? [Number(m[1]), Number(m[2])] : null
}

/**
 * 这个 Python 版本能不能装依赖。返回 { ok, code, message }。
 *
 * 为什么要提前拦：不拦的话用户会走到 pip，然后看到「找不到匹配的分发」
 * 一长串 —— 那看不出是版本不兼容，只看到「装依赖失败」。这里直接说清
 * 「你这版不行、支持到哪版、怎么办」。
 */
export function pythonVersionSupport(versionText) {
  const pair = versionPair(versionText)
  if (!pair) {
    return { ok: false, code: 'python_version_unknown', message: `读不出 Python 版本号（拿到的是「${versionText || '空'}」）。` }
  }
  const cmp = (a, b) => (a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1])
  const version = `${pair[0]}.${pair[1]}`
  if (cmp(pair, SUPPORTED_PYTHON.min) < 0) {
    return {
      ok: false,
      code: 'python_too_old',
      message: `Python ${version} 太旧了，需要 ${SUPPORTED_PYTHON.min.join('.')} ~ ${SUPPORTED_PYTHON.max.join('.')}（推荐 ${SUPPORTED_PYTHON.recommended}）。`,
    }
  }
  if (cmp(pair, SUPPORTED_PYTHON.max) > 0) {
    return {
      ok: false,
      code: 'python_too_new',
      message:
        `Python ${version} 太新了：这个后端要用的 onnxruntime（OCR 推理引擎）还没有适配它的预编译包，` +
        `只能现编，而现编需要 C++ 工具链，普通机器上装不了。` +
        `支持 ${SUPPORTED_PYTHON.min.join('.')} ~ ${SUPPORTED_PYTHON.max.join('.')}，推荐装 ${SUPPORTED_PYTHON.recommended}。`,
    }
  }
  return { ok: true, code: '', message: '' }
}

/**
 * 在 Windows 上按注册表找 Python。
 *
 * 为什么必须要有这一步：官方安装器**默认不勾**「Add python.exe to PATH」，
 * 于是一台装好 Python 的机器上 `python` / `python3` 全是「找不到命令」
 * （实测：注册表里明明有 PythonCore\3.15，PATH 里一个都没有）。
 * 只查 PATH 就等于「用户装了 Python 但程序说没装」。
 *
 * 注册表里存的是安装目录，比 PATH 可靠。HKCU 是「只为当前用户装」的默认落点，
 * 所以先看它。
 */
function windowsRegistryPythons() {
  if (process.platform !== 'win32') return []
  const roots = [
    'HKCU\\SOFTWARE\\Python\\PythonCore',
    'HKLM\\SOFTWARE\\Python\\PythonCore',
    'HKLM\\SOFTWARE\\WOW6432Node\\Python\\PythonCore',
  ]
  const found = []
  for (const root of roots) {
    // reg query 的输出是「键名 + 值行」，直接按 ExecutablePath 抓最省事
    const r = run('reg', ['query', root, '/s', '/v', 'ExecutablePath'], 8000)
    const text = `${r.stdout || ''}`
    for (const line of text.split(/\r?\n/)) {
      const m = /ExecutablePath\s+REG_SZ\s+(.+)$/i.exec(line.trim())
      if (!m) continue
      const exe = m[1].trim()
      if (exe && exists(exe)) found.push(exe)
    }
  }
  return found
}

/**
 * 候选解释器，按优先级：
 *   1. 已经建好的 venv（依赖就装在里面，优先用它）
 *   2. XFC_VISION_PYTHON / XFC_PYTHON 指定的（用户明确指定就最优先）
 *   3. **Windows 注册表里装过的**（HKCU 优先：官方安装器默认不勾 Add to PATH，
 *      所以一台装好 Python 的机器上 PATH 里可能一个都没有 —— 实测就是这样）
 *   4. Windows 常见安装目录（%LOCALAPPDATA%\Programs\Python\Python3xx 等）
 *   5. 系统 PATH 里的 python / python3
 *
 * 非绝对路径的候选会先解析成真实可执行文件路径：WindowsApps 那个别名
 * 能通过 `--version` 探测，但拿它去建 venv / 装包会出问题。
 */
function pythonCandidates() {
  const venv = visionVenvPython()
  const raw = [
    venv,
    VISION_PYTHON,
    process.env.XFC_PYTHON,
    ...windowsRegistryPythons(),
    ...windowsCommonPythons(),
    process.platform === 'win32' ? 'python' : 'python3',
    'python3',
    'python',
  ].filter(Boolean)

  const resolved = []
  for (const bin of [...new Set(raw)]) {
    if (path.isAbsolute(bin)) {
      if (exists(bin)) resolved.push(bin)
      continue
    }
    const probe = run(bin, ['-c', 'import sys; print(sys.executable)'], 8000)
    const executable = String(probe.stdout || '').trim().split(/\r?\n/).pop() || ''
    if (executable && path.isAbsolute(executable) && exists(executable)) resolved.push(executable)
    resolved.push(bin)
  }
  return [...new Set(resolved)]
}
function windowsCommonPythons() {
  if (process.platform !== 'win32') return []
  const dirs = []
  const local = process.env.LOCALAPPDATA || ''
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const home = process.env.USERPROFILE || ''
  if (local) dirs.push(path.join(local, 'Programs', 'Python'))
  dirs.push(pf)
  if (home) dirs.push(path.join(home, 'anaconda3'), path.join(home, 'miniconda3'))
  const out = []
  for (const dir of dirs) {
    if (!dir || !exists(dir)) continue
    // ...\Programs\Python\Python314\python.exe 以及 ...\Program Files\Python314\python.exe
    try {
      for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!child.isDirectory()) continue
        if (!/^Python3\d+$/i.test(child.name) && !/^(anaconda|miniconda)3$/i.test(child.name)) continue
        const exe = path.join(dir, child.name, 'python.exe')
        if (exists(exe)) out.push(exe)
      }
    } catch {
      /* 读不了就跳过 */
    }
  }
  return out
}

/**
 * 挑一个能用的 Python 解释器（不要求装了依赖）。
 *
 * 关键点：**优先挑「依赖装得上」的版本，而不是 PATH 里第一个 Python 3**。
 * 以前只要求「是 Python 3」就返回，于是机器上同时有 3.15 和 3.12 时，
 * 谁先被扫到就用谁 —— 扫到 3.15 就必然装不上依赖，而用户看不出为什么。
 *
 * 返回里带上 support：不支持时调用方要**明确报错**，不能继续往下走。
 */
export function findVisionInterpreter() {
  const tried = []
  const usable = []
  for (const bin of pythonCandidates()) {
    const version = run(bin, ['--version'], 8000)
    const text = `${version.stdout || ''}${version.stderr || ''}`.trim()
    if (version.status !== 0 || !/^Python\s+3\./i.test(text)) {
      tried.push({ bin, output: text, status: version.status, supported: false })
      continue
    }
    const clean = text.replace(/^Python\s+/i, '')
    const support = pythonVersionSupport(clean)
    tried.push({ bin, output: text, status: version.status, supported: support.ok })
    usable.push({ bin, version: clean, support })
  }

  if (!usable.length) return { available: false, bin: '', version: '', tried, support: null }

  // 支持范围内的优先；同样支持就按候选顺序（venv → 用户指定 → 注册表 → PATH）
  const supported = usable.find((u) => u.support.ok)
  const chosen = supported || usable[0]
  return {
    available: true,
    bin: chosen.bin,
    version: chosen.version,
    tried,
    support: chosen.support,
    // 有几个能用的版本，界面上可以提示「换个版本就行」
    usableVersions: [...new Set(usable.map((u) => u.version))],
  }
}

/** 拿一个解释器去问「五个模块在不在」。返回 {ok, python, executable, mods, error} */
function probeWith(bin) {
  const r = run(bin, ['-c', PROBE_SRC], 30000)
  const line = String(r.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('{'))
    .pop()
  if (!line) {
    return { ok: false, python: '', executable: bin, mods: {}, error: `${String(r.stderr || '').trim().slice(0, 300) || '探测脚本没有输出'}` }
  }
  try {
    const parsed = JSON.parse(line)
    const mods = parsed.mods || {}
    return {
      ok: Boolean(mods.rapidocr && mods.onnxruntime && mods.cv2 && mods.numpy),
      python: String(parsed.python || ''),
      executable: String(parsed.executable || bin),
      mods,
      error: '',
    }
  } catch (err) {
    return { ok: false, python: '', executable: bin, mods: {}, error: `探测输出读不了：${err.message}` }
  }
}

/**
 * 依赖状态（带缓存）。
 *
 * 「装了依赖」= 用 venv 里的解释器能 import rapidocr / onnxruntime / cv2 / numpy。
 * 只查文件在不在是不够的 —— 装到一半、版本不匹配、DLL 缺失都只有真 import 才知道。
 */
export function visionDependencyStatus({ force = false } = {}) {
  if (!force && cachedProbe) return cachedProbe
  const venvPython = visionVenvPython()
  const interpreter = venvPython ? { available: true, bin: venvPython, version: '', tried: [] } : findVisionInterpreter()
  const deps = interpreter.available ? probeWith(interpreter.bin) : { ok: false, python: '', executable: '', mods: {}, error: '没找到 Python 3' }
  // 解释器版本：venv 那条路上 --version 也得问一次（设置页要显示）
  let version = interpreter.version
  if (!version && interpreter.available) {
    const v = run(interpreter.bin, ['--version'], 8000)
    version = `${v.stdout || ''}${v.stderr || ''}`.trim().replace(/^Python\s+/i, '')
  }
  // venv 已经建好时上面那条分支不会走 findVisionInterpreter，support 是空的 ——
  // 那就按 venv 自己的版本现算一次，不然「版本不支持」这个结论会漏报。
  const support = interpreter.support || (version ? pythonVersionSupport(version) : null)
  const blockReason = !interpreter.available
    ? '没有找到 Python 3。装一个再来（推荐 3.14）。'
    : support && !support.ok
      ? support.message
      : ''
  cachedProbe = {
    ready: Boolean(interpreter.available && deps.ok),
    venv: { path: VISION_VENV, exists: Boolean(venvPython), python: venvPython },
    interpreter: {
      available: Boolean(interpreter.available),
      bin: interpreter.bin,
      version,
      tried: interpreter.tried || [],
      supported: support ? support.ok : null,
      usable_versions: interpreter.usableVersions || [],
    },
    // 「这版 Python 装不上依赖」要说清楚，界面照着这条给结论
    python_support: support || null,
    block_reason: blockReason,
    supported_range: {
      min: SUPPORTED_PYTHON.min.join('.'),
      max: SUPPORTED_PYTHON.max.join('.'),
      recommended: SUPPORTED_PYTHON.recommended,
    },
    deps: { ...deps, version },
    requirements: { exists: exists(VISION_REQUIREMENTS), path: VISION_REQUIREMENTS },
    install: {
      // 装不装得成，先在这里定论 —— 不要让用户走到 pip 才发现
      possible: interpreter.available && (!support || support.ok),
      commands: interpreter.available
        ? [
            `${interpreter.bin} -m venv "${VISION_VENV}"`,
            `${path.join(VISION_VENV, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python3')} -m pip install --no-cache-dir -r "${VISION_REQUIREMENTS}"`,
          ]
        : [`先装一个 Python ${SUPPORTED_PYTHON.min.join('.')} ~ ${SUPPORTED_PYTHON.max.join('.')}（推荐 ${SUPPORTED_PYTHON.recommended}，python.org），再回到这里点「一键安装依赖」`],
      python_download: 'https://www.python.org/downloads/windows/',
      // 装依赖这一步不做「只能二进制包」的限制：antlr4-python3-runtime 这类
      // 包在 3.14 上没有 wheel，得现编（实测能编过）。
      note: `依赖装在项目内的 data/vision-venv，不动你系统里的 Python。约 200MB。支持 Python ${SUPPORTED_PYTHON.min.join('.')} ~ ${SUPPORTED_PYTHON.max.join('.')}。`,
    },
  }
  return cachedProbe
}

/**
 * 只读已经探过的结果，**不触发探测**。
 *
 * 为什么要单列一个：同步接口（ocrEngines() / 状态快照）里不能跑 python 探测 ——
 * 那是 spawnSync，导入 onnxruntime + cv2 要一两秒，会把事件循环卡住。
 */
export function visionDependencyStatusCached() {
  return cachedProbe
}

/* ============================================================
   一键安装（后台跑，前端轮询进度）
   ============================================================ */

const jobs = new Map()
const JOB_TTL = 30 * 60 * 1000

function pruneJobs() {
  const now = Date.now()
  for (const [id, job] of jobs) if (job.finished_at && now - new Date(job.finished_at).getTime() > JOB_TTL) jobs.delete(id)
}

function appendJob(job, text) {
  if (!text) return
  job.log = `${job.log}${text}`.slice(-12000)
}

function spawnStep(job, bin, args, label, index) {
  return new Promise((resolve) => {
    job.step = label
    job.step_index = index
    /**
     * TEMP/TMP/TMPDIR 指到 data/vision-tmp 是**故意的**。
     *
     * pip 装包时会用系统临时目录解压源码包、建构建环境。临时目录要是没配好
     * （或者被某种环境接管了），Python 的 tempfile 会退回**当前工作目录** ——
     * 也就是仓库根目录，于是那里会冒出几十个 `pip-unpack-*` / `pip-metadata-*`
     * 目录。这不是假想：开发机上就是这么冒出来一批，差点提交进版本库。
     * data/ 是 gitignore 的，指到那儿最省心。
     */
    const tmp = VISION_TMP
    try {
      fs.mkdirSync(tmp, { recursive: true })
    } catch {
      /* 建不出来就交给系统默认 */
    }
    const child = spawn(bin, args, {
      cwd: ROOT,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TEMP: tmp, TMP: tmp, TMPDIR: tmp, PIP_CACHE_DIR: path.join(tmp, 'pip-cache') },
    })
    child.stdout.on('data', (chunk) => appendJob(job, chunk.toString()))
    child.stderr.on('data', (chunk) => appendJob(job, chunk.toString()))
    child.on('error', (error) => resolve({ code: -1, error: error.message }))
    child.on('close', (code) => resolve({ code: code ?? -1 }))
  })
}

export function startVisionDependencyInstall() {
  pruneJobs()
  const active = [...jobs.values()].find((job) => job.status === 'running')
  if (active) return { ok: true, job: active.id, reused: true }

  const probe = visionDependencyStatus({ force: true })
  if (!probe.requirements.exists) {
    return { ok: false, error: `找不到依赖清单：${VISION_REQUIREMENTS}`, status: probe }
  }
  if (!probe.interpreter.available) {
    return { ok: false, code: 'python_missing', error: probe.block_reason || '没有找到 Python 3，请先装一个（python.org），再回到这里点「一键安装依赖」', status: probe }
  }
  /* 版本不支持就别往下走了。
     以前这里不拦，用户会一路走到 pip，然后面对「找不到匹配的分发」一长串日志
     —— 那看不出是 Python 版本的事。实测：Python 3.15 上 onnxruntime 根本没有
     预编译包，这个安装**不可能成功**。 */
  if (probe.python_support && !probe.python_support.ok) {
    return { ok: false, code: probe.python_support.code, error: probe.python_support.message, status: probe }
  }

  const id = `vision-deps-${Date.now().toString(36)}`
  const job = {
    id,
    status: 'running',
    step: '准备安装',
    step_index: 0,
    steps: ['建虚拟环境 data/vision-venv', '安装依赖（约 200MB，看网络）', '重新探测'],
    progress: 0,
    log: '',
    started_at: new Date().toISOString(),
    finished_at: null,
    error: '',
  }
  jobs.set(id, job)

  ;(async () => {
    const base = probe.interpreter.bin
    if (!visionVenvPython()) {
      const venv = await spawnStep(job, base, ['-m', 'venv', VISION_VENV], job.steps[0], 0)
      job.progress = 34
      if (venv.code !== 0 || !visionVenvPython()) {
        job.status = 'failed'
        job.error = '建虚拟环境失败，请看下面的日志'
        job.finished_at = new Date().toISOString()
        return
      }
    } else {
      appendJob(job, `虚拟环境已存在，跳过建 venv：${VISION_VENV}\n`)
    }

    const py = visionVenvPython()
    const pip = await spawnStep(job, py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', '-r', VISION_REQUIREMENTS], job.steps[1], 1)
    job.progress = 80
    if (pip.code !== 0) {
      job.status = 'failed'
      job.error = '依赖安装失败，请看下面的日志（网络、杀软拦截都会在这里现原形）'
      job.finished_at = new Date().toISOString()
      cachedProbe = null
      return
    }

    job.step = job.steps[2]
    job.step_index = 2
    const after = visionDependencyStatus({ force: true })
    job.progress = 100
    if (!after.ready) {
      job.status = 'failed'
      job.error = `装完了但 import 还是不通过：${after.deps.error || '缺模块'}`
      job.finished_at = new Date().toISOString()
      return
    }
    job.status = 'success'
    job.step = '装好了'
    job.finished_at = new Date().toISOString()
  })()

  return { ok: true, job: id }
}

export function visionDependencyInstallStatus(id) {
  pruneJobs()
  const job = jobs.get(String(id || ''))
  if (!job) return { status: 'missing', error: '安装任务不存在（服务重启过？重开一次安装）' }
  return {
    id: job.id,
    status: job.status,
    step: job.step,
    step_index: job.step_index,
    steps: job.steps,
    progress: job.progress,
    log: job.log.slice(-6000),
    started_at: job.started_at,
    finished_at: job.finished_at,
    error: job.error,
  }
}

/** 数据目录换了、或者用户手动删了 venv 之后，清掉缓存重新探测 */
export function resetVisionDepsCache() {
  cachedProbe = null
}

export const VISION_DATA_DIR = DATA_DIR
