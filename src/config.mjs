import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ORDER_STATUS, PRICE_TYPES } from '../shared/domain.js'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 这个进程是什么时候起来的 */
export const BOOT_AT = Date.now()

/**
 * 磁盘上最新的后端代码是什么时候改的。
 *
 * 用来发现「代码更新了但程序没重启」：这时候前端（每次刷新都重新读盘）是新的，
 * 后端却是旧进程 —— 新加的字段会被静默丢掉（填了存不进去，也不报错）。
 * 以前只能靠人记得重启，现在让程序自己说出来。
 */
export function newestCodeMtime() {
  let newest = 0
  const take = (p) => {
    try {
      newest = Math.max(newest, fs.statSync(p).mtimeMs)
    } catch {
      /* 读不到就跳过 */
    }
  }
  take(path.join(ROOT, 'server.mjs'))
  const walk = (dir, depth = 0) => {
    if (depth > 4) return
    let list = []
    try {
      list = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of list) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name.endsWith('.mjs')) take(p)
    }
  }
  walk(path.join(ROOT, 'src'))
  return newest
}

/** 磁盘上的代码比这个进程新 → 该重启了（留 1 秒容差给文件时间戳精度） */
export function needsRestart() {
  const newer = newestCodeMtime()
  return newer > 0 && newer > BOOT_AT + 1000
}

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
export const MEDIA_COOKIE_DIR = path.join(DATA_DIR, 'media-cookies')
export const DB_FILE = path.join(DATA_DIR, 'console.db')
export const SESSION_COOKIE = 'xfc_sid'

/**
 * ERPNext 作为第二阶段后端时使用的只读连接配置。
 * 默认关闭；密钥只从环境变量读取，不写入 SQLite 或前端响应。
 */
export const ERPNEXT = {
  enabled: process.env.XFC_ERPNEXT_ENABLED === '1',
  syncEnabled: process.env.XFC_ERPNEXT_SYNC_ENABLED === '1',
  url: String(process.env.XFC_ERPNEXT_URL || '').replace(/\/+$/, ''),
  apiKey: String(process.env.XFC_ERPNEXT_API_KEY || ''),
  apiSecret: String(process.env.XFC_ERPNEXT_API_SECRET || ''),
  paidFrom: String(process.env.XFC_ERPNEXT_PAID_FROM || ''),
  paidTo: String(process.env.XFC_ERPNEXT_PAID_TO || ''),
  timeoutMs: Math.max(1000, Number(process.env.XFC_ERPNEXT_TIMEOUT_MS || 8000)),
}

/**
 * 可选 restic 外接备份。密码只允许通过 password-file 提供，不能进入 SQLite、日志或接口响应。
 * 默认关闭，现有 JSON 备份不受影响。
 */
export const RESTIC = {
  enabled: process.env.XFC_RESTIC_ENABLED === '1',
  binary: String(process.env.XFC_RESTIC_BIN || 'restic'),
  repository: String(process.env.XFC_RESTIC_REPOSITORY || ''),
  passwordFile: String(process.env.XFC_RESTIC_PASSWORD_FILE || ''),
  timeoutMs: Math.max(5000, Number(process.env.XFC_RESTIC_TIMEOUT_MS || 120000)),
}

/** 保险箱多久没操作就自动落锁（毫秒） */
export const VAULT_IDLE_MS = 20 * 60 * 1000
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000

export const MAX_JSON_BYTES = 8 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 3 * 1024 * 1024

// 自媒体素材走二进制上传，不占用 JSON 请求体配额。
export const MAX_MEDIA_UPLOAD_BYTES = Math.max(16 * 1024 * 1024, Number(process.env.XFC_MEDIA_MAX_UPLOAD_BYTES || 512 * 1024 * 1024))

// 可选的 MediaPublishPlatform 执行器。未配置时仍可创建、排期和管理任务。
export const MEDIA_EXECUTOR_URL = String(process.env.XFC_MEDIA_EXECUTOR_URL || '').replace(/\/+$/, '')
export const MEDIA_EXECUTOR_TOKEN = String(process.env.XFC_MEDIA_EXECUTOR_TOKEN || '')
export const MEDIA_PUBLISH_ROOT = path.join(ROOT, 'integrations', 'media-publish')
export const MEDIA_REQUIREMENTS_FILE = path.join(MEDIA_PUBLISH_ROOT, 'requirements.txt')
export const MEDIA_EXECUTOR_REQUIREMENTS_FILE = path.join(MEDIA_PUBLISH_ROOT, 'requirements-executor.txt')
export const MEDIA_EXECUTOR_SCRIPT = path.join(MEDIA_PUBLISH_ROOT, 'media_executor.py')
export const MEDIA_PYTHON = String(process.env.XFC_MEDIA_PYTHON || '')
export const MEDIA_EXECUTOR_PORT = Math.max(1024, Number(process.env.XFC_MEDIA_EXECUTOR_PORT || 5409))
export const MEDIA_EXECUTOR_AUTO_START = process.env.XFC_MEDIA_EXECUTOR_AUTOSTART !== '0'
export const MEDIA_EXECUTOR_TIMEOUT_MS = Math.max(60_000, Number(process.env.XFC_MEDIA_EXECUTOR_TIMEOUT_MS || 30 * 60 * 1000))
// 定时发布调度器的轮询间隔。0 或负值 = 关闭自动调度（仍可手动在发布记录里点「发布」）。
export const MEDIA_SCHEDULER_INTERVAL_MS = Math.max(0, Number(process.env.XFC_MEDIA_SCHEDULER_INTERVAL_MS || 30_000))

/**
 * 截图识别的上传上限，单独一条。
 *
 * 为什么比普通接口大：一张 2560×1600 的游戏截图 PNG 就有 3MB 左右，
 * 转成 base64 还要再涨三分之一。截完图直接拖进来是最顺手的用法，
 * 不该逼用户先去压图（以前的提示就是「请压到 1.5MB 以内」，很难用）。
 * 只放宽这一个接口，其它接口保持 8MB 不变。
 */
export const MAX_OCR_IMAGE_BYTES = 12 * 1024 * 1024

export { ORDER_STATUS, PRICE_TYPES }

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
