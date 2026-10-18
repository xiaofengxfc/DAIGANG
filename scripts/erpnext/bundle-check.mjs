import { db } from '../../src/core/db.mjs'
import { buildERPNextBundle } from '../../src/erpnext/erpnext-map.mjs'
import { ERPNEXT_ALLOWED_DOCTYPES } from '../../src/erpnext/erpnext-scope.mjs'

const bundle = buildERPNextBundle()
const expected = {
  games: db.prepare('SELECT COUNT(*) AS c FROM games').get().c,
  categories: db.prepare('SELECT COUNT(*) AS c FROM service_categories').get().c,
  services: db.prepare('SELECT COUNT(*) AS c FROM services').get().c,
  customers: db.prepare('SELECT COUNT(*) AS c FROM customers').get().c,
  quotes: db.prepare('SELECT COUNT(*) AS c FROM quotes').get().c,
  orders: db.prepare('SELECT COUNT(*) AS c FROM orders').get().c,
  order_items: db.prepare('SELECT COUNT(*) AS c FROM order_items').get().c,
  order_progress: db.prepare('SELECT COUNT(*) AS c FROM order_progress').get().c,
  payments: db.prepare('SELECT COUNT(*) AS c FROM payments').get().c,
}

for (const [key, count] of Object.entries(expected)) {
  if (bundle.source[key] !== count) throw new Error(`${key} count mismatch: bundle=${bundle.source[key]} local=${count}`)
}

const itemCodes = bundle.doctypes.items.map((row) => row.item_code)
if (new Set(itemCodes).size !== itemCodes.length) throw new Error('duplicate ERPNext item_code')

const serialized = JSON.stringify(bundle.doctypes)
if (serialized.includes('payload_enc') || serialized.includes('credentials')) {
  throw new Error('migration bundle contains credential data')
}

const allowed = new Set(ERPNEXT_ALLOWED_DOCTYPES)
for (const [key, rows] of Object.entries(bundle.doctypes)) {
  for (const row of rows) {
    if (row.doctype && !allowed.has(row.doctype)) throw new Error(`${key} contains out-of-scope doctype: ${row.doctype}`)
  }
}

console.log(JSON.stringify({
  ok: true,
  source: bundle.source,
  doctypes: Object.fromEntries(Object.entries(bundle.doctypes).map(([key, rows]) => [key, rows.length])),
  issue_count: bundle.issues.length,
}, null, 2))
