/* ============================================================
   OCR：读游戏截图里的文字和数字，三种引擎按能力从高到低排。

   为什么要三种（这是「识别率要足够高」的落点）：
     1. **Umi-OCR**（github.com/hiroi-sora/Umi-OCR, MIT）—— PaddleOCR 内核，
        完全离线，自带一个本地 HTTP 服务（默认 127.0.0.1:1224）。
        它返回的每一项都带 `score` 置信度和四角坐标 `box`，
        这正是系统引擎缺的两样东西。装了就用它。
     2. **RapidOCR**（github.com/RapidAI/RapidOCR, Apache-2.0）—— 同一套 PaddleOCR
        模型，提供免 Python 的 Windows 可执行文件，走命令行，输出 JSON。
        没装 Umi-OCR 但装了这个就用它。
     3. **Windows.Media.Ocr**（系统自带，scripts/ocr.ps1）—— 什么外部程序都没有
        时的兜底。不装任何东西，纯本机，但拿不到置信度。
   三级都是「本机跑、图不出这台电脑」，和凭证保险箱一个立场。
   探测结果是缓存的，但可以 force 重探（用户刚装完引擎能立刻生效）。
   ============================================================ */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from './config.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// resolve 一下把 '..' 消掉：powershell -File 拿到带 '..' 的路径会直接失败
const OCR_PS1 = path.resolve(HERE, '..', 'scripts', 'ocr.ps1')

/** 想认的资源：标准名 → 游戏里可能显示成什么。
 *  「体力」在鸣潮里叫「结晶波片」，OCR 也可能只认到半边，所以多列几个别名。 */
export const RESOURCE_ALIASES = {
  星声: ['星声', '星聲'],
  体力: ['结晶波片', '結晶波片', '结晶', '波片', '体力', '體力', '存储体力'],
  贝币: ['贝币', '貝幣', '贝壳币'],
}

/** 全角 → 半角，顺便把 OCR 爱认错的字符统一 */
function normalizeDigits(s) {
  return String(s || '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[，、､]/g, ',')
    .replace(/[．。]/g, '.')
    // 数字被认成字母是常事：0↔O，1↔l↔I↔L
    .replace(/[ＯO]/g, '0')
    .replace(/[ｌI|L]/g, '1')
}

/**
 * 把 OCR 出来的一串词拼成数字。
 * 认到的可能是 "12 , 480" / "240 / 240" / "1.2万" 这几种形态。
 *
 * 认不准就返回 null，**绝不硬凑**：与其把认糊的「L23生567」当成 123567
 * 填进去（看着挺像那么回事，其实是错的），不如留空让用户自己填。
 */
export function parseNumber(raw) {
  let s = normalizeDigits(raw)
  // 「240 / 240」这种「当前/上限」只取前面的当前值
  if (s.includes('/')) s = s.split('/')[0]
  s = s.trim()
  if (!s) return null
  // OCR 会把一个数拆成几个词，中间的空格直接去掉
  s = s.replace(/\s+/g, '')
  // 除了数字、分隔符、万亿，还剩别的字符 = 认糊了，不要
  if (/[^\d.,万亿]/.test(s)) return null
  let mult = 1
  if (s.includes('亿')) {
    mult = 100000000
    s = s.replace(/亿/g, '')
  } else if (s.includes('万')) {
    mult = 10000
    s = s.replace(/万/g, '')
  }
  s = s.replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * mult)
}

/** 读 TSV（x y w h 文字），变成带框的词 */
export function parseWords(tsv) {
  const words = []
  for (const line of String(tsv || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 5) continue
    const [x, y, w, hh] = parts.slice(0, 4).map((v) => Number(v) || 0)
    const text = parts.slice(4).join('\t')
    if (!text) continue
    words.push({ x, y, w, h: hh, text, cx: x + w / 2, cy: y + hh / 2 })
  }
  return words
}

/** 从识别结果里抠资源数字 */
export function extractResources(words, wanted = Object.keys(RESOURCE_ALIASES)) {
  const found = {}
  for (const key of wanted) {
    const aliases = RESOURCE_ALIASES[key] || [key]
    const hit = findResource(words, aliases)
    if (hit !== null) found[key] = hit
  }
  return found
}

/**
 * 规则：找到标签词 → 在同一横行（纵向中心接近）里，取它右边那些词拼成数字。
 * 靠坐标而不是靠行顺序 —— Windows OCR 有时把数字单独排到最后几行去。
 */
