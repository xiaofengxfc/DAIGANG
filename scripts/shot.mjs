/**
 * 无头浏览器截图（CDP 驱动，零依赖）
 *
 * 为什么不用 --screenshot + --virtual-time-budget：
 *   实测这个 Edge 版本下，虚拟时间预算会在 fetch 落地之前就烧完，
 *   页面永远停在骨架屏 / 「正在加载」，截出来的是空壳。
 * 所以这里用 --remote-debugging-port 起一个真浏览器，
 * 用 Node 自带的 WebSocket 走 CDP：能等元素出现、能执行 JS、能截整页。
 *
 * 用法：
 *   node scripts/shot.mjs --url http://127.0.0.1:8802 --password xxx \
 *        --route /price --out shots/price.png
 * 常用参数：
 *   --route /price        登录后要看的 hash 路由（默认 /）
 *   --width 1280          视口宽（默认 1280）
 *   --height 900          视口高（默认 900）
 *   --full                截整页（默认只截视口）
 *   --scale 1             输出缩放（0.5 = 缩小省 token，2 = 放大看细节）
 *   --wait ".pricelist"   等这个选择器出现再截
 *   --eval "js"           截图前执行一段 JS（可 await），结果打印出来
 *   --theme light|dark    先切主题（写 localStorage）
 *   --port 9333           CDP 端口
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const n = argv[i + 1]
      if (n === undefined || n.startsWith('--')) out[k] = true
      else {
        out[k] = n
        i++
      }
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const BASE = (args.url || 'http://127.0.0.1:8802').replace(/\/+$/, '')
const ROUTE = args.route || '/'
const WIDTH = Number(args.width || 1280)
const HEIGHT = Number(args.height || 900)
const SCALE = Number(args.scale || 1)
const PORT = Number(args.port || 9333)
const OUT = args.out || 'shots/shot.png'
const WAIT = args.wait || ''
const THEME = args.theme || ''
const FULL = Boolean(args.full)
const PASSWORD = args.password || ''
// --clip x,y,w,h  只截这一块（配合 --scale 2 看细节，省 token）
const CLIP = args.clip ? String(args.clip).split(',').map(Number) : null

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- CDP 小客户端 ---------------- */

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.errors = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails
        this.errors.push(d?.exception?.description || d?.text || 'unknown')
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        this.errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('CDP 超时: ' + method))
        }
      }, 30000)
    })
  }

  /** 在页面里跑一段 JS，返回它的值（支持 await） */
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })
    if (r.exceptionDetails) {
      throw new Error('页面里报错: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r.result?.value
  }
}

/* ---------------- 起浏览器 ---------------- */

const profile = path.resolve('.edge-cdp-' + PORT)
fs.rmSync(profile, { recursive: true, force: true })
fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true })

const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-crashpad',
    '--no-first-run',
    '--disable-extensions',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false }
)

let cdp = null
const cleanup = async () => {
  try {
    if (cdp) await cdp.send('Browser.close')
  } catch {}
  try {
    child.kill()
  } catch {}
  await sleep(300)
  try {
    fs.rmSync(profile, { recursive: true, force: true })
  } catch {}
}

