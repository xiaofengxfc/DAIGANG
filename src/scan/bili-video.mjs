/**
 * 视频下载与抽帧 —— 自动比价链路里「把画面变成图片」的那一段。
 *
 * 两个刻意的设计：
 *
 * 1. 下载只要视频轨，不要音频。抽帧根本用不到声音，而 B站 的音频流要单独下一份
 *    再合并，白花一半时间和流量。所以 -f 里不带 +ba。
 *
 * 2. 抽帧时**同时**输出一份 16×16 灰度指纹（一次 ffmpeg 调用、两个输出）。
 *    价格表视频里同一张表格往往停留十几秒，按固定间隔抽出来的帧大半是重复的，
 *    全送去 OCR 纯属浪费（一次 OCR 要 0.5~3 秒）。指纹在 Node 这边比一下就能
 *    把重复帧和纯黑/纯色的转场帧滤掉，OCR 只跑真正有新内容的那些。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { BILI_FRAME_INTERVAL_S, BILI_MAX_HEIGHT, BILI_FRAME_MAX, BILI_YTDLP_TIMEOUT_MS } from '../core/config.mjs'
import { probeFfmpeg, ytDlpInvocation } from './bili-deps.mjs'

/** 跑一个子进程并收集输出。stdout 按 utf8 收，进度行靠 \r 分隔要自己拆 */
function runProcess(bin, args, { timeoutMs = 120000, onLine = null, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(bin, args, { windowsHide: true, cwd })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message || '', error: error.message })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }, timeoutMs)

    const feed = (chunk, isErr) => {
      const text = chunk.toString()
      if (isErr) stderr = `${stderr}${text}`.slice(-8000)
      else stdout = `${stdout}${text}`.slice(-8000)
      if (onLine) {
        // yt-dlp 的进度是用 \r 刷新的，按 \r 和 \n 都切开才拿得到每一行
        for (const line of text.split(/[\r\n]+/)) {
          const trimmed = line.trim()
          if (trimmed) onLine(trimmed, isErr)
        }
      }
    }

    child.stdout?.on('data', (chunk) => feed(chunk, false))
    child.stderr?.on('data', (chunk) => feed(chunk, true))
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr, error: error.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** 用 ffprobe 读时长（秒）。读不到就返回 0，调用方按「不知道时长」处理 */
export async function probeDuration(videoPath) {
  const ffmpeg = probeFfmpeg()
  if (!ffmpeg.available) return 0
  const ffprobe = ffmpeg.bin.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'))
  const r = await runProcess(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', videoPath], {
    timeoutMs: 20000,
  })
  const value = Number(String(r.stdout || '').trim())
  return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * 下载一个 B站 视频（只要视频轨）。
 * @returns {{ ok: boolean, file?: string, error?: string, bytes?: number }}
 */
export async function downloadVideo({ bvid, dir, cookieFile = '', maxHeight = BILI_MAX_HEIGHT, onLine = null, timeoutMs = BILI_YTDLP_TIMEOUT_MS }) {
  const ytdlp = ytDlpInvocation()
  if (!ytdlp) return { ok: false, error: 'yt-dlp 还没装好（去「B站比价」面板点一键安装）' }
  fs.mkdirSync(dir, { recursive: true })

  // 只要视频轨：不带 +ba，省掉音频下载和一次合并
  const format = `bv*[height<=${maxHeight}]/b[height<=${maxHeight}]/b`
  const args = [
    ...ytdlp.prefix,
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--retries',
    '2',
    '--socket-timeout',
    '20',
    '-f',
    format,
    '-o',
    path.join(dir, '%(id)s.%(ext)s'),
  ]
  if (cookieFile && fs.existsSync(cookieFile)) args.push('--cookies', cookieFile)
  args.push(`https://www.bilibili.com/video/${bvid}`)

  const r = await runProcess(ytdlp.bin, args, { timeoutMs, onLine })
  if (r.code !== 0) {
    // yt-dlp 的报错行通常在最后几行，挑一条最像原因的带回去
    const lines = String(r.stderr || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
    const reason = lines.filter((l) => /^ERROR/i.test(l)).pop() || lines.pop() || '下载失败'
    return { ok: false, error: reason }
  }
  // 文件名里带了 %(id)s，直接按 bvid 找，不用去解析 yt-dlp 的输出
  const hit = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(bvid) && !name.endsWith('.part'))
    .map((name) => path.join(dir, name))
    .filter((file) => {
      try {
        return fs.statSync(file).isFile() && fs.statSync(file).size > 1024
      } catch {
        return false
      }
    })
  if (!hit.length) return { ok: false, error: '下载命令成功了，但目录里找不到视频文件' }
  const file = hit[0]
  return { ok: true, file, bytes: fs.statSync(file).size }
}

/* ------------------------------------------------------------------
   帧指纹：16×16 灰度图，用来判断两帧「看起来是不是同一张」
   ------------------------------------------------------------------ */

