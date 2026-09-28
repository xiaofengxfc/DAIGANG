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
