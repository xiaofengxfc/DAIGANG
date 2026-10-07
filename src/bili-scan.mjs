/**
 * B站自动比价的任务编排 —— 把「搜视频 → 下视频 → 抽帧 → OCR → 解析 → 匹配 → 取中位数」
 * 串成一条能看进度、能取消、能复查的流水线。
 *
 * 几个刻意的取舍：
 *
 * 1. **一次只跑一个任务。** B站 接口有风控，本地 CPU 也要留给 OCR。
 *    并发跑两个只会互相拖慢还更容易触发限流。第二个请求直接被告知「已有任务在跑」。
 *
 * 2. **任务结果落库。** 一次扫描要几分钟，中途改代码重启是常事；
 *    结果里带着「哪个视频、哪一帧、认出了什么」这些证据，丢了就得重跑。
 *
 * 3. **每个视频的 OCR 有预算、凑够就收工。** 价格表基本是一张静态图，
 *    找到 8 条价格之后再往下认只是重复读同一张图 —— 一帧 OCR 要 0.5~3 秒，
 *    8 个视频不设上限能跑十几分钟。
 *
 * 4. **只出建议，不直接改库。** 写入是单独一步（applyScan），由用户确认后触发。
 *    OCR 认错一个数字就是错价，让机器直接落库太危险。
 */
import fs from 'node:fs'
import path from 'node:path'
import { db, stamp } from './db.mjs'
import {
  BILI_DIR,
  BILI_ENOUGH_ROWS,
  BILI_FRAME_DIR,
  BILI_FRAME_MAX,
  BILI_FRAME_INTERVAL_S,
  BILI_MAX_VIDEOS,
  BILI_MIN_SAMPLES,
  BILI_MIN_VIDEO_SECONDS,
  BILI_MAX_VIDEO_SECONDS,
  BILI_BLOCK_TITLE_WORDS,
  BILI_OCR_BUDGET_MS,
  BILI_OCR_TIMEOUT_MS,
  BILI_SEARCH_PAGES,
  BILI_TMP_TTL_MS,
} from './config.mjs'
import { BiliClient, biliAuthStatus, resolveBiliCookieFile, storageStateToNetscape } from './bili-api.mjs'
import { biliDependencyStatus, ytDlpInvocation } from './bili-deps.mjs'
import { downloadVideo, extractFrames } from './bili-video.mjs'
import { collapseWithinVideo, extractPriceCandidates, extractSections, groupLines, median, spread } from './price-parse.mjs'
import { groupByService, matchServices } from './price-match.mjs'
import { aiConfig } from './ai.mjs'
import { acceptRename, aiMatchUnmatched, aiProposeServices, aiTriageVideo, isKnownServiceName, normalizeServiceName } from './ai-scan.mjs'
import { ensureVisionStarted, visionOcr } from './vision-python.mjs'
import { enqueueERPNextChange } from './outbox.mjs'
import { bad, nextSortOrder, notFound } from './util.mjs'
import { looksDaily } from '../shared/domain.js'

/** 内存里的活动任务。落库的那份是给「重启后还能看」用的，这份是给进度用的 */
const liveJobs = new Map()

/* ============================================================
   前置条件检查
   ============================================================ */

/**
 * 这个功能现在能不能用。前端拿它决定按钮是「开始扫描」还是「先装依赖」。
 */
export function scanReadiness() {
  const auth = biliAuthStatus()
  const deps = biliDependencyStatus()
  const blockers = []
  if (!deps.ytdlp.available) blockers.push({ code: 'ytdlp', message: '还没装 yt-dlp（下载视频要用它）' })
  if (!deps.ffmpeg.available) blockers.push({ code: 'ffmpeg', message: '没找到 ffmpeg（抽帧要用它），请先安装并确保在 PATH 里' })
  if (!auth.ok) blockers.push({ code: 'auth', message: auth.message })
  return {
    ready: blockers.length === 0,
    blockers,
    auth,
    deps: { ytdlp: deps.ytdlp, ffmpeg: deps.ffmpeg, venv: deps.venv },
    defaults: {
      max_videos: BILI_MAX_VIDEOS,
      min_samples: BILI_MIN_SAMPLES,
      frame_max: BILI_FRAME_MAX,
      ocr_budget_ms: BILI_OCR_BUDGET_MS,
    },
  }
}

/* ============================================================
   候选视频的筛选
   ============================================================ */

/** 标题里出现这些词的多半不是「价格表」视频 */
function titleBlocked(title) {
  const text = String(title || '')
  return BILI_BLOCK_TITLE_WORDS.some((word) => word && text.includes(word))
}

/**
 * 从搜索结果里挑出值得下载的视频。
 *
 * 打分而不是一刀切：B站 搜索的相关性排序已经不错，但混进来的
 * 「游戏代肝的正常价格区间」（聊行业，不给表）这类视频没有硬性排除条件，
 * 只能靠「标题里有游戏名 + 时长像价格表」这类信号排序，取前 N 个。
 */
export function rankCandidates(videos, { gameName = '', shortName = '', serviceNames = [] } = {}) {
  const names = [gameName, shortName, ...serviceNames].filter((s) => s && s.length >= 2)
  const scored = []
  for (const video of videos) {
    if (!video?.bvid) continue
    if (titleBlocked(video.title)) continue
    const duration = Number(video.duration) || 0
    if (duration < BILI_MIN_VIDEO_SECONDS || duration > BILI_MAX_VIDEO_SECONDS) continue

    const title = String(video.title || '')
    let score = 0
    if (gameName && title.includes(gameName)) score += 5
    if (shortName && title.includes(shortName)) score += 3
    // 标题里带「价格表 / 价目 / 报价」这类词的，几乎一定是我们想要的
    if (/(?:价格表|价目表|价格单|报价单|价目|价格)/.test(title)) score += 4
    if (/(?:代肝|代练|代打)/.test(title)) score += 2
    // 标题里带具体服务名说明这视频是分项报价，比泛泛而谈的更有信息量
    const hitServices = names.filter((n) => n !== gameName && n !== shortName && title.includes(n)).length
    if (hitServices) score += Math.min(4, hitServices * 2)
    // 播放量当微弱信号：太高的可能是热点吐槽，但完全不看会把一堆 0 播放的垃圾排前面
    score += Math.min(2, Math.log10(Math.max(1, Number(video.play) || 0)) / 2)

    scored.push({ ...video, score: Math.round(score * 100) / 100, hasGame: Boolean(gameName && title.includes(gameName)) })
  }
  scored.sort((a, b) => b.score - a.score || (Number(b.play) || 0) - (Number(a.play) || 0))
  return scored
}

/* ============================================================
   临时目录
   ============================================================ */

function jobDir(jobId) {
  return path.join(BILI_DIR, jobId)
}

function frameDirOf(jobId, bvid) {
  return path.join(BILI_FRAME_DIR, jobId, bvid)
}

/** 相对 BILI_FRAME_DIR 的路径，存进结果里给前端取图用 */
function frameRelPath(jobId, bvid, fileName) {
  return path.posix.join(jobId, bvid, fileName)
}

/** 顺手清掉过期的中间产物（视频和帧都挺占地方）*/
export function cleanupOldScans({ ttlMs = BILI_TMP_TTL_MS, keepJobIds = [] } = {}) {
  const keep = new Set(keepJobIds)
  const cutoff = Date.now() - ttlMs
  let removed = 0
  for (const root of [BILI_DIR, BILI_FRAME_DIR]) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (keep.has(entry.name)) continue
      const full = path.join(root, entry.name)
      try {
        if (fs.statSync(full).mtimeMs > cutoff) continue
        fs.rmSync(full, { recursive: true, force: true })
        removed += 1
      } catch {
        /* 删不掉就下次再说 */
      }
    }
  }
  pruneVideoCache()
  return { removed }
}

/* ============================================================
   视频识别结果缓存
   ============================================================ */

/**
 * 缓存版本。**抽帧参数变了，老结果就不等价了**，所以把它们编进版本号里，
 * 改了配置老缓存自动失效，不用手工清。
 *
 * 识别引擎（视觉后端的模型）换了也应该改这个数字 —— 那个没法从配置读出来。
 */
const VIDEO_CACHE_VERSION = `v1|每${BILI_FRAME_INTERVAL_S}秒|最多${BILI_FRAME_MAX}帧`

/** 缓存留多久。视频里的价格表会改，留太久不如重扫 */
const VIDEO_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 取这个视频上次的识别结果。没有、版本对不上、或者坏了都返回 null。
 *
 * 存的**只有原始识别结果**（每一帧的 words），不含解析后的成品。这是有意的：
 * 解析结果依赖库内服务项和 AI 配置，存下来就会过期；原始识别只依赖视频本身。
 */