function findResource(words, aliases) {
  const plainAliases = aliases.map((a) => a.replace(/\s/g, ''))
  for (let i = 0; i < words.length; i++) {
    // 标签可能被拆成「星」「声」两个词，所以从每个词开始试拼 1~4 个词
    for (let n = 1; n <= 4 && i + n <= words.length; n++) {
      const group = words.slice(i, i + n)
      // 同一组里的词得在同一行，否则「星」+ 下一行的「声」也会被拼起来
      if (n > 1) {
        const ys = group.map((g) => g.cy)
        if (Math.max(...ys) - Math.min(...ys) > Math.max(...group.map((g) => g.h)) * 0.8) break
      }
      const plain = group.map((g) => g.text).join('').replace(/\s/g, '')
      if (!plainAliases.includes(plain)) continue
      const last = group[group.length - 1]
      const right = last.x + last.w
      const cy = group.reduce((s, g) => s + g.cy, 0) / group.length
      const hh = Math.max(...group.map((g) => g.h)) || 30
      const sameRow = words.filter((o) => o.x >= right - 2 && Math.abs(o.cy - cy) <= hh * 0.9)
      if (!sameRow.length) continue
      sameRow.sort((a, b) => a.x - b.x)
      const num = parseNumber(sameRow.map((o) => o.text).join(''))
      if (num !== null && num > 0) return num
    }
  }
  return null
}

/** 整张图按行拼成文本，给用户核对用 */
export function textLines(words) {
  const rows = []
  for (const w of words) {
    const row = rows.find((r) => Math.abs(r.cy - w.cy) <= Math.max(8, w.h * 0.6))
    if (row) {
      row.items.push(w)
      row.cy = (row.cy * (row.items.length - 1) + w.cy) / row.items.length
    } else {
      rows.push({ cy: w.cy, items: [w] })
    }
  }
  return rows
    .sort((a, b) => a.cy - b.cy)
    .map((r) =>
      r.items
        .sort((a, b) => a.x - b.x)
        .map((i) => i.text)
        .join(' ')
    )
}

/**
 * 跑一次 OCR。返回 { ok, words, lines, error }。
 *
 * 两个坑都踩过，记这儿免得再犯：
 *   · stdio 不能给 'ignore' —— powershell 拿到空 stdio 句柄会以 0xC0000142
 *     (DLL_INIT_FAILED) 直接退出，什么都不输出。重定向到文件就行。
 *   · 也不用管道抓输出（沙箱里容易 EPERM），反正结果本来就写文件。
 * stderr 也收进日志文件，失败时能说清原因。
 */
/* ============================================================
   引擎 3：Windows 自带 OCR（兜底，不需要装任何东西）
   ============================================================ */

function windowsOCR(imagePath, { lang = 'zh-Hans-CN', timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const stamp = `${process.pid}-${Date.now()}`
    const outPath = path.join(os.tmpdir(), `xfc-ocr-${stamp}.tsv`)
    const logPath = path.join(os.tmpdir(), `xfc-ocr-${stamp}.log`)
    let outFd = null
    let logFd = null
    try {
      // 只开一个文件：stdout 基本用不到，stderr 收进来，失败时能说清原因。
      // 别用 'NUL' —— 在 Windows 上那样会真的建出一个名叫 NUL 的文件来。
      outFd = fs.openSync(logPath, 'w')
      logFd = fs.openSync(logPath, 'a')
    } catch {
      /* 打不开就按没有处理，下面会报错 */
    }

    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      for (const p of [outPath, logPath]) {
        try {
          fs.unlinkSync(p)
        } catch {
          /* 没了就算了 */
        }
      }
      for (const fd of [outFd, logFd]) {
        try {
          if (fd !== null) fs.closeSync(fd)
        } catch {
          /* 已经关了 */
        }
      }
      resolve(r)
    }

    // 必须是绝对路径：GetFileFromPathAsync 拿到相对路径会抛
    // "One or more errors occurred"，而且看不出是路径的锅
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', OCR_PS1, '-ImagePath', path.resolve(imagePath), '-OutPath', outPath, '-Lang', lang]

    let child
    try {
      child = spawn('powershell.exe', args, { stdio: ['ignore', outFd, logFd], windowsHide: true })
    } catch (err) {
      return finish({ ok: false, error: `起不了 powershell：${err.message}` })
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      finish({ ok: false, error: '识别超时（图太大或者系统卡住了）' })
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: `起不了 powershell：${err.message}` })
    })
    child.on('close', () => {
      clearTimeout(timer)
      let raw = ''
      try {
        raw = fs.readFileSync(outPath, 'utf8')
      } catch {
        let log = ''
        try {
          log = fs.readFileSync(logPath, 'utf8').trim()
        } catch {
          /* 没有就没有 */
        }
        return finish({ ok: false, error: log ? `识别没跑起来：${log.slice(0, 200)}` : '识别没有输出（可能是系统没装中文 OCR 语言包）' })
      }
      if (raw.startsWith('ERROR:')) return finish({ ok: false, error: raw.slice(6).trim() })
      const words = parseWords(raw)
      finish({ ok: true, engine: 'windows', words, lines: textLines(words) })
    })
  })
}

/* ============================================================
   引擎 1：Umi-OCR 的本地 HTTP 服务
   ============================================================ */

const UMI_PORTS = [1224, 1225]
const UMI_HOST = '127.0.0.1'

