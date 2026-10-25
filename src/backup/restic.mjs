import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { RESTIC, DATA_DIR, DB_FILE } from '../core/config.mjs'
import { db } from '../core/db.mjs'
import { scratchDir } from '../core/util.mjs'
import { ERPNextError } from '../erpnext/erpnext.mjs'

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

/** Windows 上路径比较不区分大小写，Linux 上区分 */
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function isInside(base, target) {
  const basePath = path.resolve(base)
  const targetPath = path.resolve(target)
  return samePath(targetPath, basePath) || (!samePath(targetPath, basePath) && targetPath.startsWith(basePath + path.sep))
}

function assertSafePaths() {
  /**
   * 远程仓库用 s3:/rest:/rclone: 等 scheme，不按本地路径判断。
   *
   * 但 restic 也支持 `local:` 前缀来**明确指定本地仓库**（`local:D:\...\repo`）。
   * 以前只按「有没有 scheme」判断，local: 就被当成了远程，isInside 根本不跑 ——
   * 仓库落进 data/ 里就成了备份自己备份自己。
   */
  const repo = String(RESTIC.repository || '').replace(/^local:/i, '')
  const repoLooksLocal = !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(repo) || /^[A-Za-z]:[\\/]/.test(repo)
  if (repoLooksLocal && repo && isInside(DATA_DIR, repo)) {
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

/**
 * 备份「一致的数据库快照」，而不是直接拷活着的库目录。
 *
 * 库跑在 WAL 模式下：`console.db`、`console.db-wal`、`console.db-shm` 是三个文件，
 * 直接 `restic backup data/` 会在三个不同时刻把它们读走 —— 备份期间只要有人
 * 记了一笔收款，还原出来就是「主库是旧的、WAL 里有半条新事务」，SQLite 要么
 * 回滚掉已提交的数据，要么直接报库损坏。这与 backup-archive.mjs 里
 * 「直接拷 .db 可能拷到一个自相矛盾的库」是同一条教训。
 *
 * 现在的做法：先用 `db.serialize()` 拿一份包含全部已提交事务的内存快照
 * 落到临时文件，让 restic 一次把「数据目录（排除三个库文件）+ 这份快照」
 * 收进同一个快照里。还原时用快照里的那个 .db 覆盖 console.db 即可，
 * uploads / logs 之类照常还原。
 */
export async function createResticBackup() {
  const dbName = path.basename(DB_FILE)
  const holdDir = scratchDir('restic-snapshot')
  const snapshotFile = path.join(holdDir, `${path.parse(dbName).name}-${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
  fs.writeFileSync(snapshotFile, Buffer.from(db.serialize()))
  try {
    const result = await runRestic(
      [
        'backup',
        DATA_DIR,
        snapshotFile,
        '--exclude',
        dbName,
        '--exclude',
        `${dbName}-wal`,
        '--exclude',
        `${dbName}-shm`,
        '--tag',
        'daigan-ops-console',
        '--json',
      ],
      { write: true }
    )
    const summary = [...result.json].reverse().find((row) => row.summary || row.snapshot_id) || null
    return { ok: true, summary, database_snapshot: path.basename(snapshotFile) }
  } finally {
    try {
      fs.rmSync(holdDir, { recursive: true, force: true })
    } catch {
      /* 临时目录清不掉不影响备份结果 */
    }
  }
}
