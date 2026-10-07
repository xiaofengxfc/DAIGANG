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

  /* ---------- 建大类 ---------- */
  section('从分节标题建大类')
  const sections = job?.sections || []
  check('扫描结果里有大类候选', sections.length > 0, sections.map((s) => s.name).join('、'))

  const readCats = () => {
    const d = new DatabaseSync(dbFile, { readOnly: true })
    const rows = d.prepare('SELECT id, game_id, name, status, sort_order FROM service_categories').all()
    d.close()
    return rows
  }
  const catsBefore = readCats()
  const gameId = Number(game.id)

  // 挑两个「库里还没有」的候选（候选里本来就可能包含已有的大类，比如 `托管`）
  const existingNames = new Set(catsBefore.map((c) => String(c.name).replace(/\s+/g, '')))
  const fresh = sections.filter((s) => !existingNames.has(String(s.name).replace(/\s+/g, ''))).slice(0, 2)
  const already = sections.filter((s) => existingNames.has(String(s.name).replace(/\s+/g, '')))

  if (fresh.length) {
    const res = await call('POST', `/api/price-scan/jobs/${jobId}/categories`, { names: fresh.map((s) => s.name) })
    check('建大类返回 ok', res.data?.ok === true, JSON.stringify(res.data).slice(0, 160))
    check('建出来的条数对', (res.data?.created || []).length === fresh.length, `created=${res.data?.created?.length} 期望 ${fresh.length}`)
    check('没误报跳过', (res.data?.skipped || []).length === 0, JSON.stringify(res.data?.skipped))

    const catsAfter = readCats()
    const made = catsAfter.filter((c) => fresh.some((s) => s.name === c.name))
    check('大类真的落库了', made.length === fresh.length, made.map((c) => `${c.name}(id=${c.id})`).join('、'))
    check('挂在这次扫描的游戏下', made.every((c) => Number(c.game_id) === gameId), made.map((c) => `${c.name}:game=${c.game_id}`).join('、'))
    check('状态是启用', made.every((c) => c.status === 'active'))
    check('sort_order 各不相同', new Set(made.map((c) => c.sort_order)).size === made.length, made.map((c) => `${c.name}:${c.sort_order}`).join('、'))

    // 再建一次：必须报「重名」而不是建出第二份
    const againCats = await call('POST', `/api/price-scan/jobs/${jobId}/categories`, { names: fresh.map((s) => s.name) })
    check('重复建会被跳过', (againCats.data?.created || []).length === 0 && (againCats.data?.skipped || []).length === fresh.length, JSON.stringify(againCats.data?.skipped))
    check('跳过原因写明是重名', (againCats.data?.skipped || []).every((s) => s.reason === 'duplicate'), JSON.stringify((againCats.data?.skipped || []).map((s) => s.reason)))
    check('重复建没有多出记录', readCats().length === catsAfter.length, `${catsAfter.length} → ${readCats().length}`)
  } else {
    console.log('  （这次的候选全都已经存在，跳过新建用例）')
  }

  if (already.length) {
    const dup = await call('POST', `/api/price-scan/jobs/${jobId}/categories`, { names: [already[0].name] })
    check('候选里已有的大类会被判重', (dup.data?.created || []).length === 0 && dup.data?.skipped?.[0]?.reason === 'duplicate', `${already[0].name} → ${JSON.stringify(dup.data?.skipped)}`)
  }

  /* ---------- 建大类的非法输入 ---------- */
  section('建大类的非法输入')
  const catCases = [
    ['空名单', { names: [] }],
    ['不是数组', { names: 'nope' }],
    ['扫描结果里没有的名字', { names: ['这个大类不在视频里'] }],
    ['空白名字', { names: ['   '] }],
    ['名字超长', { names: ['超'.repeat(80)] }],
  ]
  for (const [label, body] of catCases) {
    const res = await call('POST', `/api/price-scan/jobs/${jobId}/categories`, body)
    const built = (res.data?.created || []).length
    check(`${label}建不出来`, built === 0, `status=${res.status} created=${built} code=${res.data?.code} reasons=${JSON.stringify((res.data?.skipped || []).map((s) => s.reason))}`)
  }
  const badJob = await call('POST', '/api/price-scan/jobs/scan-does-not-exist/categories', { names: ['地图探索'] })
  check('不存在的任务建不了大类', badJob.status === 404, `status=${badJob.status}`)

  /* ---------- 写价不能把大类候选抹掉 ---------- */
  section('写价之后大类候选还在')
  const afterApply = await call('GET', `/api/price-scan/jobs/${jobId}`)
  check('applyScan 没有抹掉 sections', (afterApply.data?.sections || []).length === sections.length, `${sections.length} → ${(afterApply.data?.sections || []).length}`)

  /* ---------- 任务留痕 ---------- */
  section('留痕')
  const stored = await call('GET', `/api/price-scan/jobs/${jobId}`)
  check('任务里记了已写入的行', (stored.data?.applied || []).length > 0, `${(stored.data?.applied || []).length} 条`)
  check('留痕带 before/after', stored.data?.applied?.[0]?.before !== undefined && stored.data?.applied?.[0]?.after !== undefined, JSON.stringify(stored.data?.applied?.[0] || {}).slice(0, 140))

  /* ---------- 把 AI 抽到的「包含内容」补进去（默认不开） ---------- */
  section('补包含内容')
  /**
   * 这条路径改的是**给客户看的文案**，不是价格，所以规矩更紧：
   * 默认不开、只追加不覆盖、不合法就整条放弃。
   *
   * 这条要跑通得先有 AI 抽出来的包含内容 —— 也就是这个脚本要在配了模型的情况下跑
   * （见 README 里的假端点用法）。没配也不会假绿：会明确报「没抽到，测不了」。
   */
  const inclRow = (stored.data?.matched || []).find((r) => (r.samples || []).some((s) => s.inclusions))
  if (!inclRow) {
    check('有样本带着 AI 抽到的包含内容', false, '这次扫描一条都没抽到（脚本没配 AI？）—— 这条路径没被验证')
  } else {
    const incl = inclRow.samples.find((s) => s.inclusions).inclusions
    const dbPath = path.join(app.dir, 'console.db')
    const readItems = (serviceId) => {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const row = db.prepare('select package_items from services where id = ?').get(serviceId)
      db.close()
      try { return JSON.parse(row?.package_items || '[]') } catch { return null }
    }
    const before = readItems(inclRow.service_id)

    // 不传 fill_inclusions 时，一个字都不该动
    const quiet = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, {
      rows: [{ service_id: inclRow.service_id, price: inclRow.suggested_price, inclusions: incl }],
    })
    check('不勾选时不碰包含内容', JSON.stringify(readItems(inclRow.service_id)) === JSON.stringify(before),
      JSON.stringify(readItems(inclRow.service_id)))
    check('不勾选时返回里也没有 filled', (quiet.data?.filled || []).length === 0, JSON.stringify(quiet.data?.filled || []))

    // 勾了才写，而且是追加
    const filled = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, {
      rows: [{ service_id: inclRow.service_id, price: inclRow.suggested_price, inclusions: incl }],
      fill_inclusions: true,
    })
    const after = readItems(inclRow.service_id)
    check('勾选后补进去了', (filled.data?.filled || []).length === 1, JSON.stringify(filled.data?.filled || []))
    check('补的是追加不是覆盖', after.length === before.length + 1, `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    check('原有的内容一个字没动', before.every((x, i) => after[i] === x), JSON.stringify(after))
    check('补进去的就是视频里那句', after[after.length - 1] === incl, `${after[after.length - 1]} vs ${incl}`)

    // 再来一次不该重复加
    const again = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, {
      rows: [{ service_id: inclRow.service_id, price: inclRow.suggested_price, inclusions: incl }],
      fill_inclusions: true,
    })
    check('同一句不会重复补', JSON.stringify(readItems(inclRow.service_id)) === JSON.stringify(after), JSON.stringify(readItems(inclRow.service_id)))
    check('重复时 filled 是空的', (again.data?.filled || []).length === 0, JSON.stringify(again.data?.filled || []))

    /**
     * 更长的写法：先补进去，再拿短的那句来补就该被挡住 ——
     * 去重防的是「新句子已经被库里已有的覆盖」，不是反过来。
     * 库里已经有「星声1.5w（含每日）」时再补一句「星声1.5w」是纯冗余。
     */
    const longer = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, {
      rows: [{ service_id: inclRow.service_id, price: inclRow.suggested_price, inclusions: `${incl}（含每日）` }],
      fill_inclusions: true,
    })
    check('更长的写法是新的，该补', (longer.data?.filled || []).length === 1, JSON.stringify(longer.data?.filled || []))
    const afterLonger = readItems(inclRow.service_id)

    const subset = await call('POST', `/api/price-scan/jobs/${jobId}/apply`, {
      rows: [{ service_id: inclRow.service_id, price: inclRow.suggested_price, inclusions: incl }],
      fill_inclusions: true,
    })
    check('已有的覆盖了它就不重复补', (subset.data?.filled || []).length === 0, JSON.stringify(subset.data?.filled || []))
    check('挡下来时库里没变', JSON.stringify(readItems(inclRow.service_id)) === JSON.stringify(afterLonger), JSON.stringify(readItems(inclRow.service_id)))

    // 价格照写
    check('补包含内容不影响写价', subset.data?.applied?.length === 1, JSON.stringify(subset.data?.applied || []))
  }

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
