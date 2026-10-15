/* ============================================================
   「只截图，不识别」——按 F2 抓一张游戏画面
   ============================================================

   和「识别画面」有什么不一样：

     · 识别画面：切到游戏 → 按 B/M 打开界面 → 抓帧 → 认数字 → 关界面。
       目的是**读数值**，所以认完那帧就删；
     · 这里：切到游戏 → 按 F2（游戏自带的截图键）→ 抓帧 → **什么都不认**。
       目的是**留一张图**，用户想在进度里附一张画面就用它。

   图从哪来：两条路都走。

     1. `sendGameKey('F2')` —— 游戏自己会把截图存到它的截图目录里。
        好处是干净（没有别的窗口叠在上面），坏处是目录因游戏而异、
        还可能弹提示，所以**不依赖它**；
     2. `grabScreen()` —— 我们自己从帧缓冲里拷一份（scripts/grab.ps1，
        DPI 感知 + 按游戏窗口矩形裁）。这份才是真正拿去存档的：
        不管游戏把截图存哪儿，我们手里都有一张。

   第 1 步失败**不算失败**：有些游戏把截图键改过、有些按键发送会被拒。
   那种情况下第 2 步照样能拿到画面，用户要的是图，不是那个按键动作。
   ============================================================ */

import fs from 'node:fs'
import { scratchFile } from './util.mjs'
import { grabScreen } from './screen.mjs'
import { stashFrame } from './screen-stash.mjs'
import { focusGameWindow, sendGameKey, returnToPreviousWindow, activeGameWindow } from './game-window.mjs'

/** F2 之后等多久再抓。等的是「游戏自己的截图提示 / 白闪」过去，别把它照进图里 */
const SETTLE_AFTER_KEY_MS = 320

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 存档用画面的长边上限。
 * 识别路径要原始分辨率（数字小，缩了会认错），但留档只是给人看，
 * 1920 足够，而且能省掉一大半传输和内存。
 */
const MAX_STORE_WIDTH = 1920

/**
 * 抓一张当前游戏画面并暂存，返回 { ok, frame_token, size, warnings }。
 *
 * 暂存而不是直接写 uploads：用户可能截完又不要了（就像识别画面一样），
 * 所以走同一套「保存进度时才真正落盘」的机制（见 src/screen-stash.mjs）。
 */
export async function captureGameFrame({ game = '', key = 'F2' } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, error: '截图目前只支持 Windows。' }
  }

  const warnings = []

  // 1) 切到游戏窗口。这一步失败就没意义了 —— 抓到的会是浏览器自己。
  const focus = await focusGameWindow({ game })
  if (!focus || !focus.ok) {
    return { ok: false, error: (focus && focus.error) || '没有切换到游戏窗口。' }
  }
  if (focus.matched_by === 'fallback') {
    warnings.push(`没认出游戏窗口特征，按通用规则切到了 ${focus.title || focus.process}，确认一下截的是不是游戏。`)
  }

  // 让恢复前台的游戏窗口重绘一帧再抓，否则可能抓到切回来之前的旧画面
  await sleep(500)

  // 2) 顺手按一下游戏自带的截图键。失败只记一句，不影响我们自己的抓屏。
  try {
    const sent = await sendGameKey(key)
    if (!sent || !sent.ok) warnings.push(`没能把 ${key} 发给游戏（${(sent && sent.error) || '未知原因'}），已直接抓取当前画面。`)
    else await sleep(SETTLE_AFTER_KEY_MS)
  } catch (err) {
    warnings.push(`发送 ${key} 失败：${err.message}，已直接抓取当前画面。`)
  }

  // 3) 自己抓一份 —— 这份才是要存档的。
  //    限宽 1920：4K 原图一张好几兆，先让 PowerShell 等比缩好再传，
  //    反正客户端还会再压一次，留档看画面 1920 足够。
  const tmp = scratchFile('xfc-shot', '.png', { mode: 'ascii' })
  let buf = null
  try {
    const grabbed = await grabScreen(tmp, { maxWidth: MAX_STORE_WIDTH })
    if (!grabbed || !grabbed.ok) {
      return { ok: false, error: (grabbed && grabbed.error) || '抓取屏幕失败。', warnings }
    }
    buf = fs.readFileSync(tmp)
  } catch (err) {
    return { ok: false, error: `抓取屏幕失败：${err.message}`, warnings }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 清不掉就算了，临时目录里的东西 */
    }
  }

  if (!buf || !buf.length) return { ok: false, error: '抓到的画面是空的。', warnings }

  const token = stashFrame({ session: 'manual-shot', stage: 'manual', buf, width: 0, height: 0 })
  if (!token) return { ok: false, error: '画面没能暂存下来，请重试。', warnings }

  // 4) 把前台还给浏览器：用户要回来点「记下」。失败只提示（和识别流程一个口径）
  try {
    const back = await returnToPreviousWindow()
    if (back && back.ok === false) warnings.push(`没能自动切回浏览器：${back.error || '未知原因'}`)
  } catch (err) {
    warnings.push(`没能自动切回浏览器：${err.message}`)
  }

  const win = activeGameWindow()
  return {
    ok: true,
    frame_token: token,
    bytes: buf.length,
    key: String(key).toUpperCase(),
    game,
    window: win ? { title: win.title, process: win.process } : null,
    warnings,
  }
}
