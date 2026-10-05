/* ============================================================
   保险箱门禁 —— 只剩「状态」这一件事
   独立密码 + 查看/复制二次验证。这里是唯一盖章的地方。

   界面（解锁弹窗、设置密码、顶栏锁扣）已经全部搬进 React：
   见 client/vault-gate.jsx 和 client/vault.jsx。这个文件只留状态，
   谁都能读同一份 vaultState。
   ============================================================ */

import { api } from '../../client/lib/api.js'

export const vaultState = {
  configured: false,
  unlocked: false,
  expires_in_ms: 0,
  lock_reason: '',
}

export function syncVault(next) {
  if (!next) return vaultState
  Object.assign(vaultState, next)
  notifyVault()
  return vaultState
}

let onVaultChange = null
let vaultListeners = []

export function setVaultListener(fn) {
  if (typeof fn !== 'function') return
  if (!vaultListeners.includes(fn)) vaultListeners.push(fn)
  onVaultChange = fn
}

/** 退订。React 页面卸载时要用，否则每进一次保险箱就多一个监听器 */
export function removeVaultListener(fn) {
  vaultListeners = vaultListeners.filter((item) => item !== fn)
  if (onVaultChange === fn) onVaultChange = vaultListeners[vaultListeners.length - 1] || null
}

/** 重建外壳时清掉旧监听，否则登出再登录会一直堆，还会往拆掉的按钮上写 */
export function resetVaultListeners() {
  vaultListeners = []
  onVaultChange = null
}

function notifyVault() {
  for (const fn of vaultListeners) {
    try {
      fn(vaultState)
    } catch {
      /* 单个监听器出错不该影响状态同步 */
    }
  }
}

export async function refreshVault() {
  try {
    return syncVault(await api.get('/api/vault/status'))
  } catch {
    return vaultState
  }
}

/** 落锁。失败就把错误抛给调用方（React 那边会弹提示），不要悄悄吞掉 */
export async function lockVault() {
  return syncVault(await api.post('/api/vault/lock'))
}
