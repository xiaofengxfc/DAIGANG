/**
 * 桌面外壳：Electron 主进程
 *
 * 职责只有四件，别的都交给已有后端：
 *   1. 起停后端（用 Electron 自带的 Node 跑 server.mjs —— 用户机器不需要装 Node）
 *   2. 开窗口，把后端发回来的网页装进去
 *   3. 把「窗口该像桌面软件」的部分补齐：单实例、标题栏、外链、托盘、开机自启
 *   4. 后端起不来时说清楚为什么，而不是给一个白屏
 *
 * 为什么用 fork 而不是在主进程里 import：后端做 OCR 时是 CPU 密集的，
 * 跑在 GUI 进程里会让整个界面卡住。独立进程 + ELECTRON_RUN_AS_NODE 拿到的
 * 就是 Electron 内置的 Node（24.x，node:sqlite 可用，已实测），
 * 安装包里也不用再带一份 Node。
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell, Tray } from 'electron'
import { fork } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP_ROOT = path.resolve(HERE, '..')
const IS_PACKAGED = app.isPackaged

/**
 * 资源根：源码运行时是项目根，打包后是 resources/app。
 *
 * 这一份目录里必须有 server.mjs、src/、shared/、public/、scripts/、integrations/。
 * 打包时关掉了 asar —— 后端要 spawn PowerShell 脚本、要读 Python 源码、
 * 还要在 venv 里找解释器，这些路径在 asar 虚拟文件系统里都打不开。
 */
const RES_ROOT = APP_ROOT

/** 数据目录：便携版的 data/ 跟着 exe 走，安装版放用户目录 */
function resolveDataDir() {
  if (process.env.XFC_DATA_DIR) return path.resolve(process.env.XFC_DATA_DIR)
  // electron-builder 的 portable 目标会把程序解压到 %TEMP% 再跑，
  // 所以「exe 所在的目录」不能从 process.execPath 推导，要用它给的环境变量。
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  if (portableDir) return path.join(portableDir, 'data')
  if (!IS_PACKAGED) return path.join(RES_ROOT, 'data')
  return path.join(app.getPath('userData'), 'data')
}

const DATA_DIR = resolveDataDir()
const STATE_DIR = path.join(DATA_DIR, 'desktop')
const LOG_FILE = path.join(STATE_DIR, 'desktop.log')

/* ---------------- 日志：写文件 + 转发到终端（开发时看得见） ---------------- */

function ensureStateDir() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
  } catch {
    /* 目录建不出来就让下面的写日志静默失败，别把它变成启动阻塞 */
  }
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
  console.log(line)
  try {
    ensureStateDir()
    fs.appendFileSync(LOG_FILE, line + os.EOL)
  } catch {
    /* 日志写不进去不影响运行 */
  }
}

/* ---------------- 端口 ---------------- */

/** 端口空着吗。绑一下再放开，比 connect 更能反映「别人正占着」 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/**
 * 挑一个能用的端口。
 *
 * 固定 8787 在桌面场景里不够用：用户可能同时还开着一个 `npm start` 的实例，
 * 或者上次的进程没退干净。这时候硬绑会失败，而失败之后界面就什么都没有。
 * 从首选端口往后找 20 个，找到就用。
 */
async function pickPort(preferred) {
  for (let i = 0; i < 20; i++) {
    const p = preferred + i
    if (p > 65535) break
    if (await isPortFree(p)) return p
  }
  throw new Error(`端口 ${preferred}~${preferred + 19} 都被占用了`)
}

/* ---------------- 后端 ---------------- */

let serverProc = null
let serverPort = 0
let serverExited = false

