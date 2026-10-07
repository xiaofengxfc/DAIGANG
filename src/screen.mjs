/* ============================================================
   screen.mjs —— 界面识别（重做版）：把顶栏那一排资源读成数字。

   老版的问题（这次重做的原因）：
     · 阈值写死 y≈54（TOP_BAND=150），换分辨率/全屏窗口化就散架；
     · 先 OCR 拿数字、再在数字左边找图标 —— 数字被 OCR 切成 `21` + `74`
       时会当成两个数，2174 直接读成 21；
     · 认一次就算数，没有复核，也没有「同一数字认到两次才采纳」这种余地。

   现在的做法（顺序反过来，先找图标再读数）：
     1. **找图标**：用 vision.mjs 的积分图 NCC + 由粗到细多尺度搜索，
        在顶栏那条带里找已知美术资源（星声 / 贝币 / 体力）。
        分数不够就当没看见，不往下走。
     2. **量缩放**：图标本身的像素尺寸就是这一屏的缩放系数，
        拿它去推「这个分辨率下数字该多高」，不写死任何坐标。
     3. **拼数字**：OCR 的碎片按几何拼回一个数（2174 而不是 21+74），
        取图标右侧最近、纵向重叠最多的那一块。
     4. **跨帧投票**：同一数字要认到 minVotes 次（默认 2）才采纳，
        两次不一致就继续看，直到 deadline。宁可空着，也不填一个没复核的数。

   还有一个不出现在结果里的作用：它顺手证明「图标认对了」——
   如果找到的图标位置和数字块的空间关系不合理（比如数字在图标上方），
   这一帧直接作废。
   ============================================================ */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { scratchFile } from './util.mjs'
import { ocrImage, parseNumber, ocrStatus } from './ocr.mjs'
import { activeGameWindow } from './game-window.mjs'
import { profileForGame, profileKeys, DEFAULT_PROFILE } from '../shared/game-profiles.js'
import { decodePNG, crop, encodePNG, resize } from './imgmatch.mjs'
import { buildIntegral, compileTemplate, findIcon, findIconTop, pickStableCandidate, resampleBilinear, sweepScales, groupNumberBlocks, subImage } from './vision.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const GRAB_PS1 = path.resolve(HERE, '..', 'scripts', 'grab.ps1')
const ICON_DIR = path.resolve(HERE, '..', 'public', 'resource-icons')

/* ============================================================
   资源表：**按游戏来**（表在 shared/game-profiles.js）
   ============================================================

   以前这里是写死的三个资源（星声 / 体力 / 贝币）加一个图标宽度比例，
   换个游戏就得改识别代码，而且改一处漏一处。现在每个游戏一份 profile：
   认哪几个资源、图标模板叫什么文件、拿哪个当锚点、图标占画面多宽，全在表里。

   识别流程本身不认识「鸣潮」「异环」这几个字 —— 它只认 profile。
   哪个游戏由**订单上选的游戏**决定（game_name），一路传到 recognizeScreenOnce。
   ============================================================ */

/** 默认游戏（鸣潮）的资源表。老调用方还在用它 */
export const RESOURCE_ICONS = DEFAULT_PROFILE.resources

/** 默认游戏的资源名（老名字留着，routes 里还在用） */
export const SCREEN_RESOURCES = profileKeys(DEFAULT_PROFILE)

/** 某个游戏要认的资源名 */
export function screenResourcesFor(game) {
  return profileKeys(profileForGame(game))
}

/** 某个游戏里，这个资源用哪个模板文件（不带 .png） */
export function templateFileFor(game, key) {
  const p = profileForGame(game)
  const hit = (p.resources || []).find((r) => r.key === key)
  return hit ? hit.file : ''
}

/**
 * 锚点最少要多少分才拿它去定标。
 * 实测：16:10 分辨率下真图标是 0.90~0.93，界面里别的亮块最高只到 0.70 上下。
 * 但超宽分辨率下游戏 UI 按高度缩、图标本身小，同一个真图标只有 0.75~0.77 ——
 * 所以 [0.75, 0.85) 这一段不当场采信，要再找一个伙伴图标确认，
 * 见下面 ANCHOR_FALLBACK_SCORE 和 recognizeFrame 里的 confirmAnchor。
 */
const ANCHOR_MIN_SCORE = 0.85

/**
 * 字高低于这个值就提醒用户核对。
 *
 * **只对 Windows 自带 OCR 生效**：实测它在字高 ≤22px 时会读错位数
 * （超宽屏下 `2174` 读成 `21`），而 PP-OCR 系的引擎（Umi-OCR / PaddleOCR-json /
 * RapidOCR-json）在同样的字高下是全对的 —— 实测装上 RapidOCR-json 之后
 * 超宽那三档从 2/6 变成 6/6。所以这条提醒跟着当前引擎走，
 * 免得用好引擎时也一直提示「字太小」白白增加噪音。
 */
const SMALL_DIGIT_H = 26

/**
 * 锚点的「待确认」下限。分数落在 [0.75, 0.85) 时不当场采信，
 * 要「那一簇里还能找到伙伴图标」才认（见 recognizeFrame 里的 confirmAnchor）。
 * 超宽分辨率下真图标就是 0.76 上下，所以这条线不能更高；
 * 而假阳性（地图截图上的亮块 0.62~0.70）凑不出伙伴，所以也不能更低。
 */
const ANCHOR_FALLBACK_SCORE = 0.75

/** 锚点「很确定」的线。到这条线以上就信任它定标，不再为别的图标跑全条带 */
const ANCHOR_STRONG = 0.9

/**
 * 同一分辨率的定标缓存：屏幕尺寸 → 锚点图标在哪、多大。
 * 只在同一台机器同一个窗口有效，所以按「宽x高」存；用户改窗口大小或换分辨率
 * 自然会用新的 key 重新定标。故意不落盘 —— 换台机器/换游戏版本就该重新认。
 */
const calibrations = new Map()
const CALIB_TTL = 10 * 60 * 1000

function pruneCalibrations() {
  const now = Date.now()
  for (const [k, v] of calibrations) if (now - v.at > CALIB_TTL) calibrations.delete(k)
}

