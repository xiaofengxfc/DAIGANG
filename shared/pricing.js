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
 * 数量比所有档的起量都小，就按**最低那一档**算。
 * 只有一档阶梯都没有时，才用服务项的基准价。
 *
 * @param {object} service 服务项（至少要有 base_price）
 * @param {Array} tiers 阶梯价列表；服务端从库里读，前端直接传 service.tiers
 * @param {number} qty 数量
 * @returns {{ price: number, tier: object|null }}
 */
export function unitPriceFor(service, tiers, qty) {
  const list = (tiers || []).filter(Boolean)
  if (list.length) {
    // 先排一遍：各调用方给的数组顺序并不一样（/tiers、/full、导出各排各的），
    // 阶梯价一旦有重叠，「谁先命中」就会跟着顺序变 —— 同一份数据算出两个价。
    const ordered = [...list].sort(
      (a, b) => num(a.min_qty, 0) - num(b.min_qty, 0) || num(a.max_qty, Infinity) - num(b.max_qty, Infinity)
    )
    for (const tier of ordered) {
      const lo = num(tier.min_qty, 0)
      const hi = tier.max_qty === null || tier.max_qty === undefined || tier.max_qty === '' ? Infinity : num(tier.max_qty)
      if (qty >= lo && qty <= hi) return { price: money(tier.unit_price), tier }
    }
    let pick = null
    for (const tier of ordered) if (qty >= num(tier.min_qty, 0)) pick = tier
    if (pick) return { price: money(pick.unit_price), tier: pick }
    // 数量比所有档的起量都小（阶梯从 5 层起、客户只要 3 层）：
    // 按最低那一档算。价格表给客户看的头一行就是这个价（priceOf 取的是第一档），
    // 掉回基准价的话，基准价填 0 的服务项会安静地算出 ¥0 —— 等于白干一单。
    const first = ordered[0]
    return { price: money(first.unit_price), tier: first }
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

const qtyText = (value) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100))

/**
 * 「这个服务项能让客户拿到多少货币」，例：`星声 200`。
 *
 * 货币名字配在**游戏**上，服务项只填数量，所以归属要这么找：
 * 服务项自己的 game_id → 没有就跟它的大类走。
 * 游戏没配货币名、或者数量不是正数，就返回空字符串（调用方据此不显示）。
 */
export function currencyGain(service, games = [], categories = []) {
  const raw = service && service.currency_amount
  if (raw === null || raw === undefined || raw === '') return ''
  const amount = Number(raw)
  // 数量得是正数：0 和空一样，都当没填（不然会显示「星声 0」）
  if (!Number.isFinite(amount) || amount <= 0) return ''
  let gameId = (service && service.game_id) || ''
  if (!gameId && service && service.category_id) {
    gameId = (categories || []).find((category) => String(category.id) === String(service.category_id))?.game_id || ''
  }
  const name = String((games || []).find((game) => String(game.id) === String(gameId))?.currency || '').trim()
  return name ? `${name} ${qtyText(amount)}` : ''
}