function readVideoCache(bvid) {
  let row
  try {
    row = db.prepare('SELECT version, frames, frames_dir, at FROM bili_video_cache WHERE bvid = ?').get(bvid)
  } catch {
    return null
  }
  if (!row || row.version !== VIDEO_CACHE_VERSION) return null
  let frames
  try {
    frames = JSON.parse(row.frames)
  } catch {
    return null
  }
  if (!Array.isArray(frames) || !frames.length) return null
  return { frames, framesDir: row.frames_dir || '', at: row.at }
}

function writeVideoCache(bvid, frames, framesDir) {
  try {
    /**
     * 重新识别了就**把 AI 那部分缓存一起清掉**。
     *
     * 不清会出事：签名只覆盖「模型 + 库内服务名 + 解析版本」，不覆盖识别结果本身。
     * 强制重扫时 OCR 重新跑了一遍、内容可能已经不同（视频改了，或者识别本身有抖动），
     * 而旧的 AI 判断是按 `帧:行` 指认的 —— 行号一挪，判断就安到了别的行上，
     * 等于**随机删价**。实测确实出现了「重扫后未匹配数从 9 变成 12」。
     */
    db.prepare(
      `INSERT INTO bili_video_cache (bvid, version, ocr_frames, frames, frames_dir, at, ai_sig, ai_result)
       VALUES (?, ?, ?, ?, ?, ?, '', '')
       ON CONFLICT(bvid) DO UPDATE SET version = excluded.version, ocr_frames = excluded.ocr_frames,
         frames = excluded.frames, frames_dir = excluded.frames_dir, at = excluded.at,
         ai_sig = '', ai_result = ''`,
    ).run(bvid, VIDEO_CACHE_VERSION, frames.length, JSON.stringify(frames), framesDir, stamp())
  } catch {
    /* 缓存写不进去不该让这次扫描失败 */
  }
}

/** 清掉过期的缓存条目，别让它无限长 */
export function pruneVideoCache({ ttlMs = VIDEO_CACHE_TTL_MS } = {}) {
  const cutoff = new Date(Date.now() - ttlMs).toISOString()
  try {
    const r = db.prepare('DELETE FROM bili_video_cache WHERE at < ?').run(cutoff)
    return { removed: Number(r.changes || 0) }
  } catch {
    return { removed: 0 }
  }
}

/**
 * AI 判断在什么前提下才作数。
 *
 * 模型的判断只依赖三样东西：原始识别结果（缓存里那份）、库内服务名、模型本身。
 * 前两样加上版本号就是完整的签名 —— 库改了服务项、换了模型，签名变了就重新问，
 * 所以不会出现「AI 拿着旧库的判断套新库」这种错。
 *
 * 服务名排过序：库内顺序变了不该导致重新问一遍。
 */
function aiSignature(serviceNames) {
  const config = aiConfig()
  if (!config.enabled) return ''
  return `${VIDEO_CACHE_VERSION}\u0001${config.model}\u0001${[...serviceNames].sort().join('\u0002')}`
}

/**
 * 取这个视频上次的 AI 甄别结果。
 *
 * 存的是**模型的原始回复**，重放时走的是完全相同的校验、改名、剔除逻辑 ——
 * 缓存不会绕过任何一道安全闸。
 */
/**
 * `aiTriageVideo` 返回的 `decisions` 和 `renames` 是 **Map**，而 Map 过不了 JSON ——
 * `JSON.stringify(new Map())` 得到 `{}`，读回来就成了普通对象，一迭代就炸
 * （实测报的是 `object is not iterable`，而且四个视频全挂）。
 * 所以存之前转成数组，读之后转回 Map。
 */
function packAiResult(result) {
  return JSON.stringify({
    ...result,
    decisions: [...(result.decisions instanceof Map ? result.decisions : new Map()).entries()],
    renames: [...(result.renames instanceof Map ? result.renames : new Map()).entries()],
  })
}

function unpackAiResult(text) {
  const raw = JSON.parse(text)
  return {
    ...raw,
    decisions: new Map(raw.decisions || []),
    renames: new Map(raw.renames || []),
  }
}

function readCachedAi(bvid, signature) {
  if (!signature) return null
  try {
    const row = db.prepare('SELECT ai_sig, ai_result FROM bili_video_cache WHERE bvid = ?').get(bvid)
    if (!row || row.ai_sig !== signature || !row.ai_result) return null
    return unpackAiResult(row.ai_result)
  } catch {
    return null
  }
}

function writeCachedAi(bvid, signature, result) {
  if (!signature || !result?.ok) return
  try {
    // 只在签名变了才覆盖 —— 同一份输入重问一遍得到的结果可能略有出入，
    // 但没必要因此把缓存洗掉
    db.prepare('UPDATE bili_video_cache SET ai_sig = ?, ai_result = ? WHERE bvid = ?')
      .run(signature, packAiResult(result), bvid)
  } catch {
    /* 写不进去不影响这次扫描 */
  }
}

/** 手动清空（界面上「重新扫描」之外，也留给排查用） */
export function clearVideoCache() {
  try {
    return { removed: Number(db.prepare('DELETE FROM bili_video_cache').run().changes || 0) }
  } catch {
    return { removed: 0 }
  }
}

/**
 * 把缓存里的帧图拷进本任务的目录，缩略图才有出处。
 *
 * **拷不动不算失败。** 帧图是中间产物，超过 24 小时会被清掉，而识别结果还在 ——
 * 这时候照样复用识别结果（省掉下载和 OCR 才是重点），只是没有缩略图可看。
 */
function restoreCachedFrames(cached, jobId, bvid) {
  const target = frameDirOf(jobId, bvid)
  const out = []
  let copied = 0
  for (const frame of cached.frames) {
    const name = path.basename(String(frame.file || ''))
    let local = ''
    if (name && cached.framesDir) {
      try {
        const from = path.join(cached.framesDir, name)
        if (fs.existsSync(from)) {
          fs.mkdirSync(target, { recursive: true })
          fs.copyFileSync(from, path.join(target, name))
          local = name
          copied += 1
        }
      } catch {
        /* 拷不过去就当这一帧没有图 */
      }
    }
    out.push({ file: name, ok: frame.ok !== false, words: frame.words || [], local })
  }
  return { frames: out, copied }
}

/* ============================================================
   任务读写
   ============================================================ */

function persist(job) {
  const now = stamp()
  db.prepare(
    `INSERT INTO price_scan_jobs (id, game_id, game_name, keyword, status, stage, result, error_msg, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, stage = excluded.stage,
       result = excluded.result, error_msg = excluded.error_msg, updated_at = excluded.updated_at`,
  ).run(
    job.id,
    job.game_id ?? null,
    job.game_name || '',
    job.keyword || '',
    job.status,
    job.stage || '',
    JSON.stringify({ progress: job.progress, videos: job.videos, matched: job.matched, unmatched: job.unmatched, sections: job.sections, applied: job.applied, summary: job.summary, ai: job.ai }),
    job.error || '',
    job.created_at,
    now,
  )
}

function publicJob(job) {
  return {
    id: job.id,
    game_id: job.game_id,
    game_name: job.game_name,
    keyword: job.keyword,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    videos: job.videos,
    matched: job.matched,
    unmatched: job.unmatched,
    sections: job.sections || [],
    ai: job.ai || null,
    applied: job.applied,
    summary: job.summary,
    log: job.log.slice(-60),
    error: job.error,
    created_at: job.created_at,
    updated_at: job.updated_at,
  }
}

