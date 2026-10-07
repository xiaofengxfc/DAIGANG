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
  createCategoriesFromScan,
  createServicesFromScan,
  getScanJob,
  listScanJobs,
  proposeServicesFromScan,
  scanReadiness,
  startScan,
} from '../bili-scan.mjs'
import { biliDependencyInstallStatus, startBiliDependencyInstall, biliDependencyStatus } from '../bili-deps.mjs'
import { aiProbe, aiStatus, saveAiConfig } from '../ai.mjs'

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
      // 默认复用上次扫过的同一个视频（跳过下载和 OCR）；勾了「重新扫」才强制重来
      refresh: body.refresh === true,
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
    /**
     * `fill_inclusions` 默认关。写价格是改一个数，补「包含内容」是改给客户看的文案，
     * 风险不是一个量级，所以要用户明确勾。
     */
    return applyScan(ctx.params.id, rows, { fill_inclusions: ctx.body?.fill_inclusions === true })
  })

  /**
   * 把视频里的分节标题批量建成大类。
   *
   * 一次请求建多个，而不是让前端循环调 `/api/categories/append`：
   *   · 重复判断要在一个地方做完（同名的大类只建一个，哪怕用户重复提交）；
   *   · 用户勾了 5 个、第 3 个重名，不该变成「建了 2 个然后报错」这种半成品状态；
   *   · 前端循环还会并发写 sort_order，撞在一起。
   */
  post('/api/price-scan/jobs/:id/categories', (ctx) => {
    const names = Array.isArray(ctx.body?.names) ? ctx.body.names : []
    return createCategoriesFromScan(ctx.params.id, names)
  })

  /**
   * 把「没匹上的名字」整理成一份可建的服务项清单。
   *
   * 这是给**新加的游戏**用的：库里一个服务项都没有时，比价必然 0 匹配 ——
   * 不是坏了，是没东西可以匹配。让 AI 把认出来的名字合并、起名、归类，
   * 用户勾选后建进库里，下次扫描就能匹上了。
   */
  post('/api/price-scan/jobs/:id/propose-services', (ctx) => proposeServicesFromScan(ctx.params.id))

  /**
   * 把选中的建进库。
   *
   * 和建大类一样要校验「名字来自这次扫描」，但**允许用户改名字** ——
   * AI 给的只是建议，用户改完才建。同时把**视频里的原话记成别名**，
   * 这样短名字下次也能匹上长写法（含 `+` 的打包价只认同名）。
   */
  post('/api/price-scan/jobs/:id/services', (ctx) => {
    const items = Array.isArray(ctx.body?.items) ? ctx.body.items : []
    return createServicesFromScan(ctx.params.id, items)
  })

  /* ---------------- AI 配置 ---------------- */

  /**
   * AI 的开关和配置。
   *
   * GET 永远**不回密钥**，只回「配了没」和尾号 —— 这个接口会被前端反复调，
   * 回一次明文就等于密钥躺在浏览器内存和 devtools 里了。
   */
  get('/api/price-scan/ai', () => aiStatus())

  post('/api/price-scan/ai', (ctx) => {
    const body = ctx.body || {}
    return saveAiConfig({
      base_url: body.base_url === undefined ? undefined : clampStr(body.base_url, 300),
      model: body.model === undefined ? undefined : clampStr(body.model, 120),
      // 空字符串表示「不动」，不是「清掉」—— 界面上保存一次就抹掉 key 太吓人
      api_key: body.api_key === undefined ? undefined : String(body.api_key).trim().slice(0, 400),
      clear_key: body.clear_key === true,
    })
  })

  /** 探活：真发一个最小请求，确认地址 / 模型 / key 三者对得上 */
  post('/api/price-scan/ai/test', async () => aiProbe())

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