/** 带超时的 fetch（不引依赖，用全局 fetch + AbortController） */
async function fetchJSON(url, { method = 'POST', body, timeoutMs = 4000 } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 不是 JSON 就当没答 */
    }
    return { ok: res.ok, status: res.status, json, text }
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    clearTimeout(timer)
  }
}

/** Umi-OCR 的四角 box → 我们的 {x,y,w,h} */
function umiBoxToWord(item) {
  const box = item.box || item.pos
  if (!Array.isArray(box) || box.length < 2) return null
  let minx = 1e9
  let miny = 1e9
  let maxx = -1
  let maxy = -1
  for (const p of box) {
    const px = Array.isArray(p) ? Number(p[0]) : Number(p.x)
    const py = Array.isArray(p) ? Number(p[1]) : Number(p.y)
    if (!Number.isFinite(px) || !Number.isFinite(py)) continue
    if (px < minx) minx = px
    if (px > maxx) maxx = px
    if (py < miny) miny = py
    if (py > maxy) maxy = py
  }
  if (maxx < 0) return null
  const x = Math.round(minx)
  const y = Math.round(miny)
  const w = Math.max(1, Math.round(maxx - minx))
  const h = Math.max(1, Math.round(maxy - miny))
  return { x, y, w, h, cx: x + w / 2, cy: y + h / 2, text: String(item.text ?? '').trim(), score: Number(item.score) || 0 }
}

/**
 * Umi-OCR 的 /api/ocr 一次返回**整行**（end 是行尾）。
 * 为了和 Windows 引擎的「一个词一段」对齐，这里按空格切开，
 * 再按字数把行框等分回每一段 —— 粗但够用，识别层只用得到大致区间。
 */
function umiItemsToWords(data) {
  const words = []
  for (const item of data || []) {
    const base = umiBoxToWord(item)
    if (!base || !base.text) continue
    const parts = base.text.split(/\s+/).filter(Boolean)
    if (parts.length <= 1) {
      words.push(base)
      continue
    }
    const total = parts.reduce((s, p) => s + Math.max(1, p.length), 0)
    let acc = 0
    for (const p of parts) {
      const share = Math.max(1, p.length) / total
      const x = Math.round(base.x + base.w * acc)
      const w = Math.max(1, Math.round(base.w * share))
      acc += share
      words.push({ x, y: base.y, w, h: base.h, cx: x + w / 2, cy: base.y + base.h / 2, text: p, score: base.score })
    }
  }
  return words
}

async function umiOCR(imagePath, { timeoutMs = 20000, port } = {}) {
  const buf = fs.readFileSync(imagePath)
  const base64 = buf.toString('base64')
  const ports = port ? [port] : UMI_PORTS
  let lastErr = 'Umi-OCR 没有响应'
  for (const p of ports) {
    const url = `http://${UMI_HOST}:${p}/api/ocr`
    const res = await fetchJSON(url, {
      body: { base64, options: { 'ocr.language': 'models/config_chinese.txt', 'data.format': 'dict' } },
      timeoutMs,
    })
    if (!res.ok) {
      lastErr = res.error || `HTTP ${res.status}`
      continue
    }
    const json = res.json || {}
    if (Number(json.code) !== 100) {
      lastErr = json.msg || json.data || `Umi-OCR 返回 code=${json.code}`
      continue
    }
    const words = umiItemsToWords(json.data)
    return { ok: true, engine: 'umi', port: p, words, lines: textLines(words) }
  }
  return { ok: false, error: lastErr }
}

/* ============================================================
   引擎 2/3：免 Python 的控制台 OCR（PaddleOCR-json / RapidOCR-json）
   ============================================================ */

/**
 * 这两个是同一家人做的（hiroi-sora），接口几乎一样：
 *   · PaddleOCR-json —— Apache-2.0，PP-OCR 内核，解压即用（约 88MB 包 / 展开 250MB），
 *     要求 CPU 有 AVX；Umi-OCR 里那个 Paddle 插件用的就是同款引擎。
 *   · RapidOCR-json —— MIT，PP-OCR 的 onnxruntime 版，约 30MB，CPU 没 AVX 也能跑。
 * 两个都用**一次性调用**：`-image_path="图" -write_json="out.json"`，
 * 输出 { "code": 100, "data": [ {"text","box":[[x,y]×4],"score"} ] }。
 *
 * 为什么不挂常驻进程：这两个官方都明说不支持并发（多客户端会串），
 * 而我们的识别是「用户点了才跑一次」的量级，一次性调用的启动开销
 * （Rapid ~0.1s、Paddle ~2s）比维护一个会卡死、要处理端口握手的常驻进程划算。
 * 为什么不用管道抓 stdout：沙箱里 Node 的 child_process 拿管道会 EPERM，
 * 而这两个都支持 `-write_json=` 直接落盘，走文件最省事。
 */