/** 认到多少分才算数。实测真样本在 0.88~0.94（NCC 口径），0.62 是留了余量又不放水的位置 */
export const MIN_SCORE = 0.62

/** 顶栏占据画面上方这一比例以内 —— 比例，不是像素，换分辨率才不散架 */
export const TOP_BAND_RATIO = 0.14

/**
 * 「锚点周围多大算同一簇」的单侧半径，占画面宽度的比例。
 * 0.2236 = 6.5 × 0.0344，也就是鸣潮原来那句「锚点图标宽的 6.5 倍」——
 * 换算成比例是为了让图标更小的游戏（异环 0.0225）也够宽，见 recognizeFrame。
 */
export const CLUSTER_RATIO = 0.2236

/**
 * 顶栏图标宽度占画面宽度的比例 —— **每个游戏不一样，所以从 profile 取**。
 * 鸣潮：同一张截图缩到 1152×720 ~ 3840×2400 十种分辨率量出来都是 0.0344；
 * 异环：2559×1599 实测 0.0225 —— 只有鸣潮的 65%，
 * 用同一个比例去扫，档位整个偏掉，图标一个都找不到。
 * 换成「图标宽 / 画面高」两个游戏都会散架（16:10 与 21:9 差 43%）：
 * 游戏 UI 是按横向分辨率缩放的，所以宽度才是不变量。
 */
const ICON_W_RATIO = DEFAULT_PROFILE.iconWidthRatio

/**
 * 搜索图里图标的目标像素宽度。太小（20px 上下）时贝币那种内部偏平的图标
 * 分数会掉到 0.6 以下认不出来；49 是实测「分数稳、又不费算力」的位置。
 */
const WORK_ICON_W = 49

/** 老名字留着，但含义从「150 像素」变成了「按高度的比例算出来的像素」 */
export const TOP_BAND = 150

/* ============================================================
   图标模板：加载 + 从截图现场抠一个（新版才有的「自学习」）
   ============================================================ */

/** 每个游戏一份模板缓存（模板文件按游戏区分，见 game-profiles.js 的 file 字段） */
const tplCaches = new Map()

/**
 * 载入某个游戏的图标模板。两个来源，按优先级：
 *   1. `data/resource-icons/<名字>.png` —— 用户自己抠的，最贴合他的游戏版本；
 *   2. `public/resource-icons/<名字>.png` —— 随程序带的默认模板。
 * 都没有就跳过这个资源（识别不了总比认错好）。
 *
 * 两个游戏的模板靠**文件名**区分（异环的带 nte- 前缀），所以查找逻辑一行没改：
 * 异环的「体力」是另一张卡（nte-tili.png），和鸣潮的 tili.png 互不干扰。
 */
export function loadTemplates({ force = false, profile = DEFAULT_PROFILE } = {}) {
  const p = profile || DEFAULT_PROFILE
  const cached = tplCaches.get(p.id)
  if (cached && !force) return cached
  const dirs = [
    path.resolve(HERE, '..', 'data', 'resource-icons'),
    ICON_DIR,
  ]
  const refs = []
  for (const r of p.resources || []) {
    for (const dir of dirs) {
      const file = path.join(dir, `${r.file}.png`)
      try {
        const img = decodePNG(fs.readFileSync(file))
        // 打分口径挂在图对象上：模板会一路被 resample 成各档缩放，
        // 挂在图上就不用在每个 findIcon 调用点再传一遍（漏一处就只有一档是新口径）。
        img.maskedNcc = Boolean(p.maskedNcc)
        refs.push({
          key: r.key,
          anchor: Boolean(r.anchor),
          // 允许认到 0 的资源：异环的都市活力会显示 0/700，那个 0 是真值，
          // 而默认把 0 当噪声（界面上到处是 0，很容易配错）。
          allowZero: Boolean(r.allowZero),
          aliases: r.aliases || [r.key],
          file,
          from: dir.includes(`${path.sep}data${path.sep}`) ? 'custom' : 'bundled',
          img,
          tpl: compileTemplate(img, { name: r.key, maskedNcc: Boolean(p.maskedNcc) }),
        })
        break
      } catch {
        /* 这个目录没有就试下一个 */
      }
    }
  }
  tplCaches.set(p.id, refs)
  return refs
}

/** 供 /api/ocr/status 用：这台机器手上到底有几个图标模板（按游戏分开报） */
export function templateStatus(game) {
  const p = profileForGame(game)
  const refs = loadTemplates({ profile: p })
  return {
    game: p.id,
    count: refs.length,
    items: refs.map((r) => ({ key: r.key, from: r.from, w: r.img.width, h: r.img.height, hasMask: r.tpl.hasMask })),
    missing: (p.resources || []).filter((r) => !refs.some((x) => x.key === r.key)).map((r) => r.key),
  }
}

/**
 * 从一张截图里现场抠一个图标（用来给新游戏/新版本做模板）。
 * 做法：在给定的小矩形里找亮度最高的那块，按亮度阈值收一个紧贴的框，
 * 再连**右边那一列背景**一起带上（模板需要一点背景才知道「图标 vs 背景」的对比）。
 */
