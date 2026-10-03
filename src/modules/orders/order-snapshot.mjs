import { money, num } from '../../util.mjs'

export function parseSnapshot(value) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function parseProgressMedia(value) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function snapshotAddonTotal(snapshot) {
  return money((snapshot?.addons || []).reduce((sum, addon) => sum + num(addon.amount), 0))
}

export function splitItemTotals(rows) {
  let itemsSubtotal = 0
  let addonTotal = 0
  for (const row of rows || []) {
    const addonAmount = snapshotAddonTotal(parseSnapshot(row.snapshot))
    addonTotal = money(addonTotal + addonAmount)
    itemsSubtotal = money(itemsSubtotal + (money(row.amount) - addonAmount))
  }
  return { items_subtotal: itemsSubtotal, addon_total: addonTotal }
}
