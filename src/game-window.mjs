import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { profileForGame } from '../shared/game-profiles.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FOCUS_PS1 = path.resolve(HERE, '..', 'scripts', 'focus-game.ps1')
const FIND_PS1 = path.resolve(HERE, '..', 'scripts', 'find-game-window.ps1')
const KEY_PS1 = path.resolve(HERE, '..', 'scripts', 'game-key.ps1')
const ACTIVATE_PS1 = path.resolve(HERE, '..', 'scripts', 'activate-window.ps1')
let activeWindow = null
// The window that was in front before the game was focused -- in practice the
// browser the user clicked "识别画面" in. Handed back when the reading is done.
let previousWindow = null

/* ---------- 一次「看屏幕」流程的全局租约 ----------

   为什么要它：整个流程是「切到游戏 → 按 B/M → 抓图 → 认字 → ESC → 回切」，
   中间所有步骤都靠 game-window.mjs 里那两个模块级变量（activeWindow /
   previousWindow）串起来。它们是**进程级单例**，而前端每个订单、每个游戏、
   每个浏览器标签页都能各自点「识别画面」。两个流程叠在一起时：

     · A 单切到鸣潮、B 单切到异环 → A 后面按的 B 打到了异环窗口上；
     · A 的 return 把 previousWindow 用掉，B 以为自己能回去，其实不行；
     · 两个流程交替抓屏，认出来的数字会串单。

   所以同一时刻只允许一条流程。租约带超时：前端崩了/标签页关了没来释放时，
   不能把后续所有识别都永久锁死。 */
const FLOW_TTL_MS = 3 * 60 * 1000
let screenFlow = null // { id, game, at }

