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
import { decodePNG } from './imgmatch.mjs'
import { focusGameWindow, findGameWindow, sendGameKey, returnToPreviousWindow, activeGameWindow } from './game-window.mjs'

/**
 * 「截图」用的抓帧流程。
 *
 * 两条路，按能不能抢到焦点分：
 *
 *   1. **抢到焦点** → 游戏就在屏幕最前面 → CopyFromScreen 直接拷那一块。
 *      这是识别流程一直在用的办法，最可靠。
 *   2. **抢不到焦点** → 改用「读窗口自己的像素」（grab.ps1 -AllowUnfocused）。
 *      但要小心：这一步**只在游戏是窗口模式时才有用**。窗口占满整屏
 *      （全屏 / 无边框全屏）时，三种办法都拿不到 DirectX 画面，只会退回
 *      桌面内容，而图看起来完全正常 —— 所以下面用 covered 判据把它挡掉，
 *      宁可让用户多点一次，也不能往时间线里存一张桌面截图。
 *
 * Windows 的前台锁是**不保证**能被绕过的：SetForegroundWindow 直接调用、
 * AttachThreadInput 重试、合成 ALT 三招都试过了，后台进程仍然可能被拒。
 * 所以这条路不能假设自己一定成功，必须能优雅地告诉用户怎么办。
 */

/** F2 之后等多久再抓。等的是「游戏自己的截图提示 / 白闪」过去，别把它照进图里 */
const SETTLE_AFTER_KEY_MS = 320

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 抽样判断这张图是不是「废图」。
 *
 * 返回 null 表示有内容，'black' / 'flat' 表示不能用。
 *
 * 为什么抽样而不是全量：一张 1920×1200 有三百万像素，全扫一遍在记事本级别的
 * 工作里没必要 —— 每隔十几个像素取一个就足以区分「游戏画面」和「纯黑/纯色」。
 * 解不开像素时返回 null（宁可放过，也不要因为解码器的小毛病把好图拦掉）。
 */