let code = 0
try {
  /* 等 CDP 端口起来 */
  let target = null
  for (let i = 0; i < 100; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target) break
    } catch {}
    await sleep(120)
  }
  if (!target) throw new Error('CDP 起不来（端口 ' + PORT + '）')

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error('WebSocket 连不上 CDP')))
  })
  cdp = new CDP(ws)

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false,
  })

  /* 先落在站点根上，才能设 localStorage / 打登录接口 */
  await cdp.send('Page.navigate', { url: BASE + '/' })
  await sleep(700)

  if (THEME) {
    // 主题键名不写死：找 localStorage 里带 theme 的那个
    await cdp.eval(`(() => {
      // 新 profile 里还没有主题键，所以要主动写一个（顺带把带 theme 的键一起改成一致）
      localStorage.setItem('xfc.theme', ${JSON.stringify(THEME)})
      const keys = Object.keys(localStorage).filter((k) => /theme/i.test(k))
      for (const k of keys) localStorage.setItem(k, ${JSON.stringify(THEME)})
      return keys
    })()`)
  }

  if (PASSWORD) {
    const status = await cdp.eval(
      `fetch('/api/auth/login', {
         method: 'POST',
         headers: { 'content-type': 'application/json' },
         body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)} })
       }).then((r) => r.status)`
    )
    if (status !== 200) throw new Error('登录失败，HTTP ' + status)
    log('  登录 OK')
  }

  /* 走 hash 路由。整页刷新一次，保证视图是干净渲染的 */
  await cdp.send('Page.navigate', { url: `${BASE}/#${ROUTE}` })
  await sleep(500)
  await cdp.send('Page.reload', { ignoreCache: false })
  await sleep(1200)

  /* 等目标元素 */
  const sel = WAIT || '.pagehead, .pricelist, .panel, .boot'
  let found = false
  for (let i = 0; i < 60; i++) {
    found = await cdp.eval(`Boolean(document.querySelector(${JSON.stringify(sel)}))`)
    if (found) break
    await sleep(200)
  }
  if (!found) log('  ⚠ 没等到 ' + sel)
  await sleep(500)

  // --eval-file 优先：PowerShell 会把命令行里带分号/花括号的 JS 截断，
  // 复杂一点的脚本一律写文件，别跟引号较劲。
  const evalSrc = args['eval-file'] ? fs.readFileSync(String(args['eval-file']), 'utf8') : args.eval ? String(args.eval) : ''
  if (evalSrc) {
    const v = await cdp.eval(evalSrc)
    log('  eval → ' + JSON.stringify(v))
    await sleep(500)
  }

  // 滚到指定位置再截：用来验吸顶这类跟滚动有关的效果。
  // 注意 clip 用的是「文档坐标」，不是视口坐标 —— 滚了之后默认裁剪窗口
  // 也要跟着下移，否则截到的还是文档开头（一片空白）。
  const scrollY = args.scroll ? Number(args.scroll) || 0 : 0
  if (scrollY) {
    await cdp.eval(`window.scrollTo(0, ${scrollY})`)
    await sleep(450)
  }

  /* 量一下页面有多高 */
  const info = await cdp.eval(`(() => ({
    w: document.documentElement.scrollWidth,
    h: document.documentElement.scrollHeight,
    vh: window.innerHeight,
    title: document.title,
    hash: location.hash,
    text: document.body.innerText.slice(0, 200)
  }))()`)
  log('  页面: ' + info.w + '×' + info.h + '  视口高 ' + info.vh + '  hash=' + info.hash)
  if (!info.text.trim()) log('  ⚠ 页面是空的')

  const clipH = FULL ? info.h : Math.min(HEIGHT, info.h)
  const region =
    CLIP && CLIP.length === 4 && CLIP.every((n) => Number.isFinite(n))
      ? { x: CLIP[0], y: CLIP[1], width: CLIP[2], height: CLIP[3], scale: SCALE }
      : { x: 0, y: scrollY, width: Math.min(WIDTH, info.w), height: clipH, scale: SCALE }
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: FULL || Boolean(CLIP),
    clip: region,
  })
  fs.writeFileSync(path.resolve(OUT), Buffer.from(shot.data, 'base64'))
  const bytes = fs.statSync(path.resolve(OUT)).size
  log(
    `  截图 → ${OUT}  ${Math.round(region.width * SCALE)}×${Math.round(region.height * SCALE)}  ${bytes} 字节`
  )

  if (cdp.errors.length) {
    log('  ⚠ 页面里有 ' + cdp.errors.length + ' 条报错：')
    for (const e of cdp.errors.slice(0, 5)) log('     ' + String(e).split('\n')[0].slice(0, 160))
  }
} catch (err) {
  console.error('截图失败：' + (err.message || err))
  code = 1
} finally {
  await cleanup()
}
process.exit(code)
