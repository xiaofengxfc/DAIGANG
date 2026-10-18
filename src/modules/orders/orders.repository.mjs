import { db } from '../../core/db.mjs'
import { bizDate, localDate, money, num, stringifyJSON } from '../../core/util.mjs'
import { STATUS_LABEL, TRANSITIONS } from './order-status.mjs'
import { parseProgressMedia, parseSnapshot, splitItemTotals } from './order-snapshot.mjs'

export const ORDER_LIST_SQL = `
  SELECT o.*,
    (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
    (SELECT COUNT(*) FROM order_progress g WHERE g.order_id = o.id) AS progress_count,
    (SELECT MAX(g.happened_on) FROM order_progress g WHERE g.order_id = o.id) AS last_progress_on,
    (SELECT COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END), 0)
       FROM payments p WHERE p.order_id = o.id AND p.status = 'confirmed') AS paid_total,
    (SELECT COUNT(*) FROM orders x WHERE x.customer_id = o.customer_id AND o.customer_id IS NOT NULL) AS customer_order_count,
    (SELECT c.avatar FROM customers c WHERE c.id = o.customer_id) AS customer_avatar,
    (SELECT c.phone FROM customers c WHERE c.id = o.customer_id) AS customer_phone
  FROM orders o
`

function daysBetween(a, b) {
  const from = new Date(`${a}T00:00:00`)
  const to = new Date(`${b}T00:00:00`)
  return Math.round((to - from) / 86400000)
}

export function decorateOrder(row) {
  if (!row) return null
  const paid = money(row.paid_total)
  const total = money(row.total)
  return {
    ...row,
    status_label: STATUS_LABEL[row.status] || row.status,
    paid_total: paid,
    due_total: money(Math.max(0, total - paid)),
    overpaid: money(Math.max(0, paid - total)),
    profit: money(total - num(row.platform_fee) - num(row.cost)),
    next_statuses: TRANSITIONS[row.status] || [],
    daily_done_today: !!row.daily_done_on && row.daily_done_on === bizDate(),
    stale: row.status === 'in_progress' && row.progress_count > 0 && row.last_progress_on && daysBetween(row.last_progress_on, localDate()) >= 2,
    idle_days: row.last_progress_on ? daysBetween(row.last_progress_on, localDate()) : null,
  }
}

