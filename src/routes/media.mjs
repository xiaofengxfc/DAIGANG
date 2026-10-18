import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { db, stamp } from '../core/db.mjs'
import { UPLOAD_DIR, MEDIA_COOKIE_DIR, MAX_MEDIA_UPLOAD_BYTES, MEDIA_EXECUTOR_TOKEN, MEDIA_EXECUTOR_TIMEOUT_MS } from '../core/config.mjs'
import { mediaDependencyStatus, startMediaDependencyInstall, mediaDependencyInstallStatus, startMediaExecutor, mediaExecutorInfo, mediaExecutorBaseUrl } from '../media/media-deps.mjs'
import { get, post, patch, del, postRaw } from '../server/http.mjs'
import { bad, notFound, int, clampStr, parseJSON, stringifyJSON, fail } from '../core/util.mjs'

// 重命名素材时根据新扩展名推断 mime_type，保证执行器能按图文/视频正确分类。
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v',
  '.flv': 'video/x-flv', '.wmv': 'video/x-ms-wmv', '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.pdf': 'application/pdf',
}

const PLATFORMS = [
  { key: 'xiaohongshu', name: '小红书', kind: '图文 / 视频' },
  { key: 'wechat_channels', name: '视频号', kind: '视频' },
  { key: 'douyin', name: '抖音', kind: '图文 / 视频' },
  { key: 'kuaishou', name: '快手', kind: '视频' },
  { key: 'tiktok', name: 'TikTok', kind: '视频' },
  { key: 'instagram', name: 'Instagram', kind: '图文 / 视频' },
  { key: 'facebook', name: 'Facebook', kind: '图文 / 视频' },
  { key: 'bilibili', name: '哔哩哔哩', kind: '视频' },
  { key: 'baijiahao', name: '百家号', kind: '图文 / 视频' },
]
const PLATFORM_KEYS = new Set(PLATFORMS.map((item) => item.key))
const ACCOUNT_STATES = new Set(['pending', 'ready', 'disabled'])
const TASK_STATES = new Set(['queued', 'scheduled', 'publishing', 'success', 'failed', 'cancelled'])

function listJSON(value, fallback = []) {
  return Array.isArray(value) ? value : parseJSON(value, fallback)
}

function accountRow(row) {
  const { cookie_path: _cookiePath, ...safe } = row
  const hasCookie = Boolean(row.cookie_path && fs.existsSync(path.join(MEDIA_COOKIE_DIR, row.cookie_path)))
  return { ...safe, has_cookie: hasCookie, platform_name: PLATFORMS.find((p) => p.key === row.platform)?.name || row.platform }
}

function materialRow(row) {
  return { ...row, url: `/uploads/${row.file_path.replace(/\\/g, '/')}` }
}

function taskRow(row) {
  return {
    ...row,
    topics: listJSON(row.topics),
    platform_keys: listJSON(row.platform_keys),
    account_ids: listJSON(row.account_ids),
    material_ids: listJSON(row.material_ids),
    result: parseJSON(row.result, {}),
    platform_names: listJSON(row.platform_keys).map((key) => PLATFORMS.find((p) => p.key === key)?.name || key),
  }
}

function validatePlatforms(keys) {
  const out = [...new Set((Array.isArray(keys) ? keys : []).map((key) => String(key)).filter((key) => PLATFORM_KEYS.has(key)))]
  if (!out.length) bad('至少选择一个发布平台', 'missing_platform')
  return out
}

function validateIds(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => int(value, 0)).filter((value) => value > 0))]
}

function executorResultError(result) {
  if (result?.error) return clampStr(result.error, 500)
  const failures = Object.entries(result?.results || {})
    .filter(([, item]) => Number(item?.success || 0) < Number(item?.total || 0))
    .map(([platform, item]) => `${platform}: ${item?.error || `成功 ${Number(item?.success || 0)}/${Number(item?.total || 0)}`}`)
  return clampStr(failures.join('; '), 500)
}

