/* ============================================================
   OCR 引擎自动安装器。

   做的是三件事，都只用 Node 标准库 + 系统自带工具：
     1. **下载**：从 GitHub Release 拿免安装包（不走 npm，不碰任何第三方服务）；
     2. **解压**：优先用系统上的 7z 系工具（7z / 7za / 7zz / NanaZip 都行），
        `.zip` / `.tar.gz` 这类还可以退回系统自带的 `tar.exe`；
     3. **落位 + 重新探测**：把解出来的整个文件夹搬到 `tools\ocr\<引擎>\`，
        然后在里面找可执行文件写进 `data/ocr-engines.json`，最后重跑引擎探测。

   为什么不用 npm 装：这个项目的底线是「用户机器上不跑 npm install」，
   而 PaddleOCR / RapidOCR 的 npm 生态本来也没有可用的推理封装。
   走「下载官方 Release + 系统解压器」这条路，和现在 restic 的形态是同一个思路。

   关于 7z：Node 标准库解不了 LZMA，Windows 自带的 `tar.exe`（bsdtar）也
   不支持 LZMA（实测报 `LZMA codec is unsupported`）。所以解压这一步必须靠
   系统上现成的 7z 系工具。**注意要过滤掉 Microsoft Store 的占位符**：
   `%LOCALAPPDATA%\Microsoft\WindowsApps\7z.exe` 在没装真 7-Zip 时长度是 0、
   调用只会弹出应用商店，所以那个路径单独判断处理。
   ============================================================ */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { ROOT } from './config.mjs'
import { CONSOLE_OCR, CONSOLE_CLI, probeEngines, ocrEngines, rememberEngineBin, recordedEngineBin } from './ocr.mjs'

const TOOLS_DIR = path.join(ROOT, 'tools', 'ocr')
const TMP_DIR = path.join(TOOLS_DIR, '.tmp')

/* ============================================================
   可自动安装的引擎清单
   ============================================================ */

/**
 * 每个引擎：
 *   repo    —— GitHub 仓库
 *   match   —— 从 Release 资产里挑哪个（函数收到资产列表，返回一个）
 *   exe     —— 解压后在文件夹里找这个可执行文件
 *   size    —— 给用户看的体积说明
 *   note    —— 装完还要做什么
 *   manual  —— true 表示不能全自动（要做到最后一步需要 GUI），只给下载页
 */
export const INSTALL_SPECS = {
  rapidocr: {
    id: 'rapidocr',
    name: CONSOLE_OCR.rapidocr.name,
    repo: 'hiroi-sora/RapidOCR-json',
    license: CONSOLE_OCR.rapidocr.license,
    size: '约 70MB 下载 / 展开约 95MB',
    exe: CONSOLE_OCR.rapidocr.exeNames,
    envKey: CONSOLE_OCR.rapidocr.envKey,
    note: '解压即用，装完不用再配任何东西。CPU 不需要 AVX。',
    // 资产只有一个 .7z，直接选它
    match: (assets) => assets.find((a) => /\.7z$/i.test(a.name) && !/\.exe$/i.test(a.name)) || assets[0],
  },
  paddleocr: {
    id: 'paddleocr',
    name: CONSOLE_OCR.paddleocr.name,
    repo: 'hiroi-sora/PaddleOCR-json',
    license: CONSOLE_OCR.paddleocr.license,
    size: '约 88MB 下载 / 展开约 250MB',
    exe: CONSOLE_OCR.paddleocr.exeNames,
    envKey: CONSOLE_OCR.paddleocr.envKey,
    note: '解压即用。要求 CPU 支持 AVX（老机器可能跑不起来，那就用 RapidOCR-json）。',
    match: (assets) => assets.find((a) => /windows.*\.7z$/i.test(a.name)) || assets.find((a) => /\.7z$/i.test(a.name)),
  },
  umi: {
    id: 'umi',
    name: 'Umi-OCR',
    repo: 'hiroi-sora/Umi-OCR',
    license: 'MIT',
    size: '约 100~130MB',
    exe: [],
    envKey: '',
    note: '官方包是**自解压 exe**，解出来是带界面和 Qt 的整个程序，装完还要在它自己的设置里把「HTTP 服务」打开 —— 最后一步得你点一下，所以这里只给下载页。',
    manual: true,
    match: (assets) => assets.find((a) => /Rapid.*\.7z\.exe$/i.test(a.name)) || assets.find((a) => /Paddle.*\.7z\.exe$/i.test(a.name)),
  },
}

