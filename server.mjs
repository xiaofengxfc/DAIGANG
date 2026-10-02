import http from 'node:http'
import { PORT, HOST, PUBLIC_DIR, UPLOAD_DIR, DATA_DIR, SESSION_COOKIE, lanAddresses, LOCAL_ONLY } from './src/config.mjs'
import { migrate, db, getSetting } from './src/db.mjs'
import {
  match,
  sendJSON,
  sendText,
  parseCookies,
  sessionCookie,
  clearCookie,
  readJSON,
  resolveSafe,
  serveFile,
  securityHeaders,
} from './src/http.mjs'
import { HttpError, notFound } from './src/util.mjs'
import { readSession, purgeExpiredSessions, isSetUp } from './src/auth.mjs'
import { lock, status as vaultStatus } from './src/vault.mjs'
import { registerAll } from './src/routes/index.mjs'

migrate()
registerAll()

/** 不需要登录就能访问的接口 */
const PUBLIC_PATHS = new Set(['/api/auth/me', '/api/auth/login', '/api/setup'])

const server = http.createServer(async (req, res) => {
  const started = Date.now()
  const ip = clientIP(req)
  const ua = req.headers['user-agent'] || ''

  for (const [k, v] of Object.entries(securityHeaders())) res.setHeader(k, v)

  let url
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  } catch {
    sendText(res, 400, '请求地址不合法')
    return
  }
  const pathname = decodeURIComponent(url.pathname)

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  /* ---------- 接口 ---------- */
  if (pathname.startsWith('/api/')) {
    const hit = match(req.method, pathname)
    if (!hit) {
      sendJSON(res, 404, { error: '接口不存在', code: 'no_route' })
      return
    }
    const cookies = parseCookies(req)
    const token = cookies[SESSION_COOKIE]
    const session = readSession(token)

    if (!session && !PUBLIC_PATHS.has(pathname)) {
      sendJSON(res, 401, { error: '请先登录', code: 'unauthorized' })
      return
    }

    const ctx = {
      req,
      res,
      params: hit.params,
      query: Object.fromEntries(url.searchParams.entries()),
      body: {},
      session,
      token,
      ip,
      ua,
      setSessionCookie: (t, expiresAt) => res.setHeader('Set-Cookie', sessionCookie(t, expiresAt)),
      clearSessionCookie: () => res.setHeader('Set-Cookie', clearCookie()),
    }

    try {
      if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        ctx.body = await readJSON(req, hit.maxBytes ? { maxBytes: hit.maxBytes } : undefined)
      }
      const result = await hit.handler(ctx)
      if (!res.writableEnded) sendJSON(res, 200, result === undefined ? { ok: true } : result)
    } catch (err) {
      if (err instanceof HttpError) {
        sendJSON(res, err.status, { error: err.message, code: err.code })
      } else {
        console.error(`[${req.method} ${pathname}]`, err)
        sendJSON(res, 500, { error: '服务器出错了，请查看启动窗口的日志', code: 'internal' })
      }
    }
    log(req, res, pathname, started)
    return
  }

  /* ---------- 上传的图片 ---------- */
  if (pathname.startsWith('/uploads/')) {
    const file = resolveSafe(UPLOAD_DIR, pathname.slice('/uploads'.length))
    if (file && serveFile(req, res, file, { cache: true })) return
    sendText(res, 404, '图片不存在')
    return
  }

  /* ---------- 前端静态文件 ---------- */
  if (req.method === 'GET' || req.method === 'HEAD') {
    const rel = pathname === '/' ? 'index.html' : pathname
    const file = resolveSafe(PUBLIC_DIR, rel)
    if (file && serveFile(req, res, file)) return
    // 前端是单页应用，未知路径回落到 index.html
    const index = resolveSafe(PUBLIC_DIR, 'index.html')
    if (index && serveFile(req, res, index)) return
  }

  sendText(res, 404, '页面不存在')
})

function clientIP(req) {
  const fwd = req.headers['x-forwarded-for']
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
}

const QUIET = new Set(['/api/dashboard', '/api/auth/me', '/api/vault/status'])
function log(req, res, pathname, started) {
  if (QUIET.has(pathname)) return
  const ms = Date.now() - started
  const status = res.statusCode
  const tone = status >= 500 ? '!!' : status >= 400 ? ' !' : '  '
  console.log(`${tone} ${String(status).padEnd(3)} ${req.method.padEnd(6)} ${pathname} ${ms}ms`)
}

/* ---------------- 启动 ---------------- */

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在关闭…`)
  server.close(() => {
    try {
      db.close()
    } catch {}
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 2000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('unhandledRejection', (err) => console.error('未处理的异步错误：', err))

const timer = setInterval(purgeExpiredSessions, 60 * 60 * 1000)
timer.unref()

server.listen(PORT, HOST, () => {
  purgeExpiredSessions()
  const lines = []
  lines.push('')
  lines.push('  ┌───────────────────────────────────────────────┐')
  lines.push('  │   代肝价格查询 · 私用运营台                    │')
  lines.push('  └───────────────────────────────────────────────┘')
  lines.push('')
  lines.push(`  本机打开：   http://127.0.0.1:${PORT}`)
  if (!LOCAL_ONLY) {
    const ips = lanAddresses()
    if (ips.length) {
      lines.push('  手机打开：   ' + `http://${ips[0]}:${PORT}`)
      for (const extra of ips.slice(1)) lines.push(`               http://${extra}:${PORT}`)
      lines.push('               （手机要和这台电脑连同一个 WiFi）')
    } else {
      lines.push('  手机打开：   没检测到局域网地址，检查一下网络连接')
    }
  }
  lines.push('')
  const name = getSetting('business_name', '')
  if (!isSetUp()) {
    lines.push('  首次使用：   打开上面的网址，按提示设置登录密码')
  } else {
    lines.push(`  当前店铺：   ${name || '（未命名）'}`)
  }
  lines.push(`  数据位置：   ${DATA_DIR}`)
  lines.push(`  保险箱状态： ${vaultStatus().configured ? (vaultStatus().unlocked ? '已解锁' : '已锁定') : '未设置'}`)
  lines.push('')
  lines.push('  保持这个窗口开着；关掉窗口 = 关闭后台。按 Ctrl+C 退出。')
  lines.push('')
  console.log(lines.join('\n'))
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 被占用了。换一个端口再启动：\n     node server.mjs --port 8888\n`)
  } else {
    console.error('\n  启动失败：', err.message, '\n')
  }
  process.exit(1)
})