export function getOrder(id) {
  const row = db.prepare(`${ORDER_LIST_SQL} WHERE o.id = ?`).get(Number(id) || 0)
  if (!row) return null

  const order = decorateOrder(row)
  const items = db
    .prepare(
      `SELECT i.*, c.name AS category_name,
              CASE WHEN s.is_daily IS NOT NULL THEN s.is_daily ELSE c.is_daily END AS daily_flag,
              COALESCE(s.game_id, c.game_id) AS item_game_id,
              g.name AS item_game_name
       FROM order_items i
       LEFT JOIN services s ON s.id = i.ref_id
       LEFT JOIN service_categories c ON c.id = s.category_id
       LEFT JOIN games g ON g.id = COALESCE(s.game_id, c.game_id)
       WHERE i.order_id = ? ORDER BY i.sort_order, i.id`
    )
    .all(order.id)
  const payments = db
    .prepare(
      `SELECT p.*, o.order_no AS order_no FROM payments p
       LEFT JOIN orders o ON o.id = p.order_id
       WHERE p.order_id = ? ORDER BY p.paid_at, p.id`
    )
    .all(order.id)
  const progress = db.prepare('SELECT * FROM order_progress WHERE order_id = ? ORDER BY happened_on DESC, id DESC').all(order.id)
  const credentials = db
    .prepare('SELECT id, label, login_type, server, role_name, masked_hint FROM credentials WHERE customer_id = ? ORDER BY id DESC')
    .all(row.customer_id)

  const parsedItems = items.map((item) => ({
    ...item,
    snapshot: parseSnapshot(item.snapshot),
    category_name: item.category_name || '',
    is_daily: Boolean(item.daily_flag),
  }))
  const parsedProgress = progress.map((entry) => ({ ...entry, media: parseProgressMedia(entry.media) }))
  const dailyItems = parsedItems.filter((item) => item.is_daily)

  /**
   * 这一单实际涉及哪些游戏 —— **按明细里的服务项推**，不看订单头上那个 game_id。
   *
   * 以前订单的游戏是开单时手选的，还兼着「过滤服务项」的活；结果一张单里有
   * 两个游戏的服务时，头上只能写一个（或者干脆空着），进度里该记哪套资源
   * 也说不清。现在明细说了算：一单混几个游戏，就记几套。
   * 明细里的服务项已经不在价格表里（报价单转来的）时，退回订单头上的字段 ——
   * 那是唯一线索了。
   */
  const gameList = []
  for (const item of parsedItems) {
    const gid = item.item_game_id
    if (!gid) continue
    if (!gameList.some((g) => g.id === gid)) gameList.push({ id: gid, name: item.item_game_name || '' })
  }
  if (!gameList.length && order.game_id) gameList.push({ id: order.game_id, name: order.game_name || '' })

  return {
    ...order,
    items: parsedItems,
    payments,
    progress: parsedProgress,
    credentials,
    games: gameList,
    game_names: gameList.map((g) => g.name),
    package_contents: parsedItems.flatMap((item) => (item.snapshot.package_items || []).map((content) => ({ service: item.name, item: content }))),
    addon_summary: parsedItems.flatMap((item) => (item.snapshot.addons || []).map((addon) => ({ service: item.name, ...addon }))),
    daily_item_count: dailyItems.length,
    other_items: parsedItems.filter((item) => !item.is_daily).map((item) => item.name),
    has_daily: dailyItems.length > 0,
  }
}

/**
 * 一组服务项各自属于哪个游戏（服务项自己没设游戏时看它的大类）。
 * 服务项和大类都没设 → 这个服务项不算游戏（返回里就没有它）。
 */
export function gamesOfServices(refIds) {
  const ids = [...new Set((refIds || []).map((x) => Number(x)).filter((n) => n > 0))]
  if (!ids.length) return []
  return db
    .prepare(
      `SELECT DISTINCT g.id, g.name FROM services s
       LEFT JOIN service_categories c ON c.id = s.category_id
       JOIN games g ON g.id = COALESCE(s.game_id, c.game_id)
       WHERE s.id IN (${ids.map(() => '?').join(',')}) ORDER BY g.id`
    )
    .all(...ids)
}

/**
 * 明细的游戏列表 → 订单头上那两个字段该写什么。
 *   一个游戏 → 就写它（老行为，列表里按游戏筛还能筛到）
 *   多个游戏 → game_id 留空、game_name 拼成「鸣潮 + 异环」——
 *     硬塞其中一个会让「按游戏筛选」说谎（明明是两张游戏的单）。
 */
export function orderGameOfItemGames(list) {
  const games = list || []
  if (!games.length) return { game_id: null, game_name: '' }
  if (games.length === 1) return { game_id: games[0].id, game_name: games[0].name || '' }
  return { game_id: null, game_name: games.map((g) => g.name).filter(Boolean).join(' + ') }
}

export function insertOrderItems(orderId, items) {  const stmt = db.prepare(
    `INSERT INTO order_items (order_id, kind, ref_id, name, spec, price_type, unit_label, unit_price, quantity, amount, snapshot, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  for (const [index, item] of (items || []).entries()) {
    stmt.run(
      orderId,
      item.kind || 'service',
      item.ref_id || null,
      item.name,
      item.spec || '',
      item.price_type || 'fixed',
      item.unit_label || '',
      money(item.unit_price),
      num(item.quantity, 1),
      money(item.amount),
      stringifyJSON(item.snapshot || {}),
      item.sort_order || (index + 1) * 10
    )
  }
}

export { splitItemTotals }
