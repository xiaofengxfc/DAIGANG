import { ERPNEXT } from './config.mjs'

export class ERPNextError extends Error {
  constructor(message, code = 'erpnext_error', status = 502) {
    super(message)
    this.name = 'ERPNextError'
    this.code = code
    this.status = status
  }
}

export function erpNextStatus() {
  const configured = Boolean(ERPNEXT.url && ERPNEXT.apiKey && ERPNEXT.apiSecret)
  return {
    enabled: ERPNEXT.enabled,
    sync_enabled: ERPNEXT.syncEnabled,
    configured,
    ready: ERPNEXT.enabled && configured,
    url: ERPNEXT.url,
    auth: configured ? 'api-key' : 'not-configured',
  }
}

export async function erpNextRequest(path, { method = 'GET', query, body } = {}) {
  const status = erpNextStatus()
  if (!status.enabled) throw new ERPNextError('ERPNext 适配层尚未启用', 'erpnext_disabled', 409)
  if (!status.configured) throw new ERPNextError('ERPNext 连接信息未配置', 'erpnext_not_configured', 409)

  const url = new URL(String(path).replace(/^\//, ''), `${ERPNEXT.url}/`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ERPNEXT.timeoutMs)
  try {
    const response = await fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `token ${ERPNEXT.apiKey}:${ERPNEXT.apiSecret}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const raw = await response.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : null
    } catch {
      data = raw
    }
    if (!response.ok) {
      const detail = data?.exception || data?.message || data?.error || `HTTP ${response.status}`
      throw new ERPNextError(`ERPNext 请求失败：${String(detail).slice(0, 300)}`, 'erpnext_http_error', response.status)
    }
    return data
  } catch (err) {
    if (err instanceof ERPNextError) throw err
    if (err?.name === 'AbortError') throw new ERPNextError('ERPNext 请求超时', 'erpnext_timeout', 504)
    throw new ERPNextError(`ERPNext 暂时无法连接：${err.message || '网络错误'}`, 'erpnext_unreachable', 502)
  } finally {
    clearTimeout(timer)
  }
}

export async function testERPNext() {
  const response = await erpNextRequest('/api/method/frappe.auth.get_logged_user')
  return { ok: true, user: response?.message || '' }
}

const REQUIRED_DOCTYPES = ['Item Group', 'Item', 'Item Price', 'Customer', 'Quotation', 'Sales Order', 'Payment Entry']

const REQUIRED_CUSTOM_FIELDS = {
  'Item Group': ['custom_xfc_game_id', 'custom_xfc_category_id', 'custom_xfc_status'],
  Item: [
    'custom_xfc_service_id',
    'custom_xfc_game_id',
    'custom_xfc_category_id',
    'custom_xfc_price_type',
    'custom_xfc_min_qty',
    'custom_xfc_max_qty',
    'custom_xfc_package_items',
    'custom_xfc_status',
  ],
  'Item Price': ['custom_xfc_service_id', 'custom_xfc_status'],
  Customer: ['custom_xfc_customer_id', 'custom_xfc_wechat', 'custom_xfc_qq', 'custom_xfc_source', 'custom_xfc_tags', 'custom_xfc_note', 'custom_xfc_status'],
  Quotation: ['custom_xfc_quote_id', 'custom_xfc_quote_no', 'custom_xfc_game_id', 'custom_xfc_local_total', 'custom_xfc_note'],
  'Sales Order': [
    'custom_xfc_order_id',
    'custom_xfc_order_no',
    'custom_xfc_local_status',
    'custom_xfc_game_id',
    'custom_xfc_local_total',
    'custom_xfc_platform_fee',
    'custom_xfc_cost',
    'custom_xfc_note',
    'custom_xfc_internal_note',
  ],
  'Payment Entry': ['custom_xfc_payment_id', 'custom_xfc_order_id', 'custom_xfc_order_no', 'custom_xfc_kind', 'custom_xfc_local_status'],
}

async function checkDocType(doctype) {
  try {
    await erpNextRequest(`/api/resource/DocType/${encodeURIComponent(doctype)}`)
    return { key: `doctype:${doctype}`, kind: 'doctype', target: doctype, ok: true, required: true }
  } catch (err) {
    return {
      key: `doctype:${doctype}`,
      kind: 'doctype',
      target: doctype,
      ok: false,
      required: true,
      code: err.status === 404 ? 'missing_doctype' : err.code,
      error: err.message,
    }
  }
}

async function checkNamedResource(doctype, name, required = true) {
  try {
    const response = await erpNextRequest(`/api/resource/${encodeURIComponent(doctype)}`, {
      query: { filters: JSON.stringify([['name', '=', name]]), fields: JSON.stringify(['name']), limit_page_length: 1 },
    })
    const rows = Array.isArray(response?.data) ? response.data : []
    return { key: `resource:${doctype}:${name}`, kind: 'resource', target: `${doctype} / ${name}`, ok: rows.length > 0, required, count: rows.length, code: rows.length ? undefined : 'missing_resource' }
  } catch (err) {
    return { key: `resource:${doctype}:${name}`, kind: 'resource', target: `${doctype} / ${name}`, ok: false, required, code: err.code, error: err.message }
  }
}

async function checkCustomFields(doctype, fieldnames) {
  try {
    const response = await erpNextRequest('/api/resource/Custom%20Field', {
      query: {
        filters: JSON.stringify([
          ['dt', '=', doctype],
          ['fieldname', 'in', fieldnames],
        ]),
        fields: JSON.stringify(['fieldname']),
        limit_page_length: fieldnames.length + 10,
      },
    })
    const rows = Array.isArray(response?.data) ? response.data : []
    const found = new Set(rows.map((row) => row.fieldname))
    const missing = fieldnames.filter((name) => !found.has(name))
    return { key: `fields:${doctype}`, kind: 'custom_fields', target: doctype, ok: missing.length === 0, required: true, found: [...found], missing }
  } catch (err) {
    return { key: `fields:${doctype}`, kind: 'custom_fields', target: doctype, ok: false, required: true, missing: fieldnames, code: err.code, error: err.message }
  }
}

/**
 * 只读检查 ERPNext 是否具备接收迁移包的基础条件。
 * 不创建 DocType、Custom Field、客户、服务、订单或收款。
 */
export async function preflightERPNext() {
  const status = erpNextStatus()
  if (!status.enabled) throw new ERPNextError('ERPNext 适配层尚未启用', 'erpnext_disabled', 409)
  if (!status.configured) throw new ERPNextError('ERPNext 连接信息未配置', 'erpnext_not_configured', 409)

  let connection
  try {
    connection = await testERPNext()
  } catch (err) {
    return { ok: false, write_ready: false, connected: false, error: { code: err.code, message: err.message }, checks: [], warnings: [] }
  }

  const checks = []
  for (const doctype of REQUIRED_DOCTYPES) checks.push(await checkDocType(doctype))
  for (const [doctype, fields] of Object.entries(REQUIRED_CUSTOM_FIELDS)) checks.push(await checkCustomFields(doctype, fields))
  checks.push(await checkNamedResource('Item Group', 'All Item Groups'))
  checks.push(await checkNamedResource('Price List', 'Standard Selling'))
  checks.push(await checkNamedResource('Customer Group', 'Individual'))
  checks.push(await checkNamedResource('Territory', 'All Territories'))
  for (const mode of ['WeChat', 'Alipay', 'Bank Transfer', 'Cash', 'Other']) checks.push(await checkNamedResource('Mode of Payment', mode, false))

  const missing = checks.filter((check) => !check.ok && check.required)
  const warnings = checks.filter((check) => !check.ok && !check.required)
  return {
    ok: missing.length === 0,
    write_ready: missing.length === 0,
    connected: true,
    user: connection.user,
    checked_at: new Date().toISOString(),
    checks,
    missing: missing.map((check) => ({ key: check.key, target: check.target, code: check.code, missing: check.missing || [] })),
    warnings: warnings.map((check) => ({ key: check.key, target: check.target, code: check.code })),
    note: '预检只读；Payment Entry 的 paid_from / paid_to 仍需按实际账套配置后才能安全双写。',
  }
}

const MASTER_SYNC_PLAN = [
  { key: 'item_groups', doctype: 'Item Group' },
  { key: 'items', doctype: 'Item' },
  { key: 'item_prices', doctype: 'Item Price' },
  { key: 'customers', doctype: 'Customer' },
]

function syncIdentity(doc, doctype) {
  if (doctype === 'Item Group') {
    if (doc.custom_xfc_game_id) return { field: 'custom_xfc_game_id', value: doc.custom_xfc_game_id }
    if (doc.custom_xfc_category_id) return { field: 'custom_xfc_category_id', value: doc.custom_xfc_category_id }
  }
  if (doctype === 'Item') return { field: 'custom_xfc_service_id', value: doc.custom_xfc_service_id }
  if (doctype === 'Item Price') return { field: 'custom_xfc_service_id', value: doc.custom_xfc_service_id }
  if (doctype === 'Customer') return { field: 'custom_xfc_customer_id', value: doc.custom_xfc_customer_id }
  return null
}

function syncPayload(doc) {
  const payload = { ...doc }
  delete payload.doctype
  delete payload.source_id
  return payload
}

async function findRemoteDocument(doctype, identity) {
  if (!identity?.value) return null
  const response = await erpNextRequest(`/api/resource/${encodeURIComponent(doctype)}`, {
    query: {
      filters: JSON.stringify([[identity.field, '=', identity.value]]),
      fields: JSON.stringify(['name']),
      limit_page_length: 2,
    },
  })
  const rows = Array.isArray(response?.data) ? response.data : []
  if (rows.length > 1) {
    throw new ERPNextError(`ERPNext 中 ${doctype} 的 ${identity.field}=${identity.value} 出现重复记录，已停止同步以避免覆盖错误对象`, 'erpnext_duplicate_identity', 409)
  }
  return rows[0]?.name || null
}

/**
 * 幂等同步第一阶段主数据。
 * 默认 dry-run；apply 只做创建/更新，不做删除，不改本地数据库。
 */
export async function syncERPNextMaster({ mode = 'dry-run', confirm = '' } = {}, bundle) {
  if (mode !== 'dry-run' && mode !== 'apply') throw new ERPNextError('同步模式只能是 dry-run 或 apply', 'erpnext_bad_sync_mode', 400)
  if (mode === 'apply') {
    if (!ERPNEXT.syncEnabled) throw new ERPNextError('远程同步开关未启用，请先设置 XFC_ERPNEXT_SYNC_ENABLED=1', 'erpnext_sync_disabled', 409)
    if (confirm !== 'APPLY') throw new ERPNextError('远程写入需要 confirm=APPLY', 'erpnext_apply_not_confirmed', 409)
  }

  const preflight = await preflightERPNext()
  if (!preflight.write_ready) {
    return { ok: false, mode, write_ready: false, preflight, actions: [], note: '预检未通过，未执行任何远程写入。' }
  }

  const actions = []
  for (const plan of MASTER_SYNC_PLAN) {
    for (const doc of bundle?.doctypes?.[plan.key] || []) {
      const identity = syncIdentity(doc, plan.doctype)
      if (!identity?.value) {
        actions.push({ doctype: plan.doctype, source_id: doc.source_id, action: 'blocked', reason: 'missing_identity' })
        continue
      }
      const existing = await findRemoteDocument(plan.doctype, identity)
      if (mode === 'dry-run') {
        actions.push({ doctype: plan.doctype, source_id: doc.source_id, identity, action: existing ? 'update' : 'create', remote_name: existing || null })
        continue
      }
      const payload = syncPayload(doc)
      const response = existing
        ? await erpNextRequest(`/api/resource/${encodeURIComponent(plan.doctype)}/${encodeURIComponent(existing)}`, { method: 'PUT', body: payload })
        : await erpNextRequest(`/api/resource/${encodeURIComponent(plan.doctype)}`, { method: 'POST', body: payload })
      actions.push({ doctype: plan.doctype, source_id: doc.source_id, identity, action: existing ? 'updated' : 'created', remote_name: response?.data?.name || existing || null })
    }
  }

  return {
    ok: true,
    mode,
    write_ready: true,
    preflight: { ok: true, checked_at: preflight.checked_at },
    summary: {
      create: actions.filter((row) => row.action === 'create' || row.action === 'created').length,
      update: actions.filter((row) => row.action === 'update' || row.action === 'updated').length,
      blocked: actions.filter((row) => row.action === 'blocked').length,
    },
    actions,
    note: mode === 'dry-run' ? '这是预演，没有写入 ERPNext。' : '已完成主数据创建/更新；未删除任何 ERPNext 记录。',
  }
}

const TRANSACTION_SYNC_PLAN = [
  { key: 'quotations', doctype: 'Quotation', identityField: 'custom_xfc_quote_id' },
  { key: 'sales_orders', doctype: 'Sales Order', identityField: 'custom_xfc_order_id' },
  { key: 'payment_entries', doctype: 'Payment Entry', identityField: 'custom_xfc_payment_id' },
]

function transactionPayload(doc, doctype) {
  const payload = syncPayload(doc)
  // ERPNext 根据工作流计算 status，不能把本地状态硬写进标准只读字段。
  if (doctype === 'Sales Order') delete payload.status
  if (doctype === 'Payment Entry') {
    payload.paid_from = ERPNEXT.paidFrom
    payload.paid_to = ERPNEXT.paidTo
  }
  return payload
}

async function findRemoteTransaction(doctype, identityField, identityValue) {
  const response = await erpNextRequest(`/api/resource/${encodeURIComponent(doctype)}`, {
    query: {
      filters: JSON.stringify([[identityField, '=', identityValue]]),
      fields: JSON.stringify(['name', 'docstatus']),
      limit_page_length: 2,
    },
  })
  const rows = Array.isArray(response?.data) ? response.data : []
  if (rows.length > 1) {
    throw new ERPNextError(`ERPNext 中 ${doctype} 的 ${identityField}=${identityValue} 出现重复记录，已停止同步以避免覆盖错误对象`, 'erpnext_duplicate_identity', 409)
  }
  return rows[0] || null
}

function transactionScope(scope) {
  if (!scope || scope === 'all') return TRANSACTION_SYNC_PLAN
  const wanted = new Set(String(scope).split(',').map((value) => value.trim()).filter(Boolean))
  const plans = TRANSACTION_SYNC_PLAN.filter((plan) => wanted.has(plan.key) || (plan.key === 'sales_orders' && wanted.has('orders')) || (plan.key === 'payment_entries' && wanted.has('payments')))
  if (!plans.length) throw new ERPNextError('scope 只能是 all、quotations、orders、payments，或逗号分隔的组合', 'erpnext_bad_sync_scope', 400)
  return plans
}

function transactionBlockReason(doc, doctype, mode) {
  if (doctype === 'Quotation' || doctype === 'Sales Order') {
    if (!doc.customer) return 'missing_customer'
    if (!Array.isArray(doc.items) || !doc.items.length) return 'missing_items'
  }
  if (doctype === 'Payment Entry') {
    if (!doc.party) return 'missing_customer'
    if (!(numberValue(doc.paid_amount) > 0)) return 'invalid_amount'
    if (mode === 'apply' && (!ERPNEXT.paidFrom || !ERPNEXT.paidTo)) return 'payment_accounts_not_configured'
  }
  return ''
}

function numberValue(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/**
 * 幂等同步报价、订单和收款。
 * apply 前会先完整预检这一批，存在阻断项时一条也不写，避免半同步。
 */
export async function syncERPNextTransactions({ scope = 'all', mode = 'dry-run', confirm = '' } = {}, bundle) {
  if (mode !== 'dry-run' && mode !== 'apply') throw new ERPNextError('同步模式只能是 dry-run 或 apply', 'erpnext_bad_sync_mode', 400)
  if (mode === 'apply') {
    if (!ERPNEXT.syncEnabled) throw new ERPNextError('远程同步开关未启用，请先设置 XFC_ERPNEXT_SYNC_ENABLED=1', 'erpnext_sync_disabled', 409)
    if (confirm !== 'APPLY') throw new ERPNextError('远程写入需要 confirm=APPLY', 'erpnext_apply_not_confirmed', 409)
  }

  const plans = transactionScope(scope)
  const preflight = await preflightERPNext()
  if (!preflight.write_ready) return { ok: false, mode, scope, write_ready: false, preflight, actions: [], note: '预检未通过，未执行任何远程写入。' }

  const prepared = []
  for (const plan of plans) {
    for (const doc of bundle?.doctypes?.[plan.key] || []) {
      const identityValue = doc[plan.identityField]
      const base = { doctype: plan.doctype, source_id: doc.source_id, identity: { field: plan.identityField, value: identityValue } }
      if (!identityValue) {
        prepared.push({ ...base, action: 'blocked', reason: 'missing_identity' })
        continue
      }
      const remote = await findRemoteTransaction(plan.doctype, plan.identityField, identityValue)
      const reason = transactionBlockReason(doc, plan.doctype, mode)
      if (reason) {
        prepared.push({ ...base, action: 'blocked', reason, remote_name: remote?.name || null })
      } else if (remote?.docstatus && remote.docstatus !== 0) {
        prepared.push({ ...base, action: 'blocked', reason: 'submitted_remote_record', remote_name: remote.name, remote_docstatus: remote.docstatus })
      } else {
        prepared.push({ ...base, action: remote ? 'update' : 'create', remote_name: remote?.name || null })
      }
    }
  }

  const blocked = prepared.filter((row) => row.action === 'blocked')
  if (mode === 'dry-run' || blocked.length) {
    return {
      ok: blocked.length === 0,
      mode,
      scope,
      write_ready: blocked.length === 0,
      preflight: { ok: true, checked_at: preflight.checked_at },
      summary: {
        create: prepared.filter((row) => row.action === 'create').length,
        update: prepared.filter((row) => row.action === 'update').length,
        blocked: blocked.length,
      },
      actions: prepared,
      note: mode === 'dry-run' ? '这是预演，没有写入 ERPNext。' : '发现阻断项，整批未写入 ERPNext。',
    }
  }

  const actions = []
  for (const row of prepared) {
    const plan = plans.find((candidate) => candidate.doctype === row.doctype)
    const doc = bundle.doctypes[plan.key].find((candidate) => candidate.source_id === row.source_id)
    const payload = transactionPayload(doc, plan.doctype)
    const response = row.remote_name
      ? await erpNextRequest(`/api/resource/${encodeURIComponent(plan.doctype)}/${encodeURIComponent(row.remote_name)}`, { method: 'PUT', body: payload })
      : await erpNextRequest(`/api/resource/${encodeURIComponent(plan.doctype)}`, { method: 'POST', body: payload })
    actions.push({ ...row, action: row.remote_name ? 'updated' : 'created', remote_name: response?.data?.name || row.remote_name || null })
  }

  return {
    ok: true,
    mode,
    scope,
    write_ready: true,
    preflight: { ok: true, checked_at: preflight.checked_at },
    summary: {
      create: actions.filter((row) => row.action === 'created').length,
      update: actions.filter((row) => row.action === 'updated').length,
      blocked: 0,
    },
    actions,
    note: '已完成报价、订单、收款的创建/更新；未删除任何 ERPNext 记录。',
  }
}
