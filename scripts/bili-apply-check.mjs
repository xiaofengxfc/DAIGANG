/**
 * B站比价：**写入路径**的验证 —— 这个功能里唯一会改数据的部分。
 *
 *   node scripts/bili-apply-check.mjs [游戏名] [视频数]
 *
 * 数据用的是真实库的**副本**（data/bili-check-apply），所以它真的会 UPDATE 价格，
 * 但改的是副本，你自己那份价格表一点没动。这就是为什么它必须复制而不是直接用：
 * 验证「写对了没有」不能拿真价格当小白鼠。
 *
 * 要证明的四件事：
 *   1. 建议价真的落进了 base_price，而且只落这一行；
 *   2. 改派（把一行指到另一个服务项）写的是目标项，原匹配项一点没动；
 *   3. 只改基准价，阶梯价和增项不受影响；
 *   4. 非法输入（跨游戏、负价、空行）一律拒掉。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ROOT,
  ensureVision,
  findGame,
  makeCaller,
  makeChecker,
  readPrices,
  startBiliCheck,
  waitForJob,
} from './lib/bili-check.mjs'

const GAME = process.argv[2] || '鸣潮'
const VIDEOS = Number(process.argv[3] || 3)
const DATA_DIR = path.join(ROOT, 'data-bili-check-apply')

const { check, section, finish } = makeChecker()

const app = await startBiliCheck({ dataDir: DATA_DIR, copyFrom: true, label: 'B站比价 · 写入路径验证' })
const call = makeCaller(app.base, app.cookie)
const dbFile = path.join(app.dir, 'console.db')

try {
  section('准备')
  await ensureVision()
  const { game, list: games } = await findGame(call, GAME)
  check(`找到游戏「${GAME}」`, Boolean(game), game ? `id=${game.id}` : '')
  if (!game) process.exit(finish() ? 1 : 0)

  const before = await readPrices(dbFile, game.name)
  check('副本里有服务和价格', before.size > 0, `${before.size} 个服务项`)

  // 阶梯价和增项也记一份，最后要确认它们没被动过
  const beforeTiers = readTiers(dbFile, game.id)
  check('副本里有阶梯价', beforeTiers.tiers > 0, `${beforeTiers.tiers} 档`)
  check('副本里有增项', beforeTiers.addons > 0, `${beforeTiers.addons} 个`)
  /* ---------- 扫描 ---------- */
  section('扫描')
  const started = await call('POST', '/api/price-scan/start', { game_id: game.id, max_videos: VIDEOS, min_samples: 2 })
  const jobId = started.data?.job?.id
  check('起任务', Boolean(jobId), jobId)
  if (!jobId) process.exit(finish() ? 1 : 0)

  const { job } = await waitForJob(call, jobId)
  check('扫描完成', job?.status === 'done', `status=${job?.status} ${job?.error || ''}`)

  const target = (job?.matched || []).find((m) => m.enough && m.suggested_price !== null && before.has(m.service_id))
  check('有可写入的建议行', Boolean(target), target ? `${target.service_name} ${target.current_price} → ${target.suggested_price}（${target.sample_count} 样本）` : '没有')
  if (!target) process.exit(finish() ? 1 : 0)

  /* ---------- 正常写入 ---------- */
  section('写入基准价')
  const applied = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, { rows: [{ service_id: target.service_id, price: target.suggested_price }] })
  check('apply 返回 ok', applied.data?.ok === true, JSON.stringify(applied.data).slice(0, 160))
  check('changed 为 1', applied.data?.changed === 1, `changed=${applied.data?.changed}`)

  const after = await readPrices(dbFile, game.name)
  check('base_price 真的改了', Number(after.get(target.service_id)?.base_price) === Number(target.suggested_price), `库里 ${after.get(target.service_id)?.base_price}，建议 ${target.suggested_price}`)
  check('服务名没被动', after.get(target.service_id)?.name === before.get(target.service_id)?.name, after.get(target.service_id)?.name)
  const others = [...after.entries()].filter(([id, r]) => id !== target.service_id && Number(r.base_price) !== Number(before.get(id)?.base_price))
  check('其它行没被误改', others.length === 0, others.map(([id, r]) => `${r.name}:${before.get(id)?.base_price}→${r.base_price}`).join('、'))

  const afterTiers = readTiers(dbFile, game.id)
  check('阶梯价没被动', afterTiers.tiers === beforeTiers.tiers && afterTiers.tierSum === beforeTiers.tierSum, `${beforeTiers.tiers} 档 / 合计 ${beforeTiers.tierSum} → ${afterTiers.tiers} 档 / 合计 ${afterTiers.tierSum}`)
  check('增项没被动', afterTiers.addons === beforeTiers.addons, `${beforeTiers.addons} → ${afterTiers.addons}`)

  const again = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, { rows: [{ service_id: target.service_id, price: target.suggested_price }] })
  check('同价再写一次 changed=0（幂等）', again.data?.changed === 0, `changed=${again.data?.changed}`)

  /* ---------- 改派 ---------- */
  section('改派到别的服务项')
  const svcRes = await call('GET', `/api/services?game_id=${game.id}`)
  const allSvc = (Array.isArray(svcRes.data) ? svcRes.data : svcRes.data?.items || []).filter((s) => s.status !== 'archived')
  const decoy = allSvc.find((s) => s.id !== target.service_id && Number(s.base_price) !== 1234.56)
  check('有可以改派的目标项', Boolean(decoy), decoy ? `id=${decoy.id} ${decoy.name} 现价 ${decoy.base_price}` : '')
  if (decoy) {
    const originPrice = Number((await readPrices(dbFile, game.name)).get(target.service_id)?.base_price)
    const moved = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, { rows: [{ service_id: decoy.id, price: 1234.56 }] })
    check('改派写入 ok', moved.data?.ok === true, `changed=${moved.data?.changed}`)
    const now = await readPrices(dbFile, game.name)
    check('目标项的价变了', Number(now.get(decoy.id)?.base_price) === 1234.56, `→ ${now.get(decoy.id)?.base_price}`)
    check('原匹配项一点没动', Number(now.get(target.service_id)?.base_price) === originPrice, `仍是 ${now.get(target.service_id)?.base_price}`)

    const two = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, {
      rows: [{ service_id: target.service_id, price: 111.11 }, { service_id: decoy.id, price: 222.22 }],
    })
    check('一次写两行都落库', two.data?.changed === 2, `changed=${two.data?.changed}`)
    const now2 = await readPrices(dbFile, game.name)
    check('两行的值各自正确', Number(now2.get(target.service_id)?.base_price) === 111.11 && Number(now2.get(decoy.id)?.base_price) === 222.22)

    // 同一项在一批里出现两次：只算一项，最终值取最后一条。
    // 计数不准比报错更坏 —— 界面会告诉用户「改了 2 项」，实际只落了一项，没人会去查。
    const dup = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, {
      rows: [{ service_id: decoy.id, price: 333.33 }, { service_id: decoy.id, price: 444.44 }],
    })
    check('同一项重复提交只算一项', dup.data?.changed === 1, `changed=${dup.data?.changed} applied=${dup.data?.applied?.length}`)
    check('同一项重复提交取最后一条', Number((await readPrices(dbFile, game.name)).get(decoy.id)?.base_price) === 444.44)
  }

  /* ---------- 非法输入 ---------- */
  section('非法输入一律拒掉')
  const cases = [
    ['空行', { rows: [] }],
    ['不是数组', { rows: 'nope' }],
    ['负价格', { rows: [{ service_id: target.service_id, price: -5 }] }],
    ['价格不是数字', { rows: [{ service_id: target.service_id, price: 'abc' }] }],
    ['价格大得离谱', { rows: [{ service_id: target.service_id, price: 9_999_999 }] }],
    ['服务项不存在', { rows: [{ service_id: 999999, price: 10 }] }],
  ]
  for (const [label, body] of cases) {
    const res = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, body)
    check(`${label}被拒`, res.status >= 400, `status=${res.status} code=${res.data?.code}`)
  }

  const otherGame = games.find((g) => g.id !== game.id)
  if (otherGame) {
    const otherSvc = await call('GET', `/api/services?game_id=${otherGame.id}`)
    const list = Array.isArray(otherSvc.data) ? otherSvc.data : otherSvc.data?.items || []
    if (list.length) {
      const crossed = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, { rows: [{ service_id: list[0].id, price: 1 }] })
      check('跨游戏写入被拒', crossed.status >= 400, `status=${crossed.status} code=${crossed.data?.code}`)
    } else {
      console.log(`  （「${otherGame.name}」下没有服务项，跳过跨游戏用例）`)
    }
  }

  /* ---------- 任务留痕 ---------- */
  section('留痕')
  const stored = await call('GET', `/api/price-scan/jobs/${jobId}`)
  check('任务里记了已写入的行', (stored.data?.applied || []).length > 0, `${(stored.data?.applied || []).length} 条`)
  check('留痕带 before/after', stored.data?.applied?.[0]?.before !== undefined && stored.data?.applied?.[0]?.after !== undefined, JSON.stringify(stored.data?.applied?.[0] || {}).slice(0, 140))

  console.log(`\n  副本目录留在 ${app.dir}，想核对可以直接开它的库；不要了删掉即可。`)
} finally {
  await app.stop()
}

/**
 * 阶梯价和增项的口径：只数条数和合计，用来确认「没被动过」。
 *
 * 列名容易记错：阶梯价的价在 `unit_price` 上（不是 `price`），
 * 增项的表叫 `service_options`（不是 `service_addons`）。
 */
function readTiers(dbFile, gameId) {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  const svcIds = db.prepare('select id from services where game_id = ?').all(gameId).map((r) => r.id)
  let tiers = 0
  let tierSum = 0
  let addons = 0
  if (svcIds.length) {
    const ph = svcIds.map(() => '?').join(',')
    const t = db.prepare(`select count(*) c, coalesce(sum(unit_price), 0) s from service_tiers where service_id in (${ph})`).get(...svcIds)
    tiers = Number(t.c) || 0
    tierSum = Math.round(Number(t.s) || 0)
    const a = db.prepare(`select count(*) c, coalesce(sum(price), 0) s from service_options where service_id in (${ph})`).get(...svcIds)
    addons = Number(a.c) || 0
  }
  db.close()
  return { tiers, tierSum, addons }
}

process.exit(finish() ? 1 : 0)
