import { db } from './db.mjs'

/**
 * ERPNext 映射预览。
 * 这里只生成“将要发送什么”的只读模型，不调用 ERPNext，也不写本地库。
 * custom_xfc_* 字段需要在 ERPNext 中先建立，否则后续同步应保持关闭。
 */
export function buildERPNextPreview() {
  const games = db.prepare("SELECT * FROM games WHERE status = 'active' ORDER BY sort_order, id").all()
  const categories = db.prepare("SELECT * FROM service_categories WHERE status = 'active' ORDER BY sort_order, id").all()
  const services = db.prepare("SELECT * FROM services WHERE status = 'active' ORDER BY sort_order, id").all()
  const customers = db.prepare("SELECT * FROM customers WHERE status = 'active' ORDER BY id").all()
  const quotes = db.prepare('SELECT * FROM quotes ORDER BY id').all()

  const gameById = new Map(games.map((row) => [row.id, row]))
  const categoryById = new Map(categories.map((row) => [row.id, row]))

  const itemGroups = [
    ...games.map((row) => ({
      doctype: 'Item Group',
      source_id: row.id,
      item_group_name: row.name,
      custom_xfc_game_id: String(row.id),
      parent_item_group: 'All Item Groups',
    })),
    ...categories.map((row) => ({
      doctype: 'Item Group',
      source_id: row.id,
      item_group_name: row.name,
      custom_xfc_category_id: String(row.id),
      parent_item_group: gameById.get(row.game_id)?.name || 'All Item Groups',
    })),
  ]

  const items = services.map((row) => {
    const category = categoryById.get(row.category_id)
    const game = gameById.get(row.game_id)
    return {
      doctype: 'Item',
      source_id: row.id,
      item_code: `XFC-SERVICE-${row.id}`,
      item_name: row.name,
      item_group: category?.name || game?.name || 'Services',
      stock_uom: row.unit_label || 'Nos',
      is_stock_item: 0,
      description: row.description || row.note || '',
      custom_xfc_service_id: String(row.id),
      custom_xfc_game_id: row.game_id ? String(row.game_id) : '',
      custom_xfc_category_id: row.category_id ? String(row.category_id) : '',
      custom_xfc_price_type: row.price_type,
    }
  })

  const itemPrices = services.map((row) => ({
    doctype: 'Item Price',
    source_id: row.id,
    item_code: `XFC-SERVICE-${row.id}`,
    price_list: 'Standard Selling',
    currency: 'CNY',
    price_list_rate: row.base_price,
    custom_xfc_service_id: String(row.id),
  }))

  const customerDocs = customers.map((row) => ({
    doctype: 'Customer',
    source_id: row.id,
    customer_name: row.name,
    customer_type: 'Individual',
    mobile_no: row.phone || '',
    custom_xfc_customer_id: String(row.id),
    custom_xfc_wechat: row.wechat || '',
    custom_xfc_qq: row.qq || '',
    custom_xfc_source: row.source || '',
    custom_xfc_tags: row.tags || '[]',
    custom_xfc_note: row.note || '',
  }))

  return {
    source: {
      games: games.length,
      categories: categories.length,
      services: services.length,
      customers: customers.length,
      quotes: quotes.length,
    },
    doctypes: {
      item_groups: itemGroups,
      items,
      item_prices: itemPrices,
      customers: customerDocs,
    },
    prerequisites: [
      'ERPNext 中存在 All Item Groups 和 Standard Selling',
      '先建立 custom_xfc_* 字段，再允许写入',
      '客户/服务的 source_id 只用于迁移对账，不替代 ERPNext 主键',
    ],
  }
}
