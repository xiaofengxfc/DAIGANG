import http from 'node:http'
import {
  PORT,
  HOST,
  PUBLIC_DIR,
  UPLOAD_DIR,
  DATA_DIR,
  SESSION_COOKIE,
  lanAddresses,
  LOCAL_ONLY,
} from '../config.mjs'
import { migrate, db, getSetting } from '../db.mjs'
import {
  match,
  sendJSON,
  sendText,
  parseCookies,
  sessionCookie,
  clearCookie,
  readJSON,
  readRawBody,
  resolveSafe,
  serveFile,
  securityHeaders,
} from '../http.mjs'
import { HttpError } from '../util.mjs'
import { readSession, purgeExpiredSessions, isSetUp } from '../auth.mjs'
import { lock, status as vaultStatus } from '../vault.mjs'
import { registerAll } from '../routes/index.mjs'
import { stopMediaExecutor } from '../media-deps.mjs'
import { dispatchDueScheduledTasks } from '../routes/media.mjs'
import { ensureEnginesProbed } from '../ocr.mjs'
import { MEDIA_SCHEDULER_INTERVAL_MS } from '../config.mjs'

const PUBLIC_PATHS = new Set(['/api/auth/me', '/api/auth/login', '/api/setup', '/api/health'])
const QUIET_PATHS = new Set(['/api/dashboard', '/api/auth/me', '/api/vault/status', '/api/health'])
let initialized = false

function initialize() {
  if (initialized) return
  migrate()
  registerAll()
  initialized = true
  // 顺手探一次引擎（不阻塞启动）。Umi-OCR 分最高，但「在不在」只有真发过请求
  // 才知道；不先探一次的话，冷启动后它一律显示「未安装」，识别也轮不到它。
  void ensureEnginesProbed().catch(() => {})
}

function clientIP(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim()
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '')
}

function logRequest(req, res, pathname, started) {
  if (QUIET_PATHS.has(pathname)) return
  const ms = Date.now() - started
  const status = res.statusCode
  const tone = status >= 500 ? '!!' : status >= 400 ? ' !' : '  '
  console.log(`${tone} ${String(status).padEnd(3)} ${req.method.padEnd(6)} ${pathname} ${ms}ms`)
}

function writeError(res, err, req, pathname) {
  if (res.writableEnded) return
  if (err instanceof HttpError) {
    sendJSON(res, err.status, { error: err.message, code: err.code })
    return
  }
  console.error(`[${req.method} ${pathname}]`, err)
  sendJSON(res, 500, { error: '服务器出错了，请查看启动窗口的日志', code: 'internal' })
}

async function handleAPI(req, res, url, pathname) {
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
    ip: clientIP(req),
    ua: req.headers['user-agent'] || '',
    setSessionCookie: (value, expiresAt) => res.setHeader('Set-Cookie', sessionCookie(value, expiresAt)),
    clearSessionCookie: () => res.setHeader('Set-Cookie', clearCookie()),
  }

  try {
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
      if (hit.raw) ctx.rawBody = await readRawBody(req, { maxBytes: hit.maxBytes })
      else ctx.body = await readJSON(req, hit.maxBytes ? { maxBytes: hit.maxBytes } : undefined)
    }
    const result = await hit.handler(ctx)
    if (!res.writableEnded) sendJSON(res, 200, result === undefined ? { ok: true } : result)
  } catch (err) {
    writeError(res, err, req, pathname)
  }
}

