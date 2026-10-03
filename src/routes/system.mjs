import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db, setSetting, stamp, nextSerialNo } from '../db.mjs'
import { get, post, patch, del, saveDataURL, setBodyLimit } from '../http.mjs'
import { UPLOAD_DIR, needsRestart, ROOT, MAX_OCR_IMAGE_BYTES } from '../config.mjs'
import { bad, notFound, fail, int, num, money, clampStr, nowISO, localDate, localMonth, bizDate, parseJSON } from '../util.mjs'
import { ocrAvailable, ocrImage, extractResources, ocrStatus, probeEngines, ocrEngines } from '../ocr.mjs'
import { installOptions, installEngine, installStatus, extractorStatus, releasePage, INSTALL_SPECS, engineHealth, cleanupTmp } from '../ocr-install.mjs'
import { recognizeScreenOnce, recognizeImageFile, resetVotes, screenAvailable, templateStatus, loadTemplates, extractIconTemplate, TEMPLATE_FILE, SCREEN_RESOURCES, MIN_SCORE } from '../screen.mjs'
import { decodePNG, encodePNG } from '../imgmatch.mjs'
import { isSetUp, setPassword, verifyPassword, createSession, destroySession, destroyAllSessions, actorName, assertNotThrottled, noteFailure, clearFailures } from '../auth.mjs'
import { lock, status as vaultStatus, isConfigured, configure, auditLog } from '../vault.mjs'
import { STATUS_LABEL } from './orders.mjs'
import { erpNextStatus, testERPNext, preflightERPNext, syncERPNextMaster, syncERPNextTransactions, reconcileERPNext, ERPNextError } from '../erpnext.mjs'
import { buildERPNextPreview, buildERPNextBundle } from '../erpnext-map.mjs'
import { listOutbox, outboxSummary, retryOutbox } from '../outbox.mjs'
import { buildERPNextOutboxPlan, syncERPNextOutbox } from '../erpnext-outbox.mjs'
import { erpNextScopeSummary } from '../erpnext-scope.mjs'
import { resticStatus, listResticSnapshots, createResticBackup } from '../restic.mjs'
import { readSettings, updateSettings, SETTING_KEYS } from '../modules/settings/settings-service.mjs'
import { transaction } from '../infrastructure/sqlite/transaction.mjs'

/* ---------------- 看板 ---------------- */

function decorateLite(row) {
  const paid = money(
    db
      .prepare("SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount ELSE amount END),0) AS s FROM payments WHERE order_id = ? AND status = 'confirmed'")
      .get(row.id).s
  )
  return {
    ...row,
    status_label: STATUS_LABEL[row.status] || row.status,
    paid_total: paid,
    due_total: money(Math.max(0, num(row.total) - paid)),
    progress_count: db.prepare('SELECT COUNT(*) AS c FROM order_progress WHERE order_id = ?').get(row.id).c,
    last_progress_on: db.prepare('SELECT MAX(happened_on) AS m FROM order_progress WHERE order_id = ?').get(row.id).m,
  }
}