export function extractIconTemplate(img, box) {
  const { x, y, w, h } = box
  let lumMax = 0
  for (let j = y; j < Math.min(img.height, y + h); j++) {
    for (let i = x; i < Math.min(img.width, x + w); i++) {
      const p = (j * img.width + i) * 3
      const l = (img.px[p] + img.px[p + 1] + img.px[p + 2]) / 3
      if (l > lumMax) lumMax = l
    }
  }
  // 阈值取「区域内最亮像素」的比例。0.36 是实测扫出来的一组最优值
  // （扫了 0.36/0.42/0.48/0.55/0.62 × 边距 0/8%/16%/26%，按「分数 + 位置对不对」评）：
  //   · 太低（0.36 加边距）会把旁边的东西也框进来，位置就开始偏；
  //   · 太高（0.48 以上）只框住亮核心，分数掉到 0.45 上下，锚点根本定不出来。
  // 0.36 正好能把图标的**暗色勾边**收进来 —— 这一段是判别信息的一部分，
  // 丢了它「图标 vs 背景」的对比就没了。
  const thr = lumMax * 0.36
  let minx = 1e9
  let miny = 1e9
  let maxx = -1
  let maxy = -1
  for (let j = y; j < Math.min(img.height, y + h); j++) {
    for (let i = x; i < Math.min(img.width, x + w); i++) {
      const p = (j * img.width + i) * 3
      const l = (img.px[p] + img.px[p + 1] + img.px[p + 2]) / 3
      if (l <= thr) continue
      if (i < minx) minx = i
      if (i > maxx) maxx = i
      if (j < miny) miny = j
      if (j > maxy) maxy = j
    }
  }
  if (maxx < 0) return null
  // 再留一点点背景边距（1~3px），只要够让模板边缘不是硬切就行
  const side = Math.max(maxx - minx + 1, maxy - miny + 1)
  const pad = Math.min(3, Math.max(1, Math.round(side * 0.03)))
  minx = Math.max(0, minx - pad)
  miny = Math.max(0, miny - pad)
  maxx = Math.min(img.width - 1, maxx + pad)
  maxy = Math.min(img.height - 1, maxy + pad)
  return { img: crop(img, minx, miny, maxx - minx + 1, maxy - miny + 1), box: { x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1 } }
}

/* ============================================================
   一帧的识别：找图标 → 拼数字 → 出候选
   ============================================================ */

/** 在一个数字块列表里，找图标右边那块 */
function pickNumberBlock(blocks, icon, tplImg, scale, { gapRatio = 4.5, allowZero = false } = {}) {
  const right = icon.x + tplImg.width * scale
  const iconCy = icon.y + (tplImg.height * scale) / 2
  const iconH = tplImg.height * scale
  let best = null
  for (const b of blocks) {
    const num = parseNumber(b.text, { allowZero })
    // 默认不要 0：界面里到处是 0，认到 0 基本等于认错了。
    // 但异环的都市活力会真的显示 0/700 —— 那个资源的 allowZero 打开时才收 0。
    if (num === null || (!allowZero && num <= 0)) continue
    // 必须在图标右边（允许 2px 误差），不能离得太远
    const dx = b.x - right
    if (dx < -2 || dx > iconH * gapRatio) continue
    // 纵向得有重叠：数字中心落在图标高度的 ±0.8 倍以内
    const dy = Math.abs(b.cy - iconCy)
    if (dy > iconH * 0.8) continue
    const cost = dx + dy * 2
    if (!best || cost < best.cost) best = { block: b, value: num, cost, dx }
  }
  return best
}

/**
 * 图标模板只覆盖了固定 HUD 皮肤；有些页面会把资源图标换成另一套绘制，
 * 但数字格式仍然稳定。这里只接管两个很明确的格式：体力的「当前/上限」
 * 和贝币的长整数，再用同一排剩余数字推断星声。结果标成 ocr-layout，
 * 让前端明确提示用户核对，不把它伪装成一次高置信度的模板命中。
 */
function ocrLayoutFallback(blocks, existing, img) {
  const used = new Set(existing.map((h) => h.key))
  const valid = (b) => {
    if (!b || !b.text || (b.score !== null && b.score !== undefined && b.score < 0.55)) return false
    const value = parseNumber(b.text)
    return value !== null && value > 0
  }
  const list = blocks.filter(valid).map((b) => ({ block: b, value: parseNumber(b.text) }))
  const fraction = list
    .map((x) => {
      const m = String(x.block.text).replace(/[／]/g, '/').match(/^(\d+)\s*\/\s*(\d+)$/)
      return m ? { ...x, current: Number(m[1]), limit: Number(m[2]) } : null
    })
    .filter((x) => x && x.current > 0 && x.current <= x.limit && x.limit >= 100 && x.limit <= 300 && x.block.x > img.width * 0.55)
    .sort((a, b) => b.block.x - a.block.x)[0]
  const out = []
  const make = (key, item, warn) => ({
    key,
    value: item.value,
    text: item.block.text,
    score: +Math.max(0.55, Math.min(0.74, Number(item.block.score) || 0.62)).toFixed(3),
    x: Math.max(0, Math.round(item.block.x - item.block.h * 0.9)),
    y: Math.max(0, Math.round(item.block.y)),
    scale: 1,
    anchored: false,
    digit_h: Math.round(item.block.h || 0),
    warn,
    source: 'ocr-layout',
    block: { x: item.block.x, y: item.block.y, w: item.block.w, h: item.block.h, text: item.block.text, parts: item.block.parts },
    from: 'ocr',
  })
  if (fraction && !used.has('体力')) {
    out.push(make('体力', fraction, '按当前/上限格式识别，请核对'))
    used.add('体力')
  }

  const plain = list
    .filter((x) => !/[\/／]/.test(String(x.block.text)))
    .filter((x) => x.block.x > img.width * 0.45)
    .sort((a, b) => a.block.x - b.block.x)
  const shell = plain.filter((x) => String(Math.trunc(x.value)).length >= 6).sort((a, b) => b.value - a.value)[0]
  if (shell && !used.has('贝币')) {
    out.push(make('贝币', shell, '按长整数识别，请核对'))
    used.add('贝币')
  }
  if (!used.has('星声')) {
    const candidates = plain.filter((x) => x !== shell)
    // 只有一个短数字时，要求它在 HUD 右侧或同排确实看到了体力格式，
    // 避免把关卡等级、页码之类的数字写进资源栏。
    const star =
      candidates.length > 1 || fraction
        ? candidates[candidates.length - 1]
        : plain.length === 1 && plain[0].block.x > img.width * 0.62
          ? plain[0]
          : null
    if (star) out.push(make('星声', star, '按同排数字识别，请核对'))
  }
  return out
}

