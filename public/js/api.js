/* ============================================================
   接口客户端
   ============================================================ */

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
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue
      url.searchParams.set(k, String(v))
    }
  }
  return url
}

async function request(method, path, { body, query } = {}) {
  let res
  try {
    res = await fetch(buildURL(path, query), {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    })
  } catch {
    throw new ApiError('连不上后台，确认一下启动窗口还开着', 'offline', 0)
  }

  const text = await res.text()
  let data = null
  if (text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }

  if (!res.ok) {
    const message = (data && data.error) || `请求失败（${res.status}）`
    const err = new ApiError(message, data && data.code, res.status)
    if (res.status === 401) handlers.unauthorized()
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

/* ---------- 订单状态的展示口径 ---------- */

export const STATUS_TONE = {
  pending_confirm: 'cinnabar',
  pending_pay: 'amber',
  in_progress: 'slate',
  pending_accept: 'amber',
  done: 'jade',
  after_sale: 'oxblood',
  cancelled: 'muted',
}

export const STATUS_FLOW = ['pending_confirm', 'pending_pay', 'in_progress', 'pending_accept', 'done']

export const PRICE_TYPE_LABEL = {
  fixed: '固定价',
  daily: '按天',
  per_time: '按次',
  per_unit: '按数量',
  package: '套餐价',
}

export const PAY_METHOD_LABEL = {
  wechat: '微信',
  alipay: '支付宝',
  bank: '银行卡',
  cash: '现金',
  other: '其他',
}

export const PAY_KIND_LABEL = {
  deposit: '定金',
  full: '全款',
  balance: '尾款',
  refund: '退款',
}

export const LOGIN_TYPE_LABEL = {
  qrcode: '扫码登录',
  password: '账号密码',
  other: '其他方式',
}

export const AUDIT_ACTION_LABEL = {
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
}