const CONSOLE_OCR = {
  paddleocr: {
    id: 'paddleocr',
    name: 'PaddleOCR-json',
    repo: 'github.com/hiroi-sora/PaddleOCR-json',
    license: 'Apache-2.0',
    envKey: 'PADDLEOCR_JSON_BIN',
    exeNames: ['PaddleOCR-json.exe', 'PaddleOCR_json.exe'],
    install: '设置页里点「自动安装」；或者自己下载 Windows 包解压到 tools\\ocr\\，或设 PADDLEOCR_JSON_BIN 指到 exe',
    approx: '约 88MB 包 / 展开 250MB，需要 CPU 支持 AVX',
  },
  rapidocr: {
    id: 'rapidocr',
    name: 'RapidOCR-json',
    repo: 'github.com/hiroi-sora/RapidOCR-json',
    license: 'MIT',
    envKey: 'RAPIDOCR_JSON_BIN',
    exeNames: ['RapidOCR-json.exe', 'RapidOCR_json.exe'],
    install: '设置页里点「自动安装」；或者自己下载 Windows 包解压到 tools\\ocr\\，或设 RAPIDOCR_JSON_BIN 指到 exe',
    approx: '约 70MB 包 / 展开 95MB，不需要 AVX',
  },
}

export { CONSOLE_OCR }

/** PATH / 环境变量 / 几个常见目录里找可执行文件（照抄 restic 的探测样板） */
function whichSync(cmd) {
  try {
    const r = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', [cmd], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) return null
    const first = String(r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0]
    return first || null
  } catch {
    return null
  }
}

function findConsoleOcr(spec) {
  const cands = []
  if (process.env[spec.envKey]) cands.push(process.env[spec.envKey])
  // 自动安装器装完会把 exe 绝对路径记进 data/ocr-engines.json，这里优先信它 ——
  // 用户可能把 tools 目录挪到别处（数据目录跟着走，所以记录是可靠的）
  const recorded = spec.id ? recordedEngineBin(spec.id) : null
  if (recorded) cands.push(recorded)
  const roots = [
    path.resolve(HERE, '..', 'tools', 'ocr'),
    path.resolve(HERE, '..', 'tools'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'PaddleOCR-json'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'PaddleOCR-json'),
    // 用户如果已经装了 Umi-OCR，它自带的插件目录里就有现成的 exe，直接借用
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Umi-OCR', 'UmiOCR-data', 'plugins'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Umi-OCR', 'UmiOCR-data', 'plugins'),
  ].filter(Boolean)
  for (const root of roots) {
    // 自动安装器会落到 tools\ocr\<引擎id>\<包名>\，所以往下多找一层
    for (const n of spec.exeNames) cands.push(path.join(root, n))
    for (const n of spec.exeNames) cands.push(path.join(root, 'PaddleOCR-json', n))
    if (spec.id) for (const n of spec.exeNames) cands.push(path.join(root, spec.id, n))
  }
  for (const c of cands) {
    try {
      if (c && fs.existsSync(c)) return c
    } catch {
      /* 忽略 */
    }
  }
  // 自动安装的目录里再往下找一层（包名那一级）
  if (spec.id) {
    const hit = findExeUnder(path.join(HERE, '..', 'tools', 'ocr', spec.id), spec.exeNames)
    if (hit) return hit
  }
  for (const n of spec.exeNames) {
    const hit = whichSync(n)
    if (hit) return hit
  }
  return null
}

/** 在有界深度内找一个指定文件名的文件（自动安装的目录结构不固定，靠这个兜住） */
function findExeUnder(dir, names, depth = 0) {
  if (depth > 4) return null
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
    const hit = findExeUnder(path.join(dir, e.name), names, depth + 1)
    if (hit) return hit
  }
  return null
}

/* ---------------- 自动安装的记录文件 ---------------- */

const BIN_CONFIG_FILE = path.join(DATA_DIR, 'ocr-engines.json')

