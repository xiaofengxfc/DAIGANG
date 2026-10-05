import {
  LOGIN_TYPE_LABEL,
  PAY_KIND_LABEL,
  PAY_METHOD_LABEL,
  PRICE_TYPES,
  PRICE_TYPE_LABEL,
  PRICE_TYPE_UNIT_LABEL,
  ORDER_STATUS,
  ORDER_STATUS_LABEL,
} from '../../shared/domain.js'

export class ApiError extends Error {
  constructor(message, code, status) {
    super(message)
    this.code = code || 'error'
    this.status = status
  }
}

const handlers = {
  unauthorized: () => {},
  vaultLocked: () => {},
}

export function setApiHandlers(next) {
  Object.assign(handlers, next)
}

function buildURL(path, query) {
  const url = new URL(path, window.location.origin)
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue
      url.searchParams.set(key, String(value))
    }
  }
  return url
}

async function request(method, path, { body, query } = {}) {
  let response
  try {
    response = await fetch(buildURL(path, query), {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError('连不上后台，确认一下启动窗口还开着', 'offline', 0)
  }

  const text = await response.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!response.ok) {
    const message = (data && data.error) || `请求失败（${response.status}）`
    const err = new ApiError(message, data && data.code, response.status)
    if (response.status === 401) handlers.unauthorized()
    if (err.code === 'vault_locked') handlers.vaultLocked()
    throw err
  }
  return data
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  post: (path, body) => request('POST', path, { body: body || {} }),
  patch: (path, body) => request('PATCH', path, { body: body || {} }),
  del: (path, query) => request('DELETE', path, { query }),
}

export const STATUS_TONE = Object.freeze(Object.fromEntries(ORDER_STATUS.map(({ key, tone }) => [key, key === 'pending_confirm' ? 'cinnabar' : key === 'cancelled' ? 'muted' : tone])))
export const STATUS_FLOW = ORDER_STATUS.filter((item) => !['after_sale', 'cancelled'].includes(item.key)).map((item) => item.key)
export { ORDER_STATUS_LABEL }

export { LOGIN_TYPE_LABEL, PAY_KIND_LABEL, PAY_METHOD_LABEL, PRICE_TYPES, PRICE_TYPE_LABEL, PRICE_TYPE_UNIT_LABEL }

export const AUDIT_ACTION_LABEL = Object.freeze({
  'vault.setup': '设置保险箱密码',
  'vault.unlock': '解锁保险箱',
  'vault.lock': '锁定保险箱',
  'vault.unlock_failed': '解锁失败',
  'vault.password_changed': '修改保险箱密码',
  'credential.create': '新建凭证',
  'credential.update_secret': '修改凭证内容',
  'credential.delete': '删除凭证',
  'credential.view': '查看凭证',
  'credential.copy': '复制凭证',
})