/**
 * 认一帧。img 是 {width,height,px}，words 是 OCR 的词框。
 * 返回 { hits, seen, size, ms, anchor }：
 *   hits   = [{ key, value, score, x, y, scale, block }] 只含分数达标的
 *   seen   = 所有「图标看到了」的记录（含没配到数字的），方便排查
 *   anchor = 这一帧用哪个图标定标（哪个分数最高、位置最可信）
 *
 * 两遍扫描（这是 accuray 的关键）：
 *   第一遍：每个模板在自己的缩放档位里全条带找一遍，拿到候选。
 *   第二遍：挑**分数最高的那个当锚点**（锚点的尺寸 = 这一屏的缩放系数），
 *          其余图标只在锚点附近这个「簇」里重找一次。
 *
 * 为什么要第二遍：顶栏的资源是**挤在一起的一排**，而 NCC 的绝对分数量级
 * 跟图标本身好不好认有关 —— 实测同一张图上星声真位置 0.88 分，贝币真位置
 * 只有 0.72~0.75，而界面左边别处一个完全无关的亮块能刷到 0.697。
 * 只取最高分就会把贝币认到左边的假块上，于是读到隔壁星声的 2174。
 * 有了锚点就能说清楚「资源都在这一簇里」：离锚点超过十几倍图标宽度的
 * 候选直接不认 —— 实测那个假块离锚点 34 倍，一刀就切掉了。
 */
