/**
 * B站比价：扫描链路 + 接口契约的验证。
 *
 *   node scripts/bili-scan-check.mjs [游戏名] [视频数]
 *
 * 走的是真实数据目录（只读地用它）：真去 B站 搜、下视频、抽帧、OCR，
 * 然后逐项核对接口返回的东西够不够用户核对。
 *
 * 这个脚本**会联网**，而且要 ffmpeg、要能跑起来视觉后端、要 media-cookies 里有
 * 可用的 B站 登录态 —— 所以它不在 `npm test` 里，属于「想验的时候手动跑」。
 * 写入路径的验证在 scripts/bili-apply-check.mjs（那个才会动库，且动的是副本）。
 */
import {
  REAL_DATA,
  ensureVision,
  findGame,
  makeCaller,
  makeChecker,
  startBiliCheck,
  waitForJob,
} from './lib/bili-check.mjs'

const GAME = process.argv[2] || '鸣潮'
const VIDEOS = Number(process.argv[3] || 3)

const { check, section, finish } = makeChecker()

const app = await startBiliCheck({ dataDir: REAL_DATA, label: 'B站比价 · 扫描链路验证' })
const call = makeCaller(app.base, app.cookie)

try {
  /* ---------- 环境 ---------- */
  section('环境检查')
  await ensureVision()
  check('视觉后端起来了', true, `端口 ${process.env.XFC_VISION_PORT}`)

  const ready = await call('GET', '/api/price-scan/readiness')
  check('readiness 返回 200', ready.status === 200, `status=${ready.status}`)
  check('环境就绪', ready.data?.ready === true, JSON.stringify(ready.data?.blockers || []))
  check('复用了 media-cookies 里的 B站 登录态', ready.data?.auth?.ok === true, ready.data?.auth?.message)
  check('yt-dlp 可用', ready.data?.deps?.ytdlp?.available === true, ready.data?.deps?.ytdlp?.version)
  check('ffmpeg 可用', ready.data?.deps?.ffmpeg?.available === true)
  check('默认取前 8 个视频', ready.data?.defaults?.max_videos === 8, `max_videos=${ready.data?.defaults?.max_videos}`)
  check('默认至少 3 个样本', ready.data?.defaults?.min_samples === 3, `min_samples=${ready.data?.defaults?.min_samples}`)

  const { game } = await findGame(call, GAME)
  check(`找到游戏「${GAME}」`, Boolean(game), game ? `id=${game.id}` : '')
  if (!game) process.exit(finish() ? 1 : 0)

  /* ---------- 起任务 ---------- */
  section('起扫描')
  const started = await call('POST', '/api/price-scan/start', { game_id: game.id, max_videos: VIDEOS, min_samples: 2 })
  const jobId = started.data?.job?.id
  check('起任务成功', started.data?.ok === true && Boolean(jobId), jobId)
  if (!jobId) process.exit(finish() ? 1 : 0)

  const busy = await call('POST', '/api/price-scan/start', { game_id: game.id, max_videos: 1 })
  check('同时只允许一个任务（busy）', busy.data?.ok === false && busy.data?.code === 'busy', `code=${busy.data?.code}`)

  const listed = await call('GET', `/api/price-scan/jobs?game_id=${game.id}&limit=5`)
  check('任务出现在列表里', (listed.data?.items || []).some((j) => j.id === jobId))

  /* ---------- 跑 ---------- */
  section('跑完')
  const { job, ms, timedOut } = await waitForJob(call, jobId, {
    onTick: (j) => { if (j?.stage) process.stdout.write(`\r  ${j.stage}                    `) },
  })
  process.stdout.write('\r')
  check('没有超时', !timedOut, `${(ms / 1000).toFixed(0)}s`)
  check('任务完成', job?.status === 'done', `status=${job?.status} ${job?.error || ''}`)
  console.log(`  ${(ms / 1000).toFixed(0)}s  summary=${JSON.stringify(job?.summary)}`)

  /* ---------- 结构 ---------- */
  section('结果结构')
  check('有 videos', Array.isArray(job?.videos) && job.videos.length > 0, `${job?.videos?.length} 个`)
  check('视频都跑完了', (job?.videos || []).every((v) => v.status !== 'pending'), JSON.stringify((job?.videos || []).map((v) => v.status)))
  check('有 matched', Array.isArray(job?.matched), `${job?.matched?.length} 项`)
  check('有 unmatched', Array.isArray(job?.unmatched), `${job?.unmatched?.length} 条`)

  const withPrice = (job?.matched || []).filter((m) => m.suggested_price !== null)
  check('至少给出了一条建议', withPrice.length > 0, `${withPrice.length} 条`)
  check('建议价都是正数', withPrice.every((m) => m.suggested_price > 0), JSON.stringify(withPrice.map((m) => m.suggested_price)))
  check('样本够的标记了 enough', withPrice.some((m) => m.enough), withPrice.filter((m) => m.enough).map((m) => m.service_name).join('、'))

  // 每一条建议都要能回溯到具体视频和具体那一帧 —— 这是「用户能核对」的底线
  const sample = withPrice[0]
  check('建议行带 samples', (sample?.samples || []).length > 0, `${sample?.samples?.length} 个样本`)
  check('样本带来源视频', Boolean(sample?.samples?.[0]?.video), sample?.samples?.[0]?.video)
  check('样本带来源帧', Boolean(sample?.samples?.[0]?.frame), sample?.samples?.[0]?.frame)
  check('样本带 OCR 原文行', Boolean(sample?.samples?.[0]?.line), String(sample?.samples?.[0]?.line || '').slice(0, 50))
  check('样本带匹配分', typeof sample?.samples?.[0]?.score === 'number', String(sample?.samples?.[0]?.score))
  check('建议行有 confidence', Boolean(sample?.confidence), sample?.confidence)
  check('建议行有 excluded 数组', Array.isArray(sample?.excluded), `${sample?.excluded?.length} 条`)

  // 中位数：多样本的行，建议价必须落在样本价的区间里
  const multi = withPrice.filter((m) => (m.samples || []).length >= 2)
  check('多样本的行建议价落在样本区间内', multi.every((m) => {
    const prices = m.samples.map((s) => s.price)
    return m.suggested_price >= Math.min(...prices) - 0.01 && m.suggested_price <= Math.max(...prices) + 0.01
  }), multi.map((m) => `${m.service_name}:[${m.samples.map((s) => s.price).join(',')}]=${m.suggested_price}`).join('  '))

  /* ---------- 来源帧 ---------- */
  section('来源帧')
  const frame = sample?.samples?.[0]?.frame
  if (frame) {
    const url = `/api/price-scan/frame/${frame.split('/').map(encodeURIComponent).join('/')}`
    const res = await fetch(app.base + url, { headers: { cookie: app.cookie } })
    const buf = Buffer.from(await res.arrayBuffer())
    check('帧返回 200', res.status === 200, `status=${res.status}`)
    check('是 JPEG', res.headers.get('content-type') === 'image/jpeg', res.headers.get('content-type'))
    check('有实际字节', buf.length > 2000, `${buf.length} 字节`)
    // 存一份出来，人可以肉眼看一眼认的是不是价格表
    const fs = await import('node:fs')
    const out = `${app.dir}/bili-tmp/last-frame.jpg`
    fs.writeFileSync(out, buf)
    console.log(`  存了一张到 ${out}`)

    const evil = await fetch(`${app.base}/api/price-scan/frame/${jobId}/..%2F..%2F..%2Fconsole.db`, { headers: { cookie: app.cookie } })
    check('路径穿越被挡', evil.status === 404 || evil.status === 400, `status=${evil.status}`)
  }

  /* ---------- 404 / 取消 ---------- */
  section('边界')
  const missing = await call('GET', '/api/price-scan/jobs/does-not-exist')
  check('不存在的任务返回 404', missing.status === 404, `status=${missing.status}`)
  const cancelDone = await call('POST', `/api/price-scan/jobs/${jobId}/cancel`, {})
  check('取消一个已完成的任务不炸', cancelDone.status < 500, `status=${cancelDone.status}`)
  const badStart = await call('POST', '/api/price-scan/start', { game_id: 999999, max_videos: 1 })
  check('不存在的游戏起不了任务', badStart.status >= 400 || badStart.data?.ok === false, `status=${badStart.status} code=${badStart.data?.code}`)
} finally {
  await app.stop()
}

process.exit(finish() ? 1 : 0)
