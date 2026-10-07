import { db, stamp, nextSerialNo } from '../db.mjs'
import { get, post, patch, del } from '../http.mjs'
import { bad, notFound, int, num, money, clampStr, stringifyJSON, parseJSON, localDate, bizDate, nowISO, toStringArray } from '../util.mjs'
import { computeItems, computeTotals } from '../pricing.mjs'
import { enqueueERPNextChange } from '../outbox.mjs'
import { transaction } from '../infrastructure/sqlite/transaction.mjs'
import { STATUS_LABEL, TRANSITIONS, canTransition } from '../modules/orders/order-status.mjs'
import {
  getOrder as orderDetail,
  insertOrderItems,
  decorateOrder,
  ORDER_LIST_SQL,
  gamesOfServices,
  orderGameOfItemGames,
} from '../modules/orders/orders.repository.mjs'
import { priceOrder, priceSplit, proportionalShare } from '../modules/orders/orders.service.mjs'
import { resourceDeltaList } from '../../shared/resources.js'

export { STATUS_LABEL, TRANSITIONS, canTransition }

/* ---------------- 注册 ---------------- */

export function register() {
  /* ===== 订单列表 ===== */
  get('/api/orders', (ctx) => {
    const where = []
    const values = []
    const status = clampStr(ctx.query.status, 40)
    if (status === 'open') {
      where.push("o.status NOT IN ('done','cancelled')")
      // 这个「今天」已经标记「今日已完成」的先从在做里挪走；
      // 过了凌晨 4 点日期对不上，自己就回来了
      where.push('(o.daily_done_on IS NULL OR o.daily_done_on <> ?)')
      values.push(bizDate())
    } else if (status === 'daily_done') {
      // 只看这个「今天」标记过的这批，方便反悔
      where.push('o.daily_done_on = ?')
      values.push(bizDate())
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
    const orderBy =
      {
        oldest: 'o.ordered_at ASC, o.id ASC',
        amount: 'o.total DESC',
        // 按客户排：同一个客户的单会聚在一起，客户多的时候好对账
        customer: "o.customer_name COLLATE NOCASE ASC, o.ordered_at DESC, o.id DESC",
      }[ctx.query.sort] || 'o.ordered_at DESC, o.id DESC'
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
    const { computed, totals } = priceOrder(ctx.body)
    const customerId = ctx.body.customer_id ? int(ctx.body.customer_id) : null
    // 游戏：前端明确给了就听它的（报价单转换、老流程）；没给就**按明细里的服务项推**。
    // 推不出来的（服务项都没挂游戏）就留空，别硬塞一个默认值 —— 留空至少是诚实的。
    const pickedGames = gamesOfServices(computed.items.map((item) => item.ref_id))
    const derivedGame = orderGameOfItemGames(pickedGames)
    const gameId = ctx.body.game_id ? int(ctx.body.game_id) : derivedGame.game_id
    const customer = customerId ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : null
    if (customerId && !customer) bad('客户不存在', 'bad_customer')
    const game = gameId ? db.prepare('SELECT * FROM games WHERE id = ?').get(gameId) : null
    if (gameId && !game) bad('游戏不存在', 'bad_game')

    const now = stamp()
    const orderedAt = ctx.body.ordered_at ? `${ctx.body.ordered_at}T${new Date().toISOString().slice(11, 19)}.000Z` : now
    const order_no = nextSerialNo('DH', 'orders', 'order_no')
    const title = clampStr(ctx.body.title, 120) || computed.items.map((i) => i.name).join(' + ').slice(0, 120)
    const status = STATUS_LABEL[ctx.body.status] ? ctx.body.status : 'pending_confirm'

    return transaction(() => {
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
          // 一个游戏就写它的名字；多个游戏拼成「鸣潮 + 异环」；一个都推不出来才用前端传的
          ctx.body.game_id ? game?.name || '' : derivedGame.game_name || clampStr(ctx.body.game_name, 60),
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
      enqueueERPNextChange('orders', orderId, 'upsert')
      return orderDetail(orderId)
    })
  })

  /**
   * 拆单：把一张单里的若干服务项挪到一张新单上，两边各自收款、各自结单。
   * 典型场景：「30天日体 + 两个活动」拆成两张 —— 日体那张天天标今日完成，
   * 活动那张自己走完成流程，互不牵扯。
   *
   * 钱怎么分（说清楚，免得对不上账）：
   *   · 每个服务项自己的金额（含它的增项）跟着它走；
   *   · 折扣 / 手续费 / 成本**留在原单**，新单从 0 开始（拆完可以各自再改）；
   *   · 收款按 `payments` 决定：
   *       'proportional'（默认）按两张单的金额比例把那几笔收款拆开，两边各自结清；
   *       'keep' 全留在原单（原单可能变「多收」，会在返回里告诉你）。
   *   · 进度按 `progress` 决定：'keep'（默认）留在原单，'move' 整批跟到新单。
   *     进度是一段自由文字，没有跟服务项挂钩，所以只能整批走或整批留。
   * body: { item_ids: [...], payments: 'proportional'|'keep', progress: 'keep'|'move' }
   */
  post('/api/orders/:id/split', (ctx) => {
    const id = int(ctx.params.id)
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id)
    if (!order) notFound('订单不存在')

    const rawIds = Array.isArray(ctx.body.item_ids) ? ctx.body.item_ids.map((x) => int(x)).filter((n) => n > 0) : []
    if (!rawIds.length) bad('请至少勾一个要拆出去的服务项', 'nothing_selected')

    const all = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY sort_order, id').all(id)
    const move = all.filter((i) => rawIds.includes(i.id))
    const keep = all.filter((i) => !rawIds.includes(i.id))
    if (move.length !== rawIds.length) bad('有服务项不属于这张单', 'bad_item')
    if (!keep.length) bad('至少得留一个服务项在原单里；如果整张都要挪走，不如直接改这一张', 'leaves_nothing')

    const payMode = ctx.body.payments === 'keep' ? 'keep' : 'proportional'
    const progressMode = ctx.body.progress === 'move' ? 'move' : 'keep'

    const { keptTotals: keepTotals, movedTotals: newTotals } = priceSplit(order, move, keep)

    const now = stamp()
    const result = transaction(() => {
      // 1. 新单：客户/游戏/日期/状态都照抄，标题加个来源标注
      const orderNo = nextSerialNo('DH', 'orders', 'order_no')
      const title = clampStr(`${order.title || '订单'}（拆出）`, 120)
      const info = db
        .prepare(
          `INSERT INTO orders (order_no, customer_id, game_id, title, status, customer_name, game_name,
             items_subtotal, addon_total, discount, total, platform_fee, cost, ordered_at, due_at, completed_at,
             note, internal_note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          orderNo,
          order.customer_id,
          order.game_id,
          title,
          order.status,
          order.customer_name,
          order.game_name,
          newTotals.items_subtotal,
          newTotals.addon_total,
          newTotals.discount,
          newTotals.total,
          newTotals.platform_fee,
          newTotals.cost,
          order.ordered_at,
          order.due_at,
          order.completed_at,
          `拆自 ${order.order_no}`,
          '',
          now,
          now
        )
      const newId = Number(info.lastInsertRowid)
      enqueueERPNextChange('orders', newId, 'upsert')

      // 2. 把选中的明细挪过去（保留原来的 sort_order，顺序不变）
      const upd = db.prepare('UPDATE order_items SET order_id = ? WHERE id = ?')
      for (const it of move) upd.run(newId, it.id)

      // 3. 原单按剩下的重算
      db.prepare(
        `UPDATE orders SET items_subtotal = ?, addon_total = ?, discount = ?, total = ?,
           platform_fee = ?, cost = ?, updated_at = ? WHERE id = ?`
      ).run(
        keepTotals.items_subtotal,
        keepTotals.addon_total,
        keepTotals.discount,
        keepTotals.total,
        keepTotals.platform_fee,
        keepTotals.cost,
        now,
        id
      )
      enqueueERPNextChange('orders', id, 'upsert')

      // 4. 收款：按金额比例把每一笔拆成两份，各自结清
      let paymentsMoved = 0
      if (payMode === 'proportional') {
        const rows = db.prepare('SELECT * FROM payments WHERE order_id = ? ORDER BY id').all(id)
        const ins = db.prepare(
          `INSERT INTO payments (order_id, customer_id, kind, amount, method, status, paid_at, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        for (const p of rows) {
          // 尾差留在原单，避免两边加起来跟原来对不上
          const share = proportionalShare(p.amount, order.total, newTotals.total)
          if (share <= 0.005) continue
          const movedInfo = ins.run(newId, p.customer_id, p.kind, share, p.method, p.status, p.paid_at, clampStr(`${p.note ? p.note + ' · ' : ''}拆自 ${order.order_no}`, 400), now)
          enqueueERPNextChange('payments', Number(movedInfo.lastInsertRowid), 'upsert')
          const rest = money(money(p.amount) - share)
          if (rest <= 0.005) {
            db.prepare('DELETE FROM payments WHERE id = ?').run(p.id)
            enqueueERPNextChange('payments', p.id, 'delete')
          } else {
            db.prepare('UPDATE payments SET amount = ? WHERE id = ?').run(rest, p.id)
            enqueueERPNextChange('payments', p.id, 'upsert')
          }
          paymentsMoved += 1
        }
      }

      // 5. 进度：整批留在原单，或整批跟到新单
      let progressMoved = 0
      if (progressMode === 'move') {
        const progressRows = db.prepare('SELECT id FROM order_progress WHERE order_id = ?').all(id)
        const c = progressRows.length
        db.prepare('UPDATE order_progress SET order_id = ? WHERE order_id = ?').run(newId, id)
        for (const progress of progressRows) enqueueERPNextChange('order_progress', progress.id, 'upsert')
        progressMoved = c
      }

      const createdDetail = orderDetail(newId)
      const originalDetail = orderDetail(id)
      return {
        created: createdDetail,
        original: originalDetail,
        moved_count: move.length,
        payments_moved: paymentsMoved,
        progress_moved: progressMoved,
        // 选了「收款全留在原单」时，原单剩下的钱可能已经不够抵之前收的了
        original_overpaid: originalDetail.overpaid,
        original_paid: originalDetail.paid_total,
      }
    })
    return result
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
      // 明细变了，游戏跟着重推（前端没明确指定游戏时）——
      // 不然改完明细订单头上还挂着上一个游戏的 game_name，按游戏筛就筛错了。
      if (!('game_id' in ctx.body)) {
        const derived = orderGameOfItemGames(gamesOfServices(finalItems.map((item) => item.ref_id)))
        sets.push('game_id = ?', 'game_name = ?')
        values.push(derived.game_id, derived.game_name)
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

    transaction(() => {
      db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...values)
      if (recomputed?.items) {
        db.prepare('DELETE FROM order_items WHERE order_id = ?').run(id)
        insertOrderItems(id, recomputed.items)
      }
      enqueueERPNextChange('orders', id, 'upsert')
    })
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
    transaction(() => {
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
      enqueueERPNextChange('orders', int(ctx.params.id), 'upsert')
    })
    return orderDetail(ctx.params.id)
  })

  /**
   * 今日已完成：日体、包天这种天天要做的单，今天做完了先挪出「在做」列表，
   * 第二天日期对不上就自动回来 —— 只存日期，不存布尔，省掉定时重置。
   * 存的是 bizDate()：凌晨 4 点才算新的一天，干到后半夜不会突然刷新。
   * body: { done: true } 标记 / { done: false } 撤销
   */
  post('/api/orders/:id/daily-done', (ctx) => {
    const id = int(ctx.params.id)
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id)
    if (!order) notFound('订单不存在')
    if (['done', 'cancelled'].includes(order.status)) {
      bad(`这张单已经是「${STATUS_LABEL[order.status]}」了，不用再标今日完成`, 'order_closed')
    }
    const done = ctx.body.done !== false
    transaction(() => {
      db.prepare('UPDATE orders SET daily_done_on = ?, updated_at = ? WHERE id = ?').run(done ? bizDate() : null, stamp(), id)
      enqueueERPNextChange('orders', id, 'upsert')
    })
    return orderDetail(id)
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
    transaction(() => {
      db.prepare('DELETE FROM orders WHERE id = ?').run(id)
      enqueueERPNextChange('orders', id, 'delete')
    })
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
    const media = toStringArray(ctx.body.media, 30)
    const result = transaction(() => {
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
          stringifyJSON(media),
          clampStr(ctx.body.note, 2000),
          nowISO()
        )
      // 第一次记进度，顺手把订单更新时间一起推进。
      db.prepare('UPDATE orders SET updated_at = ? WHERE id = ?').run(stamp(), orderId)
      const progressId = Number(info.lastInsertRowid)
      enqueueERPNextChange('order_progress', progressId, 'upsert')
      return { row: db.prepare('SELECT * FROM order_progress WHERE id = ?').get(progressId), media }
    })
    return { ...result.row, media: result.media }
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
    enqueueERPNextChange('order_progress', id, 'upsert')
    return db.prepare('SELECT * FROM order_progress WHERE id = ?').get(id)
  })

  del('/api/progress/:id', (ctx) => {
    const id = int(ctx.params.id)
    const row = db.prepare('SELECT id FROM order_progress WHERE id = ?').get(id)
    if (!row) notFound('这条进度不存在')
    db.prepare('DELETE FROM order_progress WHERE id = ?').run(id)
    enqueueERPNextChange('order_progress', id, 'delete')
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
    const result = transaction(() => {
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
        const currentOrder = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId)
        const paid = money(
          db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount ELSE amount END),0) AS s FROM payments WHERE order_id = ? AND status='confirmed'").get(orderId).s
        )
        if (currentOrder.status === 'pending_pay' && paid >= num(currentOrder.total) && num(currentOrder.total) > 0) {
          db.prepare("UPDATE orders SET status = 'in_progress', updated_at = ? WHERE id = ?").run(stamp(), orderId)
          advancedTo = 'in_progress'
        }
      }
      const paymentId = Number(info.lastInsertRowid)
      enqueueERPNextChange('payments', paymentId, 'upsert')
      if (orderId) enqueueERPNextChange('orders', orderId, 'upsert')
      return { row: db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId), advancedTo }
    })
    return { ...result.row, advanced_to: result.advancedTo }
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
    enqueueERPNextChange('payments', id, 'upsert')
    if (row.order_id) enqueueERPNextChange('orders', row.order_id, 'upsert')
    return db.prepare('SELECT * FROM payments WHERE id = ?').get(id)
  })

  del('/api/payments/:id', (ctx) => {
    const id = int(ctx.params.id)
    const row = db.prepare('SELECT * FROM payments WHERE id = ?').get(id)
    if (!row) notFound('这条收款记录不存在')
    db.prepare('DELETE FROM payments WHERE id = ?').run(id)
    enqueueERPNextChange('payments', id, 'delete')
    if (row.order_id) enqueueERPNextChange('orders', row.order_id, 'upsert')
    return { deleted: true }
  })

  /* 进度汇报：给客户看的文本 + 图片模型，两者内容一致 */
