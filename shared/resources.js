/* ============================================================
   订单进度的「资源对比」：星声 / 体力 / 贝币（鸣潮）、甲硬币 / 方斯 / 环石 …
   ============================================================

   纯函数，只 import 一份纯数据（shared/game-profiles.js）—— 服务端、新 React 表单
   （client/resource-field.jsx）、订单详情页共用这一份。

   以前这几段只活在旧订单页里，React 要记进度就得再抄一遍；
   抄出偏差的话，「本次消耗」就会算错，而这种错没人看得出来
   （填进去的数字都是对的，只有差值悄悄不对）。

   现在要认哪些资源是**按游戏**定的：默认的 RES_KEYS 是所有游戏的并集，
   老记录照样读得回来（认不出的标签进「其他」，一个字不丢）；
   界面上只显示这张单所属游戏的那几个 —— 用 resourceKeysFor()。
   ============================================================ */

import { allResourceKeys, profileForGame, profileKeys } from './game-profiles.js'

/**
 * 一张单混了两个游戏时（比如「鸣潮 + 异环」），一行文本装不下两套数：
 * 「体力」在两边都记，但根本不是同一个数。所以多游戏时按【游戏名】分段存：
 *
 *   【鸣潮】星声 2174 体力 255 贝币 2508319 【异环】甲硬币 929484 方斯 4116889
 *
 * 分段只在**多游戏**时才出现 —— 单游戏订单存出来的还是原来那一行，
 * 老记录、老报表、老断言全都当没这回事（这也是敢动这里的前提）。
 */
const SECTION_RE = /【([^】]+)】/g

/** 「标签 + 数字」的通用长相：星声 105 / 4,116,889 / 255.5 都认 */
const PAIR_RE = /([^\s\d,，./·、【】]+)\s*([\d][\d,，]*(?:\.\d+)?)/g

/** 所有游戏资源的并集。名字跟 src/ocr.mjs 的 RESOURCE_ALIASES 对应 */
export const RES_KEYS = allResourceKeys()

/** 这个游戏要记的资源（按游戏里从左往右的顺序）。认不出游戏名就用默认那份 */
export function resourceKeysFor(game) {
  return profileKeys(profileForGame(game))
}

/**
 * 把「星声 105 体力 86」这种文本拆成标准资源 + 其他。
 * 老记录（甚至「原石 12000 / 树脂 160」这种）都读得回来，
 * 认不出的标签原样留在「其他」里，一个字都不丢。
 */
export function parseResources(text, keys = RES_KEYS) {
  const raw = String(text || '').trim()
  const out = { other: '' }
  for (const k of keys) out[k] = ''
  if (!raw) return out
  const re = PAIR_RE
  re.lastIndex = 0
  const found = []
  let m
  while ((m = re.exec(raw))) found.push([m[1], m[2].replace(/[,，]/g, '')])
  if (!found.length) {
    out.other = raw
    return out
  }
  const leftovers = []
  for (const [k, v] of found) {
    if (keys.includes(k)) out[k] = v
    else leftovers.push(`${k} ${v}`)
  }
  out.other = leftovers.join(' · ')
  return out
}

/** 反过来拼回一行文本（还是人一眼能读的样子） */
export function buildResources(vals, other, keys = RES_KEYS) {
  const parts = []
  for (const k of keys) {
    const v = String((vals && vals[k]) ?? '').trim()
    if (v) parts.push(`${k} ${v}`)
  }
  const o = String(other || '').trim()
  if (o) parts.push(o)
  return parts.join(' ')
}

