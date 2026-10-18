/**
 * 「待添加的服务项」—— 从比价结果整理出来、还没决定要不要进价格表的项。
 *
 * 为什么要有这一步（而不是在比价面板里点一下就建）：
 *
 *   比价面板里你看不到**这个大类现在已经有什么**。而「这一项要不要建」恰恰
 *   要看这个 —— 原神的「主线」下面已经有 7.0、7.1 了，视频里那个「主线」是
 *   重复的还是新版本？在比价面板里判断不了，得回到价格表里看。
 *
 * 所以流程是两步：比价面板里勾选 = 存成待添加（**不建**）；回价格表，在对应
 * 大类下面看到它们，一个一个决定「添加」还是「删掉」。
 *
 * 这里存的是**草稿**，不是服务项 —— 所以它：
 *   · 不进价格表的正式列表（`/api/pricebook` 里是单独一个 `drafts` 字段）
 *   · 不参与比价匹配（`servicesOfGame` 只读 `services`）
 *   · 报价、开单、导出都看不见它
 */
import { db, stamp } from '../core/db.mjs'
import { nextSortOrder, notFound, bad } from '../core/util.mjs'

const MAX_DRAFTS_PER_GAME = 400

/** 和 bili-scan 里的 nameKey 一个规矩：比名字时忽略大小写和空白 */
function nameKey(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase()
}

