/* ============================================================
   按游戏配置「屏幕识别认什么、怎么打开」
   ============================================================

   纯数据 + 纯函数，不 import 任何东西 —— 服务端（src/vision/screen.mjs）和前端
   （client/forms/resource-field.jsx）共用这一份，跟 shared/resources.js 一个路子。

   以前这张表是写死在 src/vision/screen.mjs 和 client/forms/resource-field.jsx 里的：
   三个资源（星声 / 体力 / 贝币）、两个界面（B 背包 / M 地图）、图标宽度比例 0.0344。
   换游戏就得改代码，而且改一处漏一处。现在每个游戏一段配置，识别流程本身不认识
   「鸣潮」两个字。

   两个游戏的差别不只是资源名字：
     · 图标不一样 —— 异环的「体力」是另一张卡，和鸣潮的结晶波片不是同一个图；
     · 图标尺寸不一样 —— 实测异环顶栏图标宽 / 画面宽 = 0.0225，
       只有鸣潮 0.0344 的 65%，用同一个比例去扫是扫不到的；
     · 能记的值不一样 —— 异环记 5 个，鸣潮记 3 个。
   所以比例和资源表都必须在 profile 里，不能留全局常量。
   ============================================================ */

/**
 * 每个资源：
 *   key       标准名（存进 resources_before/after 文本里的就是它）
 *   file      图标模板文件名（不带 .png）。**跨游戏必须唯一** ——
 *             模板查找沿用原来的两档（data/resource-icons/ → public/resource-icons/），
 *             所以异环的用 nte- 前缀，不跟鸣潮的撞车，也不用改查找逻辑。
 *   aliases   OCR 认到这些字也算它（备用的文字兜底路径用）
 *   anchor    拿它当定标锚点（挑内部对比最强、最好认的那个）
 *   allowZero 允许认到 0。默认不允许：0 常常是「没认到」的噪声，
 *             但异环的都市活力会真的显示 0/700，那种 0 是有意义的。
 *
 * 游戏级还有两个开关：
 *   layoutFallback 允许按顶栏数字格式硬推（只对鸣潮成立）
 *   maskedNcc      打分用带掩码的 NCC（给「亮而光滑的图标压暗背景」那种画风用）
 */
export const GAME_PROFILES = [
  {
    id: 'wuwa',
    // 认游戏时按名字匹配（数据库 games.name / orders.game_name 存的就是这个）
    names: ['鸣潮', 'Wuthering Waves', 'wuwa'],
    // 顶栏图标宽 / 画面宽。实测 1152×720 ~ 3840×2400 十档都是 0.0344
    iconWidthRatio: 0.0344,
    // 这套按顶栏数字格式硬推的兜底只对鸣潮成立（见 src/vision/screen.mjs 的 ocrLayoutFallback）
    layoutFallback: true,
    stages: [
      { id: 'bag', title: '背包', key: 'B', resources: ['贝币', '星声'], openDelay: 1100 },
      { id: 'map', title: '地图', key: 'M', resources: ['体力'], openDelay: 1400 },
    ],
    resources: [
      { key: '星声', file: 'xingsheng', aliases: ['星声', '星聲'], anchor: true },
      { key: '体力', file: 'tili', aliases: ['结晶波片', '结晶', '波片', '体力', '存储体力'] },
      { key: '贝币', file: 'beibi', aliases: ['贝币', '貝幣', '贝壳币'] },
    ],
  },
  {
    id: 'nte',
    // 异环（Neverness to Everness）
    names: ['异环', '異環', 'Neverness to Everness', 'nte'],
    // 实测 2559×1599 截图：图标宽 57~62px / 2559 = 0.0225（约鸣潮的 65%）
    iconWidthRatio: 0.0225,
    /**
     * 打分口径：分母也用模板 core 那批像素的起伏（带掩码的 NCC，见 vision.mjs）。
     *
     * 异环的图标是「又亮又光滑」的画风：甲硬币内部几乎一整块渐变金色，压在
     * 近黑的底上。旧的整窗分母会被「图标 vs 背景」的反差撑大，模板跟它自己
     * 匹配只有 0.52 —— 实机截图复现，模板、真位置那块、命中那块三张放大后
     * 肉眼一模一样。锚点恰恰是甲硬币，于是锚点永远定不出来。
     * 换口径后自匹配 = 1，甲硬币 0.52 → 0.95 上下。
     *
     * 只对异环开：鸣潮那套阈值（MIN_SCORE / ANCHOR_MIN_SCORE）是按旧口径
     * 标定的，不动它就一点回归风险都没有。
     */
    maskedNcc: true,
    /**
     * 锚点那一簇的单侧半径（占画面宽的比例）。
     * 异环顶栏三个资源横跨 62%~86% 的画面宽，锚点（甲硬币）在最左边，
     * 到最右边的环石有 25% 画面宽 —— 鸣潮那套 0.2236 差一点就够不着。
     */
    clusterRatio: 0.32,
    // 键位和鸣潮一样：B 背包、M 地图（用户确认）
    stages: [
      { id: 'bag', title: '背包', key: 'B', resources: ['甲硬币', '方斯', '环石'], openDelay: 1100 },
      { id: 'map', title: '地图', key: 'M', resources: ['都市活力', '体力'], openDelay: 1400 },
    ],
    resources: [
      { key: '甲硬币', file: 'nte-jiayingbi', aliases: ['甲硬币', '甲幣'], anchor: true },
      { key: '方斯', file: 'nte-fangsi', aliases: ['方斯'] },
      { key: '环石', file: 'nte-huanshi', aliases: ['环石', '環石'] },
      // 都市活力显示成 0/700，只取斜杠前面的当前值，而 0 是真值
      { key: '都市活力', file: 'nte-dushi', aliases: ['都市活力', '活力'], allowZero: true },
      { key: '体力', file: 'nte-tili', aliases: ['体力', '體力'], allowZero: true },
    ],
  },
]

