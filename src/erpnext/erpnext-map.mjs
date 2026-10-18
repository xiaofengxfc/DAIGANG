import { db } from '../core/db.mjs'
import { erpNextScopeSummary } from './erpnext-scope.mjs'

const ORDER_STATUS = {
  pending_confirm: 'Draft',
  pending_pay: 'Draft',
  in_progress: 'To Deliver and Bill',
  pending_accept: 'To Deliver and Bill',
  done: 'Completed',
  after_sale: 'To Deliver and Bill',
  cancelled: 'Cancelled',
}

const PAYMENT_METHOD = {
  wechat: 'WeChat',
  alipay: 'Alipay',
  bank: 'Bank Transfer',
  cash: 'Cash',
  other: 'Other',
}

function parseJSON(value, fallback) {
  if (value && typeof value === 'object') return value
  try {
    const parsed = JSON.parse(String(value || ''))
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

function dateOnly(value) {
  return value ? String(value).slice(0, 10) : ''
}

function number(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function groupRows(rows) {
  const out = new Map()
  for (const row of rows) {
    if (!out.has(row.order_id)) out.set(row.order_id, [])
    out.get(row.order_id).push(row)
  }
  return out
}

function duplicateNames(rows) {
  const seen = new Map()
  for (const row of rows) {
    const name = String(row.name || '').trim()
    if (!name) continue
    if (!seen.has(name)) seen.set(name, [])
    seen.get(name).push(row.id)
  }
  return [...seen.entries()].filter(([, ids]) => ids.length > 1).map(([name, ids]) => ({ name, ids }))
}

function itemLine(line, issues, context) {
  const snapshot = parseJSON(line.snapshot, {})
  const serviceId = number(line.ref_id || snapshot.service_id, 0) || null
  if (!serviceId) {
    issues.push({
      level: 'warning',
      code: 'manual_line_without_service',
      source: context,
      message: `明细「${line.name || '未命名'}」没有关联本地服务项，将使用手工迁移项。`,
    })
  }
  return {
    item_code: serviceId ? `XFC-SERVICE-${serviceId}` : 'XFC-MANUAL-LINE',
    item_name: line.name || '未命名服务',
    description: line.spec || snapshot.description || '',
    qty: number(line.quantity, 1),
    uom: line.unit_label || 'Nos',
    rate: number(line.unit_price),
    amount: number(line.amount),
    custom_xfc_service_id: serviceId ? String(serviceId) : '',
    custom_xfc_source_line_id: String(line.id || ''),
  }
}

function groupDocs(games, categories, gameById) {
  return [
    ...games.map((row) => ({
      doctype: 'Item Group',
      source_id: row.id,
      item_group_name: row.name,
      custom_xfc_game_id: String(row.id),
      custom_xfc_status: row.status,
      parent_item_group: 'All Item Groups',
    })),
    ...categories.map((row) => ({
      doctype: 'Item Group',
      source_id: row.id,
      item_group_name: row.name,
      custom_xfc_category_id: String(row.id),
      custom_xfc_status: row.status,
      parent_item_group: gameById.get(row.game_id)?.name || 'All Item Groups',
    })),
  ]
}

/**
 * 生成 ERPNext 迁移包。
 * 这里只读本地 SQLite，不调用 ERPNext，也不写本地库或远程库。
 * source_id/custom_xfc_* 用于后续双写对账，凭证密文永远不进入迁移包。
 */
export function buildERPNextBundle() {
  // 迁移包不能只取当前启用数据：归档项仍可能被历史订单引用。
  const games = db.prepare('SELECT * FROM games ORDER BY sort_order, id').all()
  const categories = db.prepare('SELECT * FROM service_categories ORDER BY sort_order, id').all()
  const services = db.prepare('SELECT * FROM services ORDER BY sort_order, id').all()
  const customers = db.prepare('SELECT * FROM customers ORDER BY id').all()
  const quotes = db.prepare('SELECT * FROM quotes ORDER BY id').all()
  const orders = db.prepare('SELECT * FROM orders ORDER BY id').all()
  const orderItems = db.prepare('SELECT * FROM order_items ORDER BY order_id, sort_order, id').all()
  const orderProgress = db.prepare('SELECT * FROM order_progress ORDER BY order_id, happened_on, id').all()
  const payments = db.prepare('SELECT * FROM payments ORDER BY id').all()

  const issues = []
  const gameById = new Map(games.map((row) => [row.id, row]))
  const categoryById = new Map(categories.map((row) => [row.id, row]))
  const customerById = new Map(customers.map((row) => [row.id, row]))
  const orderById = new Map(orders.map((row) => [row.id, row]))
  const itemsByOrder = groupRows(orderItems)

  for (const duplicate of duplicateNames(games)) {
    issues.push({ level: 'warning', code: 'duplicate_game_name', source: `games:${duplicate.ids.join(',')}`, message: `游戏名「${duplicate.name}」重复，ERPNext Item Group 名称可能冲突。` })
  }
  for (const duplicate of duplicateNames(categories)) {
    issues.push({ level: 'warning', code: 'duplicate_category_name', source: `service_categories:${duplicate.ids.join(',')}`, message: `分类名「${duplicate.name}」重复，ERPNext Item Group 名称可能冲突。` })
  }
  for (const duplicate of duplicateNames(customers)) {
    issues.push({ level: 'warning', code: 'duplicate_customer_name', source: `customers:${duplicate.ids.join(',')}`, message: `客户名「${duplicate.name}」重复，建议在 ERPNext Customer 中先确定唯一命名规则。` })
  }

  const itemGroups = groupDocs(games, categories, gameById)
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
      disabled: row.status !== 'active' ? 1 : 0,
      description: row.description || row.note || '',
      custom_xfc_service_id: String(row.id),
      custom_xfc_game_id: row.game_id ? String(row.game_id) : '',
      custom_xfc_category_id: row.category_id ? String(row.category_id) : '',
      custom_xfc_price_type: row.price_type,
      custom_xfc_min_qty: number(row.min_qty, 1),
      custom_xfc_max_qty: row.max_qty === null ? '' : number(row.max_qty),
      custom_xfc_package_items: row.package_items || '[]',
      custom_xfc_status: row.status,
    }
  })

  const itemPrices = services.map((row) => ({
    doctype: 'Item Price',
    source_id: row.id,
    item_code: `XFC-SERVICE-${row.id}`,
    price_list: 'Standard Selling',
    currency: 'CNY',
    price_list_rate: number(row.base_price),
    custom_xfc_service_id: String(row.id),
    custom_xfc_status: row.status,
  }))

  const customerDocs = customers.map((row) => ({
    doctype: 'Customer',
    source_id: row.id,
    customer_name: row.name,
    customer_type: 'Individual',
    customer_group: 'Individual',
    territory: 'All Territories',
    mobile_no: row.phone || '',
    custom_xfc_customer_id: String(row.id),
    custom_xfc_wechat: row.wechat || '',
    custom_xfc_qq: row.qq || '',
    custom_xfc_source: row.source || '',
    custom_xfc_tags: row.tags || '[]',
    custom_xfc_note: row.note || '',
    disabled: row.status !== 'active' ? 1 : 0,
    custom_xfc_status: row.status,
  }))

  const quotationDocs = quotes.map((row) => {
    const customer = customerById.get(row.customer_id)
    const lines = parseJSON(row.items, [])
    if (!customer && row.customer_id) issues.push({ level: 'warning', code: 'quote_customer_missing', source: `quotes:${row.id}`, message: `报价单 ${row.quote_no} 关联的客户不存在。` })
    return {
      doctype: 'Quotation',
      source_id: row.id,
      naming_series: 'XFC-QTN-.YYYY.-',
      quotation_to: 'Customer',
      customer: customer?.name || '',
      transaction_date: dateOnly(row.created_at),
      valid_till: row.valid_until || '',
      order_type: 'Sales',
      items: lines.map((line) => itemLine(line, issues, `quotes:${row.id}`)),
      custom_xfc_quote_id: String(row.id),
      custom_xfc_quote_no: row.quote_no,
      custom_xfc_game_id: row.game_id ? String(row.game_id) : '',
      custom_xfc_local_total: number(row.total),
      custom_xfc_note: row.note || '',
    }
  })

  const salesOrderDocs = orders.map((row) => {
    const customer = customerById.get(row.customer_id)
    if (!customer && row.customer_id) issues.push({ level: 'warning', code: 'order_customer_missing', source: `orders:${row.id}`, message: `订单 ${row.order_no} 关联的客户不存在。` })
    return {
      doctype: 'Sales Order',
      source_id: row.id,
      naming_series: 'XFC-SO-.YYYY.-',
      customer: customer?.name || '',
      transaction_date: dateOnly(row.ordered_at),
      delivery_date: dateOnly(row.due_at),
      order_type: 'Sales',
      status: ORDER_STATUS[row.status] || 'Draft',
      items: (itemsByOrder.get(row.id) || []).map((line) => itemLine(line, issues, `orders:${row.id}`)),
      custom_xfc_order_id: String(row.id),
      custom_xfc_order_no: row.order_no,
      custom_xfc_local_status: row.status,
      custom_xfc_game_id: row.game_id ? String(row.game_id) : '',
      custom_xfc_local_total: number(row.total),
      custom_xfc_platform_fee: number(row.platform_fee),
      custom_xfc_cost: number(row.cost),
      custom_xfc_note: row.note || '',
      custom_xfc_internal_note: row.internal_note || '',
    }
  })

  const paymentDocs = payments.map((row) => {
    const order = orderById.get(row.order_id)
    const customer = customerById.get(row.customer_id || order?.customer_id)
    if (!customer && (row.customer_id || row.order_id)) issues.push({ level: 'warning', code: 'payment_customer_missing', source: `payments:${row.id}`, message: `收款记录 ${row.id} 无法找到客户。` })
    return {
      doctype: 'Payment Entry',
      source_id: row.id,
      payment_type: 'Receive',
      party_type: 'Customer',
      party: customer?.name || '',
      posting_date: dateOnly(row.paid_at),
      paid_amount: number(row.amount),
      received_amount: number(row.amount),
      mode_of_payment: PAYMENT_METHOD[row.method] || 'Other',
      reference_no: order?.order_no || `XFC-PAY-${row.id}`,
      reference_date: dateOnly(row.paid_at),
      custom_xfc_payment_id: String(row.id),
      custom_xfc_order_id: row.order_id ? String(row.order_id) : '',
      custom_xfc_order_no: order?.order_no || '',
      custom_xfc_kind: row.kind || 'deposit',
      custom_xfc_local_status: row.status || '',
      remarks: row.note || '',
      // 目标账套科目不能猜，保留为空并在 issues/prerequisites 中提示。
      paid_from: '',
      paid_to: '',
    }
  })

  const taskDocs = orderProgress.map((row) => {
    const order = orderById.get(row.order_id)
    const orderLabel = order?.order_no || `本地订单 ${row.order_id || ''}`.trim()
    const content = String(row.content || '').trim() || '订单进度记录'
    const resources = [row.resources_before ? `之前：${row.resources_before}` : '', row.resources_after ? `之后：${row.resources_after}` : '']
      .filter(Boolean)
      .join('\n')
    const note = String(row.note || '').trim()
    return {
      doctype: 'Task',
      source_id: row.id,
      subject: `${orderLabel}：${content}`.slice(0, 140),
      description: [content, resources, note ? `备注：${note}` : ''].filter(Boolean).join('\n\n'),
      status: 'Open',
      exp_start_date: dateOnly(row.happened_on),
      custom_xfc_progress_id: String(row.id),
      custom_xfc_order_id: row.order_id ? String(row.order_id) : '',
      custom_xfc_order_no: order?.order_no || '',
      custom_xfc_happened_on: dateOnly(row.happened_on),
      custom_xfc_resources_before: row.resources_before || '',
      custom_xfc_resources_after: row.resources_after || '',
      custom_xfc_note: row.note || '',
    }
  })

  if (paymentDocs.length) {
    issues.push({ level: 'info', code: 'payment_accounts_required', source: 'payments', message: 'Payment Entry 的 paid_from / paid_to 需要按 ERPNext 账套配置，当前只生成安全的待配置草稿。' })
  }

  return {
    version: 2,
    generated_at: new Date().toISOString(),
    scope: erpNextScopeSummary(),
    source: {
      games: games.length,
      categories: categories.length,
      services: services.length,
      customers: customers.length,
      quotes: quotes.length,
      orders: orders.length,
      order_items: orderItems.length,
      order_progress: orderProgress.length,
      payments: payments.length,
    },
    doctypes: {
      item_groups: itemGroups,
      items,
      item_prices: itemPrices,
      customers: customerDocs,
      quotations: quotationDocs,
      sales_orders: salesOrderDocs,
      payment_entries: paymentDocs,
      tasks: taskDocs,
    },
    issues,
    prerequisites: [
      'ERPNext 中存在 All Item Groups、Standard Selling、Individual Customer Group 和 All Territories',
      '先建立 custom_xfc_* 字段，再允许写入或双写',
      'Payment Entry 的 paid_from / paid_to 必须由目标账套管理员配置，不能用猜测的科目名',
      '客户/服务/订单的 source_id 只用于迁移对账，不替代 ERPNext 主键',
      '凭证保险箱继续留在本地，迁移包不包含 credentials.payload_enc',
    ],
  }
}

/** 兼容原有调用名；现在预览同时包含报价、订单和收款映射。 */
export function buildERPNextPreview() {
  return buildERPNextBundle()
}