function shape(row) {
  return {
    id: Number(row.id),
    game_id: row.game_id === null || row.game_id === undefined ? null : Number(row.game_id),
    category_id: row.category_id === null || row.category_id === undefined ? null : Number(row.category_id),
    name: row.name,
    price: Number(row.price),
    aliases: row.aliases || '',
    why: row.why || '',
    source_job: row.source_job || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function listDrafts({ gameId = null } = {}) {
  const rows = gameId
    ? db.prepare('SELECT * FROM service_drafts WHERE game_id IS ? ORDER BY id ASC').all(Number(gameId))
    : db.prepare('SELECT * FROM service_drafts ORDER BY game_id, id ASC').all()
  return rows.map(shape)
}

/**
 * 校验一条「从扫描结果来的服务项」，返回归一化后的字段或者拒绝原因。
 *
 * **这是这条路上唯一一份校验。** 以前「直接建服务项」和「存成待添加」各写了一份
 * 一模一样的检查 —— 那种重复正是整包价 bug 的成因（两处匹配，一处漏了规矩）。
 * 所以现在只有一份：改规矩只改这里。
 */
export function validateProposal(raw, { known, existingNames, categoryIds }) {
  const name = String(raw?.name || '').trim().slice(0, 120)
  if (!name) return { ok: false, name: '', reason: 'empty' }

  // 来源必须是这次扫描真的认出来的名字。接口是公开的，不校验的话
  // 就成了「用比价接口建任意名字的服务项」。
  const sources = (Array.isArray(raw?.sources) ? raw.sources : []).map((s) => String(s).trim()).filter((s) => known.has(s))
  if (!sources.length) return { ok: false, name, reason: 'not_in_scan' }

  const price = Number(raw?.price)
  if (!Number.isFinite(price) || price < 0 || price > 100000) return { ok: false, name, reason: 'bad_price' }

  if (existingNames.has(nameKey(name))) return { ok: false, name, reason: 'already_in_pricebook' }

  return {
    ok: true,
    name,
    price: Math.round(price * 100) / 100,
    // 大类必须在这个游戏的可选范围里；编一个 id 出来就当没归类
    categoryId: categoryIds.has(Number(raw?.category_id)) ? Number(raw.category_id) : null,
    // 别名 = 视频原话。正式名字自己不写进去（`serviceNames` 会自己带上）。
    // 去重、限长、限条数 —— 这是个会参与匹配的字段，不能让它无限长。
    aliases: [...new Set(sources.filter((s) => s !== name))].slice(0, 20).join('\n'),
    why: String(raw?.why || '').trim().slice(0, 60),
  }
}

/**
 * 把比价面板里勾选的项存成待添加。
 *
 * 存是**累加**的，不是「先清掉这批任务的再写」：界面存完一批会把它们从勾选列表
 * 里去掉，用户接着勾第二批再存 —— 「先清空」的写法会把第一批悄悄删掉。
 *
 * 名字已经躺在那儿了就**更新**它（重新整理之后价格可能变），不摆第二条同名的。
 * 已经在价格表里的名字跳过（`already_in_pricebook`）：那是用户已经建过的项，
 * 摆成「待添加」只会让人重复建一遍。
 */
export function saveDrafts(job, items = [], { known = new Set(), categoryIds = new Set() } = {}) {
  if (!job) throw notFound('这个扫描任务不存在')
  const now = stamp()
  const gameId = job.game_id ?? null

  const existingNames = new Set(
    db.prepare('SELECT name FROM services WHERE game_id IS ?').all(gameId).map((r) => nameKey(r.name)),
  )

  /**
   * 已经躺着的待添加（这个游戏下），按名字索引。
   *
   * 存是**累加**的，不是「先清空这批任务的再写」—— 那个写法有个真实的坑：
   * 界面存完一批会把它们从勾选列表里去掉，用户接着勾第二批再存，
   * 第一批就被悄悄删了。名字已经在了就**更新**它（重新整理后价格可能变了），
   * 而不是再摆一条同名的。
   */
  const pendingByName = new Map(
    db.prepare('SELECT * FROM service_drafts WHERE game_id IS ?').all(gameId).map((r) => [nameKey(r.name), r]),
  )

  const created = []
  const updated = []
  const skipped = []

  db.exec('BEGIN')
  try {
    const insert = db.prepare(
      `INSERT INTO service_drafts (game_id, category_id, name, price, aliases, why, source_job, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    const refresh = db.prepare(
      'UPDATE service_drafts SET category_id = ?, price = ?, aliases = ?, why = ?, source_job = ?, updated_at = ? WHERE id = ?',
    )
    for (const raw of items) {
      const checked = validateProposal(raw, { known, existingNames, categoryIds })
      if (!checked.ok) {
        skipped.push({ name: checked.name, reason: checked.reason })
        continue
      }
      const there = pendingByName.get(nameKey(checked.name))
      if (there) {
        refresh.run(checked.categoryId, checked.price, checked.aliases, checked.why, String(job.id), now, there.id)
        updated.push(shape({
          ...there, category_id: checked.categoryId, price: checked.price, aliases: checked.aliases,
          why: checked.why, source_job: job.id, updated_at: now,
        }))
        continue
      }
      const info = insert.run(
        gameId,
        checked.categoryId,
        checked.name,
        checked.price,
        checked.aliases,
        checked.why,
        String(job.id),
        now,
        now,
      )
      created.push(shape({
        id: info.lastInsertRowid, game_id: gameId, category_id: checked.categoryId, name: checked.name,
        price: checked.price, aliases: checked.aliases, why: checked.why, source_job: job.id,
        created_at: now, updated_at: now,
      }))
      pendingByName.set(nameKey(checked.name), { id: Number(info.lastInsertRowid) })
      if (created.length >= MAX_DRAFTS_PER_GAME) break
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { ok: true, created, updated, skipped }
}

export function updateDraft(id, patch = {}) {
  const row = db.prepare('SELECT * FROM service_drafts WHERE id = ?').get(Number(id))
  if (!row) throw notFound('这条待添加已经不在列表里了')
  const next = {
    name: patch.name === undefined ? row.name : String(patch.name).trim().slice(0, 120),
    price: patch.price === undefined ? Number(row.price) : Number(patch.price),
    category_id: patch.category_id === undefined
      ? (row.category_id === null ? null : Number(row.category_id))
      : (patch.category_id === null || patch.category_id === '' ? null : Number(patch.category_id)),
  }
  if (!next.name) throw bad('服务名不能空着')
  if (!Number.isFinite(next.price) || next.price < 0 || next.price > 100000) throw bad('价格要填 0 到 100000 之间的数')
  // 大类可能已经被删了 —— 那就退回「未归类」，而不是写一个悬空的 id
  if (next.category_id !== null) {
    const exists = db.prepare('SELECT id FROM service_categories WHERE id = ?').get(next.category_id)
    if (!exists) next.category_id = null
  }
  db.prepare('UPDATE service_drafts SET name = ?, price = ?, category_id = ?, updated_at = ? WHERE id = ?')
    .run(next.name, Math.round(next.price * 100) / 100, next.category_id, stamp(), Number(id))
  return { ok: true, draft: shape(db.prepare('SELECT * FROM service_drafts WHERE id = ?').get(Number(id))) }
}

/**
 * 把一条待添加变成真正的服务项。
 *
 * 走的是**和手工「添加服务」完全一样的落库路径**（同一张表、同样的默认值），
 * 所以它建出来的东西和手工建的没有任何区别 —— 比价那边下次扫描就能匹上
 * （`aliases` 会带过去，短名字也匹得上长写法）。
 *
 * 建完把草稿删掉：它的使命就是「提醒你这里可以加一项」。
 */
export function acceptDraft(id) {
  const row = db.prepare('SELECT * FROM service_drafts WHERE id = ?').get(Number(id))
  if (!row) throw notFound('这条待添加已经不在列表里了')
  const draft = shape(row)

  // 大类可能已经被删了 —— 那就建成「未分类」，别写一个悬空的 id
  let categoryId = draft.category_id
  if (categoryId !== null && !db.prepare('SELECT id FROM service_categories WHERE id = ?').get(categoryId)) categoryId = null
  // 游戏可能已经被删了 —— 同理，服务项不能挂在一个不存在的游戏上
  let gameId = draft.game_id
  if (gameId !== null && !db.prepare('SELECT id FROM games WHERE id = ?').get(gameId)) gameId = null

  const now = stamp()
  const info = db.prepare(
    `INSERT INTO services (category_id, game_id, name, description, price_type, unit_label, base_price,
       min_qty, max_qty, package_items, status, sort_order, note, aliases, created_at, updated_at)
     VALUES (?, ?, ?, '', 'fixed', '', ?, 1, NULL, '[]', 'active', ?, '', ?, ?, ?)`,
  ).run(categoryId, gameId, draft.name, draft.price, nextSortOrder(db, 'services'), draft.aliases, now, now)

  db.prepare('DELETE FROM service_drafts WHERE id = ?').run(draft.id)
  return {
    ok: true,
    service: { id: Number(info.lastInsertRowid), name: draft.name, base_price: draft.price, category_id: categoryId, game_id: gameId, aliases: draft.aliases },
    // 挂的位置和草稿上写的不一样时说清楚 —— 否则用户会以为建到别处去了
    note: categoryId === draft.category_id && gameId === draft.game_id ? '' : '原来的大类或游戏已经不在了，先建成未分类',
  }
}

export function deleteDraft(id) {
  const info = db.prepare('DELETE FROM service_drafts WHERE id = ?').run(Number(id))
  if (!info.changes) throw notFound('这条待添加已经不在列表里了')
  return { ok: true }
}

/** 清掉一个游戏下所有待添加（用户决定全不要了） */
export function clearDrafts({ gameId = null } = {}) {
  const info = gameId
    ? db.prepare('DELETE FROM service_drafts WHERE game_id IS ?').run(Number(gameId))
    : db.prepare('DELETE FROM service_drafts').run()
  return { ok: true, removed: Number(info.changes) }
}

export const __testing = { nameKey, shape, MAX_DRAFTS_PER_GAME }
