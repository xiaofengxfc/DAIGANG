import * as catalog from './catalog.mjs'
import * as crm from './crm.mjs'
import * as orders from './orders.mjs'
import * as system from './system.mjs'
import * as media from './media.mjs'

export function registerAll() {
  catalog.register()
  crm.register()
  orders.register()
  system.register()
  media.register()
}
