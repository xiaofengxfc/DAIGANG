import { db, stamp, nextSerialNo } from '../db.mjs'
import { get, post, patch, del } from '../http.mjs'
import { bad, notFound, int, num, money, clampStr, parseJSON, stringifyJSON, nowISO } from '../util.mjs'
import { makeDef, registerCrud, getRow, createRow, updateRow, removeRow, shapeRow } from './_helpers.mjs'
import { audit, auditLog, configure, decrypt, encrypt, isConfigured, lock, maskHint, status as vaultStatus, unlock, changePassword, requireKey } from '../vault.mjs'
import { assertNotThrottled, clearFailures, noteFailure } from '../auth.mjs'
import { computeItems, computeTotals } from '../pricing.mjs'

/* ---------------- 客户 ---------------- */

export const customers = makeDef({
  table: 'customers',
  listOrder: 'id DESC',
  limit: 400,
  searchColumns: ['name', 'phone', 'wechat', 'qq', 'note', 'source'],
  archiveInstead: true,
  columns: {
    name: { type: 'string', required: true, label: '昵称', max: 60, filter: true },
    phone: { type: 'string', label: '手机号', max: 30, unique: true },
    wechat: { type: 'string', label: '微信', max: 60 },
    qq: { type: 'string', label: 'QQ', max: 30 },
    source: { type: 'string', label: '来源', max: 40, filter: true },
    tags: { type: 'strarray', label: '标签', max: 20 },
    note: { type: 'text', label: '备注', max: 2000 },
    status: { type: 'string', default: 'active', enum: ['active', 'archived'], filter: true },
  },
})

/* ---------------- 登录凭证 ---------------- */

export const credentials = makeDef({
  table: 'credentials',
  listOrder: 'id DESC',
  limit: 400,
  searchColumns: ['label', 'server', 'role_name', 'masked_hint'],
  columns: {
    customer_id: { type: 'ref', required: true, label: '客户', filter: true },
    game_id: { type: 'ref', label: '游戏', filter: true },
    label: { type: 'string', label: '备注名', max: 80 },
    login_type: { type: 'string', label: '登录方式', default: 'qrcode', enum: ['qrcode', 'password', 'other'], filter: true },
    server: { type: 'string', label: '区服', max: 80 },
    role_name: { type: 'string', label: '角色', max: 80 },
    masked_hint: { type: 'string', max: 90 },
    status: { type: 'string', default: 'active', enum: ['active', 'archived'], filter: true },
  },
})

const SECRET_FIELDS = ['account', 'phone', 'password', 'bind_phone', 'security_question', 'security_answer', 'note']

function cleanSecret(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const f of SECRET_FIELDS) out[f] = clampStr(src[f], f === 'note' ? 1000 : 200).trim()
  return out
}

const hasPassword = (secret) => Boolean(secret.password)
const secretIsEmpty = (secret) => SECRET_FIELDS.every((f) => !secret[f])

/* ---------------- 报价单 ---------------- */

export const quotes = makeDef({
  table: 'quotes',
  listOrder: 'id DESC',
  searchColumns: ['quote_no', 'title', 'note'],
  columns: {
    quote_no: { type: 'string', label: '报价单号', max: 40, readonly: true },
    customer_id: { type: 'ref', filter: true },
    game_id: { type: 'ref', filter: true },
    title: { type: 'string', max: 120 },
    items: { type: 'json', default: [] },
    total: { type: 'money', default: 0 },
    note: { type: 'text', max: 2000 },
    valid_until: { type: 'string', max: 30 },
  },
})

function shapeQuote(row) {
  if (!row) return null
  const q = shapeRow(quotes, row)
  q.items = Array.isArray(q.items) ? q.items : []
  return q
}

function buildQuote(body) {
  const computed = computeItems(body.items)
  const totals = computeTotals({
    items_subtotal: computed.items_subtotal,
    addon_total: computed.addon_total,
    discount: body.discount,
  })
  const lines = computed.items.map((i) => ({
    name: i.name,
    spec: i.spec,
    price_type: i.price_type,
    unit_label: i.unit_label,
    unit_price: i.unit_price,
    quantity: i.quantity,
    amount: i.amount,
    snapshot: i.snapshot,
  }))
  return { lines, totals }
}