function spawnServer(port) {
  const entry = path.join(RES_ROOT, 'server.mjs')
  if (!fs.existsSync(entry)) throw new Error(`找不到后端入口：${entry}`)
  if (!fs.existsSync(path.join(RES_ROOT, 'public', 'dist', 'app.js'))) {
    throw new Error('前端还没构建：public/dist/app.js 不存在。请在项目目录跑一次 npm run build。')
  }

  // 默认只绑本机。要手机访问就在环境变量里给 XFC_HOST=0.0.0.0。
  const host = process.env.XFC_HOST || '127.0.0.1'

  serverExited = false
  const child = fork(entry, ['--port', String(port), '--host', host], {
    execPath: process.execPath,
    // 让 Electron 的可执行文件按 Node 跑，而不是再开一个窗口
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      XFC_DATA_DIR: DATA_DIR,
      ...(process.env.XFC_HOST ? {} : { XFC_LOCAL: '1' }),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })

  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk) => writeServerLog('out', chunk))
  child.stderr?.on('data', (chunk) => writeServerLog('err', chunk))

  child.on('exit', (code, signal) => {
    serverExited = true
    log(`后端退出 code=${code} signal=${signal || '-'}`)
    if (!quitting) onServerDeath(code, signal)
  })
  child.on('error', (err) => log('后端进程启动失败：', err?.message || String(err)))

  log(`后端已启动 pid=${child.pid} port=${port} host=${host}`)
  return child
}

/** 后端输出按行写进日志，同时把最近几十行留在内存里给错误对话框用 */
const serverTail = []
function writeServerLog(kind, chunk) {
  const text = String(chunk)
  process[kind === 'err' ? 'stderr' : 'stdout'].write(text)
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    serverTail.push(line)
    if (serverTail.length > 120) serverTail.shift()
    try {
      ensureStateDir()
      fs.appendFileSync(LOG_FILE, `  ${kind}| ${line}${os.EOL}`)
    } catch {
      /* 同上 */
    }
  }
}

async function waitForServer(port, timeoutMs = 30000) {
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    if (serverExited) throw new Error(lastError || '后端进程启动后退出了')
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
      if (res.ok) return true
      lastError = `健康检查返回 ${res.status}`
    } catch (err) {
      lastError = err?.message || String(err)
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`后端 ${timeoutMs / 1000} 秒内没有就绪：${lastError}`)
}

/* ---------------- 窗口 ---------------- */

/** 标题栏高度：和网页顶栏对齐，让原生窗口按钮坐在同一条线上 */
const TITLEBAR_H = 56

let mainWindow = null
let tray = null
let quitting = false

const THEME = {
  light: { bar: '#ffffff', symbol: '#4b5563' },
  dark: { bar: '#0f1420', symbol: '#c7cedb' },
}

function createWindow(port) {
  const dark = nativeTheme.shouldUseDarkColors
  const palette = dark ? THEME.dark : THEME.light

  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: dark ? '#0f1420' : '#f6f7fb',
    title: '代肝运营台',
    icon: path.join(APP_ROOT, 'desktop', 'assets', 'daigan.ico'),
    // 自绘标题栏：把原生标题条藏起来，网页顶栏就是窗口顶栏。
    // 右侧三个系统按钮由 titleBarOverlay 画，颜色跟着主题走。
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: palette.bar, symbolColor: palette.symbol, height: TITLEBAR_H },
    // 网页里没有需要透明的地方，透明窗口在 Windows 上反而会掉帧
    autoHideMenuBar: true,
    webPreferences: {
      // preload 只暴露几个只读能力；页面本身仍然跑在隔离的渲染进程里
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })

  win.setMenuBarVisibility(false)

  win.once('ready-to-show', () => {
    win.show()
    if (process.env.XFC_DESKTOP_DEVTOOLS === '1') win.webContents.openDevTools({ mode: 'detach' })
  })

  win.on('close', (event) => {
    // 关窗口 = 收进托盘，除非用户明确要退出（托盘菜单 / 系统关机）
    if (!quitting && tray) {
      event.preventDefault()
      win.hide()
    }
  })

  win.on('closed', () => {
    mainWindow = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    // 只允许留在自己的页面里；点外链交给系统浏览器
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault()
      openExternal(url)
    }
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    log('渲染进程退出：', JSON.stringify(details))
  })

  win.loadURL(`http://127.0.0.1:${port}/`)
  return win
}

function openExternal(url) {
  try {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
  } catch (err) {
    log('打开外链失败：', err?.message || String(err))
  }
}

/** 主题变了，原生按钮的颜色也要跟着变，否则深色壳子里挂两个白按钮 */
function applyNativeTheme() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const palette = nativeTheme.shouldUseDarkColors ? THEME.dark : THEME.light
  try {
    mainWindow.setTitleBarOverlay({ color: palette.bar, symbolColor: palette.symbol, height: TITLEBAR_H })
  } catch {
    /* 旧版本没有这个方法，忽略 */
  }
}

