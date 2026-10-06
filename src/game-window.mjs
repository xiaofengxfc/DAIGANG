import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FOCUS_PS1 = path.resolve(HERE, '..', 'scripts', 'focus-game.ps1')
const KEY_PS1 = path.resolve(HERE, '..', 'scripts', 'game-key.ps1')
let activeWindow = null

export function activeGameWindow() {
  return activeWindow ? { ...activeWindow } : null
}

/** Find and foreground the game's top-level window from an explicit UI action. */
export function focusGameWindow({ timeoutMs = 10000 } = {}) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: '自动切回游戏目前只支持 Windows。' })
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
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_PS1]
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
        const knownErrors = {
          game_window_missing: '没有找到鸣潮游戏窗口。请先启动游戏；如果进程名称不同，可设置 XFC_GAME_PROCESS。',
          focus_denied: 'Windows 没有允许切换到鸣潮窗口。请先手动切到游戏一次，再点击识别。',
        }
        return finish({ ok: false, error: knownErrors[result?.code] || stderr.trim() || '没有切换到游戏窗口。' })
      }
      activeWindow = { hwnd: String(result.hwnd), processId: Number(result.processId), process: result.process, title: result.title }
      finish({ ...result, ok: true })
    })
  })
}

/** Send only the navigation keys used by the resource-reading flow. */
export function sendGameKey(key, { timeoutMs = 5000 } = {}) {
  const normalized = String(key || '').trim().toUpperCase()
  if (!['B', 'M', 'ESC'].includes(normalized)) {
    return Promise.resolve({ ok: false, error: '只允许发送 B、M 或 ESC。' })
  }
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: '自动向游戏发送按键目前只支持 Windows。' })
  }
  if (!activeWindow?.hwnd) {
    return Promise.resolve({ ok: false, error: '还没有激活鸣潮窗口，请重新点击识别。' })
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