function buildDashboard() {
  const today = localDate()
  const month = localMonth()

  const countBy = (status) => db.prepare('SELECT COUNT(*) AS c FROM orders WHERE status = ?').get(status).c
  const sumPay = (from, to) =>
    money(
      db
        .prepare(
          `SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount ELSE amount END),0) AS s
           FROM payments WHERE status='confirmed' AND paid_at >= ? AND paid_at <= ?`
        )
        .get(from, to).s
    )
  const refundOf = (from, to) =>
    money(
      db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='confirmed' AND kind='refund' AND paid_at >= ? AND paid_at <= ?").get(from, to).s
    )

  const ordersToday = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(total),0) AS t FROM orders WHERE ordered_at >= ?').get(`${today}T00:00:00.000Z`)
  const openOrders = db
    .prepare(
      `SELECT * FROM orders
       WHERE status IN ('in_progress','pending_accept')
         AND (daily_done_on IS NULL OR daily_done_on <> ?)
       ORDER BY COALESCE(due_at, '9999') ASC, id DESC LIMIT 12`
    )
    .all(bizDate())
    .map(decorateLite)
  const stale = db
    .prepare(
      `SELECT o.* FROM orders o
       WHERE o.status = 'in_progress'
         AND EXISTS (SELECT 1 FROM order_progress g WHERE g.order_id = o.id)
         AND (SELECT MAX(g.happened_on) FROM order_progress g WHERE g.order_id = o.id) <= date('now','localtime','-2 day')
       ORDER BY o.id DESC LIMIT 8`
    )
    .all()
    .map(decorateLite)
  const unpaid = db
    .prepare(
      `SELECT * FROM (
         SELECT o.*, (SELECT COALESCE(SUM(CASE WHEN p.kind='refund' THEN -p.amount ELSE p.amount END),0)
                        FROM payments p WHERE p.order_id = o.id AND p.status='confirmed') AS paid_total
         FROM orders o WHERE o.status <> 'cancelled'
       )
       WHERE total > paid_total + 0.001
       ORDER BY ordered_at DESC LIMIT 10`
    )
    .all()
    .map((r) => ({ ...decorateLite(r), due_total: money(num(r.total) - money(r.paid_total)) }))
  const monthAgg = db
    .prepare('SELECT COUNT(*) AS c, COALESCE(SUM(total),0) AS t, COALESCE(SUM(platform_fee),0) AS f, COALESCE(SUM(cost),0) AS k FROM orders WHERE ordered_at >= ? AND status <> ?')
    .get(`${month}-01T00:00:00.000Z`, 'cancelled')

  const receivables = money(
    db
      .prepare(
        `SELECT COALESCE(SUM(o.total - COALESCE((SELECT SUM(CASE WHEN p.kind='refund' THEN -p.amount ELSE p.amount END) FROM payments p WHERE p.order_id=o.id AND p.status='confirmed'),0)),0) AS s
         FROM orders o WHERE o.status NOT IN ('cancelled','done')`
      )
      .get().s
  )

  return {
    today,
    month,
    counts: {
      pending_confirm: countBy('pending_confirm'),
      pending_pay: countBy('pending_pay'),
      in_progress: countBy('in_progress'),
      pending_accept: countBy('pending_accept'),
      done: countBy('done'),
      after_sale: countBy('after_sale'),
      open: db.prepare("SELECT COUNT(*) AS c FROM orders WHERE status NOT IN ('done','cancelled')").get().c,
      customers: db.prepare("SELECT COUNT(*) AS c FROM customers WHERE status='active'").get().c,
      credentials: db.prepare("SELECT COUNT(*) AS c FROM credentials WHERE status='active'").get().c,
      services: db.prepare("SELECT COUNT(*) AS c FROM services WHERE status='active'").get().c,
      games: db.prepare("SELECT COUNT(*) AS c FROM games WHERE status='active'").get().c,
    },
    today_money: {
      ordered_count: ordersToday.c,
      ordered_amount: money(ordersToday.t),
      received: sumPay(today, today),
      refunded: refundOf(today, today),
    },
    month_money: {
      order_count: monthAgg.c,
      ordered_amount: money(monthAgg.t),
      received: sumPay(`${month}-01`, today),
      profit: money(num(monthAgg.t) - num(monthAgg.f) - num(monthAgg.k)),
      platform_fee: money(monthAgg.f),
      cost: money(monthAgg.k),
    },
    receivables,
    open_orders: openOrders,
    stale_orders: stale,
    unpaid_orders: unpaid,
    recent_payments: db
      .prepare(
        `SELECT p.*, o.order_no, o.title AS order_title, c.name AS customer_name
         FROM payments p LEFT JOIN orders o ON o.id = p.order_id
         LEFT JOIN customers c ON c.id = COALESCE(p.customer_id, o.customer_id)
         ORDER BY p.paid_at DESC, p.id DESC LIMIT 8`
      )
      .all(),
    vault: { ...vaultStatus(), audit_count: db.prepare('SELECT COUNT(*) AS c FROM vault_audit').get().c },
  }
}

/* ---------------- 财务 ---------------- */

