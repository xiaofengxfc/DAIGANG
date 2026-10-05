/**
 * 阶梯价与计价单位 —— 前后端共用一份。
 *
 * 为什么单独放 shared/：这条规则以前有两份实现（服务端 src/pricing.mjs、
 * 旧价格表页面 public/js/views/price.js），而它决定的是**钱**：
 * 前端组合报价显示多少、下单台就算多少。两份实现一旦漂移，客户看到的价
 * 和实际收的价就对不上，而且很难发现。现在服务端、旧页面、新的 React 组合报价
 * 都调这里，改一处就是全改。
 *
 * 纯函数、不碰数据库、不 import 任何 src/ 下的东西。
 */

const num = (value, fallback = 0) => {
  if (value === '' || value === null || value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const money = (value) => Math.round((Number(value) || 0) * 100) / 100

/**
 * 按数量找命中的那一档单价。
 * 先找完全落在区间里的；找不到就退到「起量最大且不超过这个数量」的那一档；
 * 再找不到就用服务项的基准价。
 *
 * @param {object} service 服务项（至少要有 base_price）
 * @param {Array} tiers 阶梯价列表；服务端从库里读，前端直接传 service.tiers
 * @param {number} qty 数量
 * @returns {{ price: number, tier: object|null }}
 */
export function unitPriceFor(service, tiers, qty) {
  const list = (tiers || []).filter(Boolean)
  if (list.length) {
    for (const tier of list) {
      const lo = num(tier.min_qty, 0)
      const hi = tier.max_qty === null || tier.max_qty === undefined || tier.max_qty === '' ? Infinity : num(tier.max_qty)
      if (qty >= lo && qty <= hi) return { price: money(tier.unit_price), tier }
    }
    const sorted = [...list].sort((a, b) => num(a.min_qty, 0) - num(b.min_qty, 0))
    let pick = null
    for (const tier of sorted) if (qty >= num(tier.min_qty, 0)) pick = tier
    if (pick) return { price: money(pick.unit_price), tier: pick }
  }
  return { price: money(service && service.base_price), tier: null }
}

/** 只关心单价时的便捷写法（前端展示用） */
export function unitPriceOf(service, qty) {
  return unitPriceFor(service, service && service.tiers, qty).price
}

/** 计价单位：服务项自己写了就用它，否则按计价方式取默认（单 / 天 / 次 / 个 / 套） */
const UNIT_BY_TYPE = Object.freeze({ fixed: '单', daily: '天', per_time: '次', per_unit: '个', package: '套' })

export function unitOf(service) {
  if (!service) return '单'
  return service.unit_label || UNIT_BY_TYPE[service.price_type] || '单'
}
