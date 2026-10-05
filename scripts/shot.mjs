/**
 * 无头浏览器截图（CDP 驱动，零依赖）
 *
 * 起浏览器、执行 JS、收页面报错这套逻辑在 scripts/lib/cdp.mjs 里，
 * 跟 UI 冒烟（scripts/ui-smoke.mjs）共用。
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
import { launchBrowser, sleep } from './lib/cdp.mjs'

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

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true })

let code = 0
let browser = null
try {
  browser = await launchBrowser({ port: PORT, width: WIDTH, height: HEIGHT, browserPath: args.browser || '' })
  const { cdp } = browser

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
  const sel = WAIT || '.pagehead, .pricelist, .panel, .refactor-gate, .react-shell, .boot'
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
  if (browser) await browser.close()
}
process.exit(code)