/** Release 页地址（人工安装用；不给具体资产链接，免得资产改名后 404） */
export function releasePage(spec) {
  return `https://github.com/${spec.repo}/releases/latest`
}

/* ============================================================
   解压器探测
   ============================================================ */

let extractorCache = null

/** 跑一个短命令，返回 { status, stdout }（不用管道时也安全） */
function runSync(bin, args, timeoutMs = 20000) {
  try {
    return spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs })
  } catch {
    return { status: -1, stdout: '', stderr: '' }
  }
}

/**
 * 这个 7z 是不是真的能用。
 * **必须实测**：Microsoft Store 的占位符（WindowsApps 下那个 0 字节 exe）
 * 调用时会弹应用商店，只看「文件在不在」会误判。
 */
function sevenZipWorks(bin) {
  const r = runSync(bin, ['i'], 15000)
  const text = `${r.stdout || ''}${r.stderr || ''}`
  if (r.status !== 0 && !text) return false
  // 真 7z 系的 `7z i` 会打印版本和格式列表；占位符什么都不打印
  return /7-?Zip|NanaZip|Libre|LZMA/i.test(text) && text.length > 40
}

/**
 * 找一个能用的解压器。
 *
 * 7z 系优先（我们的包都是 LZMA 的 .7z，只有它解得了）；
 * `.zip` / `.tar.gz` 还能退回系统自带的 `tar.exe`。
 *
 * 探测方式**必须实测**，不能只看文件在不在：
 *   · Microsoft Store 的占位符（WindowsApps 里那个 0 字节 `7z.exe`）调用时会弹应用商店；
 *   · 有些别名（比如 NanaZip 的 `7z`）用 `where.exe 7z.exe` 查不到，
 *     但直接按名字调用是好的 —— 所以候选里既有路径也有纯命令名。
 */
export function findExtractor({ force = false } = {}) {
  if (extractorCache && !force) return extractorCache
  const tried = []
  const cands = []
  if (process.env.SEVENZIP_BIN) cands.push(process.env.SEVENZIP_BIN)
  // 纯命令名：交给系统解析（能覆盖 where.exe 查不到的别名）
  for (const n of ['7z', '7za', '7zz', '7zr']) cands.push(n)
  for (const n of ['7z.exe', '7za.exe', '7zz.exe', '7zr.exe']) {
    const hit = runSync(process.platform === 'win32' ? 'where.exe' : 'which', [n], 8000)
    const first = String(hit.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0]
    if (first) cands.push(first)
  }
  for (const dir of [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, '7-Zip'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], '7-Zip'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'NanaZip'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', '7-Zip'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
  ].filter(Boolean)) {
    for (const n of ['7z.exe', '7za.exe', '7zz.exe', '7zr.exe']) cands.push(path.join(dir, n))
  }

  const seen = new Set()
  for (const c of cands) {
    if (!c || seen.has(c)) continue
    seen.add(c)
    let size = -1
    try {
      size = fs.statSync(c).size
    } catch {
      /* 不是路径（纯命令名），或者不存在 */
    }
    if (size === 0) {
      tried.push({ path: c, why: '0 字节（Microsoft Store 占位符，调用会弹应用商店）' })
      continue
    }
    if (sevenZipWorks(c)) {
      extractorCache = { kind: '7z', bin: c, tried, found: true, lzma: true }
      return extractorCache
    }
    if (size > 0) tried.push({ path: c, why: '调用了但不像 7-Zip（没有版本输出）' })
  }

  // 退路：系统自带的 tar（bsdtar）。能解 zip / tar.gz / tar.xz，**解不了 LZMA 的 .7z**。
  const tarHit = runSync(process.platform === 'win32' ? 'where.exe' : 'which', ['tar'], 8000)
  const tarBin = String(tarHit.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)[0]
  if (tarBin) {
    extractorCache = {
      kind: 'tar',
      bin: tarBin,
      tried,
      found: true,
      lzma: false,
      note: '系统自带 tar 只能解 zip / tar.gz / tar.xz，解不了 LZMA 的 .7z',
    }
    return extractorCache
  }

  extractorCache = { kind: null, bin: null, tried, found: false, lzma: false }
  return extractorCache
}

