/**
 * CDP 小客户端：起一个无头 Edge，用 Node 自带的 WebSocket 跟它说话。
 *
 * 从 scripts/shot.mjs 里抽出来的——截图工具和 UI 冒烟本来各写一套，
 * 抽出来之后两边共用同一份「起浏览器 / 执行 JS / 收集页面报错」的逻辑。
 *
 * 为什么不用 --screenshot + --virtual-time-budget：
 *   实测这个 Edge 版本下，虚拟时间预算会在 fetch 落地之前就烧完，
 *   页面永远停在骨架屏，截出来是空壳。所以这里起真浏览器走 CDP：
 *   能等元素出现、能执行 JS、能截整页、能收集页面里的报错。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const BROWSER_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Microsoft\\Edge\\Application\\msedge.exe') : '',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/usr/bin/google-chrome',
]

/** 找一个能用的浏览器，找不到返回空串 */
export function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  return ''
}

/* ---------------- CDP 客户端 ---------------- */

export class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    /** 页面里冒出来的报错（未捕获异常 + console.error），按顺序攒着 */
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

async function waitTarget(port, tries = 100, interval = 120, aborted = () => null) {
  for (let i = 0; i < tries; i++) {
    const abort = aborted()
    if (abort) throw abort
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())
      const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (target) return target
    } catch {
      /* 端口还没起来，接着等 */
    }
    await sleep(interval)
  }
  return null
}

/**
 * 起浏览器、连上第一个页面、开好 Page/Runtime 域。
 * 返回 { cdp, close }；close() 会关浏览器并删掉临时 profile。
 */
export async function launchBrowser({ port = 9333, width = 1280, height = 900, profileDir = '', browserPath = '' } = {}) {
  const exe = browserPath || findBrowser()
  if (!exe) throw new Error('没找到 Edge / Chrome，装了再跑（或者用 --browser 指定路径）')
  const profile = profileDir || path.join(os.tmpdir(), `daigan-edge-${port}`)
  fs.rmSync(profile, { recursive: true, force: true })

  const child = spawn(
    exe,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-crashpad',
      '--no-first-run',
      '--disable-extensions',
      '--hide-scrollbars',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      `--window-size=${width},${height}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: false }
  )

  let cdp = null
  // 子进程起不来（路径不对、没权限）时，spawn 会异步抛 'error'。
  // 不接住的话整个脚本会带着堆栈崩掉，调用方的 finally 也跑不到（数据目录就漏下了）。
  let spawnError = null
  child.once('error', (err) => {
    spawnError = err
  })

  const close = async () => {
    try {
      if (cdp) await cdp.send('Browser.close')
    } catch {
      /* 已经关了 */
    }
    try {
      child.kill()
    } catch {
      /* 已经退了 */
    }
    await sleep(300)
    try {
      fs.rmSync(profile, { recursive: true, force: true })
    } catch {
      /* 删不掉就留着 */
    }
  }

  try {
    const target = await waitTarget(port, 100, 120, () => spawnError && new Error(`起不了浏览器「${exe}」：${spawnError.message}`))
    if (!target) throw new Error(`CDP 起不来（端口 ${port}）`)
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', () => reject(new Error('WebSocket 连不上 CDP')))
    })
    cdp = new CDP(ws)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    return { cdp, close }
  } catch (err) {
    await close()
    throw err
  }
}

/** 轮询一段返回布尔的 JS，直到为真或超时；返回是否等到 */
export async function waitFor(cdp, expression, { tries = 60, interval = 200 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      if (await cdp.eval(expression)) return true
    } catch {
      /* 页面正在导航，下一轮再看 */
    }
    await sleep(interval)
  }
  return false
}
