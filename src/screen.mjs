/* ============================================================
   屏幕识别：截当前屏幕 → OCR 读数字 → 用图标认出每个数字是谁。

   为什么是图标而不是文字：鸣潮界面里 星声 / 体力 / 贝币 **只有图标没有文字**，
   OCR 只能读到裸数字（实测两张真截图，一个标签都没有）。
   所以流程是：先 OCR 拿到所有数字和它们的坐标，再看每个数字左边那个图标是哪个。

   实测（用户真截图）三个都 1.000 命中。三个要点：
     · 模板要「紧贴图标」的裁剪，尺寸规格差不多（约 40px）；
     · 缩放按数字高度算（图标约等于数字高度的 1.7 倍），别瞎试档位；
     · 蒙版 + 比颜色比例 —— 「暗底亮星」和「暗底亮晶体」比亮度分不开，比颜色才分得开。
   ============================================================ */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ocrImage, parseNumber } from './ocr.mjs'
import { decodePNG, classifyIcon } from './imgmatch.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GRAB_PS1 = path.resolve(HERE, '..', 'scripts', 'grab.ps1')
const ICON_DIR = path.resolve(HERE, '..', 'public', 'resource-icons')

/** 认这三个。文件名就是模板文件名 */
export const SCREEN_RESOURCES = ['星声', '体力', '贝币']
const TEMPLATE_FILE = { 星声: 'xingsheng', 体力: 'tili', 贝币: 'beibi' }

/** 认到多少分才算数。三个真样本都是 1.000，0.7 很安全；
 *  低于这个宁可说没认出来，也绝不瞎填一个数进去。 */
export const MIN_SCORE = 0.7

let cache = null
/** 载入图标模板（进程内缓存一次） */
export function loadTemplates() {
  if (cache) return cache
  const refs = []
  for (const key of SCREEN_RESOURCES) {
    const file = path.join(ICON_DIR, `${TEMPLATE_FILE[key]}.png`)
    try {
      refs.push({ key, img: decodePNG(fs.readFileSync(file)) })
    } catch {
      /* 模板缺了就当没有，下面的识别会跳过它 */
    }
  }
  cache = refs
  return refs
}

/** 截屏到一个 png 文件 */
export function grabScreen(outPath, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const logPath = `${outPath}.log`
    let stdFd = null
    let logFd = null
    try {
      stdFd = fs.openSync(logPath, 'w')
      logFd = fs.openSync(logPath, 'a')
    } catch {
      /* 打不开就当没有 */
    }
    const finish = (r) => {
      for (const p of [logPath]) {
        try {
          fs.unlinkSync(p)
        } catch {
          /* 没了就算了 */
        }
      }
      for (const fd of [stdFd, logFd]) {
        try {
          if (fd !== null) fs.closeSync(fd)
        } catch {
          /* 已经关了 */
        }
      }
      resolve(r)
    }
    let child
    try {
      // 注意不能用 stdio:'ignore'：powershell 拿到空句柄会 0xC0000142 直接退出
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', GRAB_PS1, '-Out', path.resolve(outPath)], {
        stdio: ['ignore', stdFd, logFd],
        windowsHide: true,
      })
    } catch (err) {
      return finish({ ok: false, error: `起不了 powershell：${err.message}` })
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退了 */
      }
      finish({ ok: false, error: '截屏超时' })
    }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      finish({ ok: false, error: `截不了屏：${err.message}` })
    })
    child.on('close', () => {
      clearTimeout(timer)
      if (!fs.existsSync(outPath)) return finish({ ok: false, error: '截屏没有输出（可能被系统权限拦了）' })
      finish({ ok: true })
    })
  })
}

/** 看着像不像一个资源数字（纯数字，带千分位或斜杠） */
function looksLikeNumber(text) {
  const t = String(text || '').replace(/\s/g, '')
  if (t.length < 2) return false
  return /^[\d,，/]+$/.test(t)
}

/**
 * 资源数字永远在顶部那条栏里（两张真截图都是 y≈54）。
 * 只在顶部这条带里找，既快又不会把界面里别的数字（攻击力、等级…）也算进来。
 */
export const TOP_BAND = 150

/**
 * 画面里认资源。返回 { resources, candidates }
 * candidates 会把每个「找到图标」的数字都列出来（含分数），方便排查。
 */
export function matchScreen(img, words, { refs = loadTemplates(), minScore = MIN_SCORE, topBand = TOP_BAND } = {}) {
  const resources = {}
  const candidates = []
  for (const w of words) {
    if (w.y > topBand) continue
    if (!looksLikeNumber(w.text)) continue
    const num = parseNumber(w.text)
    if (num === null) continue
    const h = w.h || 24
    // 图标就贴在数字左边：搜到 6.5 倍字高那么远足够，再远就是别的元素了
    const region = {
      x: Math.max(0, Math.round(w.x - h * 6.5)),
      y: Math.max(0, Math.round(w.cy - h * 1.8)),
      w: Math.round(h * 6.2),
      h: Math.round(h * 3.6),
    }
    // 每个模板按自己的尺寸算缩放，保证都缩到「数字高度的 1.7 倍」那么大
    let best = { key: null, score: -1 }
    for (const r of refs) {
      const base = (h * 1.7) / r.img.width
      // 缩放档位不能太稀：实测命中那一档是 0.98×，三档网格(0.9/1.0/1.1)会正好漏掉它，
      // 分数从 1.000 掉到 0.66。五档就稳。
      const scales = [base * 0.85, base * 0.95, base, base * 1.08, base * 1.2].map((s) => +s.toFixed(3))
      // step 必须是 1：图标只有 40px 上下，隔一个像素就「差一格」，
      // 实测分数会从 1.000 掉到 0.66（这一步的快慢靠上面的「只看顶栏」来省，
      // 不能靠跳像素 —— 跳过的那一格正好是命中的那一格）
      const hit = classifyIcon(img, region, [r], { step: 1, scales })
      if (hit.score > best.score) best = { key: r.key, score: hit.score, x: hit.x, y: hit.y, scale: hit.scale }
    }
    candidates.push({ text: w.text, value: num, key: best.key, score: +best.score.toFixed(3), x: w.x, y: w.y, iconAt: best.x })
    if (best.key && best.score >= minScore && resources[best.key] === undefined) resources[best.key] = num
  }
  return { resources, candidates }
}

/** 截一次屏，认一次 */
export async function recognizeScreenOnce({ lang = 'zh-Hans-CN', minScore = MIN_SCORE } = {}) {
  const tmp = path.join(os.tmpdir(), `xfc-screen-${process.pid}-${Date.now()}.png`)
  try {
    const g = await grabScreen(tmp)
    if (!g.ok) return { ok: false, error: g.error }
    const buf = fs.readFileSync(tmp)
    const ocr = await ocrImage(tmp, { lang })
    if (!ocr.ok) return { ok: false, error: ocr.error }
    const img = decodePNG(buf)
    const { resources, candidates } = matchScreen(img, ocr.words, { minScore })
    return { ok: true, resources, candidates, size: [img.width, img.height] }
  } catch (err) {
    return { ok: false, error: err.message }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 清不掉就算了 */
    }
  }
}