/** 解压器状态，给设置页显示 */
export function extractorStatus() {
  const e = findExtractor()
  const specs = Object.values(INSTALL_SPECS)
  const anyAuto = specs.some((s) => !s.manual)
  const canAuto = Boolean(e.found && e.lzma)
  return {
    found: Boolean(e.found),
    kind: e.kind,
    bin: e.bin,
    lzma: Boolean(e.lzma),
    can_auto: canAuto,
    note: e.note || (e.kind === '7z' ? `${path.basename(e.bin || '')} —— 能解 .7z` : ''),
    tried: e.tried || [],
    hint: canAuto
      ? ''
      : anyAuto
        ? '这台机器上没有能解 .7z 的解压器，装不了。装一个 7-Zip 或 NanaZip（免费开源）就能自动安装；或者照下面的下载页手动解压到 tools\\ocr\\。'
        : '',
  }
}

/* ============================================================
   已安装记录：读写都放在 ocr.mjs（探测链要用它），这里只做转发
   ============================================================ */

/** 记下这个引擎的可执行文件在哪（探测链会读它） */
export const rememberBin = rememberEngineBin

/** 取出记录过的可执行文件路径（存在且真的在才算） */
export const recordedBin = recordedEngineBin

/* ============================================================
   Release 资产解析
   ============================================================ */

const UA = { 'User-Agent': 'daigan-ops-console (local installer)', Accept: 'application/vnd.github+json' }

/**
 * 离线/固定版本的兜底表：GitHub 接口挂了（限流、公司网络挡 api.github.com）
 * 也不至于装不了。资产名写死在这里，出问题只影响「自动安装」，
 * 不影响已经装好的引擎。
 */
const PINNED_ASSETS = {
  rapidocr: { tag: 'v0.2.0', name: 'RapidOCR-json_v0.2.0.7z', url: 'https://github.com/hiroi-sora/RapidOCR-json/releases/download/v0.2.0/RapidOCR-json_v0.2.0.7z', size: 73461693 },
  paddleocr: { tag: 'v1.4.1', name: 'PaddleOCR-json_v1.4.1_windows_x64.7z', url: 'https://github.com/hiroi-sora/PaddleOCR-json/releases/download/v1.4.1/PaddleOCR-json_v1.4.1_windows_x64.7z', size: 92736768 },
}