function readBinConfig() {
  try {
    const j = JSON.parse(fs.readFileSync(BIN_CONFIG_FILE, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

/** 自动安装器的输出：记下这个引擎的 exe 在哪（探测链会读它） */
export function rememberEngineBin(engineId, binPath) {
  const cfg = readBinConfig()
  cfg[engineId] = { bin: binPath, at: new Date().toISOString() }
  try {
    fs.mkdirSync(path.dirname(BIN_CONFIG_FILE), { recursive: true })
    fs.writeFileSync(BIN_CONFIG_FILE, JSON.stringify(cfg, null, 2))
  } catch {
    /* 写不进去就算了 —— PATH 和 tools 目录那几条路还能兜住 */
  }
  return cfg[engineId]
}

/** 取出记录过的 exe 路径（文件真的还在才算，用户删了就当没装） */
export function recordedEngineBin(engineId) {
  const rec = readBinConfig()[engineId]
  if (!rec || !rec.bin) return null
  try {
    return fs.existsSync(rec.bin) ? rec.bin : null
  } catch {
    return null
  }
}

/** PaddleOCR-json / RapidOCR-json 的 JSON → 统一的词框 */
function consoleJSONToWords(json) {
  const arr = Array.isArray(json) ? json : json?.data || json?.result || json?.results || []
  const words = []
  for (const it of arr) {
    if (!it) continue
    // [box, text, score] 这种紧凑数组形态
    if (Array.isArray(it)) {
      const w = umiBoxToWord({ box: it[0], text: it[1] })
      if (w && w.text) words.push({ ...w, score: Number(it[2]) || 0 })
      continue
    }
    let word = umiBoxToWord({ box: it.box || it.boxes || it.points, text: it.text ?? it.label ?? it.transcription })
    // xyxy 形态（有些构建直接给 bbox）
    if (!word && Array.isArray(it.bbox) && it.bbox.length === 4) {
      const [x0, y0, x1, y1] = it.bbox.map(Number)
      word = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, text: String(it.text ?? ''), score: Number(it.score ?? it.confidence) || 0 }
    }
    if (word && word.text) words.push({ ...word, score: Number(it.score ?? it.confidence) || 0 })
  }
  return words
}

/**
 * 各引擎的命令行差异表。**这是实测出来的，不是看文档猜的**：
 *
 *   · PaddleOCR-json  —— 单短横线 `-image_path=` / `-write_json=`，结果写成文件；
 *   · RapidOCR-json   —— 双短横线 `--image=` / `--ensureAscii=1`，结果打在 **stdout**。
 *
 * RapidOCR-json 那条还有个坑：**图片路径带中文时它自己 dump JSON 会失败**
 * （返回 `code:300 JSON dump failed`，因为它的中文编码处理有问题）。
 * 我们用 `--ensureAscii=1` 让它把非 ASCII 转成 `\uXXXX`，就绕过去了。
 *
 * stdout 怎么读：沙箱里不能给子进程接管道（EPERM），但**把 stdout 直接重定向到
 * 一个文件描述符是允许的**，所以 spawn 时 stdio[1] 指向一个临时文件，
 * 跑完再读回来 —— 效果和抓管道一样。
 */
export const CONSOLE_CLI = {
  paddleocr: {
    args: (imagePath, outPath) => [`-image_path=${imagePath}`, `-write_json=${outPath}`],
    from: 'file',
  },
  rapidocr: {
    args: (imagePath) => [`--image=${imagePath}`, '--ensureAscii=1'],
    from: 'stdout',
    asciiPath: true,
  },
}

/** 从一段输出里挑出 JSON（引擎会先打印版本行和 `OCR init completed.`） */
function pickJSON(text) {
  const s = String(text || '').replace(/^\uFEFF/, '')
  for (const line of s.split(/\r?\n/).reverse()) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try {
      return JSON.parse(t)
    } catch {
      /* 这一行不是完整 JSON，往上继续找 */
    }
  }
  // 整段就是一个 JSON 的情况
  try {
    return JSON.parse(s.trim())
  } catch {
    return null
  }
}

/**
 * 跑一次免 Python 的控制台 OCR。
 *
 * RapidOCR-json 读**输入**路径也过不了中文（返回 `code=300 JSON dump failed`；
 * `--ensureAscii=1` 只管输出）。而这个项目的目录本身就叫「代肝价格查询」，
 * 所以凡是这类引擎，都先把图复制到一个纯 ASCII 的临时路径再喂进去。
 */
function consoleOCR(id, bin, imagePath, opts) {
  const cli = CONSOLE_CLI[id]
  let usePath = imagePath
  let asciiCopy = ''
  if (cli && cli.asciiPath && /[^\x20-\x7e]/.test(path.resolve(imagePath))) {
    try {
      asciiCopy = path.join(os.tmpdir(), `xfc-ascii-${id}-${process.pid}-${Date.now()}.png`)
      fs.copyFileSync(imagePath, asciiCopy)
      usePath = asciiCopy
    } catch {
      /* 复制不了就用原路径，让它自己报错 */
    }
  }
  return consoleOCRRun(id, bin, usePath, opts).finally(() => {
    if (asciiCopy) {
      try {
        fs.unlinkSync(asciiCopy)
      } catch {
        /* 清不掉就算了 */
      }
    }
  })
}

function consoleOCRRun(id, bin, imagePath, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const cli = CONSOLE_CLI[id] || CONSOLE_CLI.paddleocr
    const stamp = `${process.pid}-${Date.now()}`
    const outPath = path.join(os.tmpdir(), `xfc-${id}-${stamp}.json`)
    const stdoutPath = path.join(os.tmpdir(), `xfc-${id}-${stamp}.stdout`)
    const logPath = path.join(os.tmpdir(), `xfc-${id}-${stamp}.log`)
    const cleanup = [outPath, stdoutPath, logPath]
    let fd = null
    const finish = (r) => {
      for (const p of cleanup) {
        try {
          fs.unlinkSync(p)
        } catch {
          /* 没了就算了 */
        }
      }
      try {
        if (fd !== null) fs.closeSync(fd)
      } catch {
        /* 已经关了 */
      }
      resolve(r)
    }

    // stdout（或 stderr 日志）都重定向到文件；不能用管道（沙箱里 EPERM）
    const sinkPath = cli.from === 'stdout' ? stdoutPath : logPath
    try {
      fd = fs.openSync(sinkPath, 'w')
    } catch {
      /* 打不开就让子进程自己继承，下面会因为没有输出而报错 */
    }
    const args = cli.args(path.resolve(imagePath), outPath)
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', fd === null ? 'ignore' : fd, fd === null ? 'ignore' : fd], windowsHide: true, cwd: path.dirname(bin) })
    } catch (err) {
      return finish({ ok: false, error: `起不了 ${id}：${err.message}` })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      finish({ ok: false, error: `${id} 超时（${Math.round(timeoutMs / 1000)}秒）` })
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: `起不了 ${id}：${err.message}` })
    })
    child.on('close', () => {
      clearTimeout(timer)
      let raw = ''
      try {
        raw = fs.readFileSync(cli.from === 'stdout' ? stdoutPath : outPath, 'utf8')
      } catch {
        let log = ''
        try {
          log = fs.readFileSync(logPath, 'utf8').trim() || fs.readFileSync(stdoutPath, 'utf8').trim()
        } catch {
          /* 没有就没有 */
        }
        return finish({ ok: false, error: log ? `${id} 没输出：${log.slice(0, 200)}` : `${id} 没输出（参数名可能和这个版本不一致）` })
      }
      const json = pickJSON(raw)
      if (!json) return finish({ ok: false, error: `${id} 的输出不是 JSON：${raw.trim().slice(0, 160) || '(空)'}` })
      if (json.code !== undefined && Number(json.code) !== 100) {
        return finish({ ok: false, error: `${id} 返回 code=${json.code}${json.data ? `：${String(json.data).slice(0, 120)}` : ''}` })
      }
      const words = consoleJSONToWords(json)
      if (!words.length) return finish({ ok: false, error: `${id} 没认到任何文字` })
      finish({ ok: true, engine: id, words, lines: textLines(words) })
    })
  })
}