/** 申请人占用。id 由前端给（同一条流程重复调用 = 续期），不传就自动生成 */
export function beginScreenFlow({ id = '', game = '' } = {}) {
  const now = Date.now()
  const wanted = String(id || '')
  if (screenFlow && now - screenFlow.at < FLOW_TTL_MS) {
    if (wanted && screenFlow.id === wanted) {
      screenFlow.at = now
      if (game) screenFlow.game = game
      return { ok: true, id: screenFlow.id, reused: true }
    }
    const label = (profileForGame(screenFlow.game).names || [])[0] || '另一个游戏'
    return {
      ok: false,
      code: 'screen_busy',
      error: `上一条「识别画面」还没结束（${label}）。屏幕识别一次只能跑一条 —— 两条同时跑会互相抢窗口、按键打到别的游戏上。等它结束（或关掉那个页面）再试。`,
      active: { id: screenFlow.id, game: screenFlow.game },
    }
  }
  screenFlow = { id: wanted || `f${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, game, at: now }
  return { ok: true, id: screenFlow.id, reused: false }
}

/** 续期（流程里的每一步都调一次，避免长流程中途过期） */
export function touchScreenFlow(id) {
  if (!screenFlow) return
  if (id && screenFlow.id !== String(id)) return
  screenFlow.at = Date.now()
}

/** 释放。id 不匹配就什么都不做 —— 不能让别人替自己解锁 */
export function endScreenFlow(id) {
  if (!screenFlow) return false
  if (id && screenFlow.id !== String(id)) return false
  screenFlow = null
  return true
}

/** 给测试和排查用 */
export function currentScreenFlow() {
  if (!screenFlow) return null
  if (Date.now() - screenFlow.at >= FLOW_TTL_MS) return null
  return { ...screenFlow }
}

export function activeGameWindow() {
  return activeWindow ? { ...activeWindow } : null
}

/**
 * 把窗口脚本的失败 JSON 翻成「照着做就能解决」的人话。
 *
 * 为什么单独抽出来：`focusGameWindow` 和 `findGameWindow` 走的是两份 ps1，
 * 但失败原因是同一批（游戏没开 / 进程名猜错 / 本程序完整性太低）。
 * 以前只有 focus 那条会翻译，find 那条直接把 `stderr` 或一句
 * 「没有找到游戏窗口。」丢出去 —— 而 find 恰恰是「抢焦点失败」时唯一的
 * 退路，用户在那里最需要知道到底为什么。两个入口说同一套话，才不会
 * 让人以为是两个不同的毛病。
 */
function describeWindowFailure(profile, result, fallback) {
  const gameLabel = (profile.names && profile.names[0]) || profile.id
  // A low-integrity process cannot see an elevated game at all (measured:
  // Get-Process silently drops it), and that is NOT "the game is not
  // running" -- saying so sends people chasing the wrong thing. The usual
  // cause is a "Low" mandatory label on the program's own directory, which
  // also explains %TEMP% write failures and Add-Type errors on the same
  // machine. See the README section on integrity labels.
  if (result?.code === 'game_window_missing' && result.integrity === 'low') {
    const root = path.resolve(HERE, '..')
    return {
      code: 'game_window_missing',
      integrity: 'low',
      error: '本程序正以「低完整性」运行，看不到游戏进程（游戏是以管理员身份运行的）。'
        + `多半是程序目录被打上了 Low 完整性标签，在管理员窗口里执行：icacls "${root}" /setintegritylevel (OI)(CI)Medium`
        + `，再执行 icacls "${path.join(root, 'DaiganLauncher.exe')}" /setintegritylevel High，然后重启本程序。`,
    }
  }
  // 错误里带上具体是哪个游戏 —— 「没有找到游戏窗口」在混着两个游戏时帮不上忙
  const seen = Array.isArray(result?.seen) ? result.seen.filter(Boolean) : []
  const knownErrors = {
    game_window_missing:
      `没有找到${gameLabel}游戏窗口，请先启动${gameLabel}。`
      + (seen.length ? `看到这几个疑似游戏窗口：${seen.join('；')} —— 如果${gameLabel}在里面，把它的进程名设成环境变量 XFC_GAME_PROCESS 再试。` : '如果它的进程名和猜的不一样，可以设置环境变量 XFC_GAME_PROCESS 直接指定进程名。'),
    focus_denied: `Windows 没有允许切换到${gameLabel}窗口。请先手动切到${gameLabel}一次，再点击识别。`,
  }
  return { code: result?.code, error: knownErrors[result?.code] || fallback }
}

export function focusGameWindow({ timeoutMs = 10000, game = '' } = {}) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: '自动切回游戏目前只支持 Windows。' })
  }
  const profile = profileForGame(game)
  const gameLabel = (profile.names && profile.names[0]) || profile.id

  return new Promise((resolve) => {
    let settled = false
    let timer = null
    let stdout = ''
    let stderr = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_PS1]
      // 游戏名**不往命令行上传**：中文参数在 Windows 命令行上转一手就可能变乱码
      // （这个仓库已经被编码坑过一次）。传 profile id，中文在脚本里用码点拼。
      if (profile.id) args.push('-Profile', String(profile.id))
      const processName = String(process.env.XFC_GAME_PROCESS || '').trim()
      if (processName) args.push('-ProcessName', processName)
      child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      return finish({ ok: false, error: `启动游戏窗口切换失败：${err.message}` })
    }

    timer = setTimeout(() => {
      try { child.kill() } catch { /* process may have exited */ }
      finish({ ok: false, error: '切回游戏窗口超时。' })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => finish({ ok: false, error: `启动游戏窗口切换失败：${err.message}` }))
    child.on('close', (code) => {
      let result = null
      try { result = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) } catch { /* report below */ }
      if (code !== 0 || !result?.ok) {
        const described = describeWindowFailure(profile, result, stderr.trim() || '没有切换到游戏窗口。')
        return finish({ ok: false, ...described })
      }
      activeWindow = {
        hwnd: String(result.hwnd),
        processId: Number(result.processId),
        process: result.process,
        title: result.title,
        // 记下这个句柄是**为哪个游戏**找的。后续抓图/按键靠它校验：
        // 两个游戏同时开着时，句柄可能是上一条流程留下的另一个游戏的窗口。
        game: profile.id,
      }
      // "0" means there was nothing to come back to (the game was already in
      // front), so the flow will not try to hand focus anywhere.
      const previousHwnd = String(result.previous || '0')
      previousWindow = previousHwnd && previousHwnd !== '0' ? { hwnd: previousHwnd } : null
      // matchedBy=fallback：进程名/标题里没有任何该游戏的特征，是按「一个不是
      // 其它支持游戏的 UE 窗口」猜的。界面会说出来，别让人以为一定切对了。
      finish({ ...result, game: profile.id, game_name: gameLabel, matched_by: result.matchedBy || 'name', ok: true })
    })
  })
}

/**
 * 只**找**游戏窗口，不碰焦点。
 *
 * 为什么需要它：focusGameWindow 是「找到 + 抢到前台」两件事一起做，而抢焦点
 * 可能被 Windows 的前台锁拒绝。被拒时它不返回句柄，于是截图那边就不知道该
 * 抓哪个窗口，退化成「抓整个屏幕」—— 抓到的是桌面，上面还盖着浏览器。
 * 一张看起来正常但其实拍错了的图，比报错更糟（实测踩到过）。
 *
 * 找到了会把句柄记进 activeWindow，后面的 grabScreen 才知道要裁哪个窗口。
 * 失败返回 { ok: false }，调用方自行决定怎么办。
 */
export function findGameWindow({ timeoutMs = 8000, game = '' } = {}) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: '只支持 Windows。' })
  }
  const profile = profileForGame(game)

  return new Promise((resolve) => {
    let settled = false
    let timer = null
    let stdout = ''
    let stderr = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FIND_PS1]
      // 和 focusGameWindow 一样：中文游戏名不往命令行上传，传 profile id
      if (profile.id) args.push('-Profile', String(profile.id))
      const processName = String(process.env.XFC_GAME_PROCESS || '').trim()
      if (processName) args.push('-ProcessName', processName)
      child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      return finish({ ok: false, error: `查找游戏窗口失败：${err.message}` })
    }

    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 可能已经退了 */
      }
      finish({ ok: false, error: '查找游戏窗口超时。' })
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (err) => finish({ ok: false, error: `查找游戏窗口失败：${err.message}` }))
    child.on('close', (code) => {
      let result = null
      try {
        result = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
      } catch {
        /* 下面统一报 */
      }
      if (code !== 0 || !result?.ok) {
        // 和 focusGameWindow 说同一套话：code 保留（前端/调用方靠它区分
        // 「没开游戏」「进程名猜错」「本程序完整性太低」），不再只丢一句 stderr。
        return finish({ ok: false, ...describeWindowFailure(profile, result, stderr.trim() || '没有找到游戏窗口。') })
      }
      // 记进 activeWindow：grabScreen 靠它决定裁哪一块、走不走 PrintWindow
      activeWindow = {
        hwnd: String(result.hwnd),
        processId: Number(result.processId),
        process: result.process,
        title: result.title,
        game: profile.id,
      }
      finish({ ...result, game: profile.id, ok: true })
    })
  })
}

/** Send only the keys used by the resource-reading and screenshot flows. */export function sendGameKey(key, { timeoutMs = 5000 } = {}) {
  const normalized = String(key || '').trim().toUpperCase()
  // F2 / F12 是给「只截图不识别」用的：那是游戏自带的截图键
  if (!['B', 'M', 'ESC', 'F2', 'F12'].includes(normalized)) {
    return Promise.resolve({ ok: false, error: '只允许发送 B、M、ESC、F2 或 F12。' })
  }
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: '自动向游戏发送按键目前只支持 Windows。' })
  }
  if (!activeWindow?.hwnd) {
    return Promise.resolve({ ok: false, error: '还没有激活游戏窗口，请重新点击识别。' })
  }

  return new Promise((resolve) => {
    let settled = false
    let timer = null
    let stdout = ''
    let stderr = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      const args = [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', KEY_PS1,
        '-WindowHandle', activeWindow.hwnd, '-ProcessId', String(activeWindow.processId), '-Key', normalized,
      ]
      child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      return finish({ ok: false, error: `启动游戏按键失败：${err.message}` })
    }

    timer = setTimeout(() => {
      try { child.kill() } catch { /* process may have exited */ }
      finish({ ok: false, error: '向游戏发送按键超时。' })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => finish({ ok: false, error: `启动游戏按键失败：${err.message}` }))
    child.on('close', (code) => {
      let result = null
      try { result = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) } catch { /* report below */ }
      if (code !== 0 || !result?.ok) {
        // 报「哪个游戏」而不是写死鸣潮：两个游戏共用这条路径，写死会误导。
        const label = activeWindow?.title || activeWindow?.process || '游戏'
        const knownErrors = {
          game_not_foreground: `没能把焦点保持在${label}窗口上，按键没有发出去（不会盲发，免得打到别的窗口上）。`,
          game_window_closed: `${label}窗口已经关闭。`,
        }
        // 把实际的前台窗口报出来：只说「不在前台」的话，分不清是句柄过期还是被别人抢了
        const detail = result && result.got ? `（当前前台窗口 0x${Number(result.got).toString(16)}，期望 0x${Number(result.want).toString(16)}）` : ''
        return finish({ ok: false, code: result?.code, error: (knownErrors[result?.code] || stderr.trim() || `没有向${label}发送按键。`) + detail })
      }
      finish({ ok: true, key: normalized })
    })
  })
}

/**
 * Hand the foreground back to whatever was in front before the game was focused
 * -- in practice the browser the reading was started from, so nobody has to
 * Alt+Tab back to see the result.
 *
 * Deliberately never a hard failure: by the time this runs the reading has
 * already succeeded (or already reported its own error), so a refusal here is
 * only worth a hint, never an exception.
 */
export function returnToPreviousWindow({ timeoutMs = 8000 } = {}) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: true, skipped: 'not_windows' })
  }
  const hwnd = previousWindow?.hwnd
  if (!hwnd) {
    return Promise.resolve({ ok: true, skipped: 'nothing_to_return_to' })
  }

  return new Promise((resolve) => {
    let settled = false
    let timer = null
    let stdout = ''
    let stderr = ''
    const finish = (result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(result)
    }

    let child
    try {
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ACTIVATE_PS1, '-WindowHandle', hwnd]
      child = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      return finish({ ok: false, error: `切回原窗口失败：${err.message}` })
    }

    timer = setTimeout(() => {
      try { child.kill() } catch { /* process may have exited */ }
      finish({ ok: false, error: '切回原窗口超时。' })
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (err) => finish({ ok: false, error: `切回原窗口失败：${err.message}` }))
    child.on('close', (code) => {
      let result = null
      try { result = JSON.parse(stdout.trim().replace(/^\uFEFF/, '')) } catch { /* report below */ }
      if (code !== 0 || !result?.ok) {
        const knownErrors = {
          window_gone: '原来的窗口已经不在了（浏览器关掉了？），请手动切一下。',
          activate_denied: 'Windows 没有允许切回原来的窗口，请手动切一下。',
        }
        return finish({ ok: false, code: result?.code, error: knownErrors[result?.code] || stderr.trim() || '没有切回原来的窗口。' })
      }
      // Spent: the handle may be stale by the next reading, and focus-game.ps1
      // records a fresh one every time it runs anyway.
      previousWindow = null
      finish({ ok: true, hwnd: String(result.hwnd) })
    })
  })
}
