import { db } from './db.mjs'
import { bad, money, num, clampStr } from './util.mjs'
import { shapeRow } from './routes/_helpers.mjs'
import { services as servicesDef, tiers as tiersDef, options as optionsDef } from './routes/catalog.mjs'

/**
 * 计价引擎 —— 报价单和订单共用同一套算法，保证「报价多少、下单就多少」。
 * 所有价格在服务端算，前端只负责展示。
 */

export function loadService(id) {
  const row = db.prepare('SELECT * FROM services WHERE id = ?').get(Number(id) || 0)
  return row ? shapeRow(servicesDef, row) : null
}

export function loadTiers(serviceId) {
  return db
    .prepare('SELECT * FROM service_tiers WHERE service_id = ? ORDER BY sort_order ASC, min_qty ASC')
    .all(Number(serviceId) || 0)
    .map((r) => shapeRow(tiersDef, r))
}

export function loadOptions(serviceId) {
  return db
    .prepare(
      `SELECT * FROM service_options
       WHERE (service_id = ? OR service_id IS NULL) AND status = 'active'
       ORDER BY sort_order ASC, id ASC`
    )
    .all(Number(serviceId) || 0)
    .map((r) => shapeRow(optionsDef, r))
}

/** 按数量定价时，先找命中的阶梯，找不到就退到"起量最大且不超过"的那一档 */
export function unitPriceFor(service, tierList, qty) {
  const list = (tierList || []).filter(Boolean)
  if (list.length) {
    for (const t of list) {
      const lo = num(t.min_qty, 0)
      const hi = t.max_qty === null || t.max_qty === undefined || t.max_qty === '' ? Infinity : num(t.max_qty)
      if (qty >= lo && qty <= hi) return { price: money(t.unit_price), tier: t }
    }
    const sorted = [...list].sort((a, b) => num(a.min_qty, 0) - num(b.min_qty, 0))
    let pick = null
    for (const t of sorted) if (qty >= num(t.min_qty, 0)) pick = t
    if (pick) return { price: money(pick.unit_price), tier: pick }
  }
  return { price: money(service.base_price), tier: null }
}

export const defaultUnitLabel = (service) =>
  service.unit_label ||
  { fixed: '单', daily: '天', per_time: '次', per_unit: '个', package: '套' }[service.price_type] ||
  '单'

/**
 * 这个服务项能让客户拿到多少货币。
 * 名字配在游戏上（games.currency），数量配在服务项上（services.currency_amount）；
 * 服务项自己没绑游戏就跟着它的大类走。
 * 两个都没配、或者数量不是正数 → 返回 null（那就不显示，也不会冻进快照）。
 */
export function loadGain(service) {
  const raw = service?.currency_amount
  if (raw === null || raw === undefined || raw === '') return null
  const amount = num(raw)
  if (!Number.isFinite(amount) || amount <= 0) return null
  let gid = service.game_id || null
  if (!gid && service.category_id) {
    gid =
      db.prepare('SELECT game_id FROM service_categories WHERE id = ?').get(Number(service.category_id))?.game_id ||
      null
  }
  if (!gid) return null
  const name = String(db.prepare('SELECT currency FROM games WHERE id = ?').get(Number(gid))?.currency || '').trim()
  return name ? { name, amount } : null
}

/**
 * 把「选了哪些服务、几份、加了哪些增项」算成一张单子。
 * rawItems: [{ service_id, quantity, option_ids: [], unit_price?, note? }]
 */
export function computeItems(rawItems) {
  if (!Array.isArray(rawItems) || !rawItems.length) bad('至少要选一个服务项', 'empty_items')
  if (rawItems.length > 60) bad('一张单最多 60 个服务项', 'too_many_items')

  const out = []
  let seq = 0
  for (const raw of rawItems) {
    const service = loadService(raw.service_id)
    if (!service) bad(`服务项不存在（id ${raw.service_id}）`, 'bad_service')
    if (service.status === 'archived') bad(`「${service.name}」已下架，不能再下单`, 'service_archived')

    const qty = Math.max(num(raw.quantity, service.min_qty || 1) || 1, 0.01)
    const tierList = loadTiers(service.id)
    const { price: autoPrice, tier } = unitPriceFor(service, tierList, qty)
    const override = raw.unit_price === undefined || raw.unit_price === null || raw.unit_price === '' ? null : money(raw.unit_price)
    const unit_price = override === null ? autoPrice : override

    const available = loadOptions(service.id)
    const chosenIds = Array.isArray(raw.option_ids) ? raw.option_ids.map(Number) : []
    const chosen = available.filter((o) => chosenIds.includes(o.id))

    const base = money(unit_price * qty)
    let addonTotal = 0
    const addons = []
    for (const o of chosen) {
      const amount = o.price_mode === 'percent' ? money((base * num(o.price)) / 100) : money(o.price)
      addonTotal = money(addonTotal + amount)
      addons.push({ id: o.id, name: o.name, kind: o.kind, price_mode: o.price_mode, price: num(o.price), amount })
    }

    out.push({
      kind: service.price_type === 'package' ? 'package' : 'service',
      ref_id: service.id,
      name: service.name,
      spec: clampStr(raw.note || service.description, 400),
      price_type: service.price_type,
      unit_label: defaultUnitLabel(service),
      unit_price,
      quantity: qty,
      amount: money(base + addonTotal),
      base_amount: base,
      addon_amount: addonTotal,
      sort_order: (++seq) * 10,
      snapshot: {
        service_name: service.name,
        description: service.description,
        price_type: service.price_type,
        unit_label: defaultUnitLabel(service),
        list_price: autoPrice,
        price_overridden: override !== null && override !== autoPrice,
        matched_tier: tier ? { min_qty: tier.min_qty, max_qty: tier.max_qty, unit_price: tier.unit_price } : null,
        package_items: service.package_items || [],
        addons,
        // 能拿多少货币：和价格一样冻在下单那一刻。
        // 以后改价格表上的数字，这张老单还是当时说好的那个数。
        gain: loadGain(service),
        note: clampStr(raw.note, 400),
      },
    })
  }

  const itemsSubtotal = money(out.reduce((s, i) => s + i.base_amount, 0))
  const addonTotal = money(out.reduce((s, i) => s + i.addon_amount, 0))
  return { items: out, items_subtotal: itemsSubtotal, addon_total: addonTotal, total: money(itemsSubtotal + addonTotal) }
}

/** 折扣、手续费、成本算进来，得到最终总价与利润 */
export function computeTotals({ items_subtotal, addon_total, discount = 0, platform_fee = 0, cost = 0 }) {
  const discountValue = Math.max(0, num(discount))
  const total = Math.max(0, money(num(items_subtotal) + num(addon_total) - discountValue))
  const fee = Math.max(0, num(platform_fee))
  const costValue = Math.max(0, num(cost))
  return {
    items_subtotal: money(items_subtotal),
    addon_total: money(addon_total),
    discount: money(discountValue),
    total,
    platform_fee: money(fee),
    cost: money(costValue),
    profit: money(total - fee - costValue),
  }
}