/* ============================================================
   引擎 4：Tesseract（装了就用；中文界面质量不如 PP-OCR 系，所以排在后面）
   ============================================================ */

function findTesseract() {
  if (process.env.TESSERACT_BIN) return process.env.TESSERACT_BIN
  for (const p of [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Tesseract-OCR', 'tesseract.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Tesseract-OCR', 'tesseract.exe'),
  ]) {
    try {
      if (p && fs.existsSync(p)) return p
    } catch {
      /* 忽略 */
    }
  }
  return whichSync('tesseract.exe') || whichSync('tesseract')
}

/** Tesseract 的 TSV：只取 level=5（词）那些行 */
function tesseractTSVToWords(tsv) {
  const words = []
  const lines = String(tsv || '').split(/\r?\n/)
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t')
    if (cols.length < 12) continue
    if (Number(cols[0]) !== 5) continue
    const text = cols.slice(11).join('\t').trim()
    if (!text) continue
    const conf = Number(cols[10])
    const x = Number(cols[6])
    const y = Number(cols[7])
    const w = Number(cols[8])
    const h = Number(cols[9])
    if (![x, y, w, h].every(Number.isFinite)) continue
    words.push({ x, y, w, h, cx: x + w / 2, cy: y + h / 2, text, score: Number.isFinite(conf) ? Math.max(0, conf / 100) : 0 })
  }
  return words
}

function tesseractOCR(bin, imagePath, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const outPath = path.join(os.tmpdir(), `xfc-tess-${process.pid}-${Date.now()}.tsv`)
    const logPath = `${outPath}.log`
    let logFd = null
    try {
      logFd = fs.openSync(logPath, 'w')
    } catch {
      /* 没有就没有 */
    }
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      for (const p of [outPath, logPath]) {
        try {
          fs.unlinkSync(p)
        } catch {
          /* 没了就算了 */
        }
      }
      try {
        if (logFd !== null) fs.closeSync(logFd)
      } catch {
        /* 已经关了 */
      }
      resolve(r)
    }
    // 最后一个位置参数是输出文件名（不带扩展名），tesseract 自己加 .tsv
    const args = [path.resolve(imagePath), outPath.replace(/\.tsv$/i, ''), '-l', 'chi_sim+eng', '--psm', '6', 'tsv']
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'ignore', logFd], windowsHide: true })
    } catch (err) {
      return finish({ ok: false, error: `起不了 tesseract：${err.message}` })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      finish({ ok: false, error: 'tesseract 超时' })
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: `起不了 tesseract：${err.message}` })
    })
    child.on('close', () => {
      clearTimeout(timer)
      let raw = ''
      try {
        raw = fs.readFileSync(outPath, 'utf8')
      } catch {
        return finish({ ok: false, error: 'tesseract 没输出（多半是没装 chi_sim 中文语言包）' })
      }
      const words = tesseractTSVToWords(raw)
      if (!words.length) return finish({ ok: false, error: 'tesseract 没认到任何文字' })
      finish({ ok: true, engine: 'tesseract', words, lines: textLines(words) })
    })
  })
}

