import { db, stamp, nextSerialNo } from '../db.mjs'
import { get, post, patch, del } from '../http.mjs'
import { bad, notFound, int, num, money, clampStr, stringifyJSON, parseJSON, localDate, nowISO, toStringArray } from '../util.mjs'
import { computeItems, computeTotals } from '../pricing.mjs'

/* ---------------- 状态机 ---------------- */

export const TRANSITIONS = {
  pending_confirm: ['pending_pay', 'in_progress', 'cancelled'],
  pending_pay: ['in_progress', 'pending_confirm', 'cancelled'],
  in_progress: ['pending_accept', 'done', 'after_sale', 'cancelled'],
  pending_accept: ['done', 'in_progress', 'after_sale'],
  done: ['after_sale'],
  after_sale: ['done', 'cancelled'],
  cancelled: ['pending_confirm'],
}

export const STATUS_LABEL = {
  pending_confirm: '待确认',
  pending_pay: '待付款',
  in_progress: '进行中',
  pending_accept: '待验收',
  done: '已完成',
  after_sale: '售后',
  cancelled: '已取消',
}

const canTransition = (from, to) => from === to || (TRANSITIONS[from] || []).includes(to)

/* ---------------- 读 ---------------- */

const ORDER_LIST_SQL = `
  SELECT o.*,
    (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS item_count,
    (SELECT COUNT(*) FROM order_progress g WHERE g.order_id = o.id) AS progress_count,
    (SELECT MAX(g.happened_on) FROM order_progress g WHERE g.order_id = o.id) AS last_progress_on,
    (SELECT COALESCE(SUM(CASE WHEN p.kind = 'refund' THEN -p.amount ELSE p.amount END), 0)
       FROM payments p WHERE p.order_id = o.id AND p.status = 'confirmed') AS paid_total
  FROM orders o
`

function decorateOrder(row) {
  if (!row) return null
  const paid = money(row.paid_total)
  const total = money(row.total)
  const hasProgress = row.progress_count > 0
  return {
    ...row,
    status_label: STATUS_LABEL[row.status] || row.status,
    paid_total: paid,
    due_total: money(Math.max(0, total - paid)),
    overpaid: money(Math.max(0, paid - total)),
    profit: money(total - num(row.platform_fee) - num(row.cost)),
    next_statuses: TRANSITIONS[row.status] || [],
    stale: row.status === 'in_progress' && hasProgress && row.last_progress_on && daysBetween(row.last_progress_on, localDate()) >= 2,
    idle_days: row.last_progress_on ? daysBetween(row.last_progress_on, localDate()) : null,
  }
}

function daysBetween(a, b) {
  const da = new Date(`${a}T00:00:00`)
  const dbb = new Date(`${b}T00:00:00`)
  return Math.round((dbb - da) / 86400000)
}

function orderDetail(id) {
  const row = db.prepare(`${ORDER_LIST_SQL} WHERE o.id = ?`).get(int(id))
  if (!row) return null
  const order = decorateOrder(row)
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order, id').all(order.id)
  const paymentsList = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY paid_at, id').all(order.id)
  const progressList = db.prepare('SELECT * FROM order_progress WHERE order_id = ? ORDER BY happened_on DESC, id DESC').all(order.id)
  const credentials = db
    .prepare('SELECT id, label, login_type, server, role_name, masked_hint FROM credentials WHERE customer_id = ? ORDER BY id DESC')
    .all(row.customer_id)

  const itemsParsed = items.map((i) => {
    let snapshot = {}
    try {
      snapshot = JSON.parse(i.snapshot || '{}')
    } catch {
      snapshot = {}
    }
    return { ...i, snapshot }
  })
  const progressParsed = progressList.map((p) => {
    let media = []
    try {
      media = JSON.parse(p.media || '[]')
    } catch {
      media = []
    }
    return { ...p, media }
  })

  return {
    ...order,
    items: itemsParsed,
    payments: paymentsList,
    progress: progressParsed,
    credentials,
    package_contents: itemsParsed.flatMap((i) => (i.snapshot.package_items || []).map((p) => ({ service: i.name, item: p }))),
    addon_summary: itemsParsed.flatMap((i) => (i.snapshot.addons || []).map((a) => ({ service: i.name, ...a }))),
  }
}

/* ---------------- 写 ---------------- */

