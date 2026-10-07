/**
 * 把 OCR 认出来的服务名对齐到库里的服务项 —— 自动比价里第二难的一步。
 *
 * 为什么不能只用「相等」判断：OCR 出来的名字和库里的名字几乎不会一模一样。
 * 实拍帧里见过的偏差：
 *
 *   · 前缀噪声     `重璃月` / `通枫丹`（「重」「通」是画面上的装饰或误识）
 *   · 带说明       `森林会记住一切` 其实对应库里的 `森林书`
 *   · 带数量前缀   `76只活爹兰那罗` → 库里的 `活爹兰那罗`
 *   · 分隔符不同   `渔获/竭泽/灰河渡手：本体+满精` → 库里可能写成 `本体+满精`
 *   · 层级不同     `黑海岸` 和 `黑海岸群岛` 同时在库里
 *
 * 所以打分用的是几种信号的加权，而不是单一规则：
 *   · 归一化后完全相等            → 1.0
 *   · 一方是另一方的前缀/后缀      → 0.80 + 0.20×长度比（「重璃月」vs「璃月」）
 *   · 一方包含另一方（在中间）      → 0.70 + 0.25×长度比
 *   · 否则用字符二元组 Dice 系数
 *   · 单位一致再补一点（`15/期` 和 unit_label='期' 的 `深塔`）
 *
 * 最后做**全局贪心配对**：所有 (候选名, 服务项, 分数) 按分数从高到低分配，
 * 一个服务项只能被一个候选名占用，一个候选名也只认一个服务项。
 * 不这样做的话，`黑海岸` 和 `黑海岸群岛` 会互相抢，两个候选名可能都指到同一个服务项上。
 */

import { cjkCount } from './price-parse.mjs'

/** 归一化时要去掉的标点和空白 —— 这些在不同视频里写法完全随机 */
const PUNCT = /[\s\-_·、,，。.：:；;！!？?（）()《》【】\[\]<>/\\|+*"'“”‘’~—–＃#@&]/g
/** 名字里的行业通用词，比对时没有区分度，去掉 */
const NOISE_WORDS = /(?:代肝|代练|代打|价格表|价格|报价|单价|包月|套餐|服务|项目|元|块钱|块|r|R|￥|¥)/g

/** 归一化成可比较的形式：只留汉字/字母/数字 */
export function normalizeName(raw) {
  return String(raw || '')
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(PUNCT, '')
    .replace(NOISE_WORDS, '')
    .toLowerCase()
    .trim()
}

/** 字符二元组集合 */
function bigrams(text) {
  const out = new Set()
  for (let i = 0; i < text.length - 1; i++) out.add(text.slice(i, i + 2))
  return out
}

/** 编辑距离（滚动数组，只要距离值） */
export function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const curr = new Array(b.length + 1)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    prev = curr.slice()
  }
  return prev[b.length]
}

/** Dice 系数：两个字符串的二元组重合度，0~1 */
export function diceCoefficient(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const gram of A) if (B.has(gram)) shared += 1
  return (2 * shared) / (A.size + B.size)
}

/**
 * 归一化编辑距离相似度。
 *
 * 两道闸：
 * · 短名字（<3 字）不用 —— 两个字错一个字就 0.5，太不稳；
 * · **首字必须相同**。中文名字的首字是最有区分度的一位，而 OCR 认错首字的情况
 *   远少于认错中间的生僻字。这条闸专门用来挡「同后缀不同前缀」的误配：
 *   `黎娜西塔` vs `黎那汐塔` 首字都是「黎」，是同一个地方被认错了两个字，该救；
 *   `潮汐任务` vs `危行任务` 首字不同，虽然编辑距离一样是 2，但这是两个不同的任务，
 *   绝不能因为分数一样就被当成同一个。
 */
function editSimilarity(a, b) {
  if (a.length < 3 || b.length < 3) return 0
  if (a[0] !== b[0]) return 0
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length)
}

