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
import { collapseWithinVideo, extractPriceCandidates, median, spread } from './price-parse.mjs'
import { groupByService, matchServices } from './price-match.mjs'
import { ensureVisionStarted, visionOcr } from './vision-python.mjs'
import { enqueueERPNextChange } from './outbox.mjs'
import { bad, notFound } from './util.mjs'

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
  return { removed }
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
    JSON.stringify({ progress: job.progress, videos: job.videos, matched: job.matched, unmatched: job.unmatched, applied: job.applied, summary: job.summary }),
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
      `SELECT s.id, s.name, s.unit_label, s.base_price, s.category_id, c.name AS category_name
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

export function startScan({ gameId, keyword = '', maxVideos = BILI_MAX_VIDEOS, minSamples = BILI_MIN_SAMPLES, force = false } = {}) {
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
    progress: { videos_found: 0, videos_total: 0, videos_done: 0, frames: 0, ocr_frames: 0, parsed_names: 0 },
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

  void runScan(job, { maxVideos, minSamples }).catch((err) => {
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

async function runScan(job, { maxVideos, minSamples }) {
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
    job.summary = { picked: 0, parsed_names: 0, matched: 0, unmatched: 0 }
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
  for (let i = 0; i < job.videos.length; i++) {
    const video = job.videos[i]
    assertNotCancelled(job)
    job.stage = `处理视频 ${i + 1}/${job.videos.length}`
    touch(job)
    try {
      const parsed = await processOneVideo(job, video, { cookieFile })
      allParsed.push(...parsed)
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

  const { matched, unmatched } = matchServices(allParsed, services, {})
  const groups = groupByService(matched, { minSamples: Number(minSamples) })

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
  job.summary = {
    picked: job.videos.length,
    downloaded: job.videos.filter((v) => v.status === 'parsed').length,
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
 * 一个视频走完全程。
 * 失败要抛出带原因的错，让上层记到那个视频上（一个视频挂了不该毁掉整个任务）。
 */
async function processOneVideo(job, video, { cookieFile }) {
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
  const candidates = []
  let ocrFrames = 0
  for (const frame of extracted.frames) {
    if (job.cancelRequested) break
    if (Date.now() - started > BILI_OCR_BUDGET_MS) {
      logLine(job, `${video.bvid} 的 OCR 到时间预算，停在 ${ocrFrames}/${extracted.frames.length} 帧`)
      break
    }
    let result
    try {
      result = await visionOcr(frame, { timeoutMs: BILI_OCR_TIMEOUT_MS })
    } catch (err) {
      result = { ok: false, error: err?.message }
    }
    if (!result.ok) {
      logLine(job, `${video.bvid} 第 ${ocrFrames + 1} 帧识别失败：${result.error}`)
      continue
    }
    ocrFrames += 1
    job.progress.ocr_frames += 1
    const hits = extractPriceCandidates(result.words || [])
    for (const hit of hits) {
      candidates.push({ ...hit, frame: frameRelPath(job.id, video.bvid, path.basename(frame)) })
    }
    // 一张价格表找到之后，后面的帧基本是同一张图，再认下去是白花时间
    const distinct = new Set(candidates.map((c) => c.name)).size
    if (distinct >= BILI_ENOUGH_ROWS) {
      logLine(job, `${video.bvid} 已认出 ${distinct} 个服务名，提前收工（省下 ${extracted.frames.length - ocrFrames} 帧）`)
      break
    }
    video.ocr_frames = ocrFrames
    if (ocrFrames % 5 === 0) {
      job.stage = `识别 ${video.bvid}（${ocrFrames}/${extracted.frames.length} 帧）`
      touch(job)
    }
  }
  video.ocr_frames = ocrFrames

  // 同一个视频内收敛：同名服务只留一个价，并记住它出现在哪一帧
  const collapsed = collapseWithinVideo(candidates)
  video.parsed = collapsed.length
  video.status = 'parsed'

  return collapsed.map((item) => {
    // 找到这个名字第一次出现的帧，作为「来源帧」
    const source = candidates.find((c) => c.name === item.name && c.price === item.price)
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
    }
  })
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
export function applyScan(id, rows = []) {
  const job = getScanJob(id)
  if (!job) throw notFound('这个扫描任务不存在')
  if (!Array.isArray(rows) || !rows.length) throw bad('没有要写入的行', 'no_rows')

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
    byService.set(serviceId, { serviceId, price: Math.round(price * 100) / 100, service: allowed.get(serviceId) })
  }
  const updates = [...byService.values()]
  if (!updates.length) throw bad('没有一条能写入（价格或服务项不合法）', 'no_valid_rows')

  const now = stamp()
  const applied = []
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

  return { ok: true, applied, changed: applied.filter((a) => a.changed).length }
}

export const __testing = { servicesOfGame, jobDir, frameDirOf, titleBlocked }