function createTray() {
  const iconPath = path.join(APP_ROOT, 'desktop', 'assets', 'daigan.ico')
  if (!fs.existsSync(iconPath)) return
  try {
    tray = new Tray(iconPath)
    tray.setToolTip('代肝运营台')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '打开工作台', click: () => showMainWindow() },
        {
          label: '在浏览器里打开',
          click: () => {
            if (serverPort) void shell.openExternal(`http://127.0.0.1:${serverPort}/`)
          },
        },
        { type: 'separator' },
        { label: '查看日志', click: () => void shell.openPath(LOG_FILE) },
        { label: '打开数据目录', click: () => void shell.openPath(DATA_DIR) },
        { type: 'separator' },
        { label: '退出', click: () => quitApp() },
      ]),
    )
    tray.on('double-click', () => showMainWindow())
  } catch (err) {
    log('托盘创建失败：', err?.message || String(err))
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (serverPort) mainWindow = createWindow(serverPort)
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/* ---------------- 出错时给一个能照着做的窗口 ---------------- */

function errorPage({ title, detail, hint }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:40px;
         background:#f6f7fb; color:#111827;
         font:14px/1.7 "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif; }
  .card { width:min(680px,100%); background:#fff; border:1px solid #e5e8f0; border-radius:16px;
          box-shadow:0 18px 48px -28px rgba(16,24,40,.4); padding:32px 34px; }
  .badge { display:inline-flex; align-items:center; gap:8px; padding:5px 11px; border-radius:999px;
           background:#fef1f2; color:#b42334; font-size:12px; font-weight:600; }
  h1 { margin:16px 0 8px; font-size:21px; letter-spacing:-.01em; }
  p { margin:8px 0; color:#4b5563; }
  pre { margin:14px 0 0; padding:14px 16px; border-radius:10px; background:#f8fafc;
        border:1px solid #e8ecf3; font:12px/1.65 ui-monospace,Consolas,monospace;
        color:#374151; white-space:pre-wrap; word-break:break-word; max-height:260px; overflow:auto; }
  .hint { margin-top:18px; padding:14px 16px; border-radius:10px; background:#f3f5fb; color:#374151; font-size:13px; }
  .path { font-family:ui-monospace,Consolas,monospace; font-size:12px; color:#6b7280; }
</style></head>
<body><main class="card">
  <span class="badge">启动没有完成</span>
  <h1>${esc(title)}</h1>
  <p>${esc(detail)}</p>
  ${hint ? `<div class="hint">${hint}</div>` : ''}
  <pre>${esc(serverTail.slice(-25).join('\n') || '（后端没有输出）')}</pre>
  <p class="path">日志：${esc(LOG_FILE)}</p>
</main></body></html>`
}

function showFatal({ title, detail, hint }) {
  const html = errorPage({ title, detail, hint })
  const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.loadURL(dataUrl)
    mainWindow.show()
  } else {
    mainWindow = new BrowserWindow({
      width: 820,
      height: 620,
      backgroundColor: '#f6f7fb',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#ffffff', symbolColor: '#4b5563', height: TITLEBAR_H },
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    })
    mainWindow.loadURL(dataUrl)
    mainWindow.once('ready-to-show', () => mainWindow.show())
  }
}

function onServerDeath(code, signal) {
  showFatal({
    title: '后端进程退出了',
    detail: `服务进程以 code=${code ?? '-'}${signal ? ` signal=${signal}` : ''} 结束。界面暂时用不了，重启程序通常能恢复。`,
    hint: '如果反复出现，看下面的日志最后几行。数据在 <span class="path">' + DATA_DIR + '</span>，不会因为退出而丢失。',
  })
  if (process.env.XFC_DESKTOP_EXIT_ON_SERVER_DEATH === '1') quitApp()
}

/* ---------------- 启动流程 ---------------- */

async function boot() {
  try {
    ensureStateDir()
    log(`启动：packaged=${IS_PACKAGED} root=${RES_ROOT} data=${DATA_DIR}`)

    const preferred = Number(process.env.XFC_PORT || 8787)
    serverPort = await pickPort(preferred)
    if (serverPort !== preferred) log(`端口 ${preferred} 被占用，改用 ${serverPort}`)

    serverProc = spawnServer(serverPort)
    await waitForServer(serverPort)
    log(`后端就绪 http://127.0.0.1:${serverPort}`)

    mainWindow = createWindow(serverPort)
    createTray()
    nativeTheme.on('updated', applyNativeTheme)
  } catch (err) {
    const message = err?.message || String(err)
    log('启动失败：', message)
    const missingBundle = /前端还没构建/.test(message)
    showFatal({
      title: missingBundle ? '前端界面还没构建' : '后端没有启动起来',
      detail: message,
      hint: missingBundle
        ? '在项目目录跑 <span class="path">npm run build</span>，然后重新打开这个程序。'
        : '常见原因：端口被占用、数据目录没有写权限、或者杀毒软件拦了后台进程。日志在 <span class="path">' + LOG_FILE + '</span>。',
    })
  }
}

/* ---------------- 生命周期 ---------------- */

/**
 * 先请后端自己退，等不到再强杀。
 *
 * 为什么不能直接 `kill()`：Windows 上它等于 TerminateProcess，后端的
 * SIGTERM 处理器根本不会跑 —— SQLite 的 WAL 来不及合并，视觉 sidecar 也要
 * 靠「父进程死了 stdin 就 EOF」这套兜底才退出。先发一条 IPC 让它走完
 * shutdown()（关库、锁保险箱、停 sidecar），2.5 秒还不退才动粗。
 */
function shutdownServer() {
  return new Promise((resolve) => {
    if (!serverProc || serverExited) return resolve()
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      log('后端 2.5 秒内没有退出，强制结束')
      try {
        serverProc.kill()
      } catch {}
      finish()
    }, 2500)
    serverProc.once('exit', finish)
    try {
      serverProc.send({ type: 'shutdown' })
    } catch {
      try {
        serverProc.kill()
      } catch {}
      finish()
    }
  })
}

function quitApp() {
  quitting = true
  try {
    tray?.destroy()
    tray = null
  } catch {}
  void shutdownServer().then(() => app.exit(0))
}

/* ---------------- 生命周期 ---------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    app.setAppUserModelId('com.daigan.opsconsole')
    Menu.setApplicationMenu(null)
    void boot()
  })

  app.on('activate', () => showMainWindow())

  app.on('window-all-closed', () => {
    // 托盘里还留着入口，所以不在这里退出（Windows 的常规做法）
    if (!tray) quitApp()
  })

  /**
   * 退出前把时间让给后端收尾。
   * preventDefault 之后必须自己叫 app.exit，否则窗口关了进程还挂着。
   */
  let quittingForGood = false
  app.on('before-quit', (event) => {
    quitting = true
    if (quittingForGood) return
    quittingForGood = true
    if (!serverProc || serverExited) return
    event.preventDefault()
    void shutdownServer().then(() => app.exit(0))
  })

  app.on('will-quit', () => {
    quitting = true
  })

  // 给渲染进程留几个桌面能力（目前只有「打开数据目录」用得上）
  ipcMain.handle('desktop:info', () => ({
    version: app.getVersion(),
    dataDir: DATA_DIR,
    logFile: LOG_FILE,
    port: serverPort,
    portable: Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
  }))
  ipcMain.handle('desktop:open', (_e, target) => {
    if (target === 'data') return shell.openPath(DATA_DIR)
    if (target === 'log') return shell.openPath(LOG_FILE)
    return null
  })
  ipcMain.handle('desktop:open-at-login', (_e, enabled) => {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath })
    return app.getLoginItemSettings().openAtLogin
  })
  ipcMain.handle('desktop:open-at-login:get', () => app.getLoginItemSettings().openAtLogin)
  /**
   * 网页里的主题开关要带上原生窗口按钮。
   * 只改 color-scheme 是不够的：右上角那三个按钮由系统画，
   * 深色界面挂两个白按钮会非常突兀。
   */
  ipcMain.on('desktop:theme', (_e, dark) => {
    nativeTheme.themeSource = dark ? 'dark' : 'light'
    applyNativeTheme()
  })
}