function handleStatic(req, res, pathname) {
  if (pathname.startsWith('/uploads/')) {
    const file = resolveSafe(UPLOAD_DIR, pathname.slice('/uploads'.length))
    if (file && serveFile(req, res, file, { cache: true })) return true
    sendText(res, 404, '图片不存在')
    return true
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  const rel = pathname === '/' ? 'index.html' : pathname
  const file = resolveSafe(PUBLIC_DIR, rel)
  if (file && serveFile(req, res, file)) return true
  const index = resolveSafe(PUBLIC_DIR, 'index.html')
  if (index && serveFile(req, res, index)) return true
  return false
}

function banner() {
  const lines = [
    '',
    '  ┌───────────────────────────────────────────────┐',
    '  │   代肝价格查询 · 私用运营台                    │',
    '  └───────────────────────────────────────────────┘',
    '',
    `  本机打开：   http://127.0.0.1:${PORT}`,
  ]
  if (!LOCAL_ONLY) {
    const ips = lanAddresses()
    if (ips.length) {
      lines.push(`  手机打开：   http://${ips[0]}:${PORT}`)
      for (const extra of ips.slice(1)) lines.push(`               http://${extra}:${PORT}`)
      lines.push('               （手机要和这台电脑连同一个 WiFi）')
    } else lines.push('  手机打开：   没检测到局域网地址，检查一下网络连接')
  }
  lines.push('', `  数据位置：    ${DATA_DIR}`)
  lines.push(`  当前店铺：    ${getSetting('business_name', '（未命名）')}`)
  const vault = vaultStatus()
  lines.push(`  保险箱状态：  ${vault.configured ? (vault.unlocked ? '已解锁' : '已锁定') : '未设置'}`)
  if (!isSetUp()) lines.push('  首次使用：    打开上面的网址，按提示设置登录密码')
  lines.push('', '  保持这个窗口开着；关掉窗口 = 关闭后台。按 Ctrl+C 退出。', '')
  return lines.join('\n')
}

export function createApplication() {
  initialize()
  const server = http.createServer(async (req, res) => {
    const started = Date.now()
    for (const [key, value] of Object.entries(securityHeaders())) res.setHeader(key, value)

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

    if (pathname === '/api/health' && req.method === 'GET') {
      sendJSON(res, 200, { ok: true, service: 'daigan-ops-console', time: new Date().toISOString() })
      return
    }

    if (pathname.startsWith('/api/')) {
      await handleAPI(req, res, url, pathname)
      logRequest(req, res, pathname, started)
      return
    }

    if (!handleStatic(req, res, pathname)) sendText(res, 404, '页面不存在')
  })

  const timer = setInterval(purgeExpiredSessions, 60 * 60 * 1000)
  timer.unref()

  // 定时发布调度：到点自动把 scheduled 任务派发给执行器。调度器自身不会阻塞/堆积。
  let schedulerRunning = false
  const scheduler = MEDIA_SCHEDULER_INTERVAL_MS > 0
    ? setInterval(async () => {
        if (schedulerRunning) return
        schedulerRunning = true
        try {
          const r = await dispatchDueScheduledTasks()
          if (r.due > 0) console.log(`[media-scheduler] 已到期任务 ${r.due} 个，成功派发 ${r.dispatched} 个`)
        } catch (err) {
          console.error('[media-scheduler] 调度出错：', err?.message || err)
        } finally {
          schedulerRunning = false
        }
      }, MEDIA_SCHEDULER_INTERVAL_MS)
    : null
  if (scheduler) scheduler.unref()

  function shutdown(signal = 'SIGTERM') {
    console.log(`\n收到 ${signal}，正在关闭…`)
    clearInterval(timer)
    if (scheduler) clearInterval(scheduler)
    stopMediaExecutor()
    lock('shutdown')
    server.close(() => {
      try {
        db.close()
      } catch {}
    })
    setTimeout(() => process.exit(0), 2000).unref()
  }

  return { server, shutdown, banner }
}

export function startApplication() {
  const app = createApplication()
  process.once('SIGINT', () => app.shutdown('SIGINT'))
  process.once('SIGTERM', () => app.shutdown('SIGTERM'))
  process.on('unhandledRejection', (err) => console.error('未处理的异步错误：', err))
  app.server.listen(PORT, HOST, () => {
    purgeExpiredSessions()
    console.log(app.banner())
  })
  app.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  端口 ${PORT} 被占用了。换一个端口再启动：\n     node server.mjs --port 8888\n`)
    } else console.error('\n  启动失败：', err.message, '\n')
    process.exitCode = 1
  })
  return app
}