/* ============================================================
   探测链：装了谁就用谁，没装就一路往下退
   ============================================================ */

let engineCache = null

/**
 * 探测这台机器上能用的 OCR 引擎。
 * 除 Umi-OCR 要发请求（异步的 probeEngines）之外都是查文件，同步就能出结果。
 * 结果缓存；force=true 重探（用户刚装完引擎时用）。
 */
export function ocrEngines({ force = false } = {}) {
  if (engineCache && !force) return engineCache
  const prev = engineCache || {}
  const win = process.platform === 'win32' && safeExists(OCR_PS1)
  const paddleBin = findConsoleOcr(CONSOLE_OCR.paddleocr)
  const rapidBin = findConsoleOcr(CONSOLE_OCR.rapidocr)
  const tessBin = findTesseract()

  const engines = [
    {
      id: 'umi',
      name: 'Umi-OCR',
      available: Boolean(prev.umiOnline),
      port: prev.umiPort || UMI_PORTS[0],
      license: 'MIT（内含 Apache-2.0 的 PaddleOCR-json 与 LGPL 的 Qt 组件，按官方方式自行安装）',
      install: 'github.com/hiroi-sora/Umi-OCR —— 解压即用，设置里打开「HTTP 服务」（默认 127.0.0.1:1224）',
      note: prev.umiOnline ? `本地服务在线（127.0.0.1:${prev.umiPort}）` : '没检测到本地服务：装了 Umi-OCR 并打开 HTTP 服务后会自动用上',
      score: 4,
    },
    {
      id: 'paddleocr',
      name: CONSOLE_OCR.paddleocr.name,
      available: Boolean(paddleBin),
      path: paddleBin || '',
      license: CONSOLE_OCR.paddleocr.license,
      install: CONSOLE_OCR.paddleocr.install,
      note: paddleBin ? `已找到：${paddleBin}` : `没找到。${CONSOLE_OCR.paddleocr.install}（${CONSOLE_OCR.paddleocr.approx}）`,
      score: 3,
    },
    {
      id: 'rapidocr',
      name: CONSOLE_OCR.rapidocr.name,
      available: Boolean(rapidBin),
      path: rapidBin || '',
      license: CONSOLE_OCR.rapidocr.license,
      install: CONSOLE_OCR.rapidocr.install,
      note: rapidBin ? `已找到：${rapidBin}` : `没找到。${CONSOLE_OCR.rapidocr.install}（${CONSOLE_OCR.rapidocr.approx}）`,
      score: 2,
    },
    {
      id: 'tesseract',
      name: 'Tesseract',
      available: Boolean(tessBin),
      path: tessBin || '',
      license: 'Apache-2.0',
      install: 'github.com/UB-Mannheim/tesseract —— 安装时勾上 chi_sim 中文语言包',
      note: tessBin ? `已找到：${tessBin}` : '没找到。装了就有，但中文界面质量不如 PP-OCR 系，所以排在后面',
      score: 1,
    },
    {
      id: 'windows',
      name: 'Windows 自带 OCR',
      available: win,
      license: '随系统',
      install: '不用装（Windows 10/11 自带，需要系统装了中文 OCR 语言包）',
      note: win ? '系统自带，无需安装；缺点是拿不到置信度' : '只在 Windows 上有',
      score: 0,
    },
  ]
  const preferred = engines.filter((e) => e.available).sort((a, b) => b.score - a.score)[0]?.id || null
  engineCache = {
    engines,
    preferred,
    win,
    paddleBin: paddleBin || null,
    rapidBin: rapidBin || null,
    tessBin: tessBin || null,
    umiOnline: Boolean(prev.umiOnline),
    umiPort: prev.umiPort || UMI_PORTS[0],
    checkedAt: Date.now(),
  }
  return engineCache
}

/** 异步探一次 Umi-OCR（真的发请求），结果并回缓存 */
export async function probeEngines({ force = false, timeoutMs = 1200 } = {}) {
  if (force) engineCache = null
  ocrEngines({ force })
  let online = false
  let port = null
  for (const p of UMI_PORTS) {
    // get_options 不消耗 OCR 算力，正好当心跳用
    const res = await fetchJSON(`http://${UMI_HOST}:${p}/api/ocr/get_options`, { method: 'GET', timeoutMs })
    if (res.ok) {
      online = true
      port = p
      break
    }
  }
  engineCache.umiOnline = online
  engineCache.umiPort = port || UMI_PORTS[0]
  engineCache.engines = engineCache.engines.map((e) =>
    e.id === 'umi' ? { ...e, available: online, port: engineCache.umiPort, note: online ? `本地服务在线（127.0.0.1:${engineCache.umiPort}）` : e.note } : e
  )
  engineCache.preferred = engineCache.engines.filter((e) => e.available).sort((a, b) => b.score - a.score)[0]?.id || null
  return engineCache
}

