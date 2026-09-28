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
