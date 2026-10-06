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
  const re = /([^\s\d,，./·、]+)\s*([\d][\d,，]*(?:\.\d+)?)/g
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

/** 「本次消耗：星声 −20 · 体力 −40」这行字 */
export function deltaText(beforeText, afterText, fmtQty = (n) => String(n)) {
  const deltas = resourceDelta(beforeText, afterText)
  if (!deltas.length) return ''
  return (
    '本次消耗：' +
    deltas
      .map((d) => {
        const sign = d.diff < 0 ? '−' : d.diff > 0 ? '+' : '±'
        return `${d.key} ${sign}${fmtQty(Math.abs(d.diff))}`
      })
      .join(' · ')
  )
}