async function dispatchTask(id) {
  const row = db.prepare('SELECT * FROM media_tasks WHERE id = ?').get(id)
  if (!row) notFound('发布任务不存在')
  startMediaExecutor()
  const executorUrl = mediaExecutorBaseUrl()
  if (!executorUrl) return { ok: false, available: false, status: row.status, message: '未配置发布执行器，任务已保留在队列中' }
  if (['success', 'cancelled'].includes(row.status)) return { ok: false, available: true, status: row.status, message: '这个任务当前不能再次发布' }
  if (row.status === 'publishing') return { ok: false, available: true, status: row.status, message: '这个任务正在发布，请等待当前执行完成' }
  const now = stamp()
  const claimed = db.prepare("UPDATE media_tasks SET status = 'publishing', error_msg = '', updated_at = ? WHERE id = ? AND status IN ('queued', 'scheduled')").run(now, id)
  if (claimed.changes !== 1) {
    const latest = db.prepare('SELECT status FROM media_tasks WHERE id = ?').get(id)
    return { ok: false, available: true, status: latest?.status || row.status, message: '这个任务正在被处理或状态已变化，请刷新后查看' }
  }
  try {
    const accountIds = listJSON(row.account_ids)
    const materialIds = listJSON(row.material_ids)
    const accounts = accountIds.length
      ? db.prepare(`SELECT id, platform, account_name, profile_url, auth_state, cookie_path FROM media_accounts WHERE id IN (${accountIds.map(() => '?').join(',')})`).all(...accountIds).map((account) => {
        const cookiePath = account.cookie_path ? path.resolve(MEDIA_COOKIE_DIR, account.cookie_path) : ''
        return { ...account, cookie_path: cookiePath && fs.existsSync(cookiePath) ? cookiePath : '' }
      })
      : []
    const materials = materialIds.length
      ? db.prepare(`SELECT id, filename, file_path, mime_type, file_size FROM media_materials WHERE id IN (${materialIds.map(() => '?').join(',')})`).all(...materialIds).map((material) => ({ ...material, url: `/uploads/${material.file_path.replace(/\\/g, '/')}`, absolute_path: path.resolve(UPLOAD_DIR, material.file_path) }))
      : []
    const headers = { 'content-type': 'application/json' }
    if (MEDIA_EXECUTOR_TOKEN) headers.authorization = `Bearer ${MEDIA_EXECUTOR_TOKEN}`
    const response = await fetch(`${executorUrl}/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id,
        title: row.title,
        content: row.content,
        topics: listJSON(row.topics),
        platforms: listJSON(row.platform_keys),
        account_ids: accountIds,
        material_ids: materialIds,
        accounts,
        materials,
        publish_at: row.publish_at,
      }),
      signal: AbortSignal.timeout(MEDIA_EXECUTOR_TIMEOUT_MS),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(clampStr(result.error || result.message || `执行器返回 ${response.status}`, 500))
    const resultError = executorResultError(result)
    const resultStatus = TASK_STATES.has(result.status)
      ? result.status
      : resultError
        ? 'failed'
        : 'success'
    db.prepare('UPDATE media_tasks SET status = ?, result = ?, error_msg = ?, updated_at = ? WHERE id = ?').run(resultStatus, stringifyJSON(result), resultError, stamp(), id)
    return { ok: true, available: true, status: resultStatus, result }
  } catch (err) {
    db.prepare('UPDATE media_tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?').run('failed', clampStr(err.message, 500), stamp(), id)
    return { ok: false, available: true, status: 'failed', message: err.message }
  }
}

/**
 * 定时调度器：把已到发布时间的 scheduled 任务派发给执行器。
 * 由 app.mjs 的轮询定时器周期调用。未配置执行器时任务继续保留在队列。
 */
export async function dispatchDueScheduledTasks() {
  const nowIso = new Date().toISOString()
  const due = db.prepare("SELECT id FROM media_tasks WHERE status = 'scheduled' AND publish_at IS NOT NULL AND publish_at <= ?").all(nowIso)
  let dispatched = 0
  for (const row of due) {
    try {
      await dispatchTask(row.id)
      dispatched += 1
    } catch (err) {
      console.error(`[media-scheduler] 任务 ${row.id} 派发失败：`, err?.message || err)
    }
  }
  return { due: due.length, dispatched }
}

export function register() {
  startMediaExecutor()
  get('/api/media/bootstrap', () => ({
    platforms: PLATFORMS,
    executor: startMediaExecutor(),
    accounts: db.prepare('SELECT * FROM media_accounts ORDER BY updated_at DESC, id DESC').all().map(accountRow),
    materials: db.prepare("SELECT * FROM media_materials WHERE status = 'active' ORDER BY created_at DESC, id DESC").all().map(materialRow),
    tasks: db.prepare('SELECT * FROM media_tasks ORDER BY id DESC LIMIT 100').all().map(taskRow),
    summary: buildSummary(),
  }))

  get('/api/media/platforms', () => ({ items: PLATFORMS }))
  get('/api/media/dependencies', (ctx) => mediaDependencyStatus({ force: ctx.query.force === '1' }))
  post('/api/media/dependencies/install', () => startMediaDependencyInstall())
  get('/api/media/dependencies/install/status', (ctx) => mediaDependencyInstallStatus(ctx.query.job))

  get('/api/media/accounts', (ctx) => {
    const q = clampStr(ctx.query.q, 80).trim()
    const rows = db.prepare(`SELECT * FROM media_accounts ${q ? 'WHERE account_name LIKE ? OR platform LIKE ?' : ''} ORDER BY updated_at DESC, id DESC`).all(...(q ? [`%${q}%`, `%${q}%`] : []))
    return { items: rows.map(accountRow) }
  })
  post('/api/media/accounts', (ctx) => {
    const platform = clampStr(ctx.body.platform, 40)
    if (!PLATFORM_KEYS.has(platform)) bad('请选择有效的平台', 'bad_platform')
    const accountName = clampStr(ctx.body.account_name, 100).trim()
    if (!accountName) bad('请填写账号名称', 'missing_field')
    const authState = ACCOUNT_STATES.has(ctx.body.auth_state) ? ctx.body.auth_state : 'pending'
    const now = stamp()
    const info = db.prepare('INSERT INTO media_accounts (platform, account_name, profile_url, auth_state, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(platform, accountName, clampStr(ctx.body.profile_url, 500), authState, clampStr(ctx.body.note, 1000), now, now)
    return accountRow(db.prepare('SELECT * FROM media_accounts WHERE id = ?').get(Number(info.lastInsertRowid)))
  })
  patch('/api/media/accounts/:id', (ctx) => {
    const id = int(ctx.params.id)
    const existing = db.prepare('SELECT * FROM media_accounts WHERE id = ?').get(id)
    if (!existing) notFound('账号不存在')
    const platform = ctx.body.platform === undefined ? existing.platform : clampStr(ctx.body.platform, 40)
    if (!PLATFORM_KEYS.has(platform)) bad('请选择有效的平台', 'bad_platform')
    const accountName = ctx.body.account_name === undefined ? existing.account_name : clampStr(ctx.body.account_name, 100).trim()
    if (!accountName) bad('请填写账号名称', 'missing_field')
    const authState = ctx.body.auth_state === undefined ? existing.auth_state : ctx.body.auth_state
    if (!ACCOUNT_STATES.has(authState)) bad('账号状态不合法', 'bad_state')
    db.prepare('UPDATE media_accounts SET platform = ?, account_name = ?, profile_url = ?, auth_state = ?, note = ?, updated_at = ? WHERE id = ?').run(platform, accountName, ctx.body.profile_url === undefined ? existing.profile_url : clampStr(ctx.body.profile_url, 500), authState, ctx.body.note === undefined ? existing.note : clampStr(ctx.body.note, 1000), stamp(), id)
    return accountRow(db.prepare('SELECT * FROM media_accounts WHERE id = ?').get(id))
  })
  post('/api/media/accounts/:id/login', async (ctx) => {
    const id = int(ctx.params.id)
    const account = db.prepare('SELECT * FROM media_accounts WHERE id = ?').get(id)
    if (!account) notFound('账号不存在')
    startMediaExecutor()
    const executor = mediaExecutorInfo()
    if (!executor.configured) fail(503, '发布执行器未启动，请先安装依赖或配置执行器', 'executor_unavailable')
    const base = executor.url.replace(/\/tasks$/, '')
    const filename = `account-${id}-login.json`
    const cookiePath = path.join(MEDIA_COOKIE_DIR, filename)
    try {
      const response = await fetch(`${base}/accounts/login`, { method: 'POST', headers: { 'content-type': 'application/json', ...(MEDIA_EXECUTOR_TOKEN ? { authorization: `Bearer ${MEDIA_EXECUTOR_TOKEN}` } : {}) }, body: JSON.stringify({ platform: account.platform, account_name: account.account_name, cookie_path: cookiePath }), signal: AbortSignal.timeout(10000) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) fail(response.status, result.error || '登录窗口启动失败', 'login_failed')
      return { ...result, account_id: id }
    } catch (err) {
      if (err?.code === 'login_failed' || err?.status) throw err
      fail(503, `执行器连接失败：${err.message}`, 'executor_unavailable')
    }
  })
  get('/api/media/accounts/:id/login/status', async (ctx) => {
    const id = int(ctx.params.id)
    const account = db.prepare('SELECT * FROM media_accounts WHERE id = ?').get(id)
    if (!account) notFound('账号不存在')
    const job = clampStr(ctx.query.job, 80)
    if (!job) bad('缺少登录任务编号', 'missing_job')
    startMediaExecutor()
    const executor = mediaExecutorInfo()
    if (!executor.configured) fail(503, '发布执行器未启动', 'executor_unavailable')
    const base = executor.url.replace(/\/tasks$/, '')
    const response = await fetch(`${base}/accounts/login/status/${encodeURIComponent(job)}`, { headers: MEDIA_EXECUTOR_TOKEN ? { authorization: `Bearer ${MEDIA_EXECUTOR_TOKEN}` } : {}, signal: AbortSignal.timeout(10000) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) fail(response.status, result.error || '登录状态查询失败', 'login_status_failed')
    if (result.status === 'success') {
      const filename = `account-${id}-login.json`
      const ready = fs.existsSync(path.join(MEDIA_COOKIE_DIR, filename))
      db.prepare('UPDATE media_accounts SET cookie_path = ?, auth_state = ?, updated_at = ? WHERE id = ?').run(ready ? filename : '', ready ? 'ready' : 'pending', stamp(), id)
    }
    return { ...result, account_id: id }
  })
  del('/api/media/accounts/:id', (ctx) => {
    const id = int(ctx.params.id)
    const row = db.prepare('SELECT cookie_path FROM media_accounts WHERE id = ?').get(id)
    const result = db.prepare('DELETE FROM media_accounts WHERE id = ?').run(id)
    if (!result.changes) notFound('账号不存在')
    if (row?.cookie_path) {
      try { fs.unlinkSync(path.join(MEDIA_COOKIE_DIR, row.cookie_path)) } catch {}
    }
    return { deleted: true, id }
  })

  postRaw('/api/media/accounts/:id/cookie', async (ctx) => {
    const id = int(ctx.params.id)
    const account = db.prepare('SELECT * FROM media_accounts WHERE id = ?').get(id)
    if (!account) notFound('账号不存在')
    let payload
    try { payload = JSON.parse((ctx.rawBody || Buffer.alloc(0)).toString('utf8')) } catch { bad('登录态不是合法 JSON', 'bad_cookie') }
    if (!payload || typeof payload !== 'object' || (!Array.isArray(payload.cookies) && !payload.origins)) bad('请选择 Playwright storage_state JSON 文件', 'bad_cookie')
    const name = `account-${id}-${Date.now().toString(36)}.json`
    fs.mkdirSync(MEDIA_COOKIE_DIR, { recursive: true })
    fs.writeFileSync(path.join(MEDIA_COOKIE_DIR, name), JSON.stringify(payload))
    if (account.cookie_path && account.cookie_path !== name) {
      try { fs.unlinkSync(path.join(MEDIA_COOKIE_DIR, account.cookie_path)) } catch {}
    }
    db.prepare("UPDATE media_accounts SET cookie_path = ?, auth_state = 'ready', updated_at = ? WHERE id = ?").run(name, stamp(), id)
    return accountRow(db.prepare('SELECT * FROM media_accounts WHERE id = ?').get(id))
  }, { maxBytes: 2 * 1024 * 1024 })

  postRaw('/api/media/materials/upload', async (ctx) => {
    const body = ctx.rawBody || Buffer.alloc(0)
    if (!body.length) bad('上传文件为空', 'empty_file')
    const filenameHeader = ctx.req.headers['x-file-name']
    const original = clampStr(filenameHeader ? decodeURIComponent(String(filenameHeader)) : 'media-file', 180).replace(/[\\/:*?"<>|\0]/g, '_').trim() || 'media-file'
    const ext = path.extname(original).toLowerCase().replace(/[^a-z0-9.]/g, '') || '.bin'
    const stem = path.basename(original, path.extname(original)).replace(/[^\w\u4e00-\u9fff.-]+/g, '_').slice(0, 100) || 'media'
    const stored = `${stem}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}${ext}`
    const relative = path.join('media', stored)
    const absolute = path.join(UPLOAD_DIR, relative)
    fs.mkdirSync(path.dirname(absolute), { recursive: true })
    fs.writeFileSync(absolute, body)
    const now = stamp()
    const info = db.prepare('INSERT INTO media_materials (filename, file_path, mime_type, file_size, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(original, relative, clampStr(ctx.req.headers['content-type'], 120) || 'application/octet-stream', body.length, now, now)
    return materialRow(db.prepare('SELECT * FROM media_materials WHERE id = ?').get(Number(info.lastInsertRowid)))
  }, { maxBytes: MAX_MEDIA_UPLOAD_BYTES })

  get('/api/media/materials', (ctx) => {
    const q = clampStr(ctx.query.q, 100).trim()
    const rows = db.prepare(`SELECT * FROM media_materials WHERE status = 'active' ${q ? 'AND filename LIKE ?' : ''} ORDER BY created_at DESC, id DESC`).all(...(q ? [`%${q}%`] : []))
    return { items: rows.map(materialRow) }
  })
  patch('/api/media/materials/:id', (ctx) => {
    const id = int(ctx.params.id)
    const row = db.prepare("SELECT * FROM media_materials WHERE id = ? AND status = 'active'").get(id)
    if (!row) notFound('素材不存在')
    const requested = clampStr(ctx.body.filename ?? ctx.body.name, 180).replace(/[\\/:*?"<>|\0]/g, ' ').replace(/\s+/g, ' ').trim()
    if (!requested) bad('请填写素材名称', 'missing_filename')

    const oldAbsolute = path.resolve(UPLOAD_DIR, row.file_path)
    if (!fs.existsSync(oldAbsolute)) bad('素材文件不存在', 'missing_file')

    // 用户输入的名字可以带或不带扩展名：
    //  - 带合法扩展名 → 磁盘文件跟随新扩展，并据此重算 mime_type（修名字即可把 .bin 等修回正确类型）。
    //  - 不带扩展名   → 保留原磁盘扩展名。
    const oldExtension = path.extname(row.file_path).toLowerCase()
    const typedExt = path.extname(requested).toLowerCase()
    const hasTypedExt = /^\.[a-z0-9]+$/.test(typedExt)
    const baseName = hasTypedExt ? path.basename(requested, path.extname(requested)).trim() : requested.trim()
    if (!baseName) bad('请填写素材名称', 'missing_filename')
    if (baseName === '.' || baseName === '..') bad('素材名称不合法', 'bad_filename')
    const storedName = `${baseName}${hasTypedExt ? typedExt : oldExtension}`
    const newMime = hasTypedExt
      ? MIME_BY_EXT[typedExt] || row.mime_type
      : row.mime_type
    const nextRelative = path.join(path.dirname(row.file_path), storedName)
    const nextAbsolute = path.resolve(UPLOAD_DIR, nextRelative)
    if (nextAbsolute !== oldAbsolute && fs.existsSync(nextAbsolute)) bad('同名素材已经存在', 'filename_exists')

    if (nextAbsolute !== oldAbsolute) {
      fs.renameSync(oldAbsolute, nextAbsolute)
      try {
        db.prepare('UPDATE media_materials SET filename = ?, file_path = ?, mime_type = ?, updated_at = ? WHERE id = ?').run(requested, nextRelative, newMime, stamp(), id)
      } catch (error) {
        try { fs.renameSync(nextAbsolute, oldAbsolute) } catch {}
        throw error
      }
    } else {
      db.prepare('UPDATE media_materials SET filename = ?, mime_type = ?, updated_at = ? WHERE id = ?').run(requested, newMime, stamp(), id)
    }
    return materialRow(db.prepare('SELECT * FROM media_materials WHERE id = ?').get(id))
  })
  del('/api/media/materials/:id', (ctx) => {
    const id = int(ctx.params.id)
    const row = db.prepare('SELECT * FROM media_materials WHERE id = ?').get(id)
    if (!row) notFound('素材不存在')
    db.prepare("UPDATE media_materials SET status = 'deleted', updated_at = ? WHERE id = ?").run(stamp(), id)
    try { fs.unlinkSync(path.join(UPLOAD_DIR, row.file_path)) } catch {}
    return { deleted: true, id }
  })

  get('/api/media/tasks', (ctx) => {
    const status = clampStr(ctx.query.status, 30)
    const rows = db.prepare(`SELECT * FROM media_tasks ${TASK_STATES.has(status) ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 300`).all(...(TASK_STATES.has(status) ? [status] : []))
    return { items: rows.map(taskRow) }
  })
  post('/api/media/tasks', async (ctx) => {
    const platforms = validatePlatforms(ctx.body.platform_keys || ctx.body.platforms)
    const accounts = validateIds(ctx.body.account_ids)
    const materials = validateIds(ctx.body.material_ids)
    if (!accounts.length) bad('至少选择一个账号', 'missing_account')
    if (!materials.length) bad('至少选择一个素材', 'missing_material')
    const knownAccounts = db.prepare(`SELECT id, platform FROM media_accounts WHERE id IN (${accounts.map(() => '?').join(',')})`).all(...accounts)
    if (knownAccounts.length !== accounts.length) bad('有账号已经不存在了，请刷新后重试', 'stale_account')
    if (knownAccounts.some((account) => !platforms.includes(account.platform))) bad('已选账号和发布平台不匹配', 'account_platform_mismatch')
    const knownMaterials = db.prepare(`SELECT id FROM media_materials WHERE status = 'active' AND id IN (${materials.map(() => '?').join(',')})`).all(...materials)
    if (knownMaterials.length !== materials.length) bad('有素材已经不存在了，请刷新后重试', 'stale_material')
    const title = clampStr(ctx.body.title, 180).trim()
    if (!title) bad('请填写标题', 'missing_field')
    let publishAt = null
    if (ctx.body.publish_at) {
      const publishTime = Date.parse(ctx.body.publish_at)
      if (Number.isNaN(publishTime)) bad('发布时间格式不正确', 'bad_publish_at')
      publishAt = new Date(publishTime).toISOString()
    }
    const topics = [...new Set((Array.isArray(ctx.body.topics) ? ctx.body.topics : String(ctx.body.topics || '').split(/[,，\n]/)).map((v) => clampStr(v, 40).replace(/^#/, '').trim()).filter(Boolean))].slice(0, 30)
    const status = publishAt && Date.parse(publishAt) > Date.now() ? 'scheduled' : 'queued'
    const now = stamp()
    const info = db.prepare('INSERT INTO media_tasks (title, content, topics, platform_keys, account_ids, material_ids, publish_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(title, clampStr(ctx.body.content, 10000), stringifyJSON(topics), stringifyJSON(platforms), stringifyJSON(accounts), stringifyJSON(materials), publishAt, status, now, now)
    const row = db.prepare('SELECT * FROM media_tasks WHERE id = ?').get(Number(info.lastInsertRowid))
    if (status === 'queued' && ctx.body.dispatch === true) return { task: taskRow(row), dispatch: await dispatchTask(Number(info.lastInsertRowid)) }
    return taskRow(row)
  })
  post('/api/media/tasks/:id/dispatch', async (ctx) => dispatchTask(int(ctx.params.id)))
  post('/api/media/tasks/:id/cancel', (ctx) => {
    const id = int(ctx.params.id)
    const row = db.prepare('SELECT * FROM media_tasks WHERE id = ?').get(id)
    if (!row) notFound('发布任务不存在')
    if (['success', 'cancelled'].includes(row.status)) return taskRow(row)
    db.prepare('UPDATE media_tasks SET status = ?, updated_at = ? WHERE id = ?').run('cancelled', stamp(), id)
    return taskRow(db.prepare('SELECT * FROM media_tasks WHERE id = ?').get(id))
  })
  post('/api/media/tasks/:id/retry', async (ctx) => {
    const id = int(ctx.params.id)
    const row = db.prepare('SELECT * FROM media_tasks WHERE id = ?').get(id)
    if (!row) notFound('发布任务不存在')
    db.prepare('UPDATE media_tasks SET status = ?, error_msg = ?, updated_at = ? WHERE id = ?').run('queued', '', stamp(), id)
    const refreshed = db.prepare('SELECT * FROM media_tasks WHERE id = ?').get(id)
    return { task: taskRow(refreshed), dispatch: ctx.body?.dispatch === true ? await dispatchTask(id) : null }
  })
}

function buildSummary() {
  const count = (where = '') => db.prepare(`SELECT COUNT(*) AS c FROM media_tasks ${where ? `WHERE ${where}` : ''}`).get().c
  return {
    accounts: db.prepare("SELECT COUNT(*) AS c FROM media_accounts WHERE auth_state <> 'disabled'").get().c,
    materials: db.prepare("SELECT COUNT(*) AS c FROM media_materials WHERE status = 'active'").get().c,
    queued: count("status IN ('queued', 'scheduled', 'publishing')"),
    failed: count("status = 'failed'"),
  }
}