function detectBlank(buf) {
  let img = null
  try {
    img = decodePNG(buf)
  } catch {
    return null
  }
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 20000)))
  let sampled = 0
  let bright = 0
  let min = 255
  let max = 0
  const first = [img.px[0], img.px[1], img.px[2]]
  let allSame = true
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      const p = (y * img.width + x) * 3
      const l = (img.px[p] + img.px[p + 1] + img.px[p + 2]) / 3
      sampled++
      if (l > 12) bright++
      if (l < min) min = l
      if (l > max) max = l
      if (allSame && (Math.abs(img.px[p] - first[0]) > 6 || Math.abs(img.px[p + 1] - first[1]) > 6 || Math.abs(img.px[p + 2] - first[2]) > 6)) allSame = false
    }
  }
  if (!sampled) return null
  // 全黑：亮像素几乎为零
  if (bright / sampled < 0.01) return 'black'
  // 纯色：整张基本一个颜色（黑图也常常落进这一支，顺序上先判黑更准确）
  if (allSame || max - min < 8) return 'flat'
  return null
}

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

  /* 1) 尽量把游戏切到前台 —— 但**切不过去也要继续抓**。
   *
   * 为什么要改：以前 focus 失败就直接返回错误（「Windows 没有允许切换到鸣潮窗口」），
   * 于是用户在游戏开着、窗口就在那儿的情况下，既识别不了也截不了图。
   * 可我们其实不需要它在最前面：CopyFromScreen 才需要（它从屏幕上拷，
   * 被挡住就拷到挡它的东西），而 PrintWindow 是让窗口把自己画到我们的 DC 里。
   * 所以现在 focus 只是一次「顺手」，失败了就靠 PrintWindow 抓窗口自己的像素。 */
  const focus = await focusGameWindow({ game })
  const focused = Boolean(focus && focus.ok)
  if (!focused) {
    const why = (focus && focus.error) || '没有切换到游戏窗口。'
    /* 抢焦点失败**不代表找不到窗口**，而抓窗口内容本来就不需要它在最前面。
       所以这里补一步「只找不抢」：拿到句柄，grab.ps1 才能用 PrintWindow
       去读那个窗口自己的像素。少了这一步，grab.ps1 没有句柄可裁，会退化成
       抓整个屏幕 —— 抓到桌面和盖在上面的浏览器，看着像成功其实是错的图。 */
    const found = await findGameWindow({ game })
    if (found && found.ok) {
      // 只说「没切过去，改用窗口内容」，**不保证成功** —— 全屏窗口下这一步
      // 照样拿不到画面，最后会被下面的 covered 判据挡下来并给出办法。
      warnings.push(`${why}已尝试直接读取${found.title || '游戏'}窗口画面（不需要它在最前面）。`)
    } else {
      return {
        ok: false,
        error: `${why}而且也没找到游戏窗口（${(found && found.error) || '未知原因'}）。请先启动游戏再试。`,
        warnings,
      }
    }
  } else if (focus.matched_by === 'fallback') {
    warnings.push(`没认出游戏窗口特征，按通用规则切到了 ${focus.title || focus.process}，确认一下截的是不是游戏。`)
  }

  // 让恢复前台的游戏窗口重绘一帧再抓，否则可能抓到切回来之前的旧画面。
  // 没切过去时不用等：窗口没动，画面也没变。
  if (focused) await sleep(500)

  // 2) 顺手按一下游戏自带的截图键。失败只记一句，不影响我们自己的抓屏。
  //    没切到前台时**不发**：按键会打到当时前台的窗口上（很可能是浏览器），
  //    那既没意义，还可能误触别的东西。
  if (focused) {
    try {
      const sent = await sendGameKey(key)
      if (!sent || !sent.ok) warnings.push(`没能把 ${key} 发给游戏（${(sent && sent.error) || '未知原因'}），已直接抓取当前画面。`)
      else await sleep(SETTLE_AFTER_KEY_MS)
    } catch (err) {
      warnings.push(`发送 ${key} 失败：${err.message}，已直接抓取当前画面。`)
    }
  }

  // 3) 自己抓一份 —— 这份才是要存档的。
  //    限宽 1920：4K 原图一张好几兆，先让 PowerShell 等比缩好再传，
  //    反正客户端还会再压一次，留档看画面 1920 足够。
  const tmp = scratchFile('xfc-shot', '.png', { mode: 'ascii' })
  let buf = null
  let meta = null
  try {
    const grabbed = await grabScreen(tmp, { maxWidth: MAX_STORE_WIDTH, allowUnfocused: true })
    if (!grabbed || !grabbed.ok) {
      return { ok: false, error: (grabbed && grabbed.error) || '抓取屏幕失败。', warnings }
    }
    meta = grabbed.meta || null
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

  /* 5) 关键一步：**没抢到焦点、且窗口占满整屏时，这张图不能信。**
   *
   * 实测过的坑：游戏窗口占满整个屏幕（全屏 / 无边框全屏）时，三种「读窗口像素」
   * 的办法全都拿不到游戏画面，而是退回桌面内容（上面还盖着浏览器）：
   *   · PrintWindow-full / PrintWindow-client → 对 DirectX 表面渲染失败；
   *   · BitBlt 窗口 DC → 它只是把「屏幕上那个矩形」逐位拷过来，
   *     根本不会让被遮住的窗口去重绘。
   * 图看起来完全正常（不黑、不纯色），拿它存档等于存了张桌面截图。
   * 「看着像成功、其实是错的东西」比报错糟得多，所以这里直接拒掉。
   *
   * 为什么只在「没抢到焦点」时拒：抢到焦点的话，屏幕上那块地方就是游戏本身，
   * 抓整屏反而是对的（这也是识别流程一直用的办法）。
   * 判据用 grab.ps1 报回来的原始矩形，不能用缩放后的宽高 ——
   * 2560 缩到 1920 会看起来只占屏幕 75%，那就漏掉了。 */
  const covered = Boolean(meta && meta.covered)
  if (!focused && covered) {
    return {
      ok: false,
      error:
        '游戏窗口占满整屏，而 Windows 不允许在它非前台时读取画面（全屏模式的限制），照这样截到的会是桌面而不是游戏。' +
        '两个办法任选：把游戏切到前台后再点「截图」；或者把游戏的显示模式改成「无边框窗口 / 窗口」——改成窗口以后就不挑前台了。',
      warnings,
    }
  }

  /* 6) 抓到的不能是黑图 / 纯色块。
   * PrintWindow 对 DirectX 经常**返回成功但画一片黑**，只看返回值会把黑矩形
   * 当成截图存进时间线。所以抽样看像素：「几乎没有亮像素」或「整张一个颜色」
   * 都算失败。 */
  const blank = detectBlank(buf)
  if (blank) {
    return {
      ok: false,
      error:
        `抓到的是${blank === 'black' ? '一张黑图' : '一整块纯色'}，游戏多半跑在「独占全屏」下 —— ` +
        '这种模式禁止别的程序读它的画面。把游戏改成「无边框窗口 / 窗口」再试一次。',
      warnings,
    }
  }

  const token = stashFrame({ session: 'manual-shot', stage: 'manual', buf, width: 0, height: 0 })
  if (!token) return { ok: false, error: '画面没能暂存下来，请重试。', warnings }

  // 4) 把前台还给浏览器：用户要回来点「记下」。失败只提示（和识别流程一个口径）。
  //    只有真抢过焦点才需要还 —— 没抢到就说明前台没动过，别去多此一举。
  if (focused) {
    try {
      const back = await returnToPreviousWindow()
      if (back && back.ok === false) warnings.push(`没能自动切回浏览器：${back.error || '未知原因'}`)
    } catch (err) {
      warnings.push(`没能自动切回浏览器：${err.message}`)
    }
  }

  const win = activeGameWindow()
  return {
    ok: true,
    frame_token: token,
    bytes: buf.length,
    key: String(key).toUpperCase(),
    game,
    // 这一张是「窗口不在前台」时靠 PrintWindow 抓的，界面可以把这点说出来
    unfocused: !focused,
    window: win ? { title: win.title, process: win.process } : null,
    warnings,
  }
}