/** 查最新 Release 的资产列表；接口不通就退回固定版本 */
export async function fetchLatestAssets(repo, { timeoutMs = 20000, pinned = null } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: UA, signal: ac.signal })
    if (!res.ok) return { ok: false, error: `GitHub 返回 ${res.status}${res.status === 403 ? '（接口限流了，等几分钟再试）' : ''}` }
    const json = await res.json()
    const assets = (json.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url, size: a.size }))
    return { ok: true, tag: json.tag_name || '', assets }
  } catch (err) {
    // 接口不通时用固定版本兜底（Release 资产地址是稳定的）
    if (pinned) {
      return {
        ok: true,
        tag: pinned.tag,
        pinned: true,
        assets: [{ name: pinned.name, url: pinned.url, size: pinned.size }],
        note: 'GitHub 接口没连上，改用固定版本',
      }
    }
    return { ok: false, error: /abort/i.test(String(err.message)) ? '连 GitHub 超时（网络不通？）' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

/* ============================================================
   安装任务：下载 → 解压 → 落位 → 重新探测
   ============================================================ */

const jobs = new Map()
const JOB_TTL = 30 * 60 * 1000

function newJob(engineId) {
  const job = {
    id: `inst-${engineId}-${Date.now().toString(36)}`,
    engine: engineId,
    state: 'queued',
    step: '排队',
    received: 0,
    total: 0,
    file: '',
    log: [],
    started_at: Date.now(),
    finished_at: 0,
    result: null,
    error: '',
  }
  jobs.set(job.id, job)
  pruneJobs()
  return job
}

function pruneJobs() {
  const now = Date.now()
  for (const [id, j] of jobs) {
    if (j.finished_at && now - j.finished_at > JOB_TTL) jobs.delete(id)
  }
  while (jobs.size > 12) jobs.delete(jobs.keys().next().value)
}

function log(job, line) {
  job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
  if (job.log.length > 300) job.log.splice(0, job.log.length - 300)
}

export function installStatus(jobId) {
  const job = jobs.get(jobId)
  if (!job) return { ok: false, error: '这个安装任务已经过期了（或者进程重启过）' }
  return { ok: true, job: publicJob(job) }
}

function publicJob(job) {
  return {
    id: job.id,
    engine: job.engine,
    state: job.state,
    step: job.step,
    received: job.received,
    total: job.total,
    file: job.file,
    percent: job.total > 0 ? Math.min(100, Math.round((job.received / job.total) * 100)) : 0,
    log: job.log.slice(-12),
    error: job.error,
    result: job.result,
    elapsed_ms: (job.finished_at || Date.now()) - job.started_at,
  }
}

/** 开始下载（返回 job，调用方轮询 installStatus） */
function startDownload(job, asset) {
  return new Promise((resolve) => {
    fs.mkdirSync(TMP_DIR, { recursive: true })
    const outPath = path.join(TMP_DIR, asset.name)
    job.file = outPath
    job.total = asset.size || 0
    job.step = `下载 ${asset.name}`
    job.state = 'downloading'
    log(job, `开始下载 ${asset.name}（${asset.size ? Math.round(asset.size / 1024 / 1024) + 'MB' : '大小未知'}）`)

    const ac = new AbortController()
    job._abort = () => ac.abort()
    fetch(asset.url, { headers: { 'User-Agent': UA['User-Agent'] }, signal: ac.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
        if (!res.body) throw new Error('下载没有响应体')
        const fd = fs.openSync(outPath, 'w')
        try {
          for await (const chunk of res.body) {
            fs.writeSync(fd, chunk)
            job.received += chunk.length
          }
        } finally {
          fs.closeSync(fd)
        }
        job.step = '下载完成'
        log(job, `下载完成（${Math.round(job.received / 1024 / 1024)}MB）`)
        resolve({ ok: true, path: outPath })
      })
      .catch((err) => {
        log(job, `下载出错：${err.message}`)
        resolve({ ok: false, error: /abort/i.test(String(err.message)) ? '下载被取消' : err.message })
      })
  })
}

/** 解压：7z 用 `x -y -o`，tar 用 `-xf -C` */
function extract(job, archive, outDir) {
  return new Promise((resolve) => {
    const ex = findExtractor()
    if (!ex.found) return resolve({ ok: false, error: '这台机器上没有能用的解压器' })
    fs.mkdirSync(outDir, { recursive: true })
    const is7zArchive = /\.7z(\.\d+)?$/i.test(archive)
    if (is7zArchive && ex.kind !== '7z') {
      return resolve({ ok: false, error: '这是 LZMA 压缩的 .7z，系统自带的 tar 解不了，需要一个 7-Zip 系解压器' })
    }
    const args = ex.kind === '7z' ? ['x', archive, `-o${outDir}`, '-y', '-bso0', '-bsp0'] : ['-xf', archive, '-C', outDir]
    job.step = `解压（${path.basename(ex.bin || 'tar')}）`
    job.state = 'extracting'
    log(job, `解压：${path.basename(ex.bin)} ${ex.kind === '7z' ? 'x' : '-xf'} → ${outDir}`)

    let child
    try {
      child = spawn(ex.bin, args, { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
    } catch (err) {
      return resolve({ ok: false, error: `起不了解压器：${err.message}` })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      resolve({ ok: false, error: '解压超时（包太大或解压器卡住了）' })
    }, 15 * 60 * 1000)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, error: `起不了解压器：${err.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        log(job, `解压器退出码 ${code}`)
        return resolve({ ok: false, error: `解压失败（${path.basename(ex.bin)} 退出码 ${code}）` })
      }
      log(job, '解压完成')
      resolve({ ok: true })
    })
  })
}

/** 在有界深度内找一个文件名匹配的可执行文件 */
function findExe(dir, names, depth = 0) {
  if (depth > 6) return null
  let list = []
  try {
    list = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of list) {
    if (e.isFile() && names.includes(e.name)) return path.join(dir, e.name)
  }
  for (const e of list) {
    if (!e.isDirectory()) continue
    const hit = findExe(path.join(dir, e.name), names, depth + 1)
    if (hit) return hit
  }
  return null
}

/**
 * 跑一次安装。全程在后台（调用方拿 job.id 轮询），不阻塞请求。
 * 步骤：查资产 → 下载 → 解压到 .tmp → 找到 exe → 整个文件夹搬到 tools\ocr\<引擎> → 重新探测
 */
export async function installEngine(engineId) {
  const spec = INSTALL_SPECS[engineId]
  if (!spec) return { ok: false, error: `不认识的引擎：${engineId}` }
  if (spec.manual) return { ok: false, error: `${spec.name} 需要手动安装（见下载页）` }
  const job = newJob(engineId)

  // 同一个引擎只允许一个在跑的安装
  for (const j of jobs.values()) {
    if (j !== job && j.engine === engineId && !j.finished_at) {
      jobs.delete(job.id)
      return { ok: false, error: `${spec.name} 已经有一个安装在跑了`, job: publicJob(j) }
    }
  }

  ;(async () => {
    try {
      job.step = '查询最新版本'
      log(job, `查询 ${spec.repo} 的最新 Release`)
      const found = await fetchLatestAssets(spec.repo, { pinned: PINNED_ASSETS[engineId] })
      if (!found.ok) throw new Error(found.error)
      if (found.note) log(job, found.note)
      const asset = spec.match(found.assets)
      if (!asset) throw new Error(`这个版本里没有找到可用的 Windows 包（资产：${found.assets.map((a) => a.name).join('、') || '无'}）`)
      log(job, `选中资产 ${asset.name}（${found.tag}）`)

      // 复用已经下过的包：断在半路重来时不用再下一次 70MB。
      // （.tmp 里同名文件大小对得上就当它是完整的 —— 我们是先写完才继续的）
      let dl = null
      const cachedArchive = path.join(TMP_DIR, asset.name)
      try {
        if (fs.existsSync(cachedArchive) && (!asset.size || fs.statSync(cachedArchive).size === asset.size)) {
          job.received = fs.statSync(cachedArchive).size
          job.total = asset.size || job.received
          job.state = 'downloading'
          job.step = '复用已下载的包'
          log(job, `本地已有完整的 ${asset.name}，跳过下载`)
          dl = { ok: true, path: cachedArchive }
        }
      } catch {
        /* 判断不了就正常下载 */
      }
      if (!dl) dl = await startDownload(job, asset)
      if (!dl.ok) throw new Error(dl.error)

      fs.rmSync(TMP_DIR + '-out', { recursive: true, force: true })
      const outDir = `${TMP_DIR}-out`
      const ex = await extract(job, dl.path, outDir)
      if (!ex.ok) throw new Error(ex.error)

      job.step = '寻找可执行文件'
      const exePath = findExe(outDir, spec.exe)
      if (!exePath) throw new Error(`解出来的包里没找到 ${spec.exe.join(' / ')}`)
      log(job, `找到 ${path.basename(exePath)}`)

      // 落位：把 exe 所在的整个文件夹搬到 tools\ocr\<引擎>（它旁边的 models 目录是必需的）
      const srcDir = path.dirname(exePath)
      const destDir = path.join(TOOLS_DIR, engineId)
      job.step = '放到 tools\\ocr'
      fs.rmSync(destDir, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(destDir), { recursive: true })
      try {
        fs.renameSync(srcDir, destDir)
      } catch {
        // 跨盘符等情况 rename 会失败，退回「拷贝 + 删源」
        copyDir(srcDir, destDir)
      }
      const finalExe = path.join(destDir, path.basename(exePath))
      if (!fs.existsSync(finalExe)) throw new Error('搬完之后没找到可执行文件（磁盘满了？）')
      rememberBin(engineId, finalExe)
      log(job, `已安装到 ${finalExe}`)

      // 收拾临时文件
      try {
        fs.rmSync(TMP_DIR, { recursive: true, force: true })
        fs.rmSync(outDir, { recursive: true, force: true })
      } catch {
        /* 清不掉就算了 */
      }

      job.step = '重新探测引擎'
      const st = await probeEngines({ force: true })
      const now = st.engines.find((e) => e.id === engineId)
      job.state = 'done'
      job.step = now && now.available ? '装好了' : '装完了但探测没认出来'
      job.result = {
        engine: engineId,
        name: spec.name,
        bin: finalExe,
        dir: destDir,
        available: Boolean(now && now.available),
        preferred: st.preferred,
        engine_name: st.engines.find((e) => e.id === st.preferred)?.name || '',
      }
      log(job, job.result.available ? `${spec.name} 现在可用了` : `文件在了但探测没认出来：${finalExe}`)
      if (!job.result.available) {
        // 探测没认出来时给出明确的手动兜底：设环境变量
        job.result.hint = `手动兜底：设环境变量 ${spec.envKey}=${finalExe}，或者重启程序再试`
      }
    } catch (err) {
      job.state = 'error'
      job.step = '装失败'
      job.error = err.message || String(err)
      log(job, `失败：${job.error}`)
    } finally {
      job.finished_at = Date.now()
      job._abort = null
    }
  })()

  return { ok: true, job: publicJob(job) }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dest, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}

/**
 * 环境自检：这个引擎到底能不能跑。
 *
 * 不是跑 `-h`（实测 RapidOCR-json v1.1.0 不认 `-h`，会打印一堆
 * `invalid option`，什么也说明不了），而是**真认一张小图**：
 * 缺 VC 运行库、CPU 不支持 AVX、杀软拦了、模型文件没跟着搬过来 ——
 * 这些都会在真跑的时候现原形。1×1 的图认不出字是正常的，
 * 只要它给出 `code:100`（没认到文字）就算通了。
 */
export function engineHealth(engineId) {
  const spec = INSTALL_SPECS[engineId]
  if (!spec || spec.manual) return { ok: false, engine: engineId, error: '这个引擎没有可自检的可执行文件' }
  const bin = engineBinPath(engineId)
  if (!bin) return { ok: false, engine: engineId, error: '还没找到可执行文件（没装？）' }

  const tmp = path.join(TMP_DIR, `health-${engineId}.png`)
  // 和识别时一样：中文路径要先转成 ASCII 临时路径，否则这个引擎自己会
  // 报 code=300 JSON dump failed（`--ensureAscii=1` 只管输出不管输入）
  let usePath = tmp
  let asciiCopy = ''
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true })
    // 一张 2×2 的纯色 PNG：够让引擎把「模型加载 → 检测 → 识别」整条路走一遍
    fs.writeFileSync(tmp, TINY_PNG)
    if (/[^\x20-\x7e]/.test(tmp)) {
      asciiCopy = path.join(os.tmpdir(), `xfc-health-${engineId}-${process.pid}-${Date.now()}.png`)
      fs.copyFileSync(tmp, asciiCopy)
      usePath = asciiCopy
    }
  } catch (err) {
    return { ok: false, engine: engineId, error: `写测试图失败：${err.message}` }
  }
  try {
    return runHealth(engineId, bin, usePath)
  } finally {
    for (const p of [tmp, asciiCopy]) {
      try {
        if (p) fs.unlinkSync(p)
      } catch {
        /* 清不掉就算了 */
      }
    }
  }
}

/** 跑一次真实调用，按「有没有给出 code」判断通不通 */
function runHealth(engineId, bin, imagePath) {
  const cli = CONSOLE_CLI[engineId] || CONSOLE_CLI.paddleocr
  const stamp = `${process.pid}-${Date.now()}`
  const outPath = path.join(TMP_DIR, `health-${stamp}.json`)
  const stdoutPath = path.join(TMP_DIR, `health-${stamp}.out`)
  const usePath = /[^\x20-\x7e]/.test(imagePath) ? imagePath : imagePath
  const args = cli.args(usePath, outPath)
  const sink = cli.from === 'stdout' ? stdoutPath : path.join(TMP_DIR, `health-${stamp}.log`)
  let fd = null
  try {
    fd = fs.openSync(sink, 'w')
  } catch {
    /* 打不开就让子进程自己继承 */
  }
  const run = spawnSync(bin, args, {
    encoding: 'utf8',
    windowsHide: true,
    cwd: path.dirname(bin),
    timeout: 60000,
    stdio: ['ignore', fd === null ? 'ignore' : fd, fd === null ? 'ignore' : fd],
  })
  try {
    if (fd !== null) fs.closeSync(fd)
  } catch {
    /* 已经关了 */
  }
  const exitCode = typeof run.status === 'number' ? run.status : null
  let raw = ''
  try {
    raw = fs.readFileSync(cli.from === 'stdout' ? stdoutPath : outPath, 'utf8')
  } catch {
    try {
      raw = fs.readFileSync(sink, 'utf8')
    } catch {
      /* 没有输出 */
    }
  }
  for (const p of [outPath, stdoutPath, sink]) {
    try {
      fs.unlinkSync(p)
    } catch {
      /* 清不掉就算了 */
    }
  }
  const json = pickJSONLocal(raw)
  const text = String(raw || '').slice(-500)
  const code = json && json.code !== undefined ? Number(json.code) : null
  // 判定：给出 code 就算引擎活着（300 是「编码问题」，不是引擎坏了也不是模型缺失）
  const alive = code !== null
  let verdict
  if (alive && code === 100) verdict = '跑通了（模型加载正常，能出识别结果）'
  else if (alive && code === 101) verdict = '跑通了（模型正常，测试图上没有文字 —— 这是预期的）'
  else if (alive) verdict = `跑起来了但返回 code=${code}${json.data ? `：${String(json.data).slice(0, 90)}` : ''}`
  else if (/Model .* not found|models\\/i.test(text)) verdict = '模型文件没找到 —— 安装目录被搬动过？重新装一次'
  else if (/AVX/i.test(text)) verdict = '报 AVX 相关错误 —— 这台 CPU 可能不支持，换 RapidOCR-json'
  else if (/缺少|missing|\.dll|无法启动|not a valid Win32/i.test(text)) verdict = '起不来 —— 多半是缺 Visual C++ 运行库，或者被杀软拦了'
  else verdict = `没有输出（退出码 ${exitCode}）—— 可能被杀软拦了，或者这个版本参数不一样`
  return {
    ok: true,
    engine: engineId,
    bin,
    exit_code: exitCode,
    alive,
    code,
    output: text.slice(-400),
    verdict,
  }
}

/** 从一段文本里挑 JSON（和 ocr.mjs 里那个同逻辑，这里不引它避免循环依赖） */
function pickJSONLocal(text) {
  const s = String(text || '').replace(/^\uFEFF/, '')
  for (const line of s.split(/\r?\n/).reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      return JSON.parse(t)
    } catch {
      /* 继续往上找 */
    }
  }
  return null
}

/**
 * 2×2 的纯色 PNG（自检用）。写死一段 base64 比现造省事 —— 这段是用
 * `imgmatch.mjs` 的 `encodePNG` 生成后再核过一遍的，保证是合法 PNG
 * （之前手写的那段 PNG 让引擎报了 code=203 Image decode failed）。
 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGOQAwMGCAUACeYBadT3gZgAAAAASUVORK5CYII=',
  'base64'
)

/** 走一遍正规的探测链拿这个引擎的路径（和识别时用的是同一条路） */
function engineBinPath(engineId) {
  const st = ocrEngines()
  if (engineId === 'paddleocr') return st.paddleBin || recordedEngineBin(engineId)
  if (engineId === 'rapidocr') return st.rapidBin || recordedEngineBin(engineId)
  if (engineId === 'tesseract') return st.tessBin || ''
  return recordedEngineBin(engineId)
}

/** 进程重启后清掉上次遗留的临时目录 */
export function cleanupTmp() {
  for (const p of [TMP_DIR, `${TMP_DIR}-out`]) {
    try {
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true })
    } catch {
      /* 清不掉就算了 */
    }
  }
}

/**
 * 安装选项清单：给设置页「安装选项」那一块用。
 * 只列**还没装**的；已装的就没什么好装的了。
 */
export async function installOptions() {
  const st = await probeEngines()
  const ex = extractorStatus()
  const opts = []
  for (const id of ['rapidocr', 'paddleocr', 'umi']) {
    const spec = INSTALL_SPECS[id]
    const eng = st.engines.find((e) => e.id === id)
    opts.push({
      id,
      name: spec.name,
      license: spec.license,
      size: spec.size,
      note: spec.note,
      manual: Boolean(spec.manual),
      installed: Boolean(eng && eng.available),
      path: (eng && eng.path) || recordedBin(id) || '',
      release_page: releasePage(spec),
      env_key: spec.envKey,
      can_auto: !spec.manual && Boolean(ex.lzma),
      blocked_reason: spec.manual ? '官方包是自解压 exe，最后一步要你自己点' : ex.lzma ? '' : ex.hint,
    })
  }
  return { options: opts, extractor: ex, engine: st.preferred, engine_name: st.engines.find((e) => e.id === st.preferred)?.name || '' }
}
