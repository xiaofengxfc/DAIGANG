/**
 * 业务层共享契约。这里不放任何浏览器或 Node 专属代码，前后端都可以直接引用。
 */

export const ORDER_STATUS = [
  { key: 'pending_confirm', label: '待确认', tone: 'amber' },
  { key: 'pending_pay', label: '待付款', tone: 'amber' },
  { key: 'in_progress', label: '进行中', tone: 'slate' },
  { key: 'pending_accept', label: '待验收', tone: 'amber' },
  { key: 'done', label: '已完成', tone: 'jade' },
  { key: 'after_sale', label: '售后', tone: 'oxblood' },
  { key: 'cancelled', label: '已取消', tone: 'oxblood' },
]

export const ORDER_STATUS_LABEL = Object.freeze(Object.fromEntries(ORDER_STATUS.map(({ key, label }) => [key, label])))

export const ORDER_TRANSITIONS = Object.freeze({
  pending_confirm: ['pending_pay', 'in_progress', 'cancelled'],
  pending_pay: ['in_progress', 'pending_confirm', 'cancelled'],
  in_progress: ['pending_accept', 'done', 'after_sale', 'cancelled'],
  pending_accept: ['done', 'in_progress', 'after_sale'],
  done: ['after_sale'],
  after_sale: ['done', 'cancelled'],
  cancelled: ['pending_confirm'],
})

export const PRICE_TYPES = [
  { key: 'fixed', label: '固定价', unitLabel: '单' },
  { key: 'daily', label: '按天', unitLabel: '天' },
  { key: 'per_time', label: '按次', unitLabel: '次' },
  { key: 'per_unit', label: '按数量', unitLabel: '个' },
  { key: 'package', label: '套餐价', unitLabel: '套' },
]

export const PRICE_TYPE_LABEL = Object.freeze(Object.fromEntries(PRICE_TYPES.map(({ key, label }) => [key, label])))
export const PRICE_TYPE_UNIT_LABEL = Object.freeze(Object.fromEntries(PRICE_TYPES.map(({ key, unitLabel }) => [key, unitLabel])))

export const PAY_METHOD_LABEL = Object.freeze({
  wechat: '微信',
  alipay: '支付宝',
  bank: '银行卡',
  cash: '现金',
  other: '其他',
})

export const PAY_KIND_LABEL = Object.freeze({
  deposit: '定金',
  full: '全款',
  balance: '尾款',
  refund: '退款',
})

export const LOGIN_TYPE_LABEL = Object.freeze({
  qrcode: '扫码登录',
  password: '账号密码',
  other: '其他方式',
})

export const canTransitionOrder = (from, to) => from === to || (ORDER_TRANSITIONS[from] || []).includes(to)

/**
 * 名字看起来是不是「每天都要做」的那种大类（日常 / 日体 / 包天 / 每日 / 托管）。
 *
 * 前后端共用同一条规则：
 *  · 后端在新建大类、且没显式传 is_daily 时拿它自动认一次（老数据、接口调用都能兼容）；
 *  · 前端「新建大类」表单里，用户没自己动过勾选框时，也跟着它自动勾上 ——
 *    不然界面上看着没勾，存下去却是勾上的，谁也说不清。
 */
export function looksDaily(name) {
  return /日常|日体|包天|每日|托管/.test(String(name || ''))
}