/**
 * Umi-OCR 在不在，只有真发一次请求才知道；而 ocrEngines() 是同步的，
 * 只能读到「上一次探出来的结果」。
 *
 * 这一条以前没有，于是冷启动之后：
 *   · 设置页上面说「Umi-OCR 未安装」，下面「安装选项」（它会真探）说「已装好」，
 *     同一屏上自相矛盾；
 *   · 识别也永远轮不到 Umi-OCR（它分最高、最好用），只能退到 RapidOCR；
 *   · 用户点「重新检测」才把这些纠正过来。
 *
 * 所以凡是「要给人看引擎状态」和「马上要开始识别」的地方，都先过
 * ensureEnginesProbed()：缓存够新就直接用，冷掉/过期就真探一次（心跳请求很便宜）。
 */
const UMI_PROBE_TTL_MS = 60 * 1000
let umiProbedAt = 0

/** 真探一次，返回公开状态（available / engine / engine_name …） */
export async function probeEnginesStatus({ force = false, timeoutMs = 1200 } = {}) {
  try {
    await probeEngines({ force, timeoutMs })
  } catch {
    /* 探不动就用手上的缓存，别把调用方拖崩 */
  }
  umiProbedAt = Date.now()
  return ocrStatus()
}

/** 状态够新就直接给，冷启动或过期就真探一次 */
export async function ensureEnginesProbed({ maxAgeMs = UMI_PROBE_TTL_MS, timeoutMs = 1200 } = {}) {
  if (umiProbedAt && Date.now() - umiProbedAt < maxAgeMs) return ocrStatus()
  return probeEnginesStatus({ timeoutMs })
}

function safeExists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** 这台机器能不能用截图识别（沿用老接口名） */
export function ocrAvailable() {
  const st = ocrEngines()
  return Boolean(st.preferred)
}

/** 详细状态，给 /api/ocr/status 用 */
export function ocrStatus() {
  const st = ocrEngines()
  return {
    available: Boolean(st.preferred),
    engine: st.preferred,
    engine_name: st.engines.find((e) => e.id === st.preferred)?.name || '',
    engines: st.engines,
    umi_online: Boolean(st.umiOnline),
    umi_port: st.umiPort,
    paddle_bin: st.paddleBin || '',
    rapid_bin: st.rapidBin || '',
    tess_bin: st.tessBin || '',
    platform: process.platform,
  }
}

/**
 * 跑一次 OCR：从能力最高的引擎往下一路试，第一个成功的就用。
 * 返回 { ok, engine, words, lines, error, tried }
 *
 * Umi-OCR 官方明说不支持并发，所以这里不做并发调用 —— 识别是
 * 「用户点了才跑一次」的量级（一秒一次），够用。
 */
export async function ocrImage(imagePath, { lang = 'zh-Hans-CN', timeoutMs = 30000, engine = null } = {}) {
  const st = ocrEngines()
  const chain = engine
    ? [engine]
    : ['umi', 'paddleocr', 'rapidocr', 'tesseract', 'windows'].filter((id) => st.engines.find((e) => e.id === id)?.available)
  if (!chain.length) return { ok: false, error: '这台机器上没有可用的 OCR（装一个本地引擎，或者用 Windows 自带的那个）', tried: [] }
  const tried = []
  for (const id of chain) {
    let r
    if (id === 'umi') r = await umiOCR(imagePath, { timeoutMs: Math.min(timeoutMs, 20000), port: st.umiPort })
    else if (id === 'paddleocr') r = await consoleOCR('paddleocr', st.paddleBin, imagePath, { timeoutMs })
    else if (id === 'rapidocr') r = await consoleOCR('rapidocr', st.rapidBin, imagePath, { timeoutMs })
    else if (id === 'tesseract') r = await tesseractOCR(st.tessBin, imagePath, { timeoutMs })
    else r = await windowsOCR(imagePath, { lang, timeoutMs })
    tried.push({ engine: id, ok: r.ok, error: r.error })
    if (r.ok) return { ...r, tried }
    // 这次挂了（用户关了 Umi-OCR / 把 exe 挪走了）→ 从链里摘掉，别每次都白等一个超时
    if (engine) continue
    if (id === 'umi') engineCache.umiOnline = false
    if (id === 'paddleocr' && /起不了/.test(String(r.error))) engineCache.paddleBin = null
    if (id === 'rapidocr' && /起不了/.test(String(r.error))) engineCache.rapidBin = null
  }
  return { ok: false, error: tried[tried.length - 1]?.error || '识别失败', tried }
}