export function recognizeFrame(img, words, {
  minScore = MIN_SCORE,
  profile = DEFAULT_PROFILE,
  refs = null,
  keys = null,
  topBandRatio = TOP_BAND_RATIO,
  timeBudgetMs = 1500,
  timings = null,
} = {}) {
  // profile 收对象也收游戏名：调用方（路由/自检）两种都能传
  const p = profile && profile.resources ? profile : profileForGame(profile)
  /**
   * 只找这一屏**真的会有**的那几个。
   *
   * 一屏只需要两三个资源，但以前每帧都把整份模板表扫一遍，于是：
   *   · 定标锚点按「谁最像锚点」挑，常常挑到本屏根本没有的那个（异环的地图页
   *     优先挑甲硬币，那屏压根没有甲硬币），锚点定不出来 → 退化成一堆全条带
   *     搜索，又慢又容易认到隔壁的图标上（实测地图页把 255 挂到了甲硬币名下）；
   *   · 白扫的那几个图标每帧都占时间。
   * 传了 keys 就只找这几个，锚点也从这几个里挑。不传 = 老行为（整份表都找）。
   */
  const wanted = Array.isArray(keys) && keys.length ? new Set(keys) : null
  const iconRefs = (refs || loadTemplates({ profile: p })).filter((r) => !wanted || wanted.has(r.key))
  const t0 = Date.now()
  const mark = (k) => {
    if (timings) timings[k] = (timings[k] || 0) + (Date.now() - t0)
  }
  if (timings) timings.setup = Date.now() - t0
  // 顶栏条带：按画面高度的比例取，不写死像素
  const bandH = Math.max(48, Math.round(img.height * topBandRatio))
  pruneCalibrations()
  const bandWords = (words || []).filter((w) => w && w.cy < bandH + 8)
  const blocks = groupNumberBlocks(bandWords)
  const seen = []
  const deadline = timeBudgetMs > 0 ? t0 + timeBudgetMs : 0
  const budget = () => (deadline ? Math.max(0, deadline - Date.now()) : 0)
  /**
   * 「还剩多少时间，但至少给 ms」。
   *
   * 定出锚点之后每个图标都还要一遍搜索，而 budget() 到点之后返回 0 ——
   * 0 在 findIcon 里的意思是**不限时**（不传预算的调用方用它），于是「预算用完」
   * 反而变成了「随便跑」：异环实测定出锚点之后这一遍跑了 11 秒。
   * 保底给一点时间，既不漏图标，也不会无限跑。
   */
  const leftOr = (ms) => (deadline ? Math.max(budget(), ms) : 0)

  // 这一屏「图标大概多大」：**跟画面宽度成比例，不跟高度**。
  //
  // 这一条是实测量出来的（同一张截图缩到十种分辨率，看图标到底多大）：
  //   图标宽 / 画面宽 = 0.0344，在 1152×720 到 3840×2400 之间是常数；
  //   而「图标宽 / 画面高」在 16:10 下是 0.0551、21:9 下变成 0.0791 —— 差 43%。
  // 之前按高度估，在 2560×1080 / 1920×822 这种超宽比下档位整个偏掉，
  // 锚点定不出来，数字就读错（实测那两种比例全错）。
  // 游戏 UI 是按横向分辨率缩放的，所以宽度才是那个不变量。
  const expectedIconW = Math.max(8, img.width * (p.iconWidthRatio || ICON_W_RATIO))
  // 不同页面的 HUD 不一定按同一个轴缩放：武器页图标接近 80px，地图页
  // 同一套资源可能只有 45px。放宽搜索档位，避免模板尺寸正确却完全错过。
  //
  // 铺多宽可以按游戏给（profile.scaleSpan/scaleSteps），但**别为了省时间收窄**：
  // 异环试过从 11 档 / 5.5 倍收到 6 档 / 2.56 倍，档距变成 21%，同一个金币
  // 的分数从 0.971 掉到 0.807，锚点那一遍反而更慢（分数低就一直找下一个候选）。
  // 带掩码的 NCC 对尺度很敏感，档位密才是对的。两个游戏现在都用默认值。
  const scalesFor = (tplImg) => sweepScales((expectedIconW / tplImg.width) * 1.1, p.scaleSpan || 2.35, p.scaleSteps || 11)

  /* 锚点那一簇有多宽（单侧，按画面宽度的比例）。
     原来写的是「锚点图标宽的 6.5 倍」：对鸣潮成立（6.5 × 0.0344 = 0.2236），
     但异环图标只有画面宽的 0.0225，6.5 倍只剩 14.6%，而它顶栏三个资源横跨
     62%~86% 的画面宽 —— 最右边那个（环石）落在簇外，锚点认出来了它却永远
     认不到（实机复现）。换成比例后鸣潮的数值和以前一模一样。 */
  const clusterSpan = img.width * (p.clusterRatio || CLUSTER_RATIO)

  /* ---- 工作图：只裁顶栏那条带 ----
     「任何分辨率都跑得动」的关键就在这一步：4K 截图整张缩一遍要 200ms 以上，
     而这条带只占画面高度的 14%。裁完再缩，一次缩放给所有图标共用。

     缩多少不是随便定的：**让图标在搜索图上有固定的像素宽度**（WORK_ICON_W）。
     太小（20px 上下）时银币那种内部偏平的图标分数会掉到 0.6 以下、认不出来；
     太大又白费算力。按这个定，1280 和 4K 认出同一个分数、花同一份时间。
     比例记住：带内坐标 ÷workScale 就是原图坐标。

     小画面上这一步还会**放大**（workScale > 1）。这不是浪费：数字本来就小，
     放大了 OCR 才认得全 —— 实测 1152×720 时不放大只能认出 `217`（丢了最后一位），
     放大之后就完整认出 `2174`。放大只作用在这一条带上，代价可以忽略。 */
  const maxWorkW = 2600
  const workScale = Math.min(maxWorkW / img.width, Math.max(0.2, WORK_ICON_W / expectedIconW))
  const bandImg = resampleBilinear(
    subImage(img, 0, 0, img.width, bandH),
    Math.max(16, Math.round(img.width * workScale)),
    Math.max(8, Math.round(bandH * workScale))
  )
  const work = { img: bandImg, scale: workScale }
  const band = { x: 0, y: 0, w: img.width, h: bandH }

  /* ---- 第一遍：定锚点 ----
     顶栏资源图标在实测里分数差得很开：星声（内部对比强）0.88~0.93，
     贝币（一枚银币，内部偏平）只有 0.70~0.77。所以先用最有把握的那个全条带定标，
     其余图标再按它的尺度在小范围里找 —— 又快又不会认到别处去。

     要是上一次在同一分辨率下已经定过标（用户连着点「识别画面」就是这种情况），
     直接用上次的锚点：同一台机器同一个窗口，位置不会跳。
     这一条把「第一次贵、之后每帧几十毫秒」变成常态。 */
  // 定标缓存按「游戏 + 分辨率」存。两个游戏的图标大小差一倍（0.0344 vs 0.0225），
  // 共用一份定标会把异环的图标按鸣潮的尺度去复核，直接找不到。
  const calibKey = `${p.id}:${img.width}x${img.height}`
  const cached = calibrations.get(calibKey)
  // 这一帧认到的图标位置，收尾时写回缓存（每个 key 单独记，下帧直接复查）
  const calibIcons = cached && cached.icons ? { ...cached.icons } : {}
  const anchorPriority = [...iconRefs].sort((a, b) => (b.anchor ? 1 : 0) - (a.anchor ? 1 : 0) || (b.img?.width || 0) - (a.img?.width || 0))
  const quick = anchorPriority[0]
  let anchor = null
  let anchorR = null
  if (quick && quick.img) {
    const tryHit = (opts) => {
      const found = findIconTop(img, quick.img, { work, minScore, timeBudgetMs: leftOr(1200), ...opts }, 3)
      return pickStableCandidate(found, { margin: 0.92, minScore })
    }
    /**
     * 锚点够不够格。分两档，因为「这张图跟模板有多像」跟画面物理大小有关：
     * 16:10 的画面里顶栏图标有 88px 宽，超宽（21:9 / 2.34:1）下游戏 UI 按高度缩，
     * 图标只有 66~88px、字更小，同一个真图标的分数会从 0.93 掉到 0.76 附近。
     * 所以分数在 [0.75, 0.85) 之间时**不直接采信**，而是要求「锚点那一簇里
     * 还能再找到一个伙伴图标」才认 —— 实测那一档的假阳性（一张地图截图上
     * 某个亮块 0.62~0.70）凑不出第二个伙伴，所以这一条能把它挡在外面，
     * 同时不误伤超宽下的真图标。
     */
    const confirmAnchor = (hit) => {
      if (!hit) return null
      if (hit.score >= ANCHOR_MIN_SCORE) return hit
      if (hit.score < ANCHOR_FALLBACK_SCORE) return null
      const near = {
        x: Math.max(0, hit.x - clusterSpan),
        y: 0,
        w: Math.min(img.width, hit.x + clusterSpan) - Math.max(0, hit.x - clusterSpan),
        h: bandH,
      }
      for (const other of iconRefs) {
        if (!other.img || other === quick) continue
        const found = findIconTop(img, other.img, { region: near, baseScale: hit.scale, scaleFactor: 1.3, scaleSteps: 7, work, coarseStep: 3, minScore, timeBudgetMs: Math.min(leftOr(400), 400) }, 1)
        const best = pickStableCandidate(found, { margin: 0.92, minScore })
        if (best) return { ...hit, confirmed_by: other.key, confirm_score: +best.score.toFixed(3) }
      }
      return null
    }
    if (cached && cached.key === quick.key) {
      const aw = quick.img.width * cached.scale
      const near = {
        x: Math.max(0, cached.x - aw * 2),
        y: Math.max(0, cached.y - aw),
        w: aw * 5,
        h: Math.max(24, quick.img.height * cached.scale * 3),
      }
      // 缓存命中只是「核对上次的位置」，给它一份小预算就够；
      // 主力预算留给全条带定标。budget() 为 0 表示不限时（不会传进来）。
      const cachedBudget = deadline ? Math.min(budget(), 400) : 0
      const hit = tryHit({ region: near, baseScale: cached.scale, scaleFactor: 1.15, scaleSteps: 5, timeBudgetMs: cachedBudget })
      if (hit && hit.score >= ANCHOR_MIN_SCORE) {
        anchor = { ...hit, key: quick.key, tpl: quick.img }
        anchorR = quick
      }
    }
    if (!anchor) {
      const hit = confirmAnchor(tryHit({ region: band, scales: scalesFor(quick.img), coarseStep: 3, timeBudgetMs: leftOr(1200) }))
      if (hit) {
        anchor = { ...hit, key: quick.key, tpl: quick.img }
        anchorR = quick
        calibrations.set(calibKey, { key: quick.key, x: hit.x, y: hit.y, scale: hit.scale, at: Date.now() })
      }
    }
  }
  mark('anchor')

  /* ---- 第二遍：锚点定标 → 其余图标只在锚点那一簇里找（几档细尺度） ---- */
  const MAX_CLUSTER = clusterSpan * 2.3 // 和原来的 aw*15 等价（15/6.5 ≈ 2.3）
  const hits = []
  for (const r of iconRefs) {
    if (!r.img) continue
    // 时间上限只在**没定出锚点**时生效：那种情况说明这张图和模板差得远
    // （比如给了一张地图截图），三个图标各扫一遍全条带又慢又没意义。
    // 定出锚点了就照常跑完 —— 有锚点时每个图标只要几十毫秒，而且少了它
    // 真会漏（实测把这条写死成「到点就停」会把贝币漏掉）。
    if (!anchor && deadline && Date.now() > deadline) break
    let hit = null
    let fallbackHits = null
    // 上一次在同一分辨率下认到过这个图标 → 记住它在哪、多大。
    // 同一台机器同一个窗口，它不会跑；只在原位附近小范围复核一遍就够了，
    // 这一步比重新全条带扫快两个数量级。「盯着屏幕」连拍时全靠它。
    const memo = cached && cached.icons ? cached.icons[r.key] : null
    if (memo && Math.abs(memo.x - img.width / 2) < img.width) {
      const tw = r.img.width * memo.scale
      const th = r.img.height * memo.scale
      const near = { x: Math.max(0, memo.x - tw), y: Math.max(0, memo.y - th), w: tw * 3, h: th * 3 }
      const found = findIconTop(img, r.img, { region: near, baseScale: memo.scale, scaleFactor: 1.12, scaleSteps: 5, work, coarseStep: 3, minScore, timeBudgetMs: leftOr(300) }, 1)
      const best = pickStableCandidate(found, { margin: 0.92, minScore })
      if (best) hit = best
    }
    if (!hit && anchor && anchorR && r !== anchorR) {
      const near = {
        x: Math.max(0, anchor.x - clusterSpan),
        y: 0,
        w: Math.min(img.width, anchor.x + clusterSpan) - Math.max(0, anchor.x - clusterSpan),
        h: bandH,
      }
      const local = findIconTop(img, r.img, { region: near, baseScale: anchor.scale, scaleFactor: 1.25, scaleSteps: 7, work, coarseStep: 3, minScore, timeBudgetMs: leftOr(700) }, 3)
      hit = pickStableCandidate(local, { margin: 0.92, minScore })
      // 簇里没找到就到此为止：**不再跑一遍全条带**。
      // 这一步以前很贵（每个找不到的图标多花 0.9 秒，一帧就两秒），收益却极小 ——
      // 那个图标要么本来就只在别处（体力不在顶栏），要么这屏根本没有；
      // 两种情况都该老实说「没认到」，让人自己填。
      // 只有锚点自己也弱（说明这张图跟模板差别大，可能是新版本界面）时，
      // 才值得退回全条带再找一遍看看。
      if (!hit && anchor.score < ANCHOR_STRONG) {
        fallbackHits = findIconTop(img, r.img, { region: band, scales: scalesFor(r.img), work, coarseStep: 3, minScore, timeBudgetMs: leftOr(700) }, 3)
        const wide = pickStableCandidate(fallbackHits, { margin: 0.92, minScore })
        if (wide && Math.abs(wide.x - anchor.x) <= MAX_CLUSTER) hit = wide
        else if (wide) {
          seen.push({ key: r.key, score: +wide.score.toFixed(3), found: false, why: '离锚点太远' })
          continue
        }
      }
    } else if (!hit) {
      if (anchor && r === anchorR) {
        // 锚点就是它自己：第一遍已经全条带扫过一遍了，直接用那次的命中。
        // 以前这里又扫了一遍全条带 —— 异环实测白花 4.5 秒（一帧总共才十几秒），
        // 而且扫出来的还是同一个位置。
        hit = anchor
      } else {
        // 压根没定出锚点 → 老老实实全条带找
        const found = findIconTop(img, r.img, { region: band, scales: scalesFor(r.img), work, coarseStep: 3, minScore, timeBudgetMs: leftOr(700) }, 3)
        hit = pickStableCandidate(found, { margin: 0.92, minScore })
        fallbackHits = found
      }
    }
    if (!hit) {
      seen.push({ key: r.key, score: fallbackHits?.[0] ? +fallbackHits[0].score.toFixed(3) : null, found: false })
      continue
    }
    calibIcons[r.key] = { x: hit.x, y: hit.y, scale: hit.scale }
    const picked = pickNumberBlock(blocks, hit, r.img, hit.scale, { allowZero: r.allowZero })
    // 字太小就标出来让人多看一眼 —— 但只对 Windows 自带 OCR 标：
    // 它在字高 ≤22px 时会读错位数，PP-OCR 系的引擎不会（见 SMALL_DIGIT_H 的注释）。
    const engineId = ocrStatus().engine
    const digitH = picked ? picked.block.h : 0
    const smallText = digitH > 0 && digitH < SMALL_DIGIT_H && engineId === 'windows'
    const rec = {
      key: r.key,
      value: picked ? picked.value : null,
      text: picked ? picked.block.text : null,
      score: +hit.score.toFixed(3),
      x: hit.x,
      y: hit.y,
      scale: +hit.scale.toFixed(3),
      anchored: Boolean(anchor && r !== anchorR),
      digit_h: Math.round(digitH),
      warn: smallText ? '字太小，务必核对' : '',
      block: picked ? { x: picked.block.x, y: picked.block.y, w: picked.block.w, h: picked.block.h, text: picked.block.text, parts: picked.block.parts } : null,
      from: r.from || 'bundled',
    }
    seen.push(rec)
    if (picked) hits.push(rec)
  }

  // 模板完全没有覆盖到的 HUD 皮肤仍可能有可靠的 OCR 数字格式。
  // 只在对应资源尚未命中时补入，模板命中始终优先。
  //
  // **只对写明 layoutFallback 的游戏跑**（现在只有鸣潮）：那套启发式是按鸣潮顶栏
  // 写的（「当前/上限 且上限 100~300」= 体力、「≥6 位长整数」= 贝币、剩下的短数字
  // 推成星声）。异环的数字长得完全不一样（方斯 4,116,889 也是长整数），
  // 拿同一套去套只会凭空编出几个看着挺像的值 —— 那比认不出来更糟。
  const fallback = p.layoutFallback ? ocrLayoutFallback(blocks, hits, img) : []
  for (const rec of fallback) {
    if (!hits.some((h) => h.key === rec.key)) {
      hits.push(rec)
      seen.push(rec)
    }
  }

  // 同一个 key 认到多个就留分最高的那个（详情页里也可能有同款图标）
  const byKey = new Map()
  for (const h of hits) {
    const cur = byKey.get(h.key)
    if (!cur || h.score > cur.score) byKey.set(h.key, h)
  }
  const anchorOut = anchor ? { key: anchor.key, x: anchor.x, y: anchor.y, scale: +anchor.scale.toFixed(3), score: +anchor.score.toFixed(3) } : null
  // 写回定标缓存（同一分辨率下次直接用）
  if (anchor) {
    calibrations.set(calibKey, { key: anchor.key, x: anchor.x, y: anchor.y, scale: anchor.scale, icons: calibIcons, at: Date.now() })
  } else if (Object.keys(calibIcons).length) {
    calibrations.set(calibKey, { ...(cached || {}), icons: calibIcons, at: Date.now() })
  }
  return { hits: [...byKey.values()], seen, anchor: anchorOut, size: [img.width, img.height], bandH, blocks, ms: Date.now() - t0 }
}

