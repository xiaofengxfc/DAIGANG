import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PUBLIC_DIR, SESSION_COOKIE, MAX_JSON_BYTES } from '../core/config.mjs'
import { HttpError, fail } from '../core/util.mjs'

/* ---------------- 路由表 ---------------- */

const routes = []

/** 同一方法 + 同一路径后注册的覆盖先注册的，方便专用处理器盖掉通用 CRUD */
export function route(method, pattern, handler, { raw = false, maxBytes = 0 } = {}) {
  const m = method.toUpperCase()
  const norm = pattern.replace(/\/+$/, '') || '/'
  const keys = []
  const body = norm
    .split('/')
    .map((seg) => {
      const hit = /^:([A-Za-z_][A-Za-z0-9_]*)$/.exec(seg)
      if (hit) {
        keys.push(hit[1])
        return '([^/]+)'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  const entry = { method: m, pattern: norm, rx: new RegExp(`^${body}/?$`), keys, handler, maxBytes, raw }
  const at = routes.findIndex((r) => r.method === m && r.pattern === norm)
  if (at >= 0) routes[at] = entry
  else routes.push(entry)
}

/**
 * 给某个路由单独放宽请求体上限（0 表示用默认的 MAX_JSON_BYTES）。
 * 目前只有截图识别那几个接口需要：一张 2K 游戏截图 PNG 转 base64 就到 4MB 以上，
 * 拿默认上限去卡它，用户就得先压图才能用。
 */
export function setBodyLimit(pattern, maxBytes) {
  const norm = pattern.replace(/\/+$/, '') || '/'
  const hit = routes.find((r) => r.pattern === norm)
  if (hit) hit.maxBytes = maxBytes
  return hit
}

export const get = (p, h) => route('GET', p, h)
export const post = (p, h) => route('POST', p, h)
export const postRaw = (p, h, options = {}) => route('POST', p, h, { ...options, raw: true })
export const patch = (p, h) => route('PATCH', p, h)
export const put = (p, h) => route('PUT', p, h)
export const del = (p, h) => route('DELETE', p, h)

export function match(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue
    const m = r.rx.exec(pathname)
    if (!m) continue
    const params = {}
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1])
    })
    return { handler: r.handler, params, maxBytes: r.maxBytes || 0, raw: Boolean(r.raw) }
  }
  return null
}

/* ---------------- 响应helpers ---------------- */

export function sendJSON(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload === undefined ? null : payload), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function sendText(res, status, text) {
  const body = Buffer.from(String(text), 'utf8')
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length })
  res.end(body)
}

export function parseCookies(req) {
  const out = {}
  const raw = req.headers.cookie
  if (!raw) return out
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    const k = part.slice(0, idx).trim()
    const v = part.slice(idx + 1).trim()
    if (k) out[k] = decodeURIComponent(v)
  }
  return out
}

export function sessionCookie(token, expiresAt) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (expiresAt) attrs.push(`Expires=${new Date(expiresAt).toUTCString()}`)
  return attrs.join('; ')
}

export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

/* ---------------- 请求体 ---------------- */

export async function readJSON(req, { maxBytes = MAX_JSON_BYTES } = {}) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) fail(413, '提交内容过大', 'payload_too_large')
    chunks.push(chunk)
  }
  if (!size) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    fail(400, '提交内容不是合法 JSON', 'bad_json')
  }
}

/** 读取二进制请求体，供视频/图片素材上传使用。 */
export async function readRawBody(req, { maxBytes = MAX_JSON_BYTES } = {}) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) fail(413, '上传文件过大', 'upload_too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * 读取 multipart 太麻烦，图片走 base64 data URL 提交，这里落盘。
 * maxBytes 可以放宽：截图识别收的是整张游戏截图（2K 就有 3MB），
 * 而上传头像/游戏图标那种小图还是按 1.5MB 卡。
 */
export function saveDataURL(dataURL, prefix = 'img', { maxBytes = 1.5 * 1024 * 1024 } = {}) {
  const m = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataURL || ''))
  if (!m) fail(400, '只支持 PNG / JPEG / WebP / GIF / SVG 图片', 'bad_image')
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1] === 'svg+xml' ? 'svg' : m[1]
  const buf = Buffer.from(m[2], 'base64')
  if (buf.length > maxBytes) fail(413, `图片请压到 ${Math.round(maxBytes / 1024 / 1024)}MB 以内`, 'image_too_large')
  const name = `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.${ext}`
  return { name, buf }
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.ogv': 'video/ogg',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv; charset=utf-8',
}

export function resolveSafe(baseDir, relPath) {
  const clean = decodeURIComponent(relPath).replace(/^\/+/, '')
  const full = path.resolve(baseDir, clean)
  const base = path.resolve(baseDir)
  if (full !== base && !full.startsWith(base + path.sep)) return null
  return full
}

export function serveFile(req, res, filePath, { cache = true } = {}) {
  let stat
  try {
    stat = fs.statSync(filePath)
  } catch {
    return false
  }
  if (!stat.isFile()) return false

  const ext = path.extname(filePath).toLowerCase()
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`
  if (cache && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag })
    res.end()
    return true
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': cache ? 'no-cache' : 'no-store',
  })
  fs.createReadStream(filePath).pipe(res)
  return true
}

export function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  }
}

export { HttpError }