/**
 * 滑窗模糊匹配：在长名字上滑一个和短名字差不多长的窗口，逐窗比编辑距离。
 *
 * 为什么光有整体编辑距离不够：实拍里 `黎那汐塔` 被认成 `黎娜西塔全图探索` ——
 * 既错了两个字（那→娜、汐→西），又多了一截后缀（全图探索）。整体比下来
 * 编辑距离 6 / 长度 8，相似度只有 0.25，怎么都够不着阈值；
 * 但滑一个 4 字窗口正好套住 `黎娜西塔`，距离 2，相似度 0.5。
 *
 * 窗口同样要求首字一致，理由和上面一样。
 * 只在短名字 ≥4 字时启用：2~3 字的名字（`日体`、`深塔`、`七丘`）滑窗太容易撞上无关的字。
 */
function windowedEditSimilarity(a, b) {
  const shorter = a.length <= b.length ? a : b
  const longer = a.length <= b.length ? b : a
  if (shorter.length < 4 || longer.length < shorter.length) return 0
  let best = 0
  for (let len = shorter.length - 1; len <= shorter.length + 1; len++) {
    if (len < 4 || len > longer.length) continue
    for (let i = 0; i + len <= longer.length; i++) {
      const window = longer.slice(i, i + len)
      if (window[0] !== shorter[0]) continue
      const score = 1 - levenshtein(window, shorter) / Math.max(window.length, shorter.length)
      if (score > best) best = score
    }
  }
  return best
}

/**
 * 两个归一化名字的相似度，同时告诉调用方**这个分是哪个信号给的**。
 *
 * 为什么要区分信号：错别字匹配（edit / windowed）天生比包含关系弱，
 * 4 字名字错 2 个字就只有 0.5。这个分该被接受，但**不能用和包含关系同一个阈值** ——
 * 否则要么放进来一堆 0.5 的垃圾，要么把真正的错别字全挡在外面。
 *
 * 四个信号各有各的适用面：
 *
 * · **前缀/后缀包含** —— OCR 多认或漏认首尾一两个字（`重璃月`、`通枫丹`）。
 *   这种偏差落在首尾时 Dice 会被稀释到 0.5 上下，但「一个是另一个的后缀」本身是极强的信号。
 *   系数随长度比变化：`黑海岸` 落在 `黎娜西塔加珑十一图+黑海岸` 里也是后缀，
 *   但那是个打包短语，长度比小的时候分数自然就压下去了。
 *
 * · **Dice 二元组** —— 处理中间多字少字。
 *
 * · **整体编辑距离** —— 处理错别字（`黎那汐塔` → `黎娜西塔`，二元组一个都不重合）。
 *
 * · **滑窗编辑距离** —— 处理「错字 + 多一截后缀」叠在一起的情况。
 */
export function compareNames(a, b) {
  const left = normalizeName(a)
  const right = normalizeName(b)
  if (!left || !right) return { score: 0, signal: 'none' }
  if (left === right) return { score: 1, signal: 'exact' }

  const shorter = left.length <= right.length ? left : right
  const longer = left.length <= right.length ? right : left
  const ratio = shorter.length / longer.length

  let containment = 0
  if (longer.includes(shorter)) {
    const atEdge = longer.startsWith(shorter) || longer.endsWith(shorter)
    containment = atEdge ? 0.55 + 0.45 * ratio : 0.45 + 0.45 * ratio
  }
  const options = [
    { score: containment, signal: 'contain' },
    { score: diceCoefficient(left, right), signal: 'dice' },
    { score: editSimilarity(left, right), signal: 'edit' },
    { score: windowedEditSimilarity(left, right), signal: 'windowed' },
  ]
  options.sort((x, y) => y.score - x.score)
  return options[0]
}

/** 只要分数（测试和展示用） */
export function similarity(a, b) {
  return compareNames(a, b).score
}

/**
 * 单位一致性加成。
 * `15/期` 对上 unit_label='期' 的 `深塔`，比对上同名的别的项更可信。
 */
function unitBonus(parsed, service) {
  const unit = String(parsed.unit || '').trim()
  if (!unit || unit === '元') return 0
  const label = String(service.unit_label || '').trim()
  if (label && label === unit) return 0.06
  // 价格表里「幕」常写成「章」之类，只要一方含另一方也算沾边
  if (label && (label.includes(unit) || unit.includes(label))) return 0.03
  return 0
}

/* ============================================================
   单位口径
   ============================================================ */