/* ============================================================
   截屏
   ============================================================ */

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
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', GRAB_PS1, '-Out', path.resolve(outPath)]
      const gameWindow = activeGameWindow()
      if (gameWindow?.hwnd) args.push('-WindowHandle', gameWindow.hwnd)
      child = spawn('powershell.exe', args, {
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

/**
 * 只 OCR 顶栏那条带，而不是整张截图。
 *
 * 为什么：OCR 的开销基本和像素数成正比，而我们要读的数字全在这条带里。
 * 实测 2559 宽整图 OCR 要 0.5~2 秒，只喂这条带不到 200ms，识别结果一样 ——
 * 数字块本来就是按 cy < bandH 过滤的，喂整图纯属浪费。
 *
 * 坐标：带是从 y=0 裁的，所以 x 不用换算；y 只是整体上移，而带内的相对
 * 位置关系（数字和图标同一行）完全不变，识别层只用到相对关系。
 */
/**
 * 喂给 OCR 的那条带要缩放到多宽。
 *
 * 这一条是实测定下来的：Windows 自带 OCR 对「字高」很敏感。
 *   · 1152×720 那条带（数字只有 12px 高）按原尺寸喂，只认出 `217`，丢了最后一位；
 *     放到 1.5 倍以上才稳定认出 `2174`。
 *   · 1600 宽时字高已经够（17px），1.19 倍就认全。
 * 所以按「目标字高」反推缩放，并给一个小画面的下限（1.5 倍）当保险：
 * 目标是字高 ~20px，但**小画面至少放到 1.5 倍**，大画面该缩就缩。
 * 上限 2600 宽是为了别把这条带变成几 MB 的 PNG（OCR 开销跟像素数成正比）。
 *
 * 顺带说清楚一个真实的边界：**超宽分辨率（21:9 之类）下游戏 UI 按高度缩，
 * 顶栏数字只有 14~22px 高，Windows 自带 OCR 就是认不出来**（放大到 3 倍也一样，
 * 因为原图信息量就那么多）。这不是逻辑问题 —— 那种情况会诚实留空，
 * 要认全得装设置页里说的本地 OCR 引擎（PP-OCR 系对这种小字强得多）。
 */
function ocrTargetWidth(img, bandH) {
  void bandH
  const digitH = Math.max(6, img.width * 0.0115)
  const ideal = (img.width * 20) / digitH
  const floor = img.width * 1.7
  const cap = 2600
  return Math.max(img.width * 0.5, Math.min(cap, Math.max(floor, Math.min(ideal, cap))))
}

async function ocrBand(img, bandH, { lang = 'zh-Hans-CN' } = {}) {
  const band = subImage(img, 0, 0, img.width, Math.min(img.height, bandH))
  const target = ocrTargetWidth(img, bandH)
  const shrink = target / band.width
  const small = Math.abs(shrink - 1) > 0.05 ? resampleBilinear(band, Math.round(band.width * shrink), Math.round(band.height * shrink)) : band
  // mode:'ascii' = 优先系统临时目录：这条带图可能被喂给 RapidOCR-json 那种
  // 外部 exe，而它读不了中文路径（见 src/ocr.mjs 的 asciiCopy）。
  // 系统临时目录写不进去时才退到 data/tmp —— 那时候至少 Python 后端还能用。
  const tmp = scratchFile('xfc-band', '.png', { mode: 'ascii' })
  fs.writeFileSync(tmp, encodePNG(small))
  try {
    const ocr = await ocrImage(tmp, { lang })
    if (!ocr.ok) return ocr
    // 把坐标换算回原图尺度（识别层要拿它和原图坐标的图标比对）
    const words =
      Math.abs(shrink - 1) > 0.05
        ? (ocr.words || []).map((w) => ({ ...w, x: w.x / shrink, y: w.y / shrink, w: w.w / shrink, h: w.h / shrink, cx: w.cx / shrink, cy: w.cy / shrink }))
        : ocr.words
    return { ...ocr, words, band_scale: +shrink.toFixed(3), band_size: [small.width, small.height] }
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* 清不掉就算了 */
    }
  }
}

/**
 * 截图文件 → 识别一帧（前端点「识别截图」走的就是这条路）。
 *
 * 只有 PNG 能被自己解像素（零依赖里没有 JPEG 解码器），
 * 所以 JPEG 进来时**不报错**：照常跑 OCR 把文字行给出来，
 * 但明说「这张图只能看字、认不了图标数字」，让人换 PNG 重截，
 * 而不是丢一个看不懂的解码异常给用户。
 */
export async function recognizeImageFile(filePath, { lang = 'zh-Hans-CN', minScore = MIN_SCORE, game = '', keys = null } = {}) {
  const profile = profileForGame(game)
  const buf = fs.readFileSync(filePath)
  let img = null
  let decodeError = ''
  try {
    img = decodePNG(buf)
  } catch (err) {
    decodeError = err.message
  }
  if (!img) {
    const ocr = await ocrImage(filePath, { lang })
    if (!ocr.ok) return { ok: false, error: `${decodeError}；另外 OCR 也没跑起来：${ocr.error}` }
    return {
      ok: true,
      resources: {},
      hits: [],
      seen: [],
      anchor: null,
      pixel: false,
      warning: `这张图自己解不了像素（${decodeError}），所以只能给文字、认不了图标旁边的数字。游戏里重新截一张 PNG 就行。`,
      size: null,
      lines: ocr.lines,
      engine: ocr.engine || 'windows',
      ms: 0,
    }
  }
  const bandH = Math.max(48, Math.round(img.height * TOP_BAND_RATIO))
  const ocr = await ocrBand(img, bandH, { lang })
  if (!ocr.ok) return { ok: false, error: ocr.error }
  const r = recognizeFrame(img, ocr.words, { minScore, profile, keys })
  return {
    ok: true,
    game: profile.id,
    resources: Object.fromEntries(r.hits.map((h) => [h.key, h.value])),
    hits: r.hits,
    seen: r.seen,
    anchor: r.anchor,
    pixel: true,
    candidates: r.hits.map((h) => ({ text: h.text, value: h.value, key: h.key, score: h.score, source: h.source || 'icon', warn: h.warn || '', x: h.x, y: h.y, iconAt: h.x })),
    size: r.size,
    lines: ocr.lines,
    engine: ocr.engine || 'windows',
    ms: r.ms,
  }
}

/* ============================================================
   跨帧投票：同一个数字认到 N 次才采纳
   这是用户明确要的「数量要准确」——不是认一次就写进去。
   ============================================================ */

const sessions = new Map()
const SESSION_TTL = 5 * 60 * 1000
const MAX_SESSIONS = 32

export function resetVotes(id) {
  sessions.delete(id)
  return { ok: true }
}

function pruneSessions() {
  const now = Date.now()
  for (const [k, v] of sessions) if (now - v.touched > SESSION_TTL) sessions.delete(k)
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value)
}

