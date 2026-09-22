/* ============================================================
   OCR：用 Windows 自带的识别引擎读游戏截图，把资源数字抠出来。

   为什么用系统自带的：
     · 不用装任何东西（不 npm install，不带 wasm 模型）；
     · 完全在本机跑，截图不出这台电脑（跟凭证保险箱一个立场）；
     · 中文识别是现成的（zh-Hans-CN）。

   识别一定会认错（实测：真机尺寸下数字基本准，小图会认糊），
   所以这里只负责「猜」，填什么由用户核对后确认。
   ============================================================ */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

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
export function ocrImage(imagePath, { lang = 'zh-Hans-CN', timeoutMs = 30000 } = {}) {
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
      finish({ ok: true, words, lines: textLines(words) })
    })
  })
}

/** 这台机器能不能用截图识别 */
export function ocrAvailable() {
  if (process.platform !== 'win32') return false
  try {
    return fs.existsSync(OCR_PS1)
  } catch {
    return false
  }
}