/**
 * 单位等价组。
 *
 * 为什么要归一：库里 `日体` 的单位写的是 `30天`（月价），视频里写的是
 * `日体：5R/天，150/月` —— 5 和 150 都是这行上的数，但只有 150 能和库里的 70 比。
 * 不区分单位的话，`5/天` 会被当成「日体降到 5 元」的建议，这是纯粹的错价。
 */
const UNIT_GROUPS = [
  ['月', '30天', '31天', '包月', '每月', '一个月', '整月'],
  ['天', '日', '一天', '每日', '1天'],
  ['周', '7天', '一周', '每周'],
  ['期', '赛季'],
  ['个', '只', '件'],
  ['小时', '时'],
  ['次', '单'],
]

/** 把一个单位归到它的等价组代表；认不出来的原样返回 */
export function unitGroup(unit) {
  const text = String(unit || '').trim()
  if (!text) return null
  for (const group of UNIT_GROUPS) if (group.includes(text)) return group[0]
  for (const group of UNIT_GROUPS) if (group.some((alias) => text.endsWith(alias))) return group[0]
  return text
}

/**
 * 样本单位和库内单位是不是一个口径。
 *
 * · 库里没写单位 → 什么都算兼容（库里 48 个服务项单位是空的）
 * · 视频里没写单位 → 算兼容但标记为「口径未知」，不能凭这个下结论
 * · 两边都有单位 → 必须同组
 */
export function unitCompatibility(sampleUnit, serviceUnit) {
  const service = unitGroup(serviceUnit)
  const sample = unitGroup(sampleUnit)
  if (!service) return { ok: true, certain: false }
  if (!sample) return { ok: true, certain: false }
  return { ok: sample === service, certain: true }
}

/* ============================================================
   名字的预处理：冒号取有效名、打包短语拆段
   ============================================================ */

/** 名字里的连接符：`A+B`、`A、B`、`A加B` 都表示「这是好几项」 */
const BUNDLE_SPLIT = /[+＋、，,]|加(?=[\u4e00-\u9fa5])/

/**
 * 取出「有效名字」。
 *
 * `精托：日常体力+活动` 是「名字：说明」的写法 —— 冒号后面在解释这一项包含什么，
 * 价格属于冒号前面那一段。不切的话它会因为含 `+` 被当成打包短语而丢掉，
 * 而这一项（精托=238）本来是完全对得上的。
 *
 * 只认第一个冒号，且要求冒号前面至少 2 个汉字（`0.1r：柔灯铃…` 那种价格在前的
 * 写法冒号前面是空的，不能被切）。
 */
export function effectiveName(raw) {
  const text = String(raw || '')
  const at = text.search(/[：:]/)
  if (at > 0) {
    const head = text.slice(0, at)
    if (cjkCount(head) >= 2) return head
  }
  return text
}

/** 把「好几项串在一起」的名字拆成各段（短于 2 个汉字的不算一段）*/
export function splitSegments(raw) {
  return String(raw || '')
    .split(BUNDLE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => cjkCount(s) >= 2)
}

/** 是不是「好几项串在一起」*/
export function isBundle(raw) {
  return splitSegments(raw).length >= 2
}

/**
 * 把解析结果摊平成「一个名字对一个价格」的待匹配项。
 *
 * 打包短语分两种情况，处理方式必须不同：
 *
 * · **带 /单位 的**（`蒙德、璃月、稻妻主线25/幕`）—— 这是**单价**，
 *   每个地区的主线都按 25/幕 算。所以要拆成 `蒙德`、`璃月`、`稻妻主线` 三条，
 *   各自去匹配自己的服务项，中位数才能分别算。
 *
 * · **不带单位的**（`黎娜西塔加珑十一图+黑海岸800`）—— 这是**整包一个价**，
 *   800 是这一整套的钱，摊给「黑海岸」就是错价。这种只允许和库内服务名
 *   完全相等时才匹配（万一库里真有个同名的打包项），否则一律不猜。
 */