function tally(session, frame, minVotes) {
  for (const h of frame.hits) {
    let slot = session.votes.get(h.key)
    if (!slot) {
      slot = { counts: new Map(), scores: new Map(), best: null }
      session.votes.set(h.key, slot)
    }
    slot.counts.set(h.value, (slot.counts.get(h.value) || 0) + 1)
    slot.scores.set(h.value, Math.max(slot.scores.get(h.value) || 0, h.score))
    if (!slot.best || h.score > slot.best.score) slot.best = h
  }
  session.frames++
  const agreed = {}
  const pending = {}
  for (const [key, slot] of session.votes) {
    let top = null
    for (const [value, n] of slot.counts) {
      if (!top || n > top.n || (n === top.n && (slot.scores.get(value) || 0) > (slot.scores.get(top.value) || 0))) {
        top = { value, n }
      }
    }
    if (!top) continue
    const score = slot.scores.get(top.value) || 0
    if (top.n >= minVotes) agreed[key] = { value: top.value, votes: top.n, score: +score.toFixed(3) }
    else pending[key] = { value: top.value, votes: top.n, need: minVotes, score: +score.toFixed(3) }
  }
  return { agreed, pending }
}

/**
 * 看一帧屏幕并投票。同一 id 连续调用，票数会累计。
 * 返回 { ok, resources, agreed, pending, hits, seen, size, engine }
 *   resources：累计到 minVotes 的（可以放心往表单里填）
 *   pending  ：看见了但还没复核够的（前端显示「正在核对 1/2」）
 */