/** 前后差值，给「本次消耗」那行用 */
export function resourceDelta(beforeText, afterText, keys = RES_KEYS) {
  const a = parseResources(beforeText, keys)
  const b = parseResources(afterText, keys)
  const out = []
  for (const k of keys) {
    const x = Number(a[k])
    const y = Number(b[k])
    if (!a[k] || !b[k] || !Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push({ key: k, diff: y - x })
  }
  return out
}

/* ---------------- 多游戏：按【游戏】分段 ---------------- */

/**
 * 拆成 [{ game, text }]。
 * 没有【】标记就返回 null —— 单游戏订单和所有老记录都是这个情况，
 * 调用方一律走原来的平铺逻辑，不用关心分段这回事。
 */
export function splitResourceSections(text) {
  const raw = String(text || '').trim()
  if (!raw || !raw.includes('【')) return null
  const out = []
  SECTION_RE.lastIndex = 0
  let m
  let cursor = 0
  let current = null
  while ((m = SECTION_RE.exec(raw))) {
    const head = raw.slice(cursor, m.index).trim()
    // 上一段的正文就是「上一个标记」到「这一个标记」之间的东西
    if (current) current.text = head
    else if (head) out.push({ game: '', text: head }) // 第一个【】之前还有内容
    current = { game: m[1].trim(), text: '' }
    out.push(current)
    cursor = SECTION_RE.lastIndex
  }
  const tail = raw.slice(cursor).trim()
  if (current) current.text = tail
  else if (tail) out.push({ game: '', text: tail })
  return out
}

/** 取某个游戏那一段的正文。没有分段（或没这一段）时：没分段给全文，有分段给空串 */
export function sectionText(text, game) {
  const secs = splitResourceSections(text)
  if (!secs) return String(text || '').trim()
  const hit = secs.find((s) => s.game === game)
  return hit ? hit.text : ''
}

/**
 * 把每段的正文拼回一行。
 * 只有一段（或者只有一段有内容）就不加【游戏】标记 —— 单游戏订单存出来的
 * 和以前一模一样，这一点是刻意的。
 */
export function joinResourceSections(list) {
  const parts = (list || [])
    .map((s) => ({ game: String((s && s.game) || '').trim(), body: String((s && s.body) || '').trim() }))
    .filter((s) => s.body)
  if (!parts.length) return ''
  if (parts.length === 1) return parts[0].body
  return parts.map((s) => (s.game ? `【${s.game}】${s.body}` : s.body)).join(' ')
}

/** 文本里出现过的所有标签（认不认得出都算）—— 报表要按原文比差值时用 */
export function labelsIn(text) {
  const out = []
  PAIR_RE.lastIndex = 0
  let m
  while ((m = PAIR_RE.exec(String(text || '')))) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/**
 * 差值列表，分段文本按段各算一次（带上 game 名），普通文本照旧。
 *   opts.keys：认哪些键（默认并集）
 *   opts.includeUnknown：把文本里出现过的标签也一起比 —— 报表用它，
 *     老数据里可能写着别的游戏/别的写法，报表不该因为「不在并集里」就少一行。
 */
export function resourceDeltaList(beforeText, afterText, opts = {}) {
  const includeUnknown = !!opts.includeUnknown
  const baseKeys = opts.keys || RES_KEYS
  const keysOf = (b, a) => {
    if (!includeUnknown) return baseKeys
    const extra = [...labelsIn(b), ...labelsIn(a)].filter((k) => !baseKeys.includes(k))
    return extra.length ? [...baseKeys, ...new Set(extra)] : baseKeys
  }
  const secs = splitResourceSections(beforeText) || splitResourceSections(afterText)
  if (!secs) return resourceDelta(beforeText, afterText, keysOf(beforeText, afterText)).map((d) => ({ ...d, game: '' }))

  const games = opts.games && opts.games.length ? opts.games : [...new Set(secs.map((s) => s.game).filter(Boolean))]
  const out = []
  for (const g of games) {
    const b = sectionText(beforeText, g)
    const a = sectionText(afterText, g)
    for (const d of resourceDelta(b, a, keysOf(b, a))) out.push({ ...d, game: g })
  }
  return out
}

/**
 * 上一条进度里「做之后」的资源。
 * 连着记的时候，这一次的「做之前」就是上一次的「做之后」——
 * 直接带出来，省得每回都重抄一遍。
 */
export function lastResourcesAfter(order) {
  const list = (order && order.progress) || []
  const sorted = [...list].sort(
    (a, b) => String(a.happened_on || '').localeCompare(String(b.happened_on || '')) || (a.id || 0) - (b.id || 0)
  )
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].resources_after) return sorted[i].resources_after
  }
  return ''
}

/** 「本次消耗：星声 −20 · 体力 −40」这行字。分段文本会自动带上游戏名 */
export function deltaText(beforeText, afterText, fmtQty = (n) => String(n), games = null) {
  const deltas = resourceDeltaList(beforeText, afterText, { games })
  if (!deltas.length) return ''
  const multi = deltas.some((d) => d.game)
  return (
    '本次消耗：' +
    deltas
      .map((d) => {
        const sign = d.diff < 0 ? '−' : d.diff > 0 ? '+' : '±'
        const name = multi && d.game ? `${d.game} ${d.key}` : d.key
        return `${name} ${sign}${fmtQty(Math.abs(d.diff))}`
      })
      .join(' · ')
  )
}