const SIG_W = 16
const SIG_H = 16
const SIG_BYTES = SIG_W * SIG_H

/** 指纹是否「有内容」：全黑、全白、或者几乎没有明暗变化的帧（转场、淡入淡出）没有 OCR 价值 */
export function signatureHasContent(sig) {
  let min = 255
  let max = 0
  let sum = 0
  for (const value of sig) {
    if (value < min) min = value
    if (value > max) max = value
    sum += value
  }
  const mean = sum / sig.length
  let variance = 0
  for (const value of sig) variance += (value - mean) ** 2
  const std = Math.sqrt(variance / sig.length)
  // 对比度太低 = 纯色/黑屏/白屏；min===max 是极端情况
  return max - min >= 24 && std >= 8
}

/** 两帧的平均绝对差（0~255）。低于阈值就当同一张图 */
export function signatureDistance(a, b) {
  let total = 0
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i])
  return total / a.length
}

/** 在已保留的指纹里找最接近的一帧，用于「这张图是不是已经见过」 */
export function findSimilar(sig, kept, threshold = 6) {
  for (let i = 0; i < kept.length; i++) {
    if (signatureDistance(sig, kept[i]) < threshold) return i
  }
  return -1
}

/**
 * 抽帧。
 *
 * 一次 ffmpeg 跑出两路输出：
 *   · frames/f%04d.jpg —— 1280 宽的 JPEG，送去 OCR
 *   · sig.raw          —— 同样时间点的 16×16 灰度原始字节，用来去重
 * 两路都用同一个 fps 滤镜，所以第 N 张 JPEG 和第 N 块指纹严格对应。
 *
 * @returns {{ ok: boolean, frames: string[], skipped: number, error?: string }}
 */
export async function extractFrames({
  videoPath,
  frameDir,
  intervalS = BILI_FRAME_INTERVAL_S,
  maxFrames = BILI_FRAME_MAX,
  width = 1280,
} = {}) {
  const ffmpeg = probeFfmpeg()
  if (!ffmpeg.available) return { ok: false, frames: [], skipped: 0, error: '没找到 ffmpeg，无法抽帧' }
  fs.mkdirSync(frameDir, { recursive: true })

  const jpgPattern = path.join(frameDir, 'f%04d.jpg')
  const sigPath = path.join(frameDir, 'sig.raw')
  // -frames:v 卡住上限：超长视频不会抽出几百张图把磁盘和 OCR 都拖垮
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    videoPath,
    '-map',
    '0:v:0',
    '-vf',
    `fps=1/${intervalS},scale=${width}:-2`,
    '-frames:v',
    String(maxFrames),
    '-q:v',
    '3',
    jpgPattern,
    '-map',
    '0:v:0',
    '-vf',
    `fps=1/${intervalS},scale=${SIG_W}:${SIG_H}`,
    '-frames:v',
    String(maxFrames),
    '-pix_fmt',
    'gray',
    '-f',
    'rawvideo',
    sigPath,
  ]
  const r = await runProcess(ffmpeg.bin, args, { timeoutMs: 5 * 60 * 1000 })
  if (r.code !== 0) {
    return { ok: false, frames: [], skipped: 0, error: `ffmpeg 抽帧失败：${String(r.stderr || '').trim().split(/\r?\n/).pop() || r.code}` }
  }

  const all = fs
    .readdirSync(frameDir)
    .filter((name) => /^f\d+\.jpg$/.test(name))
    .sort()
    .map((name) => path.join(frameDir, name))
  if (!all.length) return { ok: true, frames: [], skipped: 0 }

  let sigBuf = Buffer.alloc(0)
  try {
    sigBuf = fs.readFileSync(sigPath)
  } catch {
    // 指纹没出来（老版本 ffmpeg？）就退化成「全部保留」，功能不受影响只是慢一点
    return { ok: true, frames: all, skipped: 0 }
  }

  const kept = []
  const keptSigs = []
  let skipped = 0
  for (let i = 0; i < all.length; i++) {
    const offset = i * SIG_BYTES
    if (offset + SIG_BYTES > sigBuf.length) {
      // 指纹比图少：剩下的图没有指纹可比，保守起见留着
      kept.push(all[i])
      continue
    }
    const sig = sigBuf.subarray(offset, offset + SIG_BYTES)
    if (!signatureHasContent(sig)) {
      skipped++
      continue
    }
    if (findSimilar(sig, keptSigs) >= 0) {
      skipped++
      continue
    }
    kept.push(all[i])
    keptSigs.push(Uint8Array.from(sig))
  }

  // 去重后把没留下的 JPEG 删掉，省磁盘（留 sig.raw 没用，一并删）
  const keepSet = new Set(kept)
  for (const file of all) {
    if (keepSet.has(file)) continue
    try {
      fs.unlinkSync(file)
    } catch {
      /* 删不掉就算了 */
    }
  }
  try {
    fs.unlinkSync(sigPath)
  } catch {
    /* 同上 */
  }

  return { ok: true, frames: kept, skipped }
}