/* ---------------- 注册 ---------------- */

export function register() {
  /* ===== 客户 ===== */
  registerCrud('/api/customers', customers, {
    afterList: (rows) => {
      const ord = new Map()
      for (const r of db
        .prepare('SELECT customer_id, COUNT(*) AS c, COALESCE(SUM(total),0) AS t FROM orders GROUP BY customer_id')
        .all()) {
        ord.set(r.customer_id, r)
      }
      const paid = new Map()
      for (const r of db
        .prepare(
          `SELECT customer_id,
                  COALESCE(SUM(CASE WHEN kind = 'refund' THEN -amount ELSE amount END),0) AS p
           FROM payments WHERE status = 'confirmed' AND customer_id IS NOT NULL GROUP BY customer_id`
        )
        .all()) {
        paid.set(r.customer_id, num(r.p))
      }
      const cred = new Map(
        db.prepare("SELECT customer_id, COUNT(*) AS c FROM credentials WHERE status = 'active' GROUP BY customer_id").all().map((r) => [r.customer_id, r.c])
      )
      return rows.map((r) => {
        const o = ord.get(r.id) || { c: 0, t: 0 }
        const p = paid.get(r.id) || 0
        return {
          ...r,
          order_count: o.c,
          order_total: money(o.t),
          paid_total: money(p),
          due_total: money(num(o.t) - p),
          credential_count: cred.get(r.id) || 0,
        }
      })
    },
  })

  /** 客户全景：订单、凭证、收款、报价，一个请求拿全 */
  get('/api/customers/:id/profile', (ctx) => {
    const id = int(ctx.params.id)
    const customer = getRow(customers, id)
    if (!customer) notFound('客户不存在')
    const orders = db.prepare('SELECT * FROM orders WHERE customer_id = ? ORDER BY id DESC').all(id)
    const orderIds = orders.map((o) => o.id)
    const payments = orderIds.length
      ? db.prepare(`SELECT * FROM payments WHERE customer_id = ? OR order_id IN (${orderIds.map(() => '?').join(',')}) ORDER BY paid_at DESC, id DESC`).all(id, ...orderIds)
      : db.prepare('SELECT * FROM payments WHERE customer_id = ? ORDER BY paid_at DESC, id DESC').all(id)
    const creds = db
      .prepare('SELECT id, game_id, label, login_type, server, role_name, masked_hint, status, created_at FROM credentials WHERE customer_id = ? ORDER BY id DESC')
      .all(id)
    const games = new Map(db.prepare('SELECT id, name FROM games').all().map((r) => [r.id, r.name]))
    const paid = payments.filter((p) => p.status === 'confirmed').reduce((s, p) => s + (p.kind === 'refund' ? -num(p.amount) : num(p.amount)), 0)
    return {
      customer,
      orders: orders.map((o) => ({ ...o, game_name: o.game_name || games.get(o.game_id) || '' })),
      payments,
      credentials: creds.map((c) => ({ ...c, game_name: games.get(c.game_id) || '' })),
      quotes: db.prepare('SELECT id, quote_no, title, total, created_at FROM quotes WHERE customer_id = ? ORDER BY id DESC').all(id),
      summary: {
        order_count: orders.length,
        order_total: money(orders.reduce((s, o) => s + num(o.total), 0)),
        paid_total: money(paid),
        due_total: money(orders.reduce((s, o) => s + num(o.total), 0) - paid),
        active_orders: orders.filter((o) => !['done', 'cancelled'].includes(o.status)).length,
      },
    }
  })

  /* ===== 保险箱 ===== */
  get('/api/vault/status', () => vaultStatus())

  post('/api/vault/setup', (ctx) => {
    if (isConfigured()) bad('保险箱已经设置过了，想改密码请用「修改密码」', 'already_configured')
    assertNotThrottled('vault', ctx.ip)
    try {
      configure(String(ctx.body.password ?? ''))
    } catch (err) {
      noteFailure('vault', ctx.ip)
      throw err
    }
    clearFailures('vault', ctx.ip)
    return vaultStatus()
  })

  post('/api/vault/unlock', (ctx) => {
    if (!isConfigured()) bad('保险箱还没有设置密码', 'vault_unconfigured')
    assertNotThrottled('vault', ctx.ip)
    const ok = unlock(String(ctx.body.password ?? ''))
    if (!ok) {
      noteFailure('vault', ctx.ip)
      audit('vault.unlock_failed', { target: '密码错误', ip: ctx.ip, ua: ctx.ua })
      bad('保险箱密码不对', 'bad_password')
    }
    clearFailures('vault', ctx.ip)
    audit('vault.unlock', { target: '解锁保险箱', ip: ctx.ip, ua: ctx.ua })
    return vaultStatus()
  })

  post('/api/vault/lock', (ctx) => {
    const was = lock('manual')
    if (was) audit('vault.lock', { target: '手动落锁', ip: ctx.ip, ua: ctx.ua })
    return vaultStatus()
  })

  post('/api/vault/password', (ctx) => {
    const count = changePassword(String(ctx.body.current ?? ''), String(ctx.body.next ?? ''))
    return { ok: true, reencrypted: count }
  })

  get('/api/vault/audit', (ctx) => ({ items: auditLog(int(ctx.query.limit, 200)) }))

  /* ===== 登录凭证 ===== */
  registerCrud('/api/credentials', credentials, {
    afterList: (rows) => {
      const map = new Map()
      for (const c of db.prepare('SELECT id, name FROM customers').all()) map.set(c.id, c.name)
      const gm = new Map(db.prepare('SELECT id, name FROM games').all().map((r) => [r.id, r.name]))
      return rows.map((r) => ({
        ...r,
        customer_name: map.get(r.customer_id) || '',
        game_name: gm.get(r.game_id) || '',
      }))
    },
    onDelete: (ctx, def) => {
      const row = getRow(def, ctx.params.id)
      if (!row) notFound('凭证不存在')
      audit('credential.delete', {
        credentialId: row.id,
        customerId: row.customer_id,
        target: `${row.label || row.masked_hint}（删除）`,
        ip: ctx.ip,
        ua: ctx.ua,
      })
      return removeRow(def, ctx.params.id)
    },
  })

  post('/api/credentials', (ctx) => {
    if (!isConfigured()) bad('请先在「设置 → 保险箱」里设置保险箱密码', 'vault_unconfigured')
    requireKey()
    const secret = cleanSecret(ctx.body.secret)
    if (secretIsEmpty(secret)) bad('凭证内容不能全空', 'empty_secret')
    const meta = {
      customer_id: ctx.body.customer_id,
      game_id: ctx.body.game_id,
      label: ctx.body.label,
      login_type: ctx.body.login_type || (hasPassword(secret) ? 'password' : 'qrcode'),
      server: ctx.body.server,
      role_name: ctx.body.role_name,
      masked_hint: maskHint(secret.account, secret.phone),
      status: 'active',
    }
    const created = createRow(credentials, meta)
    db.prepare('UPDATE credentials SET payload_enc = ?, updated_at = ? WHERE id = ?').run(encrypt(secret), stamp(), created.id)
    audit('credential.create', {
      credentialId: created.id,
      customerId: created.customer_id,
      target: `${created.label || created.masked_hint}（新建）`,
      ip: ctx.ip,
      ua: ctx.ua,
    })
    return { ...getRow(credentials, created.id), has_password: hasPassword(secret) }
  })

  patch('/api/credentials/:id', (ctx) => {
    const id = int(ctx.params.id)
    const existing = getRow(credentials, id)
    if (!existing) notFound('凭证不存在')
    const patchBody = { ...ctx.body }
    if (ctx.body.secret) {
      requireKey()
      const secret = cleanSecret(ctx.body.secret)
      if (secretIsEmpty(secret)) bad('凭证内容不能全空', 'empty_secret')
      db.prepare('UPDATE credentials SET payload_enc = ?, updated_at = ? WHERE id = ?').run(encrypt(secret), stamp(), id)
      patchBody.masked_hint = maskHint(secret.account, secret.phone)
      audit('credential.update_secret', {
        credentialId: id,
        customerId: existing.customer_id,
        target: `${existing.label || existing.masked_hint}（改内容）`,
        ip: ctx.ip,
        ua: ctx.ua,
      })
    }
    delete patchBody.secret
    delete patchBody.payload_enc
    const updated = Object.keys(patchBody).length ? updateRow(credentials, id, patchBody) : existing
    return updated
  })

  /** 二次验证后的取用：必须已解锁，且每次都留痕 */
  post('/api/credentials/:id/reveal', (ctx) => {
    const id = int(ctx.params.id)
    const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id)
    if (!row) notFound('凭证不存在')
    const secret = decrypt(row.payload_enc)
    const field = clampStr(ctx.body.field, 30)
    const action = ctx.body.action === 'copy' ? 'credential.copy' : 'credential.view'
    audit(action, {
      credentialId: id,
      customerId: row.customer_id,
      target: `${row.label || row.masked_hint}${field ? ` · ${field}` : '（整条）'}`,
      ip: ctx.ip,
      ua: ctx.ua,
    })
    const games = new Map(db.prepare('SELECT id, name FROM games').all().map((r) => [r.id, r.name]))
    return {
      id,
      customer_id: row.customer_id,
      game_id: row.game_id,
      game_name: games.get(row.game_id) || '',
      label: row.label,
      login_type: row.login_type,
      server: row.server,
      role_name: row.role_name,
      secret,
      revealed_at: nowISO(),
    }
  })

  get('/api/credentials/:id/audit', (ctx) => ({
    items: db
      .prepare('SELECT * FROM vault_audit WHERE credential_id = ? ORDER BY id DESC LIMIT 100')
      .all(int(ctx.params.id)),
  }))

  /** 批量取用（比如一次要登好几个号）—— 数量受限并留痕 */
  post('/api/credentials/reveal-batch', (ctx) => {
    const ids = (Array.isArray(ctx.body.ids) ? ctx.body.ids : []).map(int).filter(Boolean).slice(0, 20)
    if (!ids.length) bad('没有选择凭证', 'empty_ids')
    const out = []
    for (const id of ids) {
      const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id)
      if (!row) continue
      out.push({ id, label: row.label, server: row.server, role_name: row.role_name, secret: decrypt(row.payload_enc) })
      audit(ctx.body.action === 'copy' ? 'credential.copy' : 'credential.view', {
        credentialId: id,
        customerId: row.customer_id,
        target: `${row.label || row.masked_hint}（批量）`,
        ip: ctx.ip,
        ua: ctx.ua,
      })
    }
    return { items: out }
  })

  /* ===== 报价单 ===== */
  registerCrud('/api/quotes', quotes, {
    afterList: (rows) => {
      const cm = new Map(db.prepare('SELECT id, name, phone, wechat FROM customers').all().map((r) => [r.id, r]))
      const gm = new Map(db.prepare('SELECT id, name FROM games').all().map((r) => [r.id, r.name]))
      return rows.map((r) => {
        const q = shapeQuote(r)
        const c = cm.get(r.customer_id)
        return { ...q, item_count: q.items.length, customer_name: c?.name || '', customer_wechat: c?.wechat || '', game_name: gm.get(r.game_id) || '' }
      })
    },
  })

  /** 只算不存：报价单面板实时试算 */
  post('/api/quotes/preview', (ctx) => {
    const { lines, totals } = buildQuote(ctx.body)
    return { items: lines, ...totals }
  })

  post('/api/quotes', (ctx) => {
    const { lines, totals } = buildQuote(ctx.body)
    const days = int(ctx.body.valid_days, 7)
    const validUntil = ctx.body.valid_until || new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)
    const quote_no = nextSerialNo('BJ', 'quotes', 'quote_no')
    const now = stamp()
    const info = db
      .prepare(
        `INSERT INTO quotes (quote_no, customer_id, game_id, title, items, total, note, valid_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        quote_no,
        ctx.body.customer_id ? int(ctx.body.customer_id) : null,
        ctx.body.game_id ? int(ctx.body.game_id) : null,
        clampStr(ctx.body.title, 120) || '代肝报价单',
        stringifyJSON(lines),
        totals.total,
        clampStr(ctx.body.note, 2000),
        validUntil,
        now,
        now
      )
    return shapeQuote(db.prepare('SELECT * FROM quotes WHERE id = ?').get(Number(info.lastInsertRowid)))
  })

  /** 客户点头了，直接从报价单开单 */
  post('/api/quotes/:id/convert', (ctx) => {
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(int(ctx.params.id))
    if (!row) notFound('报价单不存在')
    const q = shapeQuote(row)
    const customerId = q.customer_id
    const customer = customerId ? db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) : null
    if (q.items.some((i) => i.name) === false) bad('这张报价单是空的', 'empty_quote')
    const game = q.game_id ? db.prepare('SELECT name FROM games WHERE id = ?').get(q.game_id) : null
    const order_no = nextSerialNo('DH', 'orders', 'order_no')
    const now = stamp()
    const totals = computeTotals({ items_subtotal: money(q.total), addon_total: 0, discount: 0 })
    db.exec('BEGIN')
    try {
      const info = db
        .prepare(
          `INSERT INTO orders (order_no, customer_id, game_id, title, status, customer_name, game_name,
             items_subtotal, addon_total, discount, total, platform_fee, cost, ordered_at,
             note, internal_note, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending_confirm', ?, ?, ?, 0, 0, ?, 0, 0, ?, ?, ?, ?, ?)`
        )
        .run(
          order_no,
          customerId || null,
          q.game_id || null,
          q.title,
          customer?.name || '',
          game?.name || '',
          totals.items_subtotal,
          totals.total,
          now,
          q.note,
          `由报价单 ${q.quote_no} 转入`,
          now,
          now
        )
      const orderId = Number(info.lastInsertRowid)
      const stmt = db.prepare(
        `INSERT INTO order_items (order_id, kind, ref_id, name, spec, price_type, unit_label, unit_price, quantity, amount, snapshot, sort_order)
         VALUES (?, 'service', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      q.items.forEach((i, idx) => {
        stmt.run(orderId, i.name, i.spec || '', i.price_type || 'fixed', i.unit_label || '', money(i.unit_price), num(i.quantity, 1), money(i.amount), stringifyJSON(i.snapshot || {}), (idx + 1) * 10)
      })
      db.exec('COMMIT')
      return { ok: true, order_id: orderId, order_no }
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  })

  /** 报价单文本，直接粘到微信里 */
  get('/api/quotes/:id/text', (ctx) => {
    const row = db.prepare('SELECT * FROM quotes WHERE id = ?').get(int(ctx.params.id))
    if (!row) notFound('报价单不存在')
    const q = shapeQuote(row)
    const customer = q.customer_id ? db.prepare('SELECT * FROM customers WHERE id = ?').get(q.customer_id) : null
    const game = q.game_id ? db.prepare('SELECT name FROM games WHERE id = ?').get(q.game_id) : null
    const business = db.prepare("SELECT value FROM settings WHERE key = 'business_name'").get()?.value || '代肝工作室'
    const lines = []
    lines.push(`【${business}】报价单`)
    if (customer) lines.push(`客户：${customer.name}`)
    if (game) lines.push(`游戏：${game.name}`)
    lines.push(`单号：${q.quote_no}`)
    lines.push('————————————')
    q.items.forEach((i, idx) => {
      const qty = num(i.quantity, 1)
      const unit = i.unit_label ? `/${i.unit_label}` : ''
      lines.push(`${idx + 1}. ${i.name}`)
      lines.push(`   ${money(i.unit_price)} 元${unit} × ${qty} = ${money(i.amount)} 元`)
      if (i.spec) lines.push(`   说明：${i.spec}`)
    })
    lines.push('————————————')
    lines.push(`合计：${money(q.total)} 元`)
    if (q.note) lines.push(`备注：${q.note}`)
    if (q.valid_until) lines.push(`有效期至：${q.valid_until}`)
    return { text: lines.join('\n'), quote: q }
  })
}