/** 认不出游戏名时用第一个（= 鸣潮，也就是改造前的老行为） */
export const DEFAULT_PROFILE = GAME_PROFILES[0]

/**
 * 游戏名（或 id）→ profile，认不出来是 null。
 *
 * 要判断「这个游戏配没配模板」时用这个，不要用 profileForGame：静默退回默认
 * 那份的代价是把鸣潮的模板套到别的游戏上，认出来的数字看着像真的 ——
 * 比认不出来糟得多（认不出来用户会去核对）。
 */
export function matchProfile(name) {
  const raw = String(name || '').trim()
  if (!raw) return null
  const lower = raw.toLowerCase()
  for (const p of GAME_PROFILES) {
    if (p.id === lower) return p
    for (const n of p.names) {
      const candidate = String(n).toLowerCase()
      if (candidate === lower) return p
    }
  }
  // 「异环（国服）」这种带后缀的也认一下
  for (const p of GAME_PROFILES) {
    for (const n of p.names) {
      const candidate = String(n).toLowerCase()
      if (candidate.length >= 2 && lower.includes(candidate)) return p
    }
  }
  return null
}

/**
 * 认不出来就退回默认那份（= 鸣潮）。只给「没有游戏名也要跑」的内部路径用，
 * 比如不带 game 的老调用。入口处判断游戏支持与否请用 matchProfile。
 */
export function profileForGame(name) {
  return matchProfile(name) || DEFAULT_PROFILE
}

/** 现在能认的游戏名（拼提示语用：告诉用户「能认哪些」） */
export function supportedGameNames() {
  return GAME_PROFILES.map((p) => (p.names && p.names[0]) || p.id)
}

/** 这个游戏要记的资源，按游戏里从左往右的顺序 */
export function profileKeys(profile) {
  return (profile?.resources || []).map((r) => r.key)
}

/** 某个界面要认的资源（profile 里 stages 的 resources） */
export function stageResources(profile, stageId) {
  const stage = (profile?.stages || []).find((s) => s.id === stageId)
  return stage ? stage.resources : []
}

/**
 * 所有游戏所有资源的并集 —— 给「老文本还能读回来」用。
 * 顺序：默认游戏（鸣潮）的先，保住历史记录拼出来的文本顺序不变，
 * 免得同一个值在改动前后拼成两行不同的字。
 */
export function allResourceKeys() {
  const out = []
  for (const p of [DEFAULT_PROFILE, ...GAME_PROFILES.filter((p) => p !== DEFAULT_PROFILE)]) {
    for (const key of profileKeys(p)) if (!out.includes(key)) out.push(key)
  }
  return out
}

/** key → 别名表（文字兜底路径用） */
export function aliasesOf(profile) {
  const out = {}
  for (const r of profile?.resources || []) out[r.key] = r.aliases || [r.key]
  return out
}
