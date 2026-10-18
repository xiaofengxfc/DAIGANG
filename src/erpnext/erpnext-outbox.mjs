import { buildERPNextBundle } from './erpnext-map.mjs'
import { ERPNextError, syncERPNextMaster, syncERPNextTransactions } from './erpnext.mjs'
import { listOutbox, markOutboxStatus, outboxSummary } from '../core/outbox.mjs'

const ACTIVE_STATUSES = new Set(['pending', 'processing', 'failed'])

function activeRows() {
  return listOutbox({ limit: 1000 }).filter((row) => ACTIVE_STATUSES.has(row.status))
}

function rowGroup(row) {
  if (['game', 'category', 'service', 'customer'].includes(row.entity_type)) return 'master'
  if (['quotation', 'sales_order', 'payment', 'task'].includes(row.entity_type)) return 'transactions'
  return 'unsupported'
}

function transactionScope(rows) {
  const scopes = new Set()
  for (const row of rows) {
    if (row.entity_type === 'quotation') scopes.add('quotations')
    if (row.entity_type === 'sales_order') scopes.add('orders')
    if (row.entity_type === 'payment') scopes.add('payments')
    if (row.entity_type === 'task') scopes.add('tasks')
  }
  return [...scopes]
}

function selectedIds(rows, entityType) {
  return new Set(rows.filter((row) => row.entity_type === entityType && row.event_type !== 'delete').map((row) => Number(row.source_id)))
}

/**
 * 把完整迁移包裁剪成当前队列涉及的对象，避免「改一个客户却把全部客户都写一遍」。
 * 订单明细仍然随订单一起保留在 Sales Order 文档内；ERPNext 是否已存在依赖项
 * 由已有的幂等同步器和预检规则判断，缺失时会阻断，不会猜测创建。
 */
export function filterERPNextBundleForOutbox(bundle, rows) {
  const gameIds = selectedIds(rows, 'game')
  const categoryIds = selectedIds(rows, 'category')
  const serviceIds = selectedIds(rows, 'service')
  const customerIds = selectedIds(rows, 'customer')
  const quoteIds = selectedIds(rows, 'quotation')
  const orderIds = selectedIds(rows, 'sales_order')
  const paymentIds = selectedIds(rows, 'payment')
  const taskIds = selectedIds(rows, 'task')
  const source = { ...(bundle?.source || {}) }
  const doctypes = bundle?.doctypes || {}
  const filtered = {
    ...bundle,
    source,
    doctypes: {
      item_groups: (doctypes.item_groups || []).filter((doc) =>
        (doc.custom_xfc_game_id && gameIds.has(Number(doc.custom_xfc_game_id))) ||
        (doc.custom_xfc_category_id && categoryIds.has(Number(doc.custom_xfc_category_id)))
      ),
      items: (doctypes.items || []).filter((doc) => serviceIds.has(Number(doc.custom_xfc_service_id))),
      item_prices: (doctypes.item_prices || []).filter((doc) => serviceIds.has(Number(doc.custom_xfc_service_id))),
      customers: (doctypes.customers || []).filter((doc) => customerIds.has(Number(doc.custom_xfc_customer_id))),
      quotations: (doctypes.quotations || []).filter((doc) => quoteIds.has(Number(doc.source_id))),
      sales_orders: (doctypes.sales_orders || []).filter((doc) => orderIds.has(Number(doc.source_id))),
      payment_entries: (doctypes.payment_entries || []).filter((doc) => paymentIds.has(Number(doc.source_id))),
      tasks: (doctypes.tasks || []).filter((doc) => taskIds.has(Number(doc.source_id))),
    },
  }
  for (const [key, rowsForType] of Object.entries(filtered.doctypes)) source[key] = rowsForType.length
  return filtered
}

/**
 * 只根据本地队列生成同步计划，不访问 ERPNext，也不修改本地数据。
 */
export function buildERPNextOutboxPlan() {
  const rows = activeRows()
  const groups = { master: [], transactions: [], unsupported: [] }
  for (const row of rows) groups[rowGroup(row)].push(row)
  return {
    provider: 'erpnext',
    queue: outboxSummary(),
    pending: rows.length,
    master: {
      count: groups.master.length,
      source_ids: groups.master.map((row) => ({ entity_type: row.entity_type, source_id: row.source_id, event_type: row.event_type })),
    },
    transactions: {
      count: groups.transactions.length,
      scope: transactionScope(groups.transactions),
      source_ids: groups.transactions.map((row) => ({ entity_type: row.entity_type, source_id: row.source_id, event_type: row.event_type })),
    },
    unsupported: groups.unsupported.map((row) => ({ id: row.id, entity_type: row.entity_type, source_id: row.source_id })),
    note: 'plan 只读取本地队列；dry-run 会读取 ERPNext 预检和远程现状；apply 才可能写入 ERPNext。',
  }
}

