import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

const argv = parseArgs(process.argv.slice(2))

export const PORT = Number(argv.port || process.env.XFC_PORT || 8787)
export const LOCAL_ONLY = Boolean(argv.local) || process.env.XFC_LOCAL === '1'
export const HOST = argv.host || process.env.XFC_HOST || (LOCAL_ONLY ? '127.0.0.1' : '0.0.0.0')
export const DATA_DIR = path.resolve(process.env.XFC_DATA_DIR || path.join(ROOT, 'data'))
export const PUBLIC_DIR = path.join(ROOT, 'public')
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads')
export const DB_FILE = path.join(DATA_DIR, 'console.db')
export const SESSION_COOKIE = 'xfc_sid'

/** 保险箱多久没操作就自动落锁（毫秒） */
export const VAULT_IDLE_MS = 20 * 60 * 1000
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

export const MAX_JSON_BYTES = 4 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024

/** 订单状态机 —— 顺序即流程顺序 */
export const ORDER_STATUS = [
  { key: 'pending_confirm', label: '待确认', tone: 'amber' },
  { key: 'pending_pay', label: '待付款', tone: 'amber' },
  { key: 'in_progress', label: '进行中', tone: 'slate' },
  { key: 'pending_accept', label: '待验收', tone: 'amber' },
  { key: 'done', label: '已完成', tone: 'jade' },
  { key: 'after_sale', label: '售后', tone: 'oxblood' },
  { key: 'cancelled', label: '已取消', tone: 'oxblood' },
]

export const PRICE_TYPES = [
  { key: 'fixed', label: '固定价', unitLabel: '单' },
  { key: 'daily', label: '按天', unitLabel: '天' },
  { key: 'per_time', label: '按次', unitLabel: '次' },
  { key: 'per_unit', label: '按数量', unitLabel: '个' },
  { key: 'package', label: '套餐价', unitLabel: '套' },
]

/** 局域网地址，用来打印手机可访问的网址 */
export function lanAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}