/**
 * 算出这一趟的消耗，给人看的一行：`星声 +780 · 体力 −191`
 *
 * 规则和界面上那行「本次消耗」是**同一份代码**（shared/resources.js）：
 * 分享出去的文字和界面上看到的必须一致，抄一遍迟早会抄出偏差。
 *   · includeUnknown：老数据里可能写着别的游戏/别的写法（原石、树脂…），
 *     报表不该因为「不在并集里」就少一行 —— 认得出标签就照原文比。
 *   · 差值为 0 的不报（界面上会显示 ±0，报表里全是 0 很吵）。
 */
function resourceDeltaText(beforeText, afterText) {
  return resourceDeltaList(beforeText, afterText, { includeUnknown: true })
    .filter((d) => Math.abs(d.diff) >= 0.001)
    .map((d) => `${d.game ? `${d.game} ` : ''}${d.key} ${d.diff > 0 ? '+' : '−'}${Math.abs(d.diff)}`)
    .join(' · ')
}

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
        delta: resourceDeltaText(p.resources_before, p.resources_after),
        note: p.note || '',
        shots: (p.media || []).filter((m) => /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(m)).length,
        links: (p.media || []).filter((m) => !/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(m)).length,
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
        // 「做之前 → 做之后」是原始记录，再给一行算好的差，客户一眼看出这一趟动了多少
        if (e.delta) lines.push(`  本次消耗：${e.delta}`)
        lines.push(`  ${e.content}`)
        if (e.shots) lines.push(`  （附 ${e.shots} 张截图）`)
        if (e.links) lines.push(`  （附 ${e.links} 个链接）`)
        if (e.note) lines.push(`  备注：${e.note}`)
      }
    }
    lines.push('————————————')
    if (report.contact) lines.push(`联系：${report.contact}`)

    return { text: lines.join('\n'), report }
  })
}
