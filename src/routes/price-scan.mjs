/**
 * B站自动比价的接口。
 *
 * 分成三段，前端也按这个顺序用：
 *   1. 准备：`/readiness` 看能不能用，`/install` 一键装 yt-dlp
 *   2. 扫描：`/start` 起任务，`/jobs/:id` 轮询进度，`/jobs/:id/cancel` 取消
 *   3. 确认：`/jobs/:id/apply` 把用户勾过的价格写进服务项
 *
 * 另外 `/frame/:jobId/:bvid/:name` 用来取「这个价是从哪一帧认出来的」——
 * 预览界面要能点开看原图，否则 OCR 认错了用户无从判断。
 */
import fs from 'node:fs'
import path from 'node:path'
import { get, post } from '../http.mjs'
import { BILI_FRAME_DIR } from '../config.mjs'
import { resolveSafe } from '../http.mjs'
import { bad, notFound, int, clampStr } from '../util.mjs'
import {
  activeScanJob,
  applyScan,
  cancelScan,
  getScanJob,
  listScanJobs,
  scanReadiness,
  startScan,
} from '../bili-scan.mjs'
import { biliDependencyInstallStatus, startBiliDependencyInstall, biliDependencyStatus } from '../bili-deps.mjs'

const FRAME_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }

export function register() {
  /* ---------------- 准备 ---------------- */

  get('/api/price-scan/readiness', () => ({
    ...scanReadiness(),
    active: activeScanJob(),
  }))

  get('/api/price-scan/deps', () => biliDependencyStatus({ force: true }))

  post('/api/price-scan/install', () => {
    const result = startBiliDependencyInstall()
    if (!result.ok) return { ...result, status: biliDependencyStatus({ force: true }) }
    return result
  })

  get('/api/price-scan/install/:id', (ctx) => biliDependencyInstallStatus(ctx.params.id))

  /* ---------------- 扫描 ---------------- */

  post('/api/price-scan/start', (ctx) => {
    const body = ctx.body || {}
    const gameId = int(body.game_id)
    if (!gameId) throw bad('请先选一个游戏（比价是按游戏搜的）', 'game_required')
    const maxVideos = body.max_videos === undefined ? undefined : Math.max(1, Math.min(20, int(body.max_videos)))
    const minSamples = body.min_samples === undefined ? undefined : Math.max(1, Math.min(20, int(body.min_samples)))
    const result = startScan({
      gameId,
      keyword: clampStr(body.keyword, 80),
      maxVideos,
      minSamples,
    })
    if (!result.ok) {
      // 「已有任务在跑」和「依赖没装好」都是可预期的业务分支，用 200 返回让前端好处理
      return result
    }
    return result
  })

  get('/api/price-scan/jobs', (ctx) => ({
    items: listScanJobs({ gameId: ctx.query.game_id ? int(ctx.query.game_id) : null, limit: Math.min(50, int(ctx.query.limit) || 20) }),
    active: activeScanJob(),
  }))

  get('/api/price-scan/jobs/:id', (ctx) => {
    const job = getScanJob(ctx.params.id)
    if (!job) throw notFound('这个扫描任务不存在')
    return job
  })

  post('/api/price-scan/jobs/:id/cancel', (ctx) => cancelScan(ctx.params.id))

  post('/api/price-scan/jobs/:id/apply', (ctx) => {
    const rows = Array.isArray(ctx.body?.rows) ? ctx.body.rows : []
    return applyScan(ctx.params.id, rows)
  })

  /* ---------------- 来源帧 ---------------- */

  /**
   * 取一帧原图。路径三段都来自任务结果，但仍然要过 resolveSafe ——
   * 这几个参数是前端传的，不能假定它们一定是合法的。
   */
  get('/api/price-scan/frame/:jobId/:bvid/:name', (ctx) => {
    const rel = [ctx.params.jobId, ctx.params.bvid, ctx.params.name].join('/')
    const file = resolveSafe(BILI_FRAME_DIR, `/${rel}`)
    if (!file || !fs.existsSync(file)) {
      ctx.res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      ctx.res.end('帧不存在（中间产物可能已经被清理）')
      return undefined
    }
    const ext = path.extname(file).toLowerCase()
    const stat = fs.statSync(file)
    ctx.res.writeHead(200, {
      'Content-Type': FRAME_MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // 帧是不可变文件（路径里带任务 id），可以放心让浏览器缓存
      'Cache-Control': 'private, max-age=86400',
    })
    ctx.res.end(fs.readFileSync(file))
    return undefined
  })
}
