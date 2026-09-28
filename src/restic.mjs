import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { RESTIC, DATA_DIR } from './config.mjs'
import { ERPNextError } from './erpnext.mjs'

function hasPathSeparator(value) {
  return value.includes('/') || value.includes('\\') || /^[A-Za-z]:/.test(value)
}

function resolveBinary() {
  if (hasPathSeparator(RESTIC.binary)) return fs.existsSync(RESTIC.binary) ? RESTIC.binary : ''
  try {
    execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [RESTIC.binary], { stdio: 'ignore', windowsHide: true })
    // 让系统 PATH 解析命令名；spawn 不经过 shell，不会执行拼接命令。
    return RESTIC.binary || ''
  } catch {
    return ''
  }
}

function resticStatus() {
  const binary = resolveBinary()
  const repository = Boolean(RESTIC.repository)
  const passwordFile = Boolean(RESTIC.passwordFile && fs.existsSync(RESTIC.passwordFile))
  return {
    enabled: RESTIC.enabled,
    installed: Boolean(binary),
    configured: RESTIC.enabled && Boolean(binary) && repository && passwordFile,
    repository_configured: repository,
    password_file_configured: passwordFile,
    data_dir: DATA_DIR,
    note: 'restic 密码不会返回；现有 JSON 备份仍可独立使用。',
  }
}

function isInside(base, target) {
  const basePath = path.resolve(base)
  const targetPath = path.resolve(target)
  return targetPath === basePath || targetPath.startsWith(basePath + path.sep)
}

function assertSafePaths() {
  // 远程仓库使用 s3:/rest:/rclone: 等 scheme，不按本地路径判断。
  const repoLooksLocal = !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(RESTIC.repository) || /^[A-Za-z]:[\\/]/.test(RESTIC.repository)
  if (repoLooksLocal && RESTIC.repository && isInside(DATA_DIR, RESTIC.repository)) {
    throw new ERPNextError('restic 仓库不能放在项目 data 目录内，避免递归备份', 'restic_unsafe_repository', 409)
  }
  if (RESTIC.passwordFile && isInside(DATA_DIR, RESTIC.passwordFile)) {
    throw new ERPNextError('restic 密码文件不能放在项目 data 目录内', 'restic_unsafe_password_file', 409)
  }
}

function assertConfigured({ write = false } = {}) {
  const status = resticStatus()
  if (!status.enabled) throw new ERPNextError('restic 备份尚未启用', 'restic_disabled', 409)
  if (!status.installed) throw new ERPNextError('没有找到 restic 程序，请先安装或配置 XFC_RESTIC_BIN', 'restic_not_found', 409)
  if (!status.repository_configured || !status.password_file_configured) {
    throw new ERPNextError('restic 仓库或密码文件未配置', 'restic_not_configured', 409)
  }
  assertSafePaths()
  if (write && !RESTIC.enabled) throw new ERPNextError('restic 写入未启用', 'restic_write_disabled', 409)
  return status
}

function parseJsonLines(raw) {
  const rows = []
  for (const line of String(raw || '').split(/\r?\n/)) {
    const value = line.trim()
    if (!value) continue
    try {
      rows.push(JSON.parse(value))
    } catch {
      /* restic 的非 JSON 文本只作为诊断，不返回给前端 */
    }
  }
  return rows
}

async function runRestic(args, { write = false } = {}) {
  assertConfigured({ write })
  const commandArgs = ['--repo', RESTIC.repository, '--password-file', RESTIC.passwordFile, ...args]
  return new Promise((resolve, reject) => {
    const child = spawn(resolveBinary(), commandArgs, { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new ERPNextError('restic 执行超时', 'restic_timeout', 504))
    }, RESTIC.timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-2 * 1024 * 1024)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-20 * 1024)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new ERPNextError(`restic 启动失败：${err.message}`, 'restic_spawn_failed', 502))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new ERPNextError(`restic 执行失败（退出码 ${code}）${stderr ? `：${stderr.trim().slice(0, 300)}` : ''}`, 'restic_command_failed', 502))
        return
      }
      resolve({ stdout, json: parseJsonLines(stdout) })
    })
  })
}

export { resticStatus }

export async function listResticSnapshots() {
  const result = await runRestic(['snapshots', '--json', '--no-lock'])
  return { ok: true, snapshots: Array.isArray(result.json[0]) ? result.json[0] : result.json }
}

export async function createResticBackup() {
  const result = await runRestic(['backup', DATA_DIR, '--tag', 'daigan-ops-console', '--json'], { write: true })
  const summary = [...result.json].reverse().find((row) => row.summary || row.snapshot_id) || null
  return { ok: true, summary }
}