function insertOrderItems(orderId, items) {
  const stmt = db.prepare(
    `INSERT INTO order_items (order_id, kind, ref_id, name, spec, price_type, unit_label, unit_price, quantity, amount, snapshot, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
  items.forEach((i, idx) => {
    stmt.run(
      orderId,
      i.kind || 'service',
      i.ref_id || null,
      i.name,
      i.spec || '',
      i.price_type || 'fixed',
      i.unit_label || '',
      money(i.unit_price),
      num(i.quantity, 1),
      money(i.amount),
      stringifyJSON(i.snapshot || {}),
      i.sort_order || (idx + 1) * 10
    )
  })
}

/* ---------------- 注册 ---------------- */

export function register() {
  /* ===== 订单列表 ===== */
  get('/api/orders', (ctx) => {
    const where = []
    const values = []
    const status = clampStr(ctx.query.status, 40)
    if (status === 'open') {
      where.push("o.status NOT IN ('done','cancelled')")
    } else if (status === 'unpaid') {
      where.push("o.status IN ('pending_confirm','pending_pay')")
    } else if (status && STATUS_LABEL[status]) {
      where.push('o.status = ?')
      values.push(status)
    }
    if (ctx.query.customer_id) {
      where.push('o.customer_id = ?')
      values.push(int(ctx.query.customer_id))
    }
    if (ctx.query.game_id) {
      where.push('o.game_id = ?')
      values.push(int(ctx.query.game_id))
    }
    const q = clampStr(ctx.query.q, 120).trim()
    if (q) {
      where.push("(o.order_no LIKE ? ESCAPE '\\' OR o.title LIKE ? ESCAPE '\\' OR o.customer_name LIKE ? ESCAPE '\\' OR o.game_name LIKE ? ESCAPE '\\')")
      const t = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`
      values.push(t, t, t, t)
    }
    if (ctx.query.from) {
      where.push('o.ordered_at >= ?')
      values.push(`${ctx.query.from}T00:00:00.000Z`)
    }
    if (ctx.query.to) {
      where.push('o.ordered_at <= ?')
      values.push(`${ctx.query.to}T23:59:59.999Z`)
    }
    if (ctx.query.due === '1') {
      where.push("o.status NOT IN ('done','cancelled') AND o.total > (SELECT COALESCE(SUM(CASE WHEN p.kind='refund' THEN -p.amount ELSE p.amount END),0) FROM payments p WHERE p.order_id = o.id AND p.status='confirmed')")
    }
    const orderBy = { oldest: 'o.ordered_at ASC, o.id ASC', amount: 'o.total DESC' }[ctx.query.sort] || 'o.ordered_at DESC, o.id DESC'
    const limit = Math.min(500, Math.max(1, int(ctx.query.limit, 200)))
    const rows = db
      .prepare(`${ORDER_LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${orderBy} LIMIT ?`)
      .all(...values, limit)
    return { items: rows.map(decorateOrder) }
  })

  get('/api/orders/:id', (ctx) => {
    const detail = orderDetail(ctx.params.id)
    if (!detail) notFound('订单不存在')
    return detail
  })

  /* ===== 建单：一次性把快照冻住 ===== */
  post('/api/orders', (ctx) => {
    const computed = computeItems(ctx.body.items)
    const totals = computeTotals({
      items_subtotal: computed.items_subtotal,
      addon_total: computed.addon_total,
      discount: ctx.body.discount,
      platform_fee: ctx.body.platform_fee,
      cost: ctx.body.cost,
    })
    const customerId = ctx.body.customer_id ? int(ctx.body.customer_id) : null
    const gameId = ctx.body.game_id ? int(ctx.body.game_id) : null
    const customer = customerId ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : null
    if (customerId && !customer) bad('客户不存在', 'bad_customer')
    const game = gameId ? db.prepare('SELECT * FROM games WHERE id = ?').get(gameId) : null
    if (gameId && !game) bad('游戏不存在', 'bad_game')

    const now = stamp()
    const orderedAt = ctx.body.ordered_at ? `${ctx.body.ordered_at}T${new Date().toISOString().slice(11, 19)}.000Z` : now
    const order_no = nextSerialNo('DH', 'orders', 'order_no')
    const title = clampStr(ctx.body.title, 120) || computed.items.map((i) => i.name).join(' + ').slice(0, 120)
    const status = STATUS_LABEL[ctx.body.status] ? ctx.body.status : 'pending_confirm'

    db.exec('BEGIN')
    try {
      const info = db
        .prepare(
          `INSERT INTO orders (order_no, customer_id, game_id, title, status, customer_name, game_name,
             items_subtotal, addon_total, discount, total, platform_fee, cost, ordered_at, due_at,
             note, internal_note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          order_no,
          customerId,
          gameId,
          title,
          status,
          customer?.name || clampStr(ctx.body.customer_name, 60),
          game?.name || clampStr(ctx.body.game_name, 60),
          totals.items_subtotal,
          totals.addon_total,
          totals.discount,
          totals.total,
          totals.platform_fee,
          totals.cost,
          orderedAt,
          ctx.body.due_at || null,
          clampStr(ctx.body.note, 4000),
          clampStr(ctx.body.internal_note, 4000),
          now,
          now
        )
      const orderId = Number(info.lastInsertRowid)
      insertOrderItems(orderId, computed.items)
      db.exec('COMMIT')
      return orderDetail(orderId)
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  })

  /* ===== 改单：改价只影响这一单，不碰价格表 ===== */
  patch('/api/orders/:id', (ctx) => {
    const id = int(ctx.params.id)
    const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(id)
    if (!existing) notFound('订单不存在')

    const sets = []
    const values = []
    const plain = ['title', 'note', 'internal_note', 'due_at']
    for (const k of plain) {
      if (k in ctx.body) {
        sets.push(`${k} = ?`)
        values.push(ctx.body[k] === null ? null : clampStr(ctx.body[k], 4000))
      }
    }
    if ('ordered_at' in ctx.body && ctx.body.ordered_at) {
      sets.push('ordered_at = ?')
      values.push(`${String(ctx.body.ordered_at).slice(0, 10)}T${new Date().toISOString().slice(11, 19)}.000Z`)
    }
    if ('customer_id' in ctx.body) {
      const cid = ctx.body.customer_id ? int(ctx.body.customer_id) : null
      const c = cid ? db.prepare('SELECT name FROM customers WHERE id = ?').get(cid) : null
      sets.push('customer_id = ?', 'customer_name = ?')
      values.push(cid, c?.name || '')
    }
    if ('game_id' in ctx.body) {
      const gid = ctx.body.game_id ? int(ctx.body.game_id) : null
      const g = gid ? db.prepare('SELECT name FROM games WHERE id = ?').get(gid) : null
      sets.push('game_id = ?', 'game_name = ?')
      values.push(gid, g?.name || '')
    }

    // 金额：给了 items 就重算整单，否则只改折扣/手续费/成本
    let recomputed = null
    if (Array.isArray(ctx.body.items) && ctx.body.items.length) {
      // 明细里可能混着 { keep_id } —— 那是报价单转过来、服务项已经不在价格表里的明细。
      // 它们不能重算（服务项都没了），但也不能因为它们在，就把整单的改动一起丢掉。
      // 以前前端遇到这种情况干脆不发 items，结果整单明细一条都改不动。
      const calcRaw = ctx.body.items.filter((x) => !(x && x.keep_id))
      const computed = calcRaw.length ? computeItems(calcRaw) : { items: [], items_subtotal: 0, addon_total: 0 }

      // 原样保留的明细从库里读，不用前端传来的金额
      const savedById = new Map(db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id).map((r) => [r.id, r]))
      const finalItems = []
      let ci = 0
      for (const raw of ctx.body.items) {
        if (raw && raw.keep_id) {
          const row = savedById.get(int(raw.keep_id))
          if (!row) continue
          const snap = parseJSON(row.snapshot, {})
          const addonAmount = money((snap.addons || []).reduce((s, a) => s + num(a.amount), 0))
          finalItems.push({
            ...row,
            snapshot: snap, // 库里的 snapshot 是字符串，这里必须换回对象，否则会被二次转义
            base_amount: money(num(row.amount) - addonAmount),
            addon_amount: addonAmount,
            sort_order: (finalItems.length + 1) * 10,
          })
        } else {
          const it = computed.items[ci++]
          if (it) finalItems.push({ ...it, sort_order: (finalItems.length + 1) * 10 })
        }
      }

      const itemsSubtotal = money(finalItems.reduce((s, i) => s + num(i.base_amount), 0))
      const addonTotal = money(finalItems.reduce((s, i) => s + num(i.addon_amount), 0))
      recomputed = {
        items: finalItems,
        totals: computeTotals({
          items_subtotal: itemsSubtotal,
          addon_total: addonTotal,
          discount: 'discount' in ctx.body ? ctx.body.discount : existing.discount,
          platform_fee: 'platform_fee' in ctx.body ? ctx.body.platform_fee : existing.platform_fee,
          cost: 'cost' in ctx.body ? ctx.body.cost : existing.cost,
        }),
      }
    } else if (['discount', 'platform_fee', 'cost'].some((k) => k in ctx.body)) {
      recomputed = {
        items: null,
        totals: computeTotals({
          items_subtotal: existing.items_subtotal,
          addon_total: existing.addon_total,
          discount: 'discount' in ctx.body ? ctx.body.discount : existing.discount,
          platform_fee: 'platform_fee' in ctx.body ? ctx.body.platform_fee : existing.platform_fee,
          cost: 'cost' in ctx.body ? ctx.body.cost : existing.cost,
        }),
      }
    }
    if (recomputed) {
      for (const k of ['items_subtotal', 'addon_total', 'discount', 'total', 'platform_fee', 'cost']) {
        sets.push(`${k} = ?`)
        values.push(recomputed.totals[k])
      }
    }

    if ('status' in ctx.body) {
      const next = clampStr(ctx.body.status, 40)
      if (!STATUS_LABEL[next]) bad('未知的订单状态', 'bad_status')
      if (!canTransition(existing.status, next)) {
        bad(`「${STATUS_LABEL[existing.status]}」不能直接改成「${STATUS_LABEL[next]}」`, 'bad_transition')
      }
      sets.push('status = ?')
      values.push(next)
      if (next === 'done' && !existing.completed_at) {
        sets.push('completed_at = ?')
        values.push(nowISO())
      }
      if (next !== 'done') {
        sets.push('completed_at = ?')
        values.push(null)
      }
    }

    if (!sets.length && !recomputed?.items) return orderDetail(id)
    sets.push('updated_at = ?')
    values.push(stamp(), id)

    db.exec('BEGIN')
    try {
      db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...values)
      if (recomputed?.items) {
        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id)
        insertOrderItems(id, recomputed.items)
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return orderDetail(id)
  })

  /** 单独改状态，给看板上的快捷按钮用 */
  post('/api/orders/:id/status', (ctx) => {
    const next = clampStr(ctx.body.status, 40)
    if (!STATUS_LABEL[next]) bad('未知的订单状态', 'bad_status')
    const existing = db.prepare('SELECT * FROM orders WHERE id = ?').get(int(ctx.params.id))
    if (!existing) notFound('订单不存在')
    if (!canTransition(existing.status, next)) {
      bad(`「${STATUS_LABEL[existing.status]}」不能直接改成「${STATUS_LABEL[next]}」`, 'bad_transition')
    }
    const now = stamp()
    db.prepare('UPDATE orders SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?').run(
      next,
      next === 'done' ? nowISO() : null,
      now,
      int(ctx.params.id)
    )
    if (ctx.body.note) {
      db.prepare(
        `INSERT INTO order_progress (order_id, happened_on, content, resources_before, resources_after, media, note, created_at)
         VALUES (?, ?, ?, '', '', '[]', '', ?)`
      ).run(int(ctx.params.id), localDate(), `状态改为「${STATUS_LABEL[next]}」：${clampStr(ctx.body.note, 400)}`, now)
    }
    return orderDetail(ctx.params.id)
  })

  /** 删除订单：收过钱的不让删，避免账对不上 */
  del('/api/orders/:id', (ctx) => {
    const id = int(ctx.params.id)
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id)
    if (!order) notFound('订单不存在')
    const paidCount = db.prepare("SELECT COUNT(*) AS c FROM payments WHERE order_id = ? AND status = 'confirmed'").get(id).c
    if (paidCount > 0 && ctx.query.force !== '1') {
      bad('这张单已经记过收款，删除会让账目对不上。建议改成「已取消」，或加 force=1 强制删除。', 'has_payments')
    }
    db.prepare('DELETE FROM orders WHERE id = ?').run(id)
    return { deleted: true, id }
  })

  /* ===== 进度时间线 ===== */
  get('/api/orders/:id/progress', (ctx) => {
    const orderId = int(ctx.params.id)
    const rows = db.prepare('SELECT * FROM order_progress WHERE order_id = ? ORDER BY happened_on DESC, id DESC').all(orderId)
    return {
      items: rows.map((r) => {
        let media = []
        try {
          media = JSON.parse(r.media || '[]')
        } catch {
          media = []
        }
        return { ...r, media }
      }),
    }
  })

  post('/api/orders/:id/progress', (ctx) => {
    const orderId = int(ctx.params.id)
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)
    if (!order) notFound('订单不存在')
    const content = clampStr(ctx.body.content, 4000).trim()
    if (!content) bad('请写一下这次做了什么', 'missing_content')
    const info = db
      .prepare(
        `INSERT INTO order_progress (order_id, happened_on, content, resources_before, resources_after, media, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        orderId,
        clampStr(ctx.body.happened_on, 30) || localDate(),
        content,
        clampStr(ctx.body.resources_before, 200),
        clampStr(ctx.body.resources_after, 200),
        stringifyJSON(toStringArray(ctx.body.media, 30)),
        clampStr(ctx.body.note, 2000),
        nowISO()
      )
    // 第一次记进度，顺手把「待付款」推进到「进行中」之外的单子也标一下
    db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(stamp(), orderId)
    const row = db.prepare('SELECT * FROM order_progress WHERE id = ?').get(Number(info.lastInsertRowid))
    return { ...row, media: toStringArray(ctx.body.media, 30) }
  })

  patch('/api/progress/:id', (ctx) => {
    const id = int(ctx.params.id)
    const row = db.prepare('SELECT * FROM order_progress WHERE id = ?').get(id)
    if (!row) notFound('这条进度不存在')
    const sets = []
    const values = []
    for (const k of ['happened_on', 'content', 'resources_before', 'resources_after', 'note']) {
      if (k in ctx.body) {
        sets.push(`${k} = ?`)
        values.push(clampStr(ctx.body[k], 4000))
      }
    }
    if ('media' in ctx.body) {
      sets.push('media = ?')
      values.push(stringifyJSON(toStringArray(ctx.body.media, 30)))
    }
    if (!sets.length) return row
    values.push(id)
    db.prepare(`UPDATE order_progress SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    return db.prepare('SELECT * FROM order_progress WHERE id = ?').get(id)
  })

  del('/api/progress/:id', (ctx) => {
    db.prepare('DELETE FROM order_progress WHERE id = ?').run(int(ctx.params.id))
    return { deleted: true }
  })

  /* ===== 收款 ===== */
  get('/api/payments', (ctx) => {
    const where = []
    const values = []
    if (ctx.query.order_id) {
      where.push('p.order_id = ?')
      values.push(int(ctx.query.order_id))
    }
    if (ctx.query.customer_id) {
      where.push('p.customer_id = ?')
      values.push(int(ctx.query.customer_id))
    }
    if (ctx.query.from) {
      where.push('p.paid_at >= ?')
      values.push(String(ctx.query.from).slice(0, 10))
    }
    if (ctx.query.to) {
      where.push('p.paid_at <= ?')
      values.push(String(ctx.query.to).slice(0, 10))
    }
    if (ctx.query.kind) {
      where.push('p.kind = ?')
      values.push(clampStr(ctx.query.kind, 20))
    }
    const rows = db
      .prepare(
        `SELECT p.*, o.order_no, o.title AS order_title, c.name AS customer_name
         FROM payments p
         LEFT JOIN orders o ON o.id = p.order_id
         LEFT JOIN customers c ON c.id = COALESCE(p.customer_id, o.customer_id)
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY p.paid_at DESC, p.id DESC LIMIT ?`
      )
      .all(...values, Math.min(1000, Math.max(1, int(ctx.query.limit, 400))))
    return { items: rows }
  })

  post('/api/payments', (ctx) => {
    const amount = money(ctx.body.amount)
    if (amount <= 0) bad('金额要大于 0', 'bad_amount')
    const kind = ['deposit', 'full', 'balance', 'refund'].includes(ctx.body.kind) ? ctx.body.kind : 'deposit'
    const orderId = ctx.body.order_id ? int(ctx.body.order_id) : null
    let customerId = ctx.body.customer_id ? int(ctx.body.customer_id) : null
    let advancedTo = null
    if (orderId) {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)
      if (!order) bad('订单不存在', 'bad_order')
      if (!customerId) customerId = order.customer_id
    }
    const info = db
      .prepare(
        `INSERT INTO payments (order_id, customer_id, kind, amount, method, status, paid_at, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        orderId,
        customerId,
        kind,
        amount,
        clampStr(ctx.body.method, 20) || 'wechat',
        ['confirmed', 'pending', 'void'].includes(ctx.body.status) ? ctx.body.status : 'confirmed',
        clampStr(ctx.body.paid_at, 30) || localDate(),
        clampStr(ctx.body.note, 500),
        nowISO()
      )

    // 付清了就把「待付款」推进到「进行中」，省得再点一次
    if (orderId && ctx.body.advance !== false) {
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)
      const paid = money(
        db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount ELSE amount END),0) AS s FROM payments WHERE order_id = ? AND status='confirmed'").get(orderId).s
      )
      if (order.status === 'pending_pay' && paid >= num(order.total) && num(order.total) > 0) {
        db.prepare("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ?").run(stamp(), orderId)
        advancedTo = 'in_progress'
      }
    }
    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(Number(info.lastInsertRowid))
    return { ...row, advanced_to: advancedTo }
  })

  patch('/api/payments/:id', (ctx) => {
    const id = int(ctx.params.id)
    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id)
    if (!row) notFound('这条收款记录不存在')
    const sets = []
    const values = []
    for (const k of ['kind', 'method', 'status', 'paid_at', 'note']) {
      if (k in ctx.body) {
        sets.push(`${k} = ?`)
        values.push(clampStr(ctx.body[k], 500))
      }
    }
    if ('amount' in ctx.body) {
      sets.push('amount = ?')
      values.push(money(ctx.body.amount))
    }
    if (!sets.length) return row
    values.push(id)
    db.prepare(`UPDATE payments SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    return db.prepare('SELECT * FROM payments WHERE id = ?').get(id)
  })

  del('/api/payments/:id', (ctx) => {
    db.prepare('DELETE FROM payments WHERE id = ?').run(int(ctx.params.id))
    return { deleted: true }
  })

  /* 进度汇报：给客户看的文本 + 图片模型，两者内容一致 */
  get('/api/orders/:id/progress-report', (ctx) => {
    const o = orderDetail(int(ctx.params.id))
    if (!o) notFound('订单不存在')
    const setting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || ''
    const today = localDate()

    const entries = [...(o.progress || [])]
      .sort((a, b) => String(a.happened_on).localeCompare(String(b.happened_on)))
      .map((p) => ({
        date: String(p.happened_on || '').slice(0, 10),
        content: p.content || '',
        before: p.resources_before || '',
        after: p.resources_after || '',
        note: p.note || '',
        shots: (p.media || []).filter((m) => /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(m)).length,
        links: (p.media || []).length,
      }))

    const report = {
      shopName: setting('business_name') || '代肝工作室',
      contact: setting('contact') || '',
      title: '订单进度',
      orderNo: o.order_no || '',
      orderTitle: o.title || '',
      customerName: o.customer_name || '散客',
      gameName: o.game_name || '',
      statusLabel: o.status_label || o.status || '',
      total: money(o.total),
      paid: money(o.paid_total),
      due: money(o.due_total),
      entries,
      date: today,
    }

    const lines = []
    lines.push(`【${report.shopName}】订单进度`)
    lines.push(`单号：${report.orderNo}`)
    if (report.orderTitle) lines.push(`内容：${report.orderTitle}`)
    if (report.gameName) lines.push(`游戏：${report.gameName}`)
    lines.push(`客户：${report.customerName}`)
    lines.push(`状态：${report.statusLabel}`)
    if (report.due > 0) lines.push(`已收 ${report.paid} 元，还差 ${report.due} 元`)
    else lines.push(`已收 ${report.paid} 元（已结清）`)
    lines.push('————————————')
    if (!entries.length) {
      lines.push('（还没有进度记录）')
    } else {
      for (const e of entries) {
        const res = e.before || e.after ? `  ${e.before || '—'} → ${e.after || '—'}` : ''
        lines.push(`${e.date}${res}`)
        lines.push(`  ${e.content}`)
        if (e.shots) lines.push(`  （附 ${e.shots} 张截图）`)
        else if (e.links) lines.push(`  （附 ${e.links} 个链接）`)
        if (e.note) lines.push(`  备注：${e.note}`)
      }
    }
    lines.push('————————————')
    if (report.contact) lines.push(`联系：${report.contact}`)

    return { text: lines.join('\n'), report }
  })
}
