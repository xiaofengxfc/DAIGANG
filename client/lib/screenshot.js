/* ============================================================
   识别截图 → 压缩 → 上传，拿到一个能长期留存的 URL
   ============================================================

   为什么必须压：

   游戏截图是 2560×1440 这一档，一张原始 PNG 通常 1.5~3MB。识别一轮是
   「背包 + 地图」两个界面，也就是两条进度各存一张 —— 不压的话，
   记一次进度就多出 3~6MB，一年下来几 GB 全是全屏截图。

   用什么压：

   `browser-image-compression`（Donaldcwl/browser-image-compression，
   npm 上叫 browser-image-compression）。选它而不是自己拿 canvas 压：
     · 支持「压到指定体积以内」的迭代（maxSizeMB），不用自己二分调质量；
     · 处理 EXIF 方向、超大图自动降到浏览器 canvas 上限以内；
     · 图标库式的自研实现容易在「降到多少质量」上拍脑袋，压完还是很大。

   ⚠️ 为什么 useWebWorker 传 false：

   这个库的多线程模式默认要从 **CDN** 拉自己的脚本去起 Worker
   （libURL 默认指向 cdn.jsdelivr.net），而本项目的 CSP 是
   `script-src 'self'`（见 src/http.mjs 的 securityHeaders）——
   走 Worker 会被浏览器直接拦掉，压缩整个失败。

   两条路：改 CSP 放行 blob: 和 CDN，或者留在主线程。
   选了后者：本地单机、就压一两张 2K 图，主线程压一次几百毫秒，
   为它把安全策略放宽不划算。真嫌卡可以改成走 libURL 指本地
   （dist 里那份），那要额外配静态路由，暂时没这个必要。

   压完仍然走 /api/uploads（data URL 上传），和图标模板同一个接口，
   服务端不用为这件事多一条路径。
   ============================================================ */

import imageCompression from 'browser-image-compression'
import { api } from './api.js'

/** 目标：单张不超过 1MB。2K 截图压到 1MB 后文字仍然看得清（timeline 上就是给人看个大概） */
const MAX_MB = 1
/** 长边上限。再大对「看个大概」没有增益，只是白占地方 */
const MAX_SIDE = 1920

/** 后端 /api/uploads 的请求体上限是 12MB（MAX_OCR_IMAGE_BYTES）。压完一般 1MB 上下，
 *  留足余量；万一压不动（比如一张噪点极多的图）也要在发出去之前拦下来，给一句人话。 */
const HARD_LIMIT_BYTES = 8 * 1024 * 1024

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读不出这张截图'))
    reader.readAsDataURL(blob)
  })
}

/**
 * 把响应体读成 data URL。
 *
 * 不用 res.blob()：那张 2K PNG 直接转 base64 会在主线程上同步跑十几毫秒到
 * 上百毫秒（图越大越久），而这期间界面完全不动 —— 用户看到的就是「点了保存
 * 卡一下」。这里分块读、每块让出事件循环，让界面能喘气。
 */
async function responseToDataURL(res) {
  const type = res.headers.get('content-type') || 'image/png'
  const total = Number(res.headers.get('content-length') || 0)
  const reader = res.body.getReader()
  const parts = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    received += value.length
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  const buf = new Uint8Array(received)
  let at = 0
  for (const part of parts) {
    buf.set(part, at)
    at += part.length
  }
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK))
  }
  void total
  return `data:${type};base64,${btoa(binary)}`
}

/** data URL → Blob（交给压缩库之前要变成 Blob/File） */
function dataURLToBlob(dataUrl) {
  const comma = dataUrl.indexOf(',')
  const meta = dataUrl.slice(5, comma)
  const isBase64 = meta.endsWith(';base64')
  const type = meta.replace(';base64', '') || 'image/png'
  if (!isBase64) return new Blob([decodeURIComponent(dataUrl.slice(comma + 1))], { type })
  const binary = atob(dataUrl.slice(comma + 1))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type })
}

/**
 * 取一帧暂存的识别截图，压缩后上传，返回它的访问 URL。
 *
 * @param {string} token  /api/ocr/screen 返回的 frame_token
 * @returns {Promise<string|null>} 上传成功返回 /uploads/xxx，失败返回 null（不抛）
 */
export async function saveScreenshot(token) {
  if (!token) return null
  try {
    const res = await fetch(`/api/ocr/screen/frame?token=${encodeURIComponent(token)}`, { credentials: 'same-origin' })
    if (!res.ok) return null
    const raw = await responseToDataURL(res)
    const blob = dataURLToBlob(raw)

    let out = blob
    try {
      out = await imageCompression(new File([blob], 'screen.png', { type: blob.type || 'image/png' }), {
        maxSizeMB: MAX_MB,
        maxWidthOrHeight: MAX_SIDE,
        // 见文件头注释：CSP 是 script-src 'self'，Worker 默认要从 CDN 拉脚本，会被拦
        useWebWorker: false,
        // 不保留 EXIF：这是游戏截图，没有拍摄信息，留着只是白占体积
        preserveExif: false,
      })
    } catch {
      // 压不动就用原图（后面还有体积兜底），总比丢掉这张截图好
      out = blob
    }

    if (out.size > HARD_LIMIT_BYTES) return null

    const dataUrl = await blobToDataURL(out)
    const saved = await api.post('/api/uploads', { data_url: dataUrl, prefix: 'shot' })
    return saved && saved.url ? saved.url : null
  } catch {
    // 截图是「锦上添花」，任何一个环节失败都不该让用户记不下这条进度
    return null
  }
}

/**
 * 把一批帧凭据依次存下来，返回可以挂到 media 上的 URL 数组。
 * 逐张来（不并发）：压缩是 CPU 活，并发只会让界面更卡。
 */
export async function saveScreenshots(tokens) {
  const out = []
  for (const token of tokens || []) {
    const url = await saveScreenshot(token)
    if (url) out.push(url)
  }
  return out
}
