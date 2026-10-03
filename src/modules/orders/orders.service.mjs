import { computeItems, computeTotals } from '../../pricing.mjs'
import { money } from '../../util.mjs'
import { splitItemTotals } from './order-snapshot.mjs'

export function priceOrder({ items, discount, platform_fee, cost }) {
  const computed = computeItems(items)
  const totals = computeTotals({
    items_subtotal: computed.items_subtotal,
    addon_total: computed.addon_total,
    discount,
    platform_fee,
    cost,
  })
  return { computed, totals }
}

export function priceSplit(order, movedItems, keptItems) {
  const moved = splitItemTotals(movedItems)
  const kept = splitItemTotals(keptItems)
  return {
    moved,
    kept,
    keptTotals: computeTotals({
      items_subtotal: kept.items_subtotal,
      addon_total: kept.addon_total,
      discount: order.discount,
      platform_fee: order.platform_fee,
      cost: order.cost,
    }),
    movedTotals: computeTotals({ items_subtotal: moved.items_subtotal, addon_total: moved.addon_total }),
  }
}

export function proportionalShare(amount, sourceTotal, targetTotal) {
  const base = money(sourceTotal)
  if (base <= 0.005) return 0
  const ratio = Math.min(1, Math.max(0, money(targetTotal) / base))
  return money(money(amount) * ratio)
}