export async function recognizeScreenOnce({
  id = 'default',
  game = '',
  minVotes = 2,
  minScore = MIN_SCORE,
  lang = 'zh-Hans-CN',
  timeBudgetMs = 0,
  keys = null,
} = {}) {
  // 认哪个游戏由调用方给（前端传的是**订单上选的游戏**）
  const profile = profileForGame(game)
  pruneSessions()
  // 截图落点：优先系统临时目录（纯 ASCII），写不进去再退 data/tmp。
  // 这一步要是写不了，整个识别就没法开始 —— 所以它必须有退路。
  const tmp = scratchFile('xfc-screen', '.png', { mode: 'ascii' })
  try {
    const g = await grabScreen(tmp)
    if (!g.ok) return { ok: false, error: g.error }
    const buf = fs.readFileSync(tmp)
    let img = null
    try {
      img = decodePNG(buf)
    } catch (err) {
      return { ok: false, error: `截到的图自己解不了像素（${err.message}）` }
    }
    const bandH = Math.max(48, Math.round(img.height * TOP_BAND_RATIO))
    const ocr = await ocrBand(img, bandH, { lang })
    if (!ocr.ok) return { ok: false, error: ocr.error }
    // 单帧最多花 1.5 秒：认不出来就该老实返回，让前端接着看下一帧
    const frame = recognizeFrame(img, ocr.words, { minScore, timeBudgetMs: 1500, profile, keys })
    let session = sessions.get(id)
    if (!session) {
      session = { votes: new Map(), frames: 0, touched: Date.now(), game: profile.id }
      sessions.set(id, session)
    }
    session.touched = Date.now()
    const { agreed, pending } = tally(session, frame, Math.max(1, minVotes))
    return {
      ok: true,
      game: profile.id,
      resources: Object.fromEntries(Object.entries(agreed).map(([k, v]) => [k, v.value])),
      agreed,
      pending,
      votes: session.votes.size ? Object.fromEntries([...session.votes].map(([k, s]) => [k, Object.fromEntries(s.counts)])) : {},
      hits: frame.hits,
      seen: frame.seen,
      frames: session.frames,
      size: frame.size,
      engine: ocr.engine || 'windows',
      ms: frame.ms,
    }
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

/** 这台机器能不能用屏幕识别 */
export function screenAvailable() {
  const st = ocrStatus()
  return { available: st.available, engine: st.engine, screen: process.platform === 'win32', platform: process.platform }
}

/* 导出给老调用方（imgmatch 的 crop/resize 还在别处用） */
export { crop, resize, encodePNG, subImage, buildIntegral, findIcon }

/**
 * 只 OCR 顶栏那条带（导出是为了能单独测「OCR 在这台机器上认不认得出」，
 * 不用整套识别跑一遍）。返回的 band_scale / band_size 说明它把带缩放成了多大。
 */
export const ocrTopBand = (img, bandH, opts) => ocrBand(img, bandH, opts)