export function getScanJob(id) {
  const live = liveJobs.get(String(id))
  if (live) return publicJob(live)
  const row = db.prepare('SELECT * FROM price_scan_jobs WHERE id = ?').get(String(id))
  if (!row) return null
  const parsed = (() => {
    try {
      return JSON.parse(row.result || '{}')
    } catch {
      return {}
    }
  })()
  return {
    id: row.id,
    game_id: row.game_id,
    game_name: row.game_name,
    keyword: row.keyword,
    status: row.status,
    stage: row.stage,
    progress: parsed.progress || {},
    videos: parsed.videos || [],
    matched: parsed.matched || [],
    unmatched: parsed.unmatched || [],
    sections: parsed.sections || [],
    ai: parsed.ai || null,
    applied: parsed.applied || [],
    summary: parsed.summary || null,
    log: [],
    error: row.error_msg,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listScanJobs({ gameId = null, limit = 20 } = {}) {
  const rows = gameId
    ? db.prepare('SELECT * FROM price_scan_jobs WHERE game_id = ? ORDER BY created_at DESC LIMIT ?').all(Number(gameId), Number(limit))
    : db.prepare('SELECT * FROM price_scan_jobs ORDER BY created_at DESC LIMIT ?').all(Number(limit))
  return rows.map((row) => {
    const parsed = (() => {
      try {
        return JSON.parse(row.result || '{}')
      } catch {
        return {}
      }
    })()
    return {
      id: row.id,
      game_id: row.game_id,
      game_name: row.game_name,
      keyword: row.keyword,
      status: row.status,
      stage: row.stage,
      created_at: row.created_at,
      updated_at: row.updated_at,
      error: row.error_msg,
      summary: parsed.summary || null,
      video_count: Array.isArray(parsed.videos) ? parsed.videos.length : 0,
      match_count: Array.isArray(parsed.matched) ? parsed.matched.length : 0,
    }
  })
}

export function activeScanJob() {
  for (const job of liveJobs.values()) {
    if (job.status === 'running') return publicJob(job)
  }
  return null
}

export function cancelScan(id) {
  const job = liveJobs.get(String(id))
  if (!job) return { ok: false, error: '这个任务不在运行中（可能已经结束，或服务重启过）' }
  if (job.status !== 'running') return { ok: false, error: '任务已经结束了' }
  job.cancelRequested = true
  job.stage = '正在取消…'
  return { ok: true }
}

/* ============================================================
   启动扫描
   ============================================================ */

/** 取这个游戏在架的服务项（匹配的目标集合）*/
function servicesOfGame(gameId) {
  return db
    .prepare(
      `SELECT s.id, s.name, s.unit_label, s.base_price, s.category_id, s.aliases, c.name AS category_name
       FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
       WHERE s.game_id = ? AND s.status = 'active'
       ORDER BY s.sort_order ASC, s.id ASC`,
    )
    .all(Number(gameId))
}

/**
 * 关键词怎么来的：`游戏名 + 代肝 + 价格表`。
 * 用户可以覆盖（有些游戏圈里习惯叫别的词），也可以额外补充同义词。
 */
export function defaultKeyword(gameName, extra = '') {
  const base = String(extra || '').trim()
  if (base) return base
  return `${String(gameName || '').trim()} 代肝 价格表`
}

export function startScan({ gameId, keyword = '', maxVideos = BILI_MAX_VIDEOS, minSamples = BILI_MIN_SAMPLES, force = false, refresh = false } = {}) {
  const readiness = scanReadiness()
  if (!readiness.ready && !force) {
    return { ok: false, code: 'not_ready', error: readiness.blockers.map((b) => b.message).join('；'), readiness }
  }
  const game = db.prepare('SELECT id, name, short_name FROM games WHERE id = ?').get(Number(gameId))
  if (!game) throw bad('请选择一个游戏', 'game_required')

  const running = activeScanJob()
  if (running) return { ok: false, code: 'busy', error: `已经有一个扫描在跑（${running.game_name}）。等它跑完或先取消。`, job: running }

  const id = `scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const job = {
    id,
    game_id: game.id,
    game_name: game.name,
    game_short_name: game.short_name || '',
    keyword: defaultKeyword(game.name, keyword),
    status: 'running',
    stage: '准备中',
    progress: { videos_found: 0, videos_total: 0, videos_done: 0, frames: 0, ocr_frames: 0, reused_videos: 0, parsed_names: 0 },
    videos: [],
    matched: [],
    unmatched: [],
    applied: [],
    summary: null,
    log: [],
    error: '',
    cancelRequested: false,
    created_at: stamp(),
    updated_at: stamp(),
  }
  liveJobs.set(id, job)
  persist(job)

  void runScan(job, { maxVideos, minSamples, refresh }).catch((err) => {
    job.status = 'failed'
    job.error = err?.message || String(err)
    job.stage = '出错了'
    job.updated_at = stamp()
    persist(job)
    liveJobs.delete(id)
  })

  return { ok: true, job: publicJob(job) }
}

/* ============================================================
   流水线本体
   ============================================================ */

function logLine(job, text) {
  job.log.push({ at: stamp(), text })
  if (job.log.length > 200) job.log.shift()
}

function touch(job) {
  job.updated_at = stamp()
  persist(job)
}

function assertNotCancelled(job) {
  if (job.cancelRequested) {
    const err = new Error('任务已取消')
    err.cancelled = true
    throw err
  }
}

async function runScan(job, { maxVideos, minSamples, refresh = false }) {
  fs.mkdirSync(jobDir(job.id), { recursive: true })

  /* ---- 1. 搜索 ---- */
  job.stage = '搜索 B站 视频'
  touch(job)
  const auth = biliAuthStatus()
  if (!auth.ok) throw new Error(auth.message)
  const found = resolveBiliCookieFile()
  if (!found) throw new Error('没有可用的 B站 登录态')

  // yt-dlp 只认 Netscape 格式的 cookies.txt，从同一份 storage_state 转一份出来
  const cookieFile = path.join(jobDir(job.id), 'cookies.txt')
  fs.writeFileSync(cookieFile, storageStateToNetscape(found.state), 'utf8')
  logLine(job, `使用登录态：${auth.account}`)

  const client = BiliClient.fromStorageState(found.state)
  const raw = []
  const seenBvid = new Set()
  // 搜两页：一页 20 条里常常有一半被时长/标题挡掉，只搜一页可能凑不够 8 个
  for (let page = 1; page <= BILI_SEARCH_PAGES; page++) {
    assertNotCancelled(job)
    const hits = await client.searchVideos(job.keyword, { page })
    logLine(job, `搜索第 ${page} 页：${hits.length} 条`)
    for (const hit of hits) {
      if (seenBvid.has(hit.bvid)) continue
      seenBvid.add(hit.bvid)
      raw.push(hit)
    }
    if (raw.length >= maxVideos * 4) break
  }
  job.progress.videos_found = raw.length

  const services = servicesOfGame(job.game_id)
  logLine(job, `库内 ${job.game_name} 在架服务项 ${services.length} 个`)

  const ranked = rankCandidates(raw, {
    gameName: job.game_name,
    shortName: job.game_short_name,
    serviceNames: services.map((s) => s.name),
  })
  const picked = ranked.slice(0, Math.max(1, Number(maxVideos)))
  if (!picked.length) {
    job.status = 'done'
    job.stage = '没有可用的视频'
    job.error = `没搜到合适的视频（关键词「${job.keyword}」）。可以换个关键词再试。`
    job.progress.videos_total = 0
    job.summary = { picked: 0, reused: 0, parsed_names: 0, matched: 0, unmatched: 0 }
    touch(job)
    liveJobs.delete(job.id)
    return
  }
  job.videos = picked.map((v) => ({
    bvid: v.bvid,
    title: v.title,
    author: v.author,
    duration: v.duration,
    play: v.play,
    url: v.url,
    score: v.score,
    status: 'pending',
    frames: 0,
    ocr_frames: 0,
    parsed: 0,
    error: '',
  }))
  job.progress.videos_total = picked.length
  logLine(job, `选中 ${picked.length} 个视频：${picked.map((v) => v.bvid).join(', ')}`)
  touch(job)

  /* ---- 2. 逐个视频：下载 → 抽帧 → OCR → 解析 ---- */
  const vision = await ensureVisionStarted().catch((err) => ({ ok: false, error: err?.message }))
  if (vision && vision.ok === false) {
    logLine(job, `视觉后端没起来：${vision.error || '未知原因'}，会退回其它 OCR 引擎`)
  }

  const allParsed = []
  const allSections = []
  /**
   * AI 甄别的累计账。放在任务上给用户看：
   * 「这次剔掉了 37 行不是价格的、纠正了 5 个认歪的名字」——
   * 不说的话用户会以为解析器变强了，而实际上是他配的模型在干活。
   */
  /**
   * `last_error` 不只是给日志看的。
   *
   * AI 调用失败时管线会安全降级（全部保留，结果照样出），但**用户看不见**——
   * 界面上写着「AI 甄别 deepseek-xxx」，实际它一次都没成功。这种「看起来在干活
   * 其实没干」比直接报错更坏，所以错误文本要一路带到界面上。
   */
  const aiTotals = {
    enabled: false, model: '', dropped: 0, renamed: 0, kept: 0, errors: 0, ms: 0, cached: 0,
    dropped_samples: [], renamed_samples: [], rename_rejected_samples: [], last_error: '',
  }
  for (let i = 0; i < job.videos.length; i++) {
    const video = job.videos[i]
    assertNotCancelled(job)
    job.stage = `处理视频 ${i + 1}/${job.videos.length}`
    touch(job)
    try {
      const parsed = await processOneVideo(job, video, {
        cookieFile,
        serviceNames: services.map((s) => s.name),
        refresh,
      })
      allParsed.push(...parsed.items)
      allSections.push(...parsed.sections)
      if (parsed.ai?.enabled) {
        aiTotals.enabled = true
        aiTotals.model = parsed.ai.model || aiTotals.model
        aiTotals.dropped += parsed.ai.dropped || 0
        aiTotals.renamed += parsed.ai.renamed || 0
        aiTotals.kept += parsed.ai.kept || 0
        aiTotals.ms += parsed.ai.ms || 0
        if (parsed.ai.cached) aiTotals.cached += 1
        for (const sample of parsed.ai.dropped_samples || []) {
          if (aiTotals.dropped_samples.length < 20) aiTotals.dropped_samples.push(sample)
        }
        for (const sample of parsed.ai.renamed_samples || []) {
          if (aiTotals.renamed_samples.length < 20) aiTotals.renamed_samples.push(sample)
        }
        for (const sample of parsed.ai.rename_rejected_samples || []) {
          if (aiTotals.rename_rejected_samples.length < 10) aiTotals.rename_rejected_samples.push(sample)
        }
      } else if (parsed.ai?.error) {
        aiTotals.errors += 1
        if (!aiTotals.last_error) aiTotals.last_error = String(parsed.ai.error).slice(0, 300)
      }
    } catch (err) {
      if (err?.cancelled) throw err
      video.status = 'failed'
      video.error = err?.message || String(err)
      logLine(job, `${video.bvid} 处理失败：${video.error}`)
    }
    job.progress.videos_done = i + 1
    job.progress.parsed_names = allParsed.length
    touch(job)
  }

  /* ---- 3. 匹配 + 中位数 ---- */
  job.stage = '匹配服务项并计算中位数'
  touch(job)

  let { matched, unmatched } = matchServices(allParsed, services, {})

  /**
   * 规则匹不上的，让模型从库内候选里挑一遍。
   *
   * 这是兜底不是主力：字符串相似度能匹上的已经匹上了，这里只处理剩下的。
   * 模型只能从我们给的候选 id 里选（`aiMatchUnmatched` 会校验），
   * 所以它编不出一个库里不存在的服务项。
   */
  if (aiConfig().enabled && unmatched.length && services.length) {
    const names = [...new Map(unmatched.map((u) => [u.parsed_name, u])).values()].map((u) => ({ name: u.parsed_name, line: u.line }))
    job.stage = `AI 兜底匹配 ${names.length} 个没匹上的名字`
    touch(job)
    let picked
    try {
      picked = await aiMatchUnmatched({ game: job.game_name || '', services, names })
    } catch (err) {
      picked = { ok: false, error: err?.message || String(err) }
    }
    if (picked.ok) {
      const byId = new Map(services.map((s) => [Number(s.id), s]))
      const rescued = []
      const stillUnmatched = []
      const pickByName = new Map(picked.picks.filter((p) => p.service_id).map((p) => [p.name, p]))
      for (const item of unmatched) {
        const pick = pickByName.get(item.parsed_name)
        const service = pick ? byId.get(Number(pick.service_id)) : null
        if (!service) {
          stillUnmatched.push(item)
          continue
        }
        rescued.push(item.parsed_name)
        matched.push({
          ...item,
          service_id: service.id,
          service_name: service.name,
          service_unit: service.unit_label || '',
          current_price: service.base_price,
          score: pick.confidence === 'high' ? 0.9 : pick.confidence === 'medium' ? 0.75 : 0.6,
          exact: false,
          // 标记来源，界面上要能区分「字符串匹上的」和「AI 判的」
          matched_by: 'ai',
          ai_confidence: pick.confidence,
          ai_why: pick.why,
        })
      }
      unmatched = stillUnmatched
      aiTotals.enabled = true
      aiTotals.rescued = rescued.length
      aiTotals.rescued_names = rescued.slice(0, 20)
      aiTotals.match_ms = picked.ms || 0
      if (rescued.length) logLine(job, `AI 兜底匹上 ${rescued.length} 个：${rescued.slice(0, 10).join('、')}`)
    } else {
      aiTotals.errors += 1
      if (!aiTotals.last_error) aiTotals.last_error = String(picked.error).slice(0, 300)
      logLine(job, `AI 兜底匹配跳过：${picked.error}`)
    }
  }

  const groups = groupByService(matched, { minSamples: Number(minSamples) })
  job.ai = aiTotals

  job.matched = groups.map((group) => {
    const values = group.prices
    const suggested = values.length ? median(values) : null
    const dispersion = values.length ? spread(values) : null
    return {
      service_id: group.service_id,
      service_name: group.service_name,
      service_unit: group.service_unit,
      category_id: group.category_id,
      category_name: group.category_name,
      current_price: group.current_price,
      suggested_price: suggested,
      sample_count: group.sample_count,
      enough: group.enough,
      min_samples: Number(minSamples),
      exact: group.exact,
      best_score: group.best_score,
      confidence: group.confidence,
      prices: values,
      dispersion,
      aliases: group.aliases,
      // 被挡掉的样本要留着：用户得能看见「为什么这一项没给建议」
      excluded: group.excluded,
      only_unit_mismatch: group.only_unit_mismatch,
      only_ambiguous: group.only_ambiguous,
      delta: suggested === null ? null : Math.round((suggested - group.current_price) * 100) / 100,
      delta_ratio: suggested === null || !group.current_price ? null : Math.round((suggested / group.current_price) * 100) / 100,
      samples: group.samples.map((s) => {
        const video = job.videos.find((v) => v.bvid === s.video)
        return { ...s, video_title: video?.title || '' }
      }),
    }
  })
  job.unmatched = unmatched

  /**
   * 分节标题 → 大类候选，跨视频聚合。
   *
   * 同一个标题会在多帧里反复出现，同一帧里也可能重复（OCR 抖动），所以按名字合并，
   * 记下它出现在几个**不同视频**里 —— 多个视频都有这个名字，说明它是价格表的固定
   * 板块而不是某一次的误认，这比出现帧数更能说明问题。
   *
   * 子项（这个板块下面有哪些服务）也一起攒着，让用户知道建了这个大类之后
   * 里面该放什么。
   */
  const sectionMap = new Map()
  for (const hit of allSections) {
    const rec = sectionMap.get(hit.name) || { name: hit.name, videos: new Set(), items: new Set(), frames: 0, frame: '' }
    rec.videos.add(hit.bvid)
    rec.frames += 1
    if (!rec.frame) rec.frame = hit.frame
    for (const item of hit.items || []) rec.items.add(item)
    sectionMap.set(hit.name, rec)
  }
  job.sections = [...sectionMap.values()]
    .map((rec) => ({
      name: rec.name,
      video_count: rec.videos.size,
      frame_count: rec.frames,
      frame: rec.frame,
      items: [...rec.items],
    }))
    .sort((a, b) => b.video_count - a.video_count || b.items.length - a.items.length)

  job.summary = {
    picked: job.videos.length,
    downloaded: job.videos.filter((v) => v.status === 'parsed').length,
    // 复用上次识别结果的条数。要说出来 —— 用户看到「只花了 5 秒」得知道为什么，
    // 否则会以为这次扫得特别顺利、结果特别可信。
    reused: job.videos.filter((v) => v.reused).length,
    failed: job.videos.filter((v) => v.status === 'failed').length,
    parsed_names: allParsed.length,
    matched: job.matched.length,
    ready: job.matched.filter((m) => m.enough).length,
    insufficient: job.matched.filter((m) => !m.enough && m.sample_count > 0).length,
    no_sample: job.matched.filter((m) => m.sample_count === 0).length,
    unmatched: job.unmatched.length,
    min_samples: Number(minSamples),
  }

  job.status = 'done'
  job.stage = '完成'
  logLine(job, `完成：匹配 ${job.summary.matched} 个服务项，其中 ${job.summary.ready} 个样本足够`)
  touch(job)
  liveJobs.delete(job.id)
}

/**
 * 拿到这个视频每一帧的识别结果。
 *
 * 命中缓存就跳过**下载 → 抽帧 → OCR** 三步。这三步占了一个视频十几秒里的绝大部分，
 * 而且结果只取决于视频本身 —— 跟游戏、库内服务项、AI 配置都无关，所以能安全复用。
 * 同一个关键词搜出来的视频高度重合，不缓存的话第二次扫大半时间都白花。
 *
 * 返回 `{ frames: [{file, ok, words, local}], total }`。`local` 是这一帧的图在
 * **本任务**目录下的文件名；帧图被清理过时是空串。
 */
async function ocrVideo(job, video, { cookieFile, refresh }) {
  if (!refresh) {
    const cached = readVideoCache(video.bvid)
    if (cached) {
      const restored = restoreCachedFrames(cached, job.id, video.bvid)
      video.reused = true
      video.status = 'cached'
      video.frames = restored.frames.length
      job.stage = `复用上次结果 ${video.bvid}`
      job.progress.reused_videos = (job.progress.reused_videos || 0) + 1
      job.progress.frames += restored.frames.length
      logLine(
        job,
        `${video.bvid} 复用上次的识别结果（${restored.frames.length} 帧）` +
          (restored.copied ? '' : '，帧图已被清理所以这次没有缩略图'),
      )
      touch(job)
      return { frames: restored.frames, total: restored.frames.length }
    }
  }

  const dir = path.join(jobDir(job.id), video.bvid)
  video.status = 'downloading'
  job.stage = `下载 ${video.bvid}`
  touch(job)

  const download = await downloadVideo({
    bvid: video.bvid,
    dir,
    cookieFile,
    onLine: () => {}, // 进度太碎，不往任务日志里塞
  })
  if (!download.ok) {
    // 下载不下来时，把这个视频从磁盘上的残留清掉
    fs.rmSync(dir, { recursive: true, force: true })
    throw new Error(download.error || '下载失败')
  }
  video.status = 'extracting'
  job.stage = `抽帧 ${video.bvid}`
  touch(job)

  const frameDir = frameDirOf(job.id, video.bvid)
  fs.rmSync(frameDir, { recursive: true, force: true })
  const extracted = await extractFrames({ videoPath: download.file, frameDir })
  // 视频本体占地方又不再需要，抽完帧就删；帧留着给预览看来源
  try {
    fs.unlinkSync(download.file)
  } catch {
    /* 删不掉无所谓 */
  }
  if (!extracted.ok) throw new Error(extracted.error || '抽帧失败')
  video.frames = extracted.frames.length
  job.progress.frames += extracted.frames.length

  /* ---- OCR：有预算、凑够就停 ---- */
  video.status = 'ocr'
  const started = Date.now()
  const frames = []
  /**
   * 边认边记「已经认出多少个不同的服务名」，用来判断「够了，别再认了」。
   *
   * 这里只数名字、不保留解析结果 —— 真正的解析在 parseOcr 里统一做一次。
   * 多解析一遍的开销是微秒级，跟一次 OCR（约半秒）比可以忽略。
   */
  const seenNames = new Set()
  for (const frame of extracted.frames) {
    if (job.cancelRequested) break
    if (Date.now() - started > BILI_OCR_BUDGET_MS) {
      logLine(job, `${video.bvid} 的 OCR 到时间预算，停在 ${frames.length}/${extracted.frames.length} 帧`)
      break
    }
    let result
    try {
      result = await visionOcr(frame, { timeoutMs: BILI_OCR_TIMEOUT_MS })
    } catch (err) {
      result = { ok: false, error: err?.message }
    }
    if (!result.ok) {
      logLine(job, `${video.bvid} 第 ${frames.length + 1} 帧识别失败：${result.error}`)
      continue
    }
    const name = path.basename(frame)
    frames.push({ file: name, ok: true, words: result.words || [], local: name })
    for (const hit of extractPriceCandidates(result.words || [])) seenNames.add(hit.name)

    video.ocr_frames = frames.length
    if (frames.length % 5 === 0) {
      job.stage = `识别 ${video.bvid}（${frames.length}/${extracted.frames.length} 帧）`
      touch(job)
    }
    // 一张价格表找到之后，后面的帧基本是同一张图，再认下去是白花时间
    if (seenNames.size >= BILI_ENOUGH_ROWS) {
      logLine(job, `${video.bvid} 已认出 ${seenNames.size} 个服务名，提前收工（省下 ${extracted.frames.length - frames.length} 帧）`)
      break
    }
  }
  video.ocr_frames = frames.length

  /**
   * 存下来给下次用。
   *
   * 一帧都没认出来就不存 —— 那通常是视觉后端没起来或者视频本身有问题，
   * 把这种空结果缓存下来，下次连重试的机会都没了。
   */
  if (frames.length) writeVideoCache(video.bvid, frames, frameDir)

  return { frames, total: extracted.frames.length }
}

/**
 * 从识别结果里解析出候选、分节标题、以及给 AI 看的逐行文本。
 *
 * **这一步每次扫描都重跑，不走缓存。** 它依赖库内服务项（名字匹配）和 AI 配置
 * （甄别、改名），缓存里只存原始识别结果，正是为了让这里永远用最新的规则 ——
 * 库改了服务项、AI 换了模型，下次扫描立刻生效，不用等缓存过期。
 */
function parseOcr(job, video, source) {
  const candidates = []
  const sectionHits = []
  /**
   * 每一帧的原始行，留给 AI 判断用。
   *
   * 这里刻意**只记「这行有没有价」，不记价是多少** —— 后面拼 prompt 时也只写
   * `[价]` 不写数字。把价格放进 prompt，模型就有一半概率在回复里复述它，
   * 而我们要的是它永远碰不到数字。
   */
  const frameLines = []
  let ocrFrames = 0

  for (const frame of source.frames) {
    if (!frame.ok) continue
    ocrFrames += 1
    const words = frame.words || []
    const hits = extractPriceCandidates(words)

    const pricedText = new Set(hits.map((h) => String(h.line || '').trim()))
    /**
     * 每一行上程序认出来的服务名。要一起发给模型 ——
     * 让它**纠正**这个名字，而不是从整行原文里重新猜一个。
     * 不给它看原名字时，它很容易把整行抄回来当名字（实测匹配率直接腰斩）。
     */
    const namesByText = new Map()
    for (const hit of hits) {
      const key = String(hit.line || '').trim()
      if (!namesByText.has(key)) namesByText.set(key, [])
      namesByText.get(key).push(hit.name)
    }
    const lines = groupLines(words).map((line, i) => ({
      index: i + 1,
      text: line.text.trim(),
      priced: pricedText.has(line.text.trim()),
      names: namesByText.get(line.text.trim()) || [],
    }))
    frameLines.push({ frame: ocrFrames, file: frame.file, lines })

    /**
     * 帧图被清理过时留空串 —— 前端对空的 frame 就是「不显示缩略图」，
     * 比给一个必然 404 的地址好。
     */
    const framePath = frame.local ? frameRelPath(job.id, video.bvid, frame.local) : ''

    /**
     * 候选要记住它出自「第几帧的第几行」。
     *
     * AI 是按 `帧:行` 回话的（它看不到价格，只能按位置指认），所以这个坐标
     * 必须记准 —— 记错了就会把 A 行的判断安到 B 行上，等于随机删价。
     */
    const lineIndexByText = new Map()
    for (const line of lines) if (!lineIndexByText.has(line.text)) lineIndexByText.set(line.text, line.index)
    for (const hit of hits) {
      candidates.push({
        ...hit,
        frame: framePath,
        frameIndex: ocrFrames,
        lineIndex: lineIndexByText.get(String(hit.line || '').trim()) || 0,
      })
    }

    /**
     * 顺手把这一帧的分节标题也认出来（`梦州地图`、`主线：` 这种）。
     *
     * 这是「建大类」的原料：价格表视频是按板块排的，板块名就是用户价格表里的
     * 大类。认出来先攒着，扫完按名字聚合成候选给用户勾选 —— 不自动建，
     * 因为 `小示地国` 这种 OCR 认歪的名字也会进来，得让人过一眼。
     */
    for (const section of extractSections(words, hits)) {
      sectionHits.push({
        name: section.name,
        items: section.items || [],
        bvid: video.bvid,
        frame: framePath,
      })
    }
  }

  video.ocr_frames = ocrFrames
  return { candidates, frameLines, sectionHits, ocrFrames }
}

/**
 * 把「没匹上的名字」按名字归并，算好每一项的建议价。
 *
 * **价格在这里算，不交给 AI。** 和甄别那一步同一个理由：价格错了会开错单，
 * 而且在界面上看不出来。AI 只负责名字、合并、归类。
 *
 * 归并规则和正式匹配那边保持一致：**同一个视频给了多个不同价格就整票弃用** ——
 * 那通常是一行里写了两个口径（`25r/周 90r/月`），硬挑一个就是掷骰子。
 */
export function unmatchedGroups(job) {
  const rows = Array.isArray(job?.unmatched) ? job.unmatched : []
  const byName = new Map()
  for (const row of rows) {
    const name = String(row.parsed_name || '').trim()
    if (!name) continue
    if (!byName.has(name)) byName.set(name, { name, rows: [], videos: new Set() })
    const entry = byName.get(name)
    entry.rows.push(row)
    if (row.video) entry.videos.add(row.video)
  }

  const out = []
  for (const entry of byName.values()) {
    const byVideo = new Map()
    for (const row of entry.rows) {
      const key = row.video || ''
      if (!byVideo.has(key)) byVideo.set(key, [])
      byVideo.get(key).push(row)
    }
    const prices = []
    let ambiguous = 0
    for (const list of byVideo.values()) {
      const distinct = new Set(list.map((r) => Number(r.price)))
      if (distinct.size > 1) {
        ambiguous += 1
        continue
      }
      prices.push(Number(list[0].price))
    }
    out.push({
      name: entry.name,
      price: median(prices),
      // 有几条样本、几个视频、几个视频因为口径不一被弃用 —— 界面上要能看出来
      sample_count: prices.length,
      video_count: entry.videos.size,
      dropped_videos: ambiguous,
      unit: entry.rows[0]?.unit || '',
      frame: entry.rows[0]?.frame || '',
      line: entry.rows[0]?.line || '',
    })
  }
  return out.sort((a, b) => b.video_count - a.video_count || b.sample_count - a.sample_count || a.name.localeCompare(b.name, 'zh'))
}

/**
 * 让 AI 把上面那堆名字整理成一份可建的服务项清单，并配上算好的价。
 *
 * 拿不到 AI 就退回「原样列出」—— 用户照样能勾选建，只是名字得自己改。
 * **绝不因为 AI 挂了就什么都不给。**
 */
export async function proposeServicesFromScan(id) {
  const job = getScanJob(id)
  if (!job) throw notFound('这个扫描任务不存在')
  const groups = unmatchedGroups(job)
  if (!groups.length) {
    return { ok: true, items: [], groups: 0, ai: { enabled: false, error: '' }, note: '这次扫描没有没匹上的名字' }
  }

  const categories = db
    .prepare("SELECT id, name FROM service_categories WHERE (game_id = ? OR game_id IS NULL) AND status <> 'archived' ORDER BY sort_order ASC, id ASC")
    .all(job.game_id ?? null)

  let ai = { enabled: aiConfig().enabled, error: '', model: '', ms: 0 }
  let items = []
  if (ai.enabled) {
    let result
    try {
      result = await aiProposeServices({
        game: job.game_name || '',
        names: groups.map((g) => ({ name: g.name, videos: g.video_count })),
        categories,
      })
    } catch (err) {
      result = { ok: false, error: err?.message || String(err) }
    }
    if (result.ok) {
      ai.model = result.model || ''
      ai.ms = result.ms || 0
      items = result.items
    } else {
      ai.error = result.error || '调用失败'
      logLine(job, `整理服务项清单时 AI 没成功：${ai.error}`)
    }
  }

  const byName = new Map(groups.map((g) => [g.name, g]))
  const used = new Set()
  const proposals = []

  /**
   * AI 整理过的：按它给的 `sources` 把原始行聚起来，价格取这些行的中位数。
   * 价格完全来自原始行，AI 一个数字都没碰。
   */
  for (const item of items) {
    const sources = item.sources.filter((s) => byName.has(s))
    if (!sources.length) continue
    for (const s of sources) used.add(s)
    const picked = sources.map((s) => byName.get(s))
    proposals.push({
      name: item.name,
      category: item.category,
      sources,
      why: item.why,
      price: median(picked.map((p) => p.price).filter((p) => p !== null)),
      sample_count: picked.reduce((n, p) => n + p.sample_count, 0),
      video_count: picked.reduce((n, p) => n + p.video_count, 0),
      from_ai: true,
    })
  }
  // AI 没提的（没配 AI，或者它判断成垃圾丢掉了）也列出来 ——
  // 丢是 AI 的判断，用户有权看到并自己决定
  for (const group of groups) {
    if (used.has(group.name)) continue
    proposals.push({
      name: group.name,
      category: '',
      sources: [group.name],
      why: '',
      price: group.price,
      sample_count: group.sample_count,
      video_count: group.video_count,
      from_ai: false,
    })
  }

  proposals.sort((a, b) => b.video_count - a.video_count || b.sample_count - a.sample_count || a.name.localeCompare(b.name, 'zh'))
  return {
    ok: true,
    items: proposals.slice(0, 200),
    groups: groups.length,
    categories: categories.map((c) => ({ id: c.id, name: c.name })),
    ai,
  }
}

/**
 * 把选中的服务项建进库里。
 *
 * 和「建大类」一样，**名字必须来自这次扫描的结果** —— 接口是公开的，不校验的话
 * 就成了「用比价接口建任意名字的服务项」。但比建大类宽松一点：允许用户改名字
 * （AI 给的是建议，用户改完才建），只要**来源名字在扫描结果里**就行。
 *
 * 建的时候把**视频里的原话记成别名**。这一步是关键：用户起的短名字
 * （`挪德卡莱满探`）匹不上视频里的长写法（`挪德卡莱满探+前置任务+神瞳`）——
 * 后者含 `+`，算打包价，只认同名。别名就是那个「同名」。
 */
export function createServicesFromScan(id, items = []) {
  const job = getScanJob(id)
  if (!job) throw notFound('这个扫描任务不存在')
  if (!Array.isArray(items) || !items.length) throw bad('没有要建的服务项', 'no_items')

  const known = new Map(unmatchedGroups(job).map((g) => [g.name, g]))
  const categories = new Set(
    db.prepare("SELECT id FROM service_categories WHERE game_id = ? OR game_id IS NULL").all(job.game_id ?? null).map((r) => Number(r.id)),
  )
  const existing = new Map(
    // `IS ?` 而不是 `= ?`：SQL 里 `game_id = NULL` 永远不成立，
    // 任务没挂游戏时重名检查会**静默失效**，同一个名字能建两遍
    db.prepare('SELECT id, name FROM services WHERE game_id IS ?').all(job.game_id ?? null).map((r) => [nameKey(r.name), r]),
  )

  const created = []
  const skipped = []
  const now = stamp()
  let order = nextSortOrder(db, 'services')
  const insert = db.prepare(
    `INSERT INTO services (category_id, game_id, name, description, price_type, unit_label, base_price,
       min_qty, max_qty, package_items, status, sort_order, note, aliases, created_at, updated_at)
     VALUES (?, ?, ?, '', 'fixed', ?, ?, 1, NULL, '[]', 'active', ?, '', ?, ?, ?)`,
  )

  db.exec('BEGIN')
  try {
    for (const raw of items) {
      const name = String(raw?.name || '').trim().slice(0, 120)
      const price = Number(raw?.price)
      if (!name) {
        skipped.push({ name: '', reason: 'empty' })
        continue
      }
      // 来源必须是这次扫描真的认出来的名字
      const sources = (Array.isArray(raw?.sources) ? raw.sources : []).map((s) => String(s).trim()).filter((s) => known.has(s))
      if (!sources.length) {
        skipped.push({ name, reason: 'not_in_scan' })
        continue
      }
      if (!Number.isFinite(price) || price < 0 || price > 100000) {
        skipped.push({ name, reason: 'bad_price' })
        continue
      }
      const dup = existing.get(nameKey(name))
      if (dup) {
        skipped.push({ name, reason: 'duplicate', existing_id: dup.id, existing_name: dup.name })
        continue
      }
      const categoryId = categories.has(Number(raw?.category_id)) ? Number(raw.category_id) : null
      /**
       * 别名 = 视频里的原话。正式名字本身不写进去（`serviceNames` 会自己带上）。
       * 去重、限长、限条数 —— 这是个会参与匹配的字段，不能让它无限长。
       */
      const aliases = [...new Set(sources.filter((s) => s !== name))].slice(0, 20).join('\n')

      const info = insert.run(
        categoryId,
        job.game_id ?? null,
        name,
        String(raw?.unit || '').trim().slice(0, 20),
        Math.round(price * 100) / 100,
        order,
        aliases,
        now,
        now,
      )
      created.push({ id: Number(info.lastInsertRowid), name, price: Math.round(price * 100) / 100, category_id: categoryId, aliases })
      existing.set(nameKey(name), { id: Number(info.lastInsertRowid), name })
      order += 10
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  if (created.length) logLine(job, `从扫描结果建了 ${created.length} 个服务项`)
  return { ok: true, created, skipped }
}

/**
 * 一个视频走完全程。
 * 失败要抛出带原因的错，让上层记到那个视频上（一个视频挂了不该毁掉整个任务）。
 *
 * 分成两步是有意的：**「拿到识别结果」和「解析识别结果」分开**。
 * 前者慢（下载 + 抽帧 + OCR，十几秒）且只取决于视频本身，所以能缓存；
 * 后者快且依赖库内服务项和 AI 配置，所以每次重跑。
 */
async function processOneVideo(job, video, { cookieFile, serviceNames = [], refresh = false }) {
  const source = await ocrVideo(job, video, { cookieFile, refresh })
  const { candidates, frameLines, sectionHits, ocrFrames } = parseOcr(job, video, source)
  job.progress.ocr_frames += ocrFrames

  /* ---- AI 甄别：哪些行根本不是价格表里的 ---- */
  const ai = await triageCandidates({ job, video, candidates, frameLines, serviceNames })

  // 同一个视频内收敛：同名服务只留一个价，并记住它出现在哪一帧
  const collapsed = collapseWithinVideo(ai.candidates)
  video.parsed = collapsed.length
  video.status = 'parsed'

  return {
    items: collapsed.map((item) => {
      // 找到这个名字第一次出现的帧，作为「来源帧」
      const source = ai.candidates.find((c) => c.name === item.name && c.price === item.price)
      return {
        name: item.name,
        price: item.price,
        unit: item.unit || '',
        unitKind: item.unitKind || '',
        hits: item.hits,
        score: item.score,
        line: item.line,
        frame: source?.frame || '',
        video: video.bvid,
        // AI 的口径判断和包含内容跟着样本走，后面按口径分组、填描述都要用。
        // 注意 collapseWithinVideo 是「按字段列表建新对象」，这些字段它不带，
        // 所以必须在这里从收敛前的候选里捞回来。
        scope: source?.scope || '',
        inclusions: source?.inclusions || '',
        nameFrom: source?.nameFrom || '',
        ai_note: source?.ai_note || '',
      }
    }),
    sections: sectionHits,
    ai: ai.stats,
  }
}

/**
 * 让模型过一遍这个视频认出来的候选，剔除「不是价格表」的行。
 *
 * 这是整个 AI 接入里最值钱的一步。价格表视频里混着主播口播、聊天记录、
 * 播放器界面、文档工具栏 —— 实测约两成「认出来的价」根本不是价。规则判不了，
 * 因为判据是语义的：`改为` 是个正常的词，只有知道它出自文档界面才知道是噪音。
 *
 * 真正的危险不是垃圾出现在预览里（那看得见），而是**垃圾的名字碰巧撞上库里
 * 的服务项，把中位数拉垮**：`每日委托 ¥2`（其实是「每天 2 元」）撞上库里的
 * `每日委托`，建议价就从 300 变成 2 —— 而这种错误在界面上完全看不出来。
 *
 * 拿不到 AI 就原样返回，走原来的规则管线。**绝不因为 AI 挂了就少给结果。**
 */
async function triageCandidates({ job, video, candidates, frameLines, serviceNames }) {
  const base = { candidates, stats: { enabled: false, model: '', dropped: 0, renamed: 0, kept: candidates.length, error: '' } }
  if (!aiConfig().enabled) return base
  if (!candidates.length || !frameLines.length) return base

  /**
   * 同一个视频、同一个模型、同一份库 —— 上次问过就直接用上次的答案。
   *
   * 实测复用识别结果的那次扫描总共 40 秒，其中 **AI 占 36 秒**：下载和 OCR 都
   * 省掉了，AI 反而成了新的重复劳动。缓存的初衷就是「不重复干活」，所以这里也省。
   *
   * 存的是**模型的原始回复**，下面那套校验、改名、剔除逻辑照常走一遍 ——
   * 缓存只是省掉一次网络往返，不绕过任何一道闸。
   */
  const signature = aiSignature(serviceNames)
  let result = readCachedAi(video.bvid, signature)
  let aiCached = Boolean(result)
  if (!result) {
    try {
      result = await aiTriageVideo({ game: job.game_name || '', serviceNames, frames: frameLines })
    } catch (err) {
      result = { ok: false, error: err?.message || String(err) }
    }
    // 只缓存成功的结果 —— 把一次超时缓存下来，下次连重试的机会都没了
    if (result.ok) writeCachedAi(video.bvid, signature, result)
  }
  if (!result.ok) {
    // 失败了要说出来，但只记一行日志 —— 用户不需要知道 AI 为什么挂
    logLine(job, `${video.bvid} 的 AI 甄别跳过：${result.error}`)
    return { candidates, stats: { ...base.stats, error: result.error || '调用失败' } }
  }

  const kept = []
  let dropped = 0
  let renamed = 0
  let renameRejected = 0
  let dropOverridden = 0
  const droppedSamples = []
  const rejectedSamples = []
  const overriddenSamples = []
  // 归一化后的库内服务名，用来挡住「把真价当噪音删掉」
  const vocabulary = new Set(serviceNames.map((n) => normalizeServiceName(n)).filter(Boolean))
  // acceptRename 期望的是「库里真有的写法」的集合，所以两种键都放进去
  for (const n of serviceNames) if (n) vocabulary.add(String(n).trim())

  /**
   * 先把改名定下来：**按名字**，不是按行。
   *
   * 同一个认歪的名字可能出现在好几行里，按名字改一次就够；按行改的话，
   * 一行里有多个候选时会被塞同一个名字（实测就是这么把匹配搞垮的）。
   * 校验不通过的改名在这里就被拦掉，并记下来给用户看。
   */
  const renameMap = new Map()
  const renamedSamples = []
  for (const [from, to] of result.renames || []) {
    if (acceptRename(from, to, vocabulary)) {
      renameMap.set(from, to)
      if (renamedSamples.length < 20) renamedSamples.push(`${from} → ${to}`)
    } else {
      renameRejected += 1
      if (rejectedSamples.length < 5) rejectedSamples.push(`${from} → ${to}`)
    }
  }

  for (const candidate of candidates) {
    const decision = result.decisions.get(`${candidate.frameIndex}:${candidate.lineIndex}`)
    /**
     * 没有判断结果的（模型漏答、行号对不上）**一律保留**。
     * 这里的选择是「宁可多留一行垃圾，也不要因为模型漏答就悄悄删掉一个真价」——
     * 漏留的垃圾用户看得见，删掉的真价用户看不见。
     */
    if (!decision) {
      kept.push(candidate)
      continue
    }
    if (!decision.keep) {
      /**
       * 模型说删，但这行和库内某个服务项完全同名 —— 不删。
       *
       * 实测过：假端点把 `黑海岸群岛 ¥20`、`虎口山脉 ¥20` 判成噪音，三项因此
       * 失去建议，而用户**看不到自己失去了什么**。和库内同名是很强的证据，
       * 这一条覆盖是有把握的。
       */
      if (isKnownServiceName(candidate.name, vocabulary)) {
        dropOverridden += 1
        if (overriddenSamples.length < 8) overriddenSamples.push(`${candidate.name}（AI 说「${decision.why || '不是价格项'}」，但库内有这一项）`)
      } else {
        dropped += 1
        if (droppedSamples.length < 8) droppedSamples.push(`${candidate.name}（${decision.why || '不是价格项'}）`)
        continue
      }
    }
    /**
     * 改名：**只换名字，价格仍是 OCR 原文里那个**。
     * `candidate.price` 从头到尾没有被 AI 碰过 —— 它的 schema 里没有价格字段。
     */
    const proposed = renameMap.get(candidate.name)
    const name = proposed || candidate.name
    if (name !== candidate.name) renamed += 1
    kept.push({
      ...candidate,
      name,
      // 原名字留着：界面上要能显示「OCR 认成 X，AI 改成 Y」
      nameFrom: name !== candidate.name ? candidate.name : '',
      scope: decision.scope === 'unknown' ? '' : decision.scope,
      inclusions: decision.inclusions || '',
      ai_note: name !== candidate.name ? `AI 纠正：${candidate.name} → ${name}` : '',
    })
  }

  if (dropped) logLine(job, `${video.bvid} 的 AI 甄别剔掉 ${dropped} 行不是价格的：${droppedSamples.join('、')}`)
  if (dropOverridden) logLine(job, `${video.bvid} 的 AI 想删 ${dropOverridden} 行但库内有同名服务项，已保留：${overriddenSamples.join('、')}`)
  if (renamed) logLine(job, `${video.bvid} 的 AI 纠正了 ${renamed} 个认歪的服务名`)
  if (renameRejected) logLine(job, `${video.bvid} 的 AI 有 ${renameRejected} 个改名不像纠正，已忽略：${rejectedSamples.join('、')}`)

  return {
    candidates: kept,
    stats: {
      enabled: true,
      model: result.model || '',
      // 复用判断时耗时记 0 —— 报上次那次调用的耗时会让「第二次扫描只花了 6 秒」
      // 和「AI 花了 33 秒」同时出现在一个界面上，自相矛盾
      ms: aiCached ? 0 : result.ms || 0,
      // 这次是重放上次的答案还是真问了模型。界面上要说清楚 ——
      // 「秒出结果」如果是因为复用了旧判断，用户有权知道
      cached: aiCached,
      kept: kept.length,
      dropped,
      renamed,
      drop_overridden: dropOverridden,
      drop_overridden_samples: overriddenSamples,
      rename_rejected: renameRejected,
      rename_rejected_samples: rejectedSamples,
      renamed_samples: renamedSamples,
      dropped_samples: droppedSamples,
      error: '',
    },
  }
}

/* ============================================================
   应用（写库）
   ============================================================ */

/**
 * 把用户确认过的建议写进服务项。
 *
 * 只改 base_price —— 阶梯价和增项的口径在不同视频里差太多，平均没有意义。
 * 传入的是前端提交的行，服务端仍然要逐条校验（价格范围、服务项是否属于这个游戏），
 * 不能因为「前端已经确认过」就照单全收。
 */
/**
 * 把 AI 抽出来的「包含内容」补进服务项的 package_items。
 *
 * 这个功能**默认不开**，要用户在写价时明确勾一下。理由：
 *
 * - 写价格是改一个数，写 package_items 是改**给客户看的内容**。
 *   两者的风险不是一个量级 —— 价格写错了用户会立刻发现（数字摆在那儿），
 *   而「包含内容」被塞进一句视频里的原话，可能要等客户来问才发现。
 * - AI 抽的是视频里的原文（`星声4.5w`），不一定是规范的写法。
 *   它能帮上忙，但不能替用户做主。
 *
 * 只**追加**不覆盖：库内已有的内容一个字都不动。宁可少补，不可改错。
 */
function appendInclusions(serviceId, inclusions) {
  const text = String(inclusions || '').trim().slice(0, 120)
  if (!text) return null
  const row = db.prepare('SELECT package_items FROM services WHERE id = ?').get(serviceId)
  if (!row) return null
  let items = []
  try {
    const parsed = JSON.parse(row.package_items || '[]')
    if (Array.isArray(parsed)) items = parsed.filter((x) => typeof x === 'string')
  } catch {
    // 存进去的不是合法 JSON，那就不动它 —— 猜错了会毁掉用户的数据
    return null
  }
  const norm = (s) => String(s).replace(/\s+/g, '')
  if (items.some((x) => norm(x) === norm(text))) return null
  if (items.some((x) => norm(x).includes(norm(text)))) return null
  const next = [...items, text]
  db.prepare('UPDATE services SET package_items = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(next), stamp(), serviceId)
  return { before: items, after: next }
}

export function applyScan(id, rows = [], options = {}) {
  const job = getScanJob(id)
  if (!job) throw notFound('这个扫描任务不存在')
  if (!Array.isArray(rows) || !rows.length) throw bad('没有要写入的行', 'no_rows')
  const fillInclusions = options.fill_inclusions === true

  const allowed = new Map(servicesOfGame(job.game_id).map((s) => [s.id, s]))
  /**
   * 按服务项去重，同一个 id 只留最后一条。
   *
   * 前端有撞项拦截，但接口不能依赖前端：同一项在一批里出现两次时，
   * 两次 UPDATE 会照跑，`changed` 就会数成 2 —— 于是界面告诉用户「改了 2 项」，
   * 实际只落了一项。计数不准比报错更坏，因为没人会去查。
   */
  const byService = new Map()
  for (const row of rows) {
    const serviceId = Number(row.service_id)
    const price = Number(row.price)
    if (!Number.isFinite(serviceId) || !allowed.has(serviceId)) continue
    if (!Number.isFinite(price) || price < 0 || price > 100000) continue
    byService.set(serviceId, {
      serviceId,
      price: Math.round(price * 100) / 100,
      service: allowed.get(serviceId),
      // 只认「这个服务项在这次扫描里真的抽到过」的包含内容，不信任前端传什么
      inclusions: fillInclusions ? String(row.inclusions || '').trim().slice(0, 120) : '',
    })
  }
  const updates = [...byService.values()]
  if (!updates.length) throw bad('没有一条能写入（价格或服务项不合法）', 'no_valid_rows')

  const now = stamp()
  const applied = []
  const filled = []
  const run = db.prepare('UPDATE services SET base_price = ?, updated_at = ? WHERE id = ?')
  db.exec('BEGIN')
  try {
    for (const update of updates) {
      const before = Number(update.service.base_price) || 0
      run.run(update.price, now, update.serviceId)
      applied.push({
        service_id: update.serviceId,
        service_name: update.service.name,
        before,
        after: update.price,
        changed: before !== update.price,
        at: now,
      })
      if (update.inclusions) {
        const diff = appendInclusions(update.serviceId, update.inclusions)
        if (diff) filled.push({ service_id: update.serviceId, service_name: update.service.name, added: update.inclusions })
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // 把「已写入」记回任务，方便回头查「这个价是哪次扫出来的」
  const live = liveJobs.get(String(id))
  const target = live || job
  target.applied = [...(target.applied || []), ...applied]
  if (live) persist(live)
  else {
    db.prepare('UPDATE price_scan_jobs SET result = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify({
        progress: job.progress,
        videos: job.videos,
        matched: job.matched,
        unmatched: job.unmatched,
        sections: job.sections || [],
        ai: job.ai || null,
        applied: target.applied,
        summary: job.summary,
      }),
      now,
      String(id),
    )
  }

  // 价格变了要通知 ERPNext 那一侧，和手动改价走同一条路径
  // （放在事务提交之后：outbox 自己也是一次写，混进上面的事务里回滚语义会变复杂）
  for (const update of updates) {
    try {
      enqueueERPNextChange('services', update.serviceId, 'upsert')
    } catch {
      /* 外部队列写不进去不该让改价失败 */
    }
  }

  return { ok: true, applied, changed: applied.filter((a) => a.changed).length, filled }
}

/* ============================================================
   大类候选 → 建大类
   ============================================================ */

/** 名字归一化后比较，避免「梦州地图 」和「梦州地图」被当成两个 */
const nameKey = (value) => String(value || '').replace(/\s+/g, '').trim()

/**
 * 把扫描结果里的分节标题批量建成大类，挂在这次扫描的游戏下面。
 *
 * 只建大类，不建服务项 —— 服务项要选计价方式、单位、是否每天做，这些
 * 视频里没有可靠信息（`238包月` 到底算 fixed 还是 daily？），猜错了比不建更麻烦。
 * 大类没有这些问题：它就是一个名字加一个游戏。
 *
 * 跳过的情况都**明确回报**，不静默丢弃：用户勾了 5 个只建出 3 个，必须知道
 * 另外 2 个为什么没建（重名 / 名字不合法），否则会以为程序漏了。
 */
export function createCategoriesFromScan(id, names = []) {
  const job = getScanJob(id)
  if (!job) throw notFound('这个扫描任务不存在')
  if (!Array.isArray(names) || !names.length) throw bad('没有要建的大类', 'no_names')

  /**
   * 候选名要来自这次扫描的结果，不能由前端随便编。
   * 接口是公开的，不校验的话就成了「用比价接口建任意名字的大类」。
   */
  const candidates = new Map((job.sections || []).map((s) => [nameKey(s.name), s]))

  // 这个游戏下已有的（含通用的）大类名，用来判重
  const existing = new Map(
    db
      .prepare("SELECT id, name, game_id FROM service_categories WHERE status <> 'archived'")
      .all()
      .map((row) => [nameKey(row.name), row]),
  )

  const created = []
  const skipped = []
  const now = stamp()
  let order = nextSortOrder(db, 'service_categories')
  const insert = db.prepare(
    'INSERT INTO service_categories (game_id, name, is_daily, status, sort_order, note, notice, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )

  db.exec('BEGIN')
  try {
    for (const raw of names) {
      const key = nameKey(raw)
      if (!key) {
        skipped.push({ name: String(raw || ''), reason: 'empty' })
        continue
      }
      const candidate = candidates.get(key)
      if (!candidate) {
        skipped.push({ name: String(raw), reason: 'not_in_scan' })
        continue
      }
      const dup = existing.get(key)
      if (dup) {
        skipped.push({ name: candidate.name, reason: 'duplicate', existing_id: dup.id, existing_name: dup.name })
        continue
      }
      if (key.length > 60) {
        skipped.push({ name: candidate.name, reason: 'too_long' })
        continue
      }

      // 和「新建分类」走同一套推断：名字像日常的大类自动标成每天都做
      const info = insert.run(job.game_id ?? null, candidate.name, looksDaily(candidate.name) ? 1 : 0, 'active', order, '', '', now, now)
      const row = { id: Number(info.lastInsertRowid), name: candidate.name, sort_order: order }
      created.push(row)
      existing.set(key, { id: row.id, name: row.name, game_id: job.game_id ?? null })
      order += 10
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }

  // 大类变了，ERPNext 那一侧也要知道
  for (const row of created) {
    try {
      enqueueERPNextChange('service_categories', row.id, 'upsert')
    } catch {
      /* 外部队列写不进去不该让建大类失败 */
    }
  }

  return { ok: true, created, skipped, game_id: job.game_id ?? null }
}

export const __testing = { servicesOfGame, jobDir, frameDirOf, titleBlocked, nameKey, triageCandidates, packAiResult, unpackAiResult, aiSignature, VIDEO_CACHE_VERSION, writeVideoCacheForTest: writeVideoCache }