export function expandParsedNames(parsedNames) {
  const out = []
  let seq = 0
  for (const parsed of parsedNames || []) {
    const eff = effectiveName(parsed.name)
    const segments = splitSegments(eff)
    if (segments.length >= 2) {
      if (parsed.unitKind === 'slash') {
        for (const segment of segments) out.push({ ...parsed, key: `${parsed.video ?? ''}#${seq++}`, name: segment, label: parsed.name, fromBundle: true })
      } else {
        // 整包价：只认完全同名的服务项
        out.push({ ...parsed, key: `${parsed.video ?? ''}#${seq++}`, name: eff, label: parsed.name, strictExact: true, fromBundle: true })
      }
      continue
    }
    out.push({ ...parsed, key: `${parsed.video ?? ''}#${seq++}`, name: eff, label: parsed.name })
  }
  return out
}

/**
 * 给一批候选名和一批服务项做配对。
 *
 * 关键点：**唯一性约束是按视频算的，不是全局算的。**
 *
 * 同一个服务项在不同视频里写法不同（`黎那汐塔350` / `重黎那汐塔350`），
 * 这些写法都应该算进中位数 —— 中位数的意义就是「多个视频的平均口径」。
 * 如果全局只允许一个名字占用一个服务项，第二个视频的样本会被直接丢掉。
 *
 * 但**同一个视频内**必须互斥：
 *   · 一个服务项只认一个名字（否则 `黑海岸` 和 `黑海岸群岛` 会互相抢）
 *   · 一个名字只认一个服务项
 * 所以按视频分组，每组内各做一次贪心配对。
 *
 * @param {Array} parsedNames  [{ name, price, unit, video, ... }]
 * @param {Array} services    [{ id, name, unit_label, base_price, category_id, category_name }]
 * @returns {{ matched: Array, unmatched: Array }}
 */
export function matchServices(parsedNames, services, opts = {}) {
  // 两档阈值：包含/Dice 这类结构信号够 0.62 才信；错别字信号（edit/windowed）
  // 天生分低（4 字错 2 字就只有 0.5），单独用 0.5 这一档，并要求更大的领先优势。
  const threshold = opts.threshold ?? 0.62
  const margin = opts.margin ?? 0.05
  const fuzzyThreshold = opts.fuzzyThreshold ?? 0.5
  const fuzzyMargin = opts.fuzzyMargin ?? 0.1

  const pool = (services || []).filter((s) => s && s.name)
  // 先把「名字：说明」和「打包短语」摊平，再按视频分组
  const list = expandParsedNames(parsedNames)

  const groups = new Map()
  for (const parsed of list) {
    const key = String(parsed.video ?? '')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(parsed)
  }

  const matched = []
  const matchedKeys = new Set()

  for (const group of groups.values()) {
    const candidates = []
    for (const parsed of group) {
      const scored = []
      for (const service of pool) {
        // 整包价只认同名服务项：800 是「黎娜西塔+珑十一图+黑海岸」这一整套的钱
        if (parsed.strictExact && normalizeName(parsed.name) !== normalizeName(service.name)) continue
        const { score: base, signal } = compareNames(parsed.name, service.name)
        const score = Math.min(1, base + unitBonus(parsed, service))
        const floor = signal === 'edit' || signal === 'windowed' ? fuzzyThreshold : threshold
        if (score >= floor) scored.push({ service, score, signal })
      }
      scored.sort((a, b) => b.score - a.score)
      for (const entry of scored) {
        candidates.push({
          parsed,
          service: entry.service,
          score: entry.score,
          signal: entry.signal,
          runnerUp: scored[1] ? scored[1].score : 0,
        })
      }
    }
    /**
     * 组内按分数降序分配：分高的先挑，避免「黑海岸群岛」被「黑海岸」抢走。
     *
     * 唯一性只约束「一个待匹配项 → 一个服务项」（用 key 去重）。
     * **不约束「一个服务项 → 一个待匹配项」**：同一个视频里同一个服务项可能
     * 出现两个不同口径的价（`周常：25r/周90r/月`），两个都要放进来，
     * 让 groupByService 去判断该用哪个、还是整票弃用。
     * 在这里按服务项去重的话，第二个价会静悄悄消失，连「有歧义」这件事都发现不了。
     */
    candidates.sort((a, b) => b.score - a.score || String(a.parsed.name).localeCompare(String(b.parsed.name), 'zh'))

    const usedParsed = new Set()
    for (const entry of candidates) {
      const parsedKey = entry.parsed.key
      if (usedParsed.has(parsedKey)) continue
      // 分数不够突出就别猜：两个服务项咬得很紧时，猜错比不猜更糟
      const isExact = entry.score >= 0.999
      const need = entry.signal === 'edit' || entry.signal === 'windowed' ? fuzzyMargin : margin
      if (!isExact && entry.score - entry.runnerUp < need) continue
      usedParsed.add(parsedKey)
      matchedKeys.add(parsedKey)
      matched.push({
        video: entry.parsed.video ?? '',
        service_id: entry.service.id,
        service_name: entry.service.name,
        service_unit: entry.service.unit_label || '',
        current_price: Number(entry.service.base_price) || 0,
        category_id: entry.service.category_id ?? null,
        category_name: entry.service.category_name || '',
        // 展示用原始名字（`蒙德、璃月、稻妻主线`），比对用的是拆出来的段（`蒙德`）
        parsed_name: entry.parsed.label || entry.parsed.name,
        matched_as: entry.parsed.name,
        price: entry.parsed.price,
        unit: entry.parsed.unit || '',
        // 来源证据要一路带到界面上：出价的那一帧原图 + OCR 认出来的整行原文。
        // 没有这两样，用户没法核对 OCR 有没有把数字认错。
        frame: entry.parsed.frame || '',
        line: entry.parsed.line || '',
        score: Math.round(entry.score * 1000) / 1000,
        signal: entry.signal,
        exact: isExact,
      })
    }
  }

  const unmatched = list
    .filter((p) => !matchedKeys.has(p.key))
    .map((p) => ({
      video: p.video ?? '',
      parsed_name: p.label || p.name,
      price: p.price,
      unit: p.unit || '',
      reason: p.strictExact ? 'bundle' : '',
      score: 0,
      exact: false,
    }))

  return { matched, unmatched }
}

