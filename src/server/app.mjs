import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
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
import { stopVisionSidecar, ensureVisionStarted } from '../vision-python.mjs'
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
  /**
   * Python 视觉后端：后台起进程 + 预热（载模型 0.8s + 预热 ~5s）。
   * 现在付掉这笔钱，用户点「识别画面」的第一帧就是热的。
   *
   * 为什么要 setTimeout 推到下一个 tick：这个函数在 listen() 之前跑，
   * 而探测依赖是 spawnSync（导入 onnxruntime + cv2 要一秒上下）——
   * 同步跑会把「服务器开始监听」拖后一秒。推到下一个 tick 就没这问题。
   * 没装 Python / 没装依赖时它会直接返回，识别走旧引擎链，不耽误事。
   */
  const visionTimer = setTimeout(() => {
    void ensureVisionStarted().catch(() => {})
  }, 0)
  visionTimer.unref?.()
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

/**
 * 请求看起来像不像一个「静态资源」——有扩展名的那种（/dist/app.js、/favicon.svg）。
 *
 * 为什么要区分：前端是单页应用，/orders/12 这种路由在磁盘上没有对应文件，
 * 只能回 index.html 让前端路由接手。但 /dist/app.js 回 index.html 是灾难——
 * 浏览器拿到 Content-Type: text/html 的 <script type="module">，直接拒绝执行，
 * 页面就是一片白。资源缺了就该 404，别拿 HTML 糊上去。
 */
function looksLikeAsset(pathname) {
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1)
  const dot = lastSegment.lastIndexOf('.')
  if (dot <= 0) return false
  const ext = lastSegment.slice(dot + 1)
  return ext.length <= 5 && /^[A-Za-z0-9]+$/.test(ext)
}

/**
 * 前端产物缺失时的说明页。
 *
 * 后台起得来、接口全通，只有网页是白的——这种故障用户没法自己定位。
 * 所以宁可不发那个空壳 index.html，也要把「缺什么、敲什么命令」直接印在页面上。
 */
function sendBuildNotice(res, missing) {
  const body = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>前端还没构建 · 代肝价格查询</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #eef1f7; color: #1b2230;
         font: 15px/1.7 "Microsoft YaHei UI", system-ui, sans-serif; }
  main { max-width: 40rem; padding: 2.5rem 2.75rem; background: #fff;
         border: 1px solid #dfe4ee; border-radius: 14px; box-shadow: 0 10px 30px rgba(27,34,48,.07); }
  h1 { margin: 0 0 .75rem; font-size: 1.3rem; }
  p { margin: .6rem 0; }
  code, pre { font-family: ui-monospace, Consolas, monospace; }
  pre { background: #f5f7fb; border: 1px solid #e3e8f1; border-radius: 9px;
        padding: .85rem 1rem; margin: .5rem 0 0; overflow-x: auto; font-size: 13px; }
  .hint { color: #5b667a; font-size: 13.5px; }
</style>
</head>
<body>
<main>
  <h1>后台起来了，但前端还没构建</h1>
  <p><code>public/dist/</code> 里缺少 <strong>${missing.map((m) => `<code>${m}</code>`).join('、')}</strong>，
     所以网页没有可以执行的界面代码——打开就是一片白。</p>
  <p>在项目目录（就是 <code>server.mjs</code> 所在的那一层）跑一次：</p>
  <pre>npm run setup     # 第一次：装依赖 + 构建前端
npm run build     # 依赖已装好，只重新构建前端</pre>
  <p class="hint">构建完刷新这个页面即可。首次构建需要联网下载前端依赖。</p>
</main>
</body>
</html>
`
  res.writeHead(503, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * 请求落在构建产物目录（/dist/…）里吗？
 *
 * 只有这里需要「产物缺失」的把关：public/dist/ 整个是构建出来的，
 * 里面的东西缺了就是没构建（或者构建没跑完）。而 /favicon.svg、/resource-icons/*
 * 是手写的静态资源，永远该照常发——不能因为前端没构建就把它们也一起挡掉。
 */
function isBundlePath(pathname) {
  return pathname === '/dist' || pathname.startsWith('/dist/')
}

function handleStatic(req, res, pathname) {
  if (pathname.startsWith('/uploads/')) {
    const file = resolveSafe(UPLOAD_DIR, pathname.slice('/uploads'.length))
    if (file && serveFile(req, res, file, { cache: true })) return true
    sendText(res, 404, '图片不存在')
    return true
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return false

  // 前端产物缺失：给一页人话说明，不要发那个注定白屏的空壳。
  //
  // 三处入口都要拦：/dist/…（产物本体）、/（根）、/index.html（显式入口）。
  // 不拦别的：/favicon.svg、/resource-icons/* 是手写的静态资源，照常发；
  // 深链接（/orders/12）走下面的 SPA 兜底，行为不变。
  //
  // 拦 /dist/ 必须排在「直接找文件」前面：vite build 也会往 public/dist/ 里
  // 写一份 index.html，它引用的 app.js 同样在 public/dist/ 里；产物缺了的话，
  // 按路径把 index.html 找出来发出去，用户拿到的还是白屏——正是要修的症状。
  const bundle = bundleHealth()
  if (bundle && (isBundlePath(pathname) || pathname === '/' || pathname === '/index.html')) {
    sendBuildNotice(res, bundle.missing)
    return true
  }

  const rel = pathname === '/' ? 'index.html' : pathname
  const file = resolveSafe(PUBLIC_DIR, rel)
  if (file && serveFile(req, res, file)) return true
  // 资源文件不存在：老实回 404。回 index.html 会让浏览器报 MIME 错，页面白屏。
  if (looksLikeAsset(pathname)) {
    sendText(res, 404, '资源不存在')
    return true
  }
  const index = resolveSafe(PUBLIC_DIR, 'index.html')
  if (index && serveFile(req, res, index)) return true
  return false
}

/**
 * 前端产物体检。public/dist/ 是构建产物、不进版本库（见 .gitignore），
 * 所以「刚克隆下来还没 build」是个很常见又很难自己看出来的状态：
 * 后台能起来、接口都通，但网页一片白。白屏从来不会自己说明原因，
 * 这里就在启动横幅里直接点破，并给出该敲的命令。
 */
function bundleHealth() {
  const dist = path.join(PUBLIC_DIR, 'dist')
  // app.js 是界面本体，app.css 缺了会变成没样式的裸页面，两个都要在。
  const missing = ['app.js', 'app.css'].filter((name) => !fs.existsSync(path.join(dist, name)))
  return missing.length ? { missing } : null
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
  const bundle = bundleHealth()
  if (bundle) {
    lines.push('')
    lines.push(`  ⚠ 前端还没构建：public/dist/ 里没有 ${bundle.missing.join('、')}。`)
    lines.push('    现在打开网页会是一片白屏。在这个目录下先跑一次：')
    lines.push('      npm run setup      （首次：装依赖 + 构建前端）')
    lines.push('      npm run build      （依赖已装好，只重新构建前端）')
  }
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
    // Python 视觉进程是我们自己起的子进程，退出时要一起收掉
    // （不然它会一直挂在后台占着 5410 端口和 200MB 内存）
    stopVisionSidecar()
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