function buildFinance(from, to) {
  const totals = db
    .prepare(
      `SELECT COUNT(*) AS order_count,
              COALESCE(SUM(total),0) AS order_total,
              COALESCE(SUM(platform_fee),0) AS platform_fee,
              COALESCE(SUM(cost),0) AS cost,
              COALESCE(SUM(discount),0) AS discount
       FROM orders WHERE ordered_at >= ? AND ordered_at <= ? AND status <> 'cancelled'`
    )
    .get(`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`)

  const received = money(
    db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount ELSE amount END),0) AS s
         FROM payments WHERE status='confirmed' AND paid_at >= ? AND paid_at <= ?`
      )
      .get(from, to).s
  )
  const refunded = money(
    db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE status='confirmed' AND kind='refund' AND paid_at >= ? AND paid_at <= ?").get(from, to).s
  )
  const grossReceived = money(received + refunded)

  const byMethod = db
    .prepare(
      `SELECT method,
              COALESCE(SUM(CASE WHEN kind='refund' THEN -amount ELSE amount END),0) AS amount,
              COUNT(*) AS count
       FROM payments WHERE status='confirmed' AND paid_at >= ? AND paid_at <= ?
       GROUP BY method ORDER BY amount DESC`
    )
    .all(from, to)

  const byGame = db
    .prepare(
      `SELECT COALESCE(o.game_name,'未指定') AS game_name,
              COUNT(*) AS order_count,
              COALESCE(SUM(o.total),0) AS order_total,
              COALESCE(SUM(o.total - o.platform_fee - o.cost),0) AS profit
       FROM orders o WHERE o.ordered_at >= ? AND o.ordered_at <= ? AND o.status <> 'cancelled'
       GROUP BY game_name ORDER BY order_total DESC`
    )
    .all(`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`)

  const daily = db
    .prepare(
      `WITH days(d) AS (
         SELECT date(?, '+1 day', '-' || n || ' day') FROM (
           WITH RECURSIVE c(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM c WHERE n < 400)
           SELECT n FROM c
         )
       )
       SELECT days.d AS date,
         (SELECT COALESCE(SUM(total),0) FROM orders o WHERE date(o.ordered_at,'localtime') = days.d AND o.status <> 'cancelled') AS ordered,
         (SELECT COALESCE(SUM(CASE WHEN p.kind='refund' THEN -p.amount ELSE p.amount END),0) FROM payments p WHERE p.status='confirmed' AND p.paid_at = days.d) AS received
       FROM days WHERE days.d >= ? AND days.d <= ? ORDER BY days.d`
    )
    .all(`${to}T00:00:00.000Z`, from, to)

  const receivables = db
    .prepare(
      `SELECT o.id, o.order_no, o.title, o.customer_name, o.status, o.total, o.ordered_at,
              COALESCE((SELECT SUM(CASE WHEN p.kind='refund' THEN -p.amount ELSE p.amount END) FROM payments p WHERE p.order_id=o.id AND p.status='confirmed'),0) AS paid_total
       FROM orders o
       WHERE o.status NOT IN ('cancelled')
       ORDER BY o.ordered_at DESC`
    )
    .all()
    .map((r) => ({ ...r, status_label: STATUS_LABEL[r.status] || r.status, due_total: money(num(r.total) - money(r.paid_total)) }))
    .filter((r) => r.due_total > 0.001)

  return {
    range: { from, to },
    totals: {
      order_count: totals.order_count,
      order_total: money(totals.order_total),
      received: grossReceived,
      refunded,
      net_received: received,
      due_total: money(totals.order_total - received),
      platform_fee: money(totals.platform_fee),
      cost: money(totals.cost),
      discount: money(totals.discount),
      profit: money(num(totals.order_total) - num(totals.platform_fee) - num(totals.cost)),
    },
    by_method: byMethod,
    by_game: byGame,
    daily,
    receivables,
  }
}

/* ---------------- 注册 ---------------- */

export function register() {
  /* ===== 初始化 / 登录 ===== */
  get('/api/auth/me', (ctx) => ({
    setup: isSetUp(),
    authenticated: Boolean(ctx.session),
    actor: ctx.session ? actorName() : '',
    settings: ctx.session ? readSettings() : {},
    vault: ctx.session ? vaultStatus() : { configured: false, unlocked: false },
    // 代码更新了但程序没重启：前端会是新的、后端还是旧的，新字段存不进去。
    // 前端拿到这个标记就挂一条提示，别让人对着「填了没反应」猜。
    stale: needsRestart(),
  }))

  post('/api/setup', (ctx) => {
    if (isSetUp()) fail(409, '已经初始化过了', 'already_setup')
    assertNotThrottled('setup', ctx.ip)
    const password = String(ctx.body.password ?? '')
    const confirm = String(ctx.body.confirm ?? '')
    if (password !== confirm) bad('两次输入的密码不一致', 'password_mismatch')
    try {
      setPassword(password)
    } catch (err) {
      noteFailure('setup', ctx.ip)
      throw err
    }
    setSetting('business_name', clampStr(ctx.body.business_name, 60) || '我的代肝小铺')
    setSetting('admin_name', clampStr(ctx.body.admin_name, 40) || '老板')
    setSetting('quote_valid_days', String(int(ctx.body.quote_valid_days, 7)))
    const vaultPassword = String(ctx.body.vault_password ?? '')
    if (vaultPassword) {
      try {
        configure(vaultPassword)
      } catch (err) {
        // 保险箱密码不合规不该让整个初始化失败，退回未配置状态
        lock('setup_failed')
      }
    }
    clearFailures('setup', ctx.ip)
    const { token, expiresAt } = createSession(ctx.ip, ctx.ua)
    ctx.setSessionCookie(token, expiresAt)
    return { ok: true, setup: true, vault: vaultStatus() }
  })

  post('/api/auth/login', (ctx) => {
    if (!isSetUp()) fail(409, '还没有初始化，请先设置登录密码', 'not_setup')
    assertNotThrottled('login', ctx.ip)
    if (!verifyPassword(String(ctx.body.password ?? ''))) {
      noteFailure('login', ctx.ip)
      bad('密码不对', 'bad_password')
    }
    clearFailures('login', ctx.ip)
    const { token, expiresAt } = createSession(ctx.ip, ctx.ua)
    ctx.setSessionCookie(token, expiresAt)
    return { ok: true }
  })

  post('/api/auth/logout', (ctx) => {
    destroySession(ctx.token)
    lock('logout')
    ctx.clearSessionCookie()
    return { ok: true }
  })

  post('/api/auth/password', (ctx) => {
    if (!verifyPassword(String(ctx.body.current ?? ''))) bad('当前密码不对', 'bad_password')
    const next = String(ctx.body.next ?? '')
    if (next !== String(ctx.body.confirm ?? '')) bad('两次输入的新密码不一致', 'password_mismatch')
    setPassword(next)
    destroyAllSessions()
    const { token, expiresAt } = createSession(ctx.ip, ctx.ua)
    ctx.setSessionCookie(token, expiresAt)
    return { ok: true, note: '其他设备上的登录已全部退出' }
  })

  /* ===== 看板 / 财务 ===== */
  get('/api/dashboard', () => buildDashboard())
  get('/api/finance/summary', (ctx) => {
    const to = clampStr(ctx.query.to, 10) || localDate()
    const from = clampStr(ctx.query.from, 10) || `${localMonth()}-01`
    return buildFinance(from, to)
  })

  /* ===== ERPNext 兼容层 ===== */
  get('/api/integrations/erpnext/status', () => erpNextStatus())
  get('/api/integrations/erpnext/scope', () => erpNextScopeSummary())
  get('/api/integrations/erpnext/preview', () => buildERPNextPreview())
  // 只读迁移包：包含客户、目录、报价、订单和收款草稿，不向 ERPNext 写入。
  get('/api/integrations/erpnext/bundle', () => buildERPNextBundle())
  // 只读远程预检：确认目标 ERPNext 的 DocType、基础数据和自定义字段是否齐全。
  get('/api/integrations/erpnext/preflight', async () => {
    try {
      return await preflightERPNext()
    } catch (err) {
      if (err instanceof ERPNextError) fail(err.status, err.message, err.code)
      throw err
    }
  })
  post('/api/integrations/erpnext/sync/master', async (ctx) => {
    try {
      return await syncERPNextMaster(
        { mode: ctx.body?.mode || 'dry-run', confirm: ctx.body?.confirm || '' },
        buildERPNextBundle()
      )
    } catch (err) {
      if (err instanceof ERPNextError) fail(err.status, err.message, err.code)
      throw err
    }
  })
  post('/api/integrations/erpnext/sync/transactions', async (ctx) => {
    try {
      return await syncERPNextTransactions(
        { scope: ctx.body?.scope || 'all', mode: ctx.body?.mode || 'dry-run', confirm: ctx.body?.confirm || '' },
        buildERPNextBundle()
      )
    } catch (err) {
      if (err instanceof ERPNextError) fail(err.status, err.message, err.code)
      throw err
    }
  })
  get('/api/integrations/erpnext/reconcile', async (ctx) => {
    try {
      return await reconcileERPNext({ scope: ctx.query.scope || 'all' }, buildERPNextBundle())
    } catch (err) {
      if (err instanceof ERPNextError) fail(err.status, err.message, err.code)
      throw err
    }
  })
  post('/api/integrations/erpnext/test', async () => {
    try {
      return await testERPNext()
    } catch (err) {
      if (err instanceof ERPNextError) fail(err.status, err.message, err.code)
      throw err
    }
  })
  // 本地 Outbox 只读查看与重试标记；这里不会触发远程 ERPNext 写入。
  get('/api/integrations/erpnext/outbox', (ctx) => ({
    items: listOutbox({ status: clampStr(ctx.query.status, 20), limit: int(ctx.query.limit, 200) }),
  }))
  get('/api/integrations/erpnext/outbox/summary', () => outboxSummary())
  get('/api/integrations/erpnext/outbox/plan', () => buildERPNextOutboxPlan())
  post('/api/integrations/erpnext/outbox/retry', (ctx) => ({
    ok: true,
    retried: retryOutbox(ctx.body?.id),
    summary: outboxSummary(),
  }))
  post('/api/integrations/erpnext/outbox/sync', async (ctx) => {
    try {
      return await syncERPNextOutbox({ mode: ctx.body?.mode || 'plan', confirm: ctx.body?.confirm || '' })
    } catch (err) {
      if (err instanceof ERPNextError) fail(err.status, err.message, err.code)
      throw err
    }
  })

  /* ===== 设置 ===== */
  get('/api/settings', () => readSettings())
  patch('/api/settings', (ctx) => {
    const values = Object.fromEntries(
      Object.entries(ctx.body || {})
        .filter(([key]) => SETTING_KEYS.includes(key))
        .map(([key, value]) => [key, clampStr(value, 500)])
    )
    return updateSettings(values)
  })

  /* ===== 上传（游戏图标 / 进度截图） ===== */
  post('/api/uploads', (ctx) => {
    const { name, buf } = saveDataURL(ctx.body.data_url, clampStr(ctx.body.prefix, 20) || 'img')
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf)
    return { url: `/uploads/${name}`, bytes: buf.length }
  })

  /**
   * 认截图：把游戏截图里的资源数字抠出来（星声 / 体力 / 贝币）。
   * 顺序是「先找图标（不认坐标、不认分辨率）→ 再由图标推出数字块 → 配 OCR 文本」。
   * 引擎会自动挑这台机器上最好的那个（Umi-OCR → RapidOCR → Windows 自带）。
   * 认出来的只是「猜」，前端会让人核对后再填，不直接写库。
   */
  post('/api/ocr', async (ctx) => {
    if (!ocrAvailable()) fail(400, '这台机器上没有可用的 OCR（Windows 自带引擎或本地 OCR 程序，二者有一即可）', 'no_ocr')
    const { name, buf } = saveDataURL(ctx.body.data_url, 'ocr', { maxBytes: MAX_OCR_IMAGE_BYTES })
    const ext = /\.(jpe?g|webp)$/i.test(name) ? path.extname(name) : '.png'
    const tmp = path.join(os.tmpdir(), `xfc-ocr-src-${process.pid}-${Date.now()}${ext}`)
    fs.writeFileSync(tmp, buf)
    try {
      const r = await recognizeImageFile(tmp, { lang: clampStr(ctx.body.lang, 20) || 'zh-Hans-CN' })
      if (!r.ok) fail(400, r.error || '识别失败', 'ocr_failed')
      return {
        resources: r.resources,
        hits: r.hits,
        seen: r.seen,
        anchor: r.anchor,
        pixel: r.pixel !== false,
        warning: r.warning || '',
        lines: r.lines,
        size: r.size,
        engine: r.engine,
        ms: r.ms,
        word_count: (r.candidates || []).length,
        template: templateStatus(),
      }
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* 清不掉就算了，临时目录里的东西 */
      }
    }
  })
  // 截图识别要收整张图，单独放宽请求体上限（其它接口维持默认）
  setBodyLimit('/api/ocr', MAX_OCR_IMAGE_BYTES)
  setBodyLimit('/api/uploads', MAX_OCR_IMAGE_BYTES)

  /**
   * 这台机器能不能用截图识别 + 现在用的是哪个引擎。
   * `?probe=1` 会真的发一次请求去探 Umi-OCR（用户刚装完引擎时点「重新检测」用）。
   */
  get('/api/ocr/status', async (ctx) => {
    const probe = String(ctx.query.probe || '') === '1'
    const st = probe ? await probeEngines({ force: true }) : ocrStatus()
    return { ...st, screen: process.platform === 'win32', templates: templateStatus(), resources: SCREEN_RESOURCES, min_score: MIN_SCORE }
  })

  /**
   * 认当前屏幕并**投票**：同一 id 连续调用，同一个数字要认到 `min_votes` 次（默认 2）才采纳。
   * 这是「数量要准确」的落点：认一次就写进去的旧行为没有了。
   * 返回里 agreed 是过了票的、pending 是还在核对的，前端两种都要显示。
   */
  post('/api/ocr/screen', async (ctx) => {
    if (!ocrAvailable()) fail(400, '这台机器上用不了屏幕识别（需要有可用的 OCR）', 'no_screen')
    const r = await recognizeScreenOnce({
      id: clampStr(ctx.body.session, 40) || 'default',
      minVotes: Math.max(1, Math.min(6, int(ctx.body.min_votes, 2) || 2)),
      minScore: num(ctx.body.min_score, MIN_SCORE) || MIN_SCORE,
    })
    if (!r.ok) fail(400, r.error || '识别失败', 'screen_failed')
    return {
      resources: r.resources,
      agreed: r.agreed,
      pending: r.pending,
      votes: r.votes,
      hits: r.hits,
      seen: r.seen,
      frames: r.frames,
      size: r.size,
      engine: r.engine,
      ms: r.ms,
      want: SCREEN_RESOURCES,
      min_votes: Math.max(1, Math.min(6, int(ctx.body.min_votes, 2) || 2)),
    }
  })

  /* ===== OCR 引擎安装选项（设置页「安装选项」那一块） ===== */

  /**
   * 安装选项清单：还没装的引擎各自能给什么、怎么装、能不能自动装。
   * 顺带把解压器状态带出去（自动安装要靠它解 .7z）。
   */
  get('/api/ocr/install', async () => {
    const r = await installOptions()
    return { ...r, extractor: extractorStatus(), engines: ocrEngines().engines }
  })

  /** 开始自动安装（后台跑，立刻返回 job；进度轮询下面那个接口） */
  post('/api/ocr/install', async (ctx) => {
    const id = clampStr(ctx.body.engine, 20)
    if (!INSTALL_SPECS[id]) fail(400, `不认识的引擎：${id}`, 'bad_engine')
    const r = await installEngine(id)
    if (!r.ok) fail(400, r.error, 'install_failed')
    return r
  })

  /** 查安装进度 */
  get('/api/ocr/install/status', (ctx) => {
    const r = installStatus(clampStr(ctx.query.job, 60))
    if (!r.ok) fail(404, r.error, 'no_job')
    return r
  })

  /** 环境自检：这个引擎的可执行文件到底跑不跑得起来 */
  post('/api/ocr/install/health', (ctx) => {
    const id = clampStr(ctx.body.engine, 20)
    if (!INSTALL_SPECS[id]) fail(400, `不认识的引擎：${id}`, 'bad_engine')
    return engineHealth(id)
  })

  /** 装完之后可以只重新探测，不用整页刷新 */
  get('/api/ocr/install/release', (ctx) => {
    const id = clampStr(ctx.query.engine, 20)
    const spec = INSTALL_SPECS[id]
    if (!spec) fail(400, `不认识的引擎：${id}`, 'bad_engine')
    return { engine: id, name: spec.name, page: releasePage(spec), license: spec.license, size: spec.size, note: spec.note }
  })

  /** 清掉一次「看屏幕」的投票记录（换了一张单、或者用户点了重来） */
  post('/api/ocr/screen/reset', (ctx) => resetVotes(clampStr(ctx.body.session, 40) || 'default'))

  /**
   * 图标模板：列出现用的、上传一个自己抠的。
   * 换了游戏版本、图标美术变了，用户可以自己截一张顶栏图上传，
   * 程序在给定的小矩形里现场抠出图标本体存成模板（存 data/resource-icons，不动程序自带的）。
   */
  get('/api/ocr/icons', () => ({ templates: templateStatus(), resources: SCREEN_RESOURCES }))

  post('/api/ocr/icons', (ctx) => {
    const key = clampStr(ctx.body.key, 20)
    const file = TEMPLATE_FILE[key]
    if (!file || !SCREEN_RESOURCES.includes(key)) fail(400, `只支持这几种资源：${SCREEN_RESOURCES.join(' / ')}`, 'bad_key')
    const box = ctx.body.box || {}
    const boxNum = (v, d) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.round(n) : d
    }
    const region = { x: boxNum(box.x, 0), y: boxNum(box.y, 0), w: Math.max(8, boxNum(box.w, 120)), h: Math.max(8, boxNum(box.h, 60)) }
    const { name, buf } = saveDataURL(ctx.body.data_url, 'icon', { maxBytes: MAX_OCR_IMAGE_BYTES })
    const tmp = path.join(os.tmpdir(), `xfc-icon-src-${process.pid}-${Date.now()}.png`)
    fs.writeFileSync(tmp, buf)
    try {
      let img
      try {
        img = decodePNG(buf)
      } catch (err) {
        fail(400, `这张图读不了（要 PNG）：${err.message}`, 'bad_image')
      }
      if (region.x + region.w > img.width || region.y + region.h > img.height) {
        fail(400, `抠图区域超出了图片范围（图是 ${img.width}×${img.height}）`, 'bad_box')
      }
      const picked = extractIconTemplate(img, region)
      if (!picked) fail(400, '这个区域里没找到够亮的图标，把区域对准图标本体再试一次', 'empty_box')
      const dir = path.resolve(ROOT, 'data', 'resource-icons')
      fs.mkdirSync(dir, { recursive: true })
      const out = path.join(dir, `${file}.png`)
      fs.writeFileSync(out, encodePNG(picked.img))
      loadTemplates({ force: true })
      return { ok: true, key, file: out, box: picked.box, size: [picked.img.width, picked.img.height], from: name, templates: templateStatus() }
    } finally {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* 清不掉就算了 */
      }
    }
  })

  /* ===== 全局搜索 ===== */
  get('/api/search', (ctx) => {    const q = clampStr(ctx.query.q, 80).trim()
    if (q.length < 1) return { customers: [], orders: [], services: [], games: [], credentials: [] }
    const like = `%${q.replace(/[%_\\]/g, (m) => '\\' + m)}%`
    return {
      customers: db
        .prepare("SELECT id, name, phone, wechat, qq FROM customers WHERE name LIKE ? ESCAPE '\\' OR phone LIKE ? ESCAPE '\\' OR wechat LIKE ? ESCAPE '\\' OR qq LIKE ? ESCAPE '\\' LIMIT 8")
        .all(like, like, like, like),
      orders: db
        .prepare("SELECT id, order_no, title, status, total, customer_name FROM orders WHERE order_no LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 8")
        .all(like, like, like)
        .map((r) => ({ ...r, status_label: STATUS_LABEL[r.status] || r.status })),
      services: db
        .prepare("SELECT id, name, base_price, price_type, unit_label, status FROM services WHERE name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' LIMIT 8")
        .all(like, like),
      games: db.prepare("SELECT id, name, short_name, status FROM games WHERE name LIKE ? ESCAPE '\\' OR short_name LIKE ? ESCAPE '\\' LIMIT 6").all(like, like),
      credentials: db
        .prepare("SELECT id, customer_id, label, masked_hint, server FROM credentials WHERE label LIKE ? ESCAPE '\\' OR masked_hint LIKE ? ESCAPE '\\' OR server LIKE ? ESCAPE '\\' OR role_name LIKE ? ESCAPE '\\' LIMIT 8")
        .all(like, like, like, like),
    }
  })

  /* ===== 可选 restic 加密增量备份 ===== */
  get('/api/backup/restic/status', () => resticStatus())
  get('/api/backup/restic/snapshots', async () => {
    try {
      return await listResticSnapshots()
    } catch (err) {
      if (err instanceof ERPNextError) fail(err.status, err.message, err.code)
      throw err
    }
  })
  post('/api/backup/restic/backup', async (ctx) => {
    if (ctx.body?.confirm !== 'BACKUP') bad('创建 restic 备份需要 confirm=BACKUP', 'need_confirm')
    try {
      return await createResticBackup()
    } catch (err) {
      if (err instanceof ERPNextError) fail(err.status, err.message, err.code)
      throw err
    }
  })

  /* ===== JSON 备份 ===== */
  const BACKUP_TABLES = [
    'settings',
    'games',
    'service_categories',
    'services',
    'service_tiers',
    'service_options',
    'customers',
    'credentials',
    'orders',
    'order_items',
    'order_progress',
    'payments',
    'quotes',
    'vault_audit',
    'integration_outbox',
  ]

  get('/api/backup/export', () => {
    const data = {}
    for (const t of BACKUP_TABLES) data[t] = db.prepare(`SELECT * FROM ${t}`).all()
    return {
      app: 'daigan-ops-console',
      version: 1,
      exported_at: nowISO(),
      counts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
      note: '这个文件包含全部业务数据。游戏登录凭证是密文，只能用同一套保险箱密码解开。',
      data,
    }
  })

  post('/api/backup/import', (ctx) => {
    const payload = ctx.body?.payload && typeof ctx.body.payload === 'object' ? ctx.body.payload : ctx.body
    if (!payload || payload.app !== 'daigan-ops-console' || !payload.data) bad('这不是本后台导出的备份文件', 'bad_backup')
    if (ctx.body?.confirm !== 'REPLACE') bad('导入会覆盖现有全部数据，需要确认', 'need_confirm')
    const data = payload.data
    transaction(() => {
      for (const t of [...BACKUP_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run()
      for (const t of BACKUP_TABLES) {
        const rows = Array.isArray(data[t]) ? data[t] : []
        for (const row of rows) {
          const cols = Object.keys(row)
          if (!cols.length) continue
          db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((c) => row[c]))
        }
      }
    })
    lock('imported')
    destroyAllSessions()
    ctx.clearSessionCookie()
    return { ok: true, imported: Object.fromEntries(BACKUP_TABLES.map((t) => [t, (data[t] || []).length])), note: '所有设备需要重新登录' }
  })

  get('/api/backup/counts', () => {
    const out = {}
    for (const t of BACKUP_TABLES) out[t] = db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c
    return out
  })

  /* ===== 清空业务数据（保留登录与保险箱设置） ===== */
  post('/api/system/reset', (ctx) => {
    if (ctx.body?.confirm !== 'CLEAR') bad('需要确认才可清空', 'need_confirm')
    const tables = ['integration_outbox', 'orders', 'order_items', 'order_progress', 'payments', 'quotes', 'credentials', 'customers', 'services', 'service_tiers', 'service_options', 'service_categories', 'games', 'vault_audit']
    transaction(() => {
      for (const t of tables) db.prepare(`DELETE FROM ${t}`).run()
    })
    return { ok: true, cleared: tables.length }
  })
}