function actionEntity(action) {
  if (action.doctype === 'Item Group') {
    if (action.identity?.field === 'custom_xfc_game_id') return 'game'
    if (action.identity?.field === 'custom_xfc_category_id') return 'category'
  }
  if (action.doctype === 'Item' || action.doctype === 'Item Price') return 'service'
  if (action.doctype === 'Customer') return 'customer'
  if (action.doctype === 'Quotation') return 'quotation'
  if (action.doctype === 'Sales Order') return 'sales_order'
  if (action.doctype === 'Payment Entry') return 'payment'
  if (action.doctype === 'Task') return 'task'
  return ''
}

function actionFor(row, actions) {
  return actions.find((action) => actionEntity(action) === row.entity_type && Number(action.source_id) === Number(row.source_id)) || null
}

function markApplyResult(rows, masterResult, transactionResult) {
  const actions = [...(masterResult?.actions || []), ...(transactionResult?.actions || [])]
  const results = []
  for (const row of rows) {
    if (row.event_type === 'delete') {
      const error = '远程删除尚未启用；本地记录已删除，队列保留等待人工处理。'
      markOutboxStatus(row.id, 'failed', { error })
      results.push({ id: row.id, status: 'failed', reason: 'remote_delete_not_supported' })
      continue
    }
    const action = actionFor(row, actions)
    if (action && ['created', 'updated'].includes(action.action)) {
      markOutboxStatus(row.id, 'done')
      results.push({ id: row.id, status: 'done', action: action.action, remote_name: action.remote_name || null })
      continue
    }
    const error = action?.reason ? `ERPNext 同步阻断：${action.reason}` : 'ERPNext 同步没有返回对应动作。'
    markOutboxStatus(row.id, 'failed', { error })
    results.push({ id: row.id, status: 'failed', reason: action?.reason || 'missing_action' })
  }
  return results
}

/**
 * 让 Outbox 驱动已有的幂等同步器。
 * - plan：只读本地队列，不联网
 * - dry-run：只做 ERPNext 预检和远程现状读取
 * - apply：沿用现有 XFC_ERPNEXT_SYNC_ENABLED + confirm=APPLY 双重保护
 */
export async function syncERPNextOutbox({ mode = 'plan', confirm = '' } = {}) {
  if (!['plan', 'dry-run', 'apply'].includes(mode)) throw new ERPNextError('同步模式只能是 plan、dry-run 或 apply', 'erpnext_bad_sync_mode', 400)

  const rows = activeRows()
  if (mode === 'plan' || !rows.length) {
    return { ok: true, mode, plan: buildERPNextOutboxPlan(), results: [] }
  }

  const unsupported = rows.filter((row) => rowGroup(row) === 'unsupported')
  const masterRows = rows.filter((row) => rowGroup(row) === 'master' && row.event_type !== 'delete')
  const transactionRows = rows.filter((row) => rowGroup(row) === 'transactions' && row.event_type !== 'delete')
  const bundle = buildERPNextBundle()
  const masterBundle = filterERPNextBundleForOutbox(bundle, masterRows)
  const transactionBundle = filterERPNextBundleForOutbox(bundle, transactionRows)
  const masterResult = masterRows.length ? await syncERPNextMaster({ mode, confirm }, masterBundle) : null
  const scopes = transactionScope(transactionRows)
  const transactionResult = scopes.length ? await syncERPNextTransactions({ scope: scopes.join(','), mode, confirm }, transactionBundle) : null

  if (mode === 'dry-run') {
    return {
      ok: Boolean((masterResult?.ok ?? true) && (transactionResult?.ok ?? true) && !unsupported.length),
      mode,
      plan: buildERPNextOutboxPlan(),
      master: masterResult,
      transactions: transactionResult,
      unsupported,
      results: [],
    }
  }

  // apply 模式才进入 processing；预检失败或网络异常会统一回写 failed，之后可 retry。
  for (const row of rows) markOutboxStatus(row.id, 'processing')
  try {
    const results = markApplyResult(rows, masterResult, transactionResult)
    for (const row of unsupported) markOutboxStatus(row.id, 'failed', { error: '该队列实体暂不支持 ERPNext 同步。' })
    return {
      ok: results.every((row) => row.status === 'done') && !unsupported.length && Boolean((masterResult?.ok ?? true) && (transactionResult?.ok ?? true)),
      mode,
      plan: buildERPNextOutboxPlan(),
      master: masterResult,
      transactions: transactionResult,
      unsupported,
      results,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    for (const row of rows) markOutboxStatus(row.id, 'failed', { error: message })
    throw err
  }
}
