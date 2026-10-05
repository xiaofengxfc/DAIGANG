/* ============================================================
   订单进度的「资源对比」：星声 / 体力 / 贝币
   ============================================================

   纯函数，不 import 任何东西 —— 服务端、旧订单页（public/js/views/orderbits.js）、
   新 React 表单（client/resource-field.jsx）共用这一份。

   以前这几段只活在旧订单页里，React 要记进度就得再抄一遍；
   抄出偏差的话，「本次消耗」就会算错，而这种错没人看得出来
   （填进去的数字都是对的，只有差值悄悄不对）。
   ============================================================ */

/** 要盯的三个资源。名字跟 src/ocr.mjs 里的 RESOURCE_ALIASES 对应 */
export const RES_KEYS = ['星声', '体力', '贝币']

/**
 * 把「星声 105 体力 86」这种文本拆成三个标准资源 + 其他。
 * 老记录（甚至「原石 12000 / 树脂 160」这种）都读得回来，
 * 认不出的标签原样留在「其他」里，一个字都不丢。
 */
export function parseResources(text) {
  const raw = String(text || '').trim()
  const out = { 星声: '', 体力: '', 贝币: '', other: '' }
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
    if (RES_KEYS.includes(k)) out[k] = v
    else leftovers.push(`${k} ${v}`)
  }
  out.other = leftovers.join(' · ')
  return out
}

/** 反过来拼回一行文本（还是人一眼能读的样子） */
export function buildResources(vals, other) {
  const parts = []
  for (const k of RES_KEYS) {
    const v = String((vals && vals[k]) ?? '').trim()
    if (v) parts.push(`${k} ${v}`)
  }
  const o = String(other || '').trim()
  if (o) parts.push(o)
  return parts.join(' ')
}

/** 前后差值，给「本次消耗」那行用 */
export function resourceDelta(beforeText, afterText) {
  const a = parseResources(beforeText)
  const b = parseResources(afterText)
  const out = []
  for (const k of RES_KEYS) {
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
