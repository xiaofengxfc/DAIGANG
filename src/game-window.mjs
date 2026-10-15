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

export function activeGameWindow() {
  return activeWindow ? { ...activeWindow } : null
}

/**
 * Find and foreground the game's top-level window from an explicit UI action.
 *
 * `game` 是订单上那个游戏名（鸣潮 / 异环）：两个游戏的进程名和窗口标题都不
 * 一样，认哪个游戏的界面就得切哪个游戏的窗口 —— 切错了后面全认错。
 * 认不出游戏名时按默认那份（鸣潮）来，保持老行为。
 */
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
        // A low-integrity process cannot see an elevated game at all (measured:
        // Get-Process silently drops it), and that is NOT "the game is not
        // running" -- saying so sends people chasing the wrong thing. The usual
        // cause is a "Low" mandatory label on the program's own directory, which
        // also explains %TEMP% write failures and Add-Type errors on the same
        // machine. See the README section on integrity labels.
        if (result?.code === 'game_window_missing' && result.integrity === 'low') {
          const root = path.resolve(HERE, '..')
          return finish({
            ok: false,
            code: 'game_window_missing',
            integrity: 'low',
            error: '本程序正以「低完整性」运行，看不到游戏进程（游戏是以管理员身份运行的）。'
              + `多半是程序目录被打上了 Low 完整性标签，在管理员窗口里执行：icacls "${root}" /setintegritylevel (OI)(CI)Medium`
              + `，再执行 icacls "${path.join(root, 'DaiganLauncher.exe')}" /setintegritylevel High，然后重启本程序。`,
          })
        }
        // 错误里带上具体是哪个游戏 —— 「没有找到游戏窗口」在混着两个游戏时帮不上忙
        const seen = Array.isArray(result?.seen) ? result.seen.filter(Boolean) : []
        const knownErrors = {
          game_window_missing:
            `没有找到${gameLabel}游戏窗口，请先启动${gameLabel}。`
            + (seen.length ? `看到这几个疑似游戏窗口：${seen.join('；')} —— 如果${gameLabel}在里面，把它的进程名设成环境变量 XFC_GAME_PROCESS 再试。` : '如果它的进程名和猜的不一样，可以设置环境变量 XFC_GAME_PROCESS 直接指定进程名。'),
          focus_denied: `Windows 没有允许切换到${gameLabel}窗口。请先手动切到${gameLabel}一次，再点击识别。`,
        }
        return finish({ ok: false, error: knownErrors[result?.code] || stderr.trim() || '没有切换到游戏窗口。' })
      }
      activeWindow = { hwnd: String(result.hwnd), processId: Number(result.processId), process: result.process, title: result.title }
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
        return finish({ ok: false, code: result?.code, error: stderr.trim() || '没有找到游戏窗口。' })
      }
      // 记进 activeWindow：grabScreen 靠它决定裁哪一块、走不走 PrintWindow
      activeWindow = { hwnd: String(result.hwnd), processId: Number(result.processId), process: result.process, title: result.title }
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
        const knownErrors = {
          game_not_foreground: '鸣潮窗口已不在前台，已停止发送按键。',
          game_window_closed: '鸣潮窗口已经关闭。',
        }
        return finish({ ok: false, error: knownErrors[result?.code] || stderr.trim() || '没有向鸣潮发送按键。' })
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
