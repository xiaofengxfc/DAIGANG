/* ============================================================
   开单试算：挑服务 → 算钱 → 交付日期
   ============================================================

   纯函数，不 import 任何东西（阶梯价规则从 ./pricing.js 来，那份也是纯的）。
   旧开单台（public/js/views/orders.js）和新 React 开单台（client/order-composer.jsx）
   共用这一份。

   以前这几段只活在旧开单台里，而且旧开单台自己还抄了一份阶梯价
   （orders.js 里那个 unitPriceFor）和一份单位表（defaultUnit）——
   三处口径一旦漂移，「挑服务时看到的钱」和「下单实际算的钱」就会不一样。
   ============================================================ */

import { unitPriceFor as tierPriceFor, unitOf } from './pricing.js'

export { unitOf }

/**
 * 阶梯价 → 单价数字。
 * shared/pricing.js 里的 unitPriceFor 返回的是 { price, tier }（服务端要用那一档的
 * 记录去冻快照），但开单台只关心「多少钱」，旧开单台的 unitPriceFor 也是直接给数字。
 * 这里包一层，免得用的人拿到对象去做乘法 —— 那会算成 NaN，而 NaN 经过
 * fmtMoney 会安静地显示成 ¥0。
 */
export function unitPriceFor(service, tiers, qty) {
  return tierPriceFor(service, tiers, qty).price
}

const fmtQty = (n) => {
  const v = Number(n) || 0
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

/** 默认单位：服务项自己写了就用它，没写按计价方式推 */
export const defaultUnit = (s) => unitOf(s)

/**
 * 这个服务项大概要做多少天。按信息量从大到小推：
 *   1. 单位写成「30天」这种 → 取那个数 × 数量（日体/精托/全托都是这种）
 *   2. 单位就是「天 / 日」→ 数量
 *   3. 按天计价但没写单位 → 数量
 *   4. 其它（单 / 次 / 层 / 个 / 套）→ 推不出来，返回 0（那就不自动填交付日期）
 */
export function serviceDays(svc, qty) {
  const n = Number(qty) || 0
  if (n <= 0) return 0
  const unit = String(svc.unit_label || '').trim()
  const m = /^(\d+(?:\.\d+)?)\s*[天日]$/.exec(unit)
  if (m) return Number(m[1]) * n
  if (unit === '天' || unit === '日') return n
  if (!unit && svc.price_type === 'daily') return n
  return 0
}

/** 'YYYY-MM-DD' 往后推 n 天 */
export function addDays(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  d.setDate(d.getDate() + Number(n))
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 大类/服务项两级的「每天都做」：服务项自己设了就听它的，没设（null）跟着大类走 */
export const svcIsDaily = (s) => (s.is_daily === null || s.is_daily === undefined ? Boolean(s._catDaily) : Boolean(s.is_daily))

/**
 * 把若干 [货币名, 数量] 加起来写成一行。
 * 一个游戏一种货币，正常只有一种；真混了两种（跨游戏下单）就分着写、不硬加。
 */
export function gainSum(pairs) {
  const byName = new Map()
  for (const pair of pairs || []) {
    if (!pair) continue
    const [name, amount] = pair
    if (!name || !Number.isFinite(amount) || amount <= 0) continue
    byName.set(name, (byName.get(name) || 0) + amount)
  }
  if (!byName.size) return ''
  return [...byName.entries()].map(([name, amount]) => `${name} ${fmtQty(amount)}`).join(' + ')
}

/**
 * 单子里这些明细加起来能让客户拿到多少货币。
 * 认的是快照里的 gain（下单那刻冻住的），所以之后改价格表不影响老单。
 */
export function gainTotal(items) {
  return gainSum(
    (items || [])
      .map((it) => {
        const g = it?.snapshot?.gain
        if (!g || !g.name) return null
        return [g.name, Number(g.amount || 0) * (Number(it.quantity) || 1)]
      })
      .filter(Boolean)
  )
}

/**
 * 勾选的东西：旧开单台用 Map<id, sel>，React 那边用普通对象。
 * 两种都收 —— 一份算钱的口径，比统一数据结构更重要。
 */
function entriesOf(picked) {
  if (!picked) return []
  return picked instanceof Map ? [...picked.entries()] : Object.entries(picked)
}

const hasOption = (sel, id) => (sel.optionIds instanceof Set ? sel.optionIds.has(id) : (sel.optionIds || []).includes(id))

/** 挑好的服务项算钱：小计 / 增项 / 每一行 */
export function calcPicked(picked, servicesById) {
  let subtotal = 0
  let addons = 0
  const lines = []
  for (const [id, sel] of entriesOf(picked)) {
    const svc = servicesById.get(Number(id)) || servicesById.get(id)
    if (!svc) continue
    const qty = Number(sel.quantity) || 1
    const auto = unitPriceFor(svc, sel.tiers || svc.tiers, qty)
    const unit = sel.unitPrice === '' || sel.unitPrice === null || sel.unitPrice === undefined ? auto : Number(sel.unitPrice)
    const base = unit * qty
    let add = 0
    for (const o of sel.options || svc.options || []) {
      if (!hasOption(sel, o.id)) continue
      add += o.price_mode === 'percent' ? (base * Number(o.price)) / 100 : Number(o.price)
    }
    subtotal += base
    addons += add
    lines.push({ svc, qty, unit, base, add, amount: base + add })
  }
  return { lines, subtotal, addons }
}

/** 勾着的「每天都做」服务项里，要做最久的那条要多少天（顺带记下名字好写提示） */
export function dailyPlan(picked, servicesById) {
  let days = 0
  let name = ''
  for (const [id, sel] of entriesOf(picked)) {
    const svc = servicesById.get(Number(id)) || servicesById.get(id)
    if (!svc || !svcIsDaily(svc)) continue
    const d = serviceDays(svc, sel.quantity)
    if (d > days) {
      days = d
      name = svc.name
    }
  }
  return { days, name }
}
