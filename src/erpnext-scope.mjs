/**
 * ERPNext 只迁移当前代肝业务真正需要的范围。
 * 这不是本地功能开关：local_only 中的功能仍然完整保留，只是不复制到 ERPNext。
 */
export const ERPNEXT_SCOPE = Object.freeze({
  master: Object.freeze([
    { key: 'item_groups', label: '游戏与服务分类', doctypes: ['Item Group'] },
    { key: 'items', label: '服务项目', doctypes: ['Item'] },
    { key: 'item_prices', label: '服务价格', doctypes: ['Item Price'] },
    { key: 'customers', label: '客户', doctypes: ['Customer'] },
  ]),
  transactions: Object.freeze([
    { key: 'quotations', label: '报价单', doctypes: ['Quotation'] },
    { key: 'sales_orders', label: '订单', doctypes: ['Sales Order'] },
    { key: 'payment_entries', label: '收款', doctypes: ['Payment Entry'] },
    { key: 'tasks', label: '订单进度任务', doctypes: ['Task'] },
  ]),
  local_only: Object.freeze([
    { key: 'credentials', label: '游戏登录凭证', reason: '凭证继续由本地保险箱加密保管，不进入 ERPNext' },
    { key: 'ocr', label: 'OCR 与屏幕识别', reason: '本机辅助工具，不属于 ERPNext 主数据' },
    { key: 'price_exports', label: '价格表图片与 Word 导出', reason: '本地展示与交付功能' },
    { key: 'dashboard_finance', label: '看板与财务报表', reason: '保留本地统计口径，待 ERPNext 账套确认后再对接' },
    { key: 'auth_vault_backup', label: '登录、保险箱、备份', reason: '本地安全与灾备基础设施' },
  ]),
})

export function erpNextScopeSummary() {
  return {
    master: ERPNEXT_SCOPE.master.map(({ key, label, doctypes }) => ({ key, label, doctypes: [...doctypes] })),
    transactions: ERPNEXT_SCOPE.transactions.map(({ key, label, doctypes }) => ({ key, label, doctypes: [...doctypes] })),
    local_only: ERPNEXT_SCOPE.local_only.map(({ key, label, reason }) => ({ key, label, reason })),
  }
}

export const ERPNEXT_ALLOWED_DOCTYPES = Object.freeze(
  [...ERPNEXT_SCOPE.master, ...ERPNEXT_SCOPE.transactions].flatMap((item) => item.doctypes)
)