/**
 * 把匹配结果按库内服务项归拢，并算出中位数。
 *
 * 同一个服务项会被好几个视频、好几种写法命中（`森林书` / `森林书140`），
 * 每个视频贡献一个价格样本，中位数就是「多个视频的平均口径」。
 *
 * 归拢前要做两道过滤，顺序不能反：
 *
 * 1. **单位口径**（先做）—— `日体：5R/天，150/月` 里 5 和 150 都在这一行上，
 *    但库里 `日体` 的单位是 `30天`，只有 150 能和它比。5/天 必须在这一步被剔掉，
 *    否则它进了中位数就是一个纯错价。剔掉的样本留在 excluded 里给用户看。
 *
 * 2. **一个视频一票** —— 同一个视频里如果同一个服务项被多条不同写法命中，
 *    只取分数高的那条。不这样做的话，一个啰嗦的视频（同一张表翻来覆去放）
 *    就能把中位数整个拽过去。
 *
 * @param {Array} matchedRows matchServices 的 matched
 * @param {{ minSamples?: number }} options
 */
export function groupByService(matchedRows, { minSamples = 3 } = {}) {
  const map = new Map()
  for (const row of matchedRows) {
    if (!map.has(row.service_id)) {
      map.set(row.service_id, {
        service_id: row.service_id,
        service_name: row.service_name,
        service_unit: row.service_unit,
        current_price: row.current_price,
        category_id: row.category_id,
        category_name: row.category_name,
        aliases: [],
        samples: [],
        excluded: [],
        best_score: 0,
        exact: false,
      })
    }
    const group = map.get(row.service_id)
    const compat = unitCompatibility(row.unit, row.service_unit)
    const sample = {
      video: row.video,
      parsed_name: row.parsed_name,
      matched_as: row.matched_as,
      price: row.price,
      unit: row.unit,
      score: row.score,
      signal: row.signal,
      frame: row.frame || '',
      line: row.line || '',
      unit_certain: compat.certain,
    }
    if (!compat.ok) {
      group.excluded.push({ ...sample, reason: `单位口径不同（视频是「${row.unit || '未标'}」，库内是「${row.service_unit}」）` })
      continue
    }
    if (!group.aliases.some((a) => a.parsed_name === row.parsed_name)) {
      group.aliases.push({ parsed_name: row.parsed_name, score: row.score, price: row.price, unit: row.unit, video: row.video })
    }
    group.samples.push(sample)
    if (row.score > group.best_score) group.best_score = row.score
    if (row.exact) group.exact = true
  }

  const out = []
  for (const group of map.values()) {
    /**
     * 置信度分层。**必须排在歧义判断前面**，顺序反了会误伤：
     *
     * `瑝珑梦州 满探索` 拿到 `梦州满探索` 230（库内名字是它的后缀，1.0）
     * 和 `梦州全包` 440（窗口模糊 0.5，只是都含「梦州」）。
     * 先分层的话，440 以「分低且已有更可信样本」被剔掉，剩下 230 一条，
     * 根本不是歧义，直接就能用；
     * 先判歧义的话，两条被当成「同一个视频给了多个口径」整票弃用 ——
     * 明明有一个是可信的，却因为一个明显不像的候选把好的也连坐了。
     *
     * 低分样本也不能和高分样本混着算中位数：230 和 440 取中位数是 335，
     * 比只用可信的 230 差得多。「全包」和「满探索」本来就是两项不同的服务。
     *
     * 一个高分样本都没有时，才退而用低分的，并把整条标成 low 让界面重点提示。
     */
    const high = group.samples.filter((s) => s.score >= 0.62)
    const low = group.samples.filter((s) => s.score < 0.62)
    let pool = group.samples
    let confidence = 'high'
    if (high.length) {
      pool = high
      for (const sample of low) {
        group.excluded.push({ ...sample, reason: `匹配分只有 ${sample.score}，这一项已有更可信的样本` })
      }
    } else if (low.length) {
      pool = low
      confidence = 'low'
    }

    /**
     * 一个视频一票，但**前提是这个视频只给了一个价**。
     *
     * 同一视频里同一个服务项出现两个不同价格时（`周常：25r/周90r/月` —— 周价和月价），
     * 库内 `周常` 的单位是空的，没法判断该用哪个，硬挑一个就是掷骰子。
     * 这种情况整票弃用，并把两个价都摆出来让用户自己定。
     *
     * 注意这一步在单位过滤和置信度分层**之后**：
     * `日体：5R/天，150/月` 里 5/天 已被单位挡掉，只剩 150/月，不算「多个价」。
     */
    const byVideo = new Map()
    for (const sample of pool) {
      if (!byVideo.has(sample.video)) byVideo.set(sample.video, [])
      byVideo.get(sample.video).push(sample)
    }
    const samples = []
    for (const [video, list] of byVideo) {
      const distinct = new Set(list.map((s) => s.price))
      if (distinct.size > 1) {
        for (const sample of list) {
          group.excluded.push({
            ...sample,
            reason: `同一个视频给了多个口径（${list.map((s) => `${s.price}${s.unit ? '/' + s.unit : ''}`).join(' 与 ')}），无法确定用哪个`,
          })
        }
        continue
      }
      samples.push(list.slice().sort((a, b) => b.score - a.score)[0])
    }

    const prices = samples.map((s) => s.price)
    out.push({
      ...group,
      samples,
      sample_count: samples.length,
      prices,
      confidence,
      suggested: null, // 由调用方按选定的平均算法填
      enough: samples.length >= minSamples,
      // 样本全被挡掉时，界面要能解释「为什么这项没建议」
      only_unit_mismatch: samples.length === 0 && group.excluded.some((e) => e.reason.startsWith('单位口径')),
      only_ambiguous: samples.length === 0 && group.excluded.length > 0 && group.excluded.every((e) => e.reason.startsWith('同一个视频')),
      only_low_confidence: samples.length === 0 && group.excluded.length > 0 && group.excluded.every((e) => e.reason.startsWith('匹配分')),
    })
  }
  // 样本多的排前面：先看证据足的
  return out.sort((a, b) => b.sample_count - a.sample_count || a.service_name.localeCompare(b.service_name, 'zh'))
}

export const __testing = { PUNCT, NOISE_WORDS, bigrams, unitBonus, BUNDLE_SPLIT }
