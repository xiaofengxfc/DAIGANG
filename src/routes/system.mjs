import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { db, setSetting, stamp, nextSerialNo } from '../db.mjs'
import { get, post, patch, del, saveDataURL, setBodyLimit } from '../http.mjs'
import { UPLOAD_DIR, needsRestart, ROOT, MAX_OCR_IMAGE_BYTES } from '../config.mjs'
import { bad, notFound, fail, int, num, money, clampStr, nowISO, localDate, localMonth, bizDate, parseJSON, scratchFile } from '../util.mjs'
import { ocrImage, extractResources, probeEnginesStatus, ensureEnginesProbed, ocrEngines } from '../ocr.mjs'
import { ensureVisionStarted, probeVisionHealth, resetVisionBlock, stopVisionSidecar, visionBackendStatus, visionHealthCheck, visionLogTail, visionOcrCrop } from '../vision-python.mjs'
import { startVisionDependencyInstall, visionDependencyInstallStatus, visionDependencyStatus } from '../vision-deps.mjs'
import { installOptions, installEngine, installStatus, extractorStatus, releasePage, INSTALL_SPECS, engineHealth, cleanupTmp } from '../ocr-install.mjs'
import { recognizeScreenOnce, recognizeImageFile, resetVotes, screenAvailable, templateStatus, loadTemplates, extractIconTemplate, screenResourcesFor, templateFileFor, SCREEN_RESOURCES, MIN_SCORE, probeIcons } from '../screen.mjs'
import { takeFrame } from '../screen-stash.mjs'
import { profileForGame } from '../../shared/game-profiles.js'
import { focusGameWindow, returnToPreviousWindow, sendGameKey } from '../game-window.mjs'
import { captureGameFrame } from '../game-shot.mjs'
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
import { streamArchive, archiveFilename } from '../backup-archive.mjs'
import { readSettings, updateSettings, SETTING_KEYS } from '../modules/settings/settings-service.mjs'
import { transaction } from '../infrastructure/sqlite/transaction.mjs'

/* ---------------- 看板 ---------------- */

/**
 * 前端只想让识别找「这一屏真会有的那几个资源」（异环背包页三个、地图页两个）。
 * 传进来的 key 必须先在**这个游戏**的模板表里对得上才算数：不能让请求体
 * 塞任意字符串，更不能让它把别的游戏的图标拉进来一起找。
 * 传空/不传 = 老行为（整份模板表都找）。
 */
function screenKeysWanted(game, raw) {
  if (!Array.isArray(raw)) return null
  const allowed = new Set(loadTemplates({ profile: profileForGame(game) }).map((r) => r.key))
  const keys = [...new Set(raw.map((k) => clampStr(k, 40)).filter((k) => k && allowed.has(k)))]
  return keys.length ? keys : null
}

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
      media_pending: db.prepare("SELECT COUNT(*) AS c FROM media_tasks WHERE status IN ('queued','scheduled','publishing')").get().c,
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
   * 认截图：把游戏截图里的资源数字抠出来。
   * **认哪几个资源由 `game` 决定**（前端传的是订单上选的游戏）：
   * 鸣潮是星声/体力/贝币，异环是甲硬币/方斯/环石/都市活力/体力。
   * 顺序是「先找图标（不认坐标、不认分辨率）→ 再由图标推出数字块 → 配 OCR 文本」。
   * 引擎会自动挑这台机器上最好的那个（Umi-OCR → RapidOCR → Windows 自带）。
   * 认出来的只是「猜」，前端会让人核对后再填，不直接写库。
   */
  post('/api/ocr', async (ctx) => {
    // 识别前先把引擎状态探一次：不然 Umi-OCR 明明开着也轮不到它（见 /api/ocr/status 的注释）
    const st = await ensureEnginesProbed()
    if (!st.available) fail(400, '这台机器上没有可用的 OCR（Windows 自带引擎或本地 OCR 程序，二者有一即可）', 'no_ocr')
    const game = clampStr(ctx.body.game, 40)
    const { name, buf } = saveDataURL(ctx.body.data_url, 'ocr', { maxBytes: MAX_OCR_IMAGE_BYTES })
    const ext = /\.(jpe?g|webp)$/i.test(name) ? path.extname(name) : '.png'
    // 这张图要喂给 OCR 引擎（可能是外部 exe），所以走 ascii 档
    const tmp = scratchFile(`xfc-ocr-src-${process.pid}-${Date.now()}`, ext, { mode: 'ascii' })
    fs.writeFileSync(tmp, buf)
    try {
      const r = await recognizeImageFile(tmp, {
        lang: clampStr(ctx.body.lang, 20) || 'zh-Hans-CN',
        game,
        // 「识别截图」也能说是哪个界面（前端目前不传，传了就能复用对的那次定标）
        stage: clampStr(ctx.body.stage, 20),
        keys: screenKeysWanted(game, ctx.body.keys),
      })
      if (!r.ok) fail(400, r.error || '识别失败', 'ocr_failed')
      /**
       * 体检模式（?deep=1）：除了识别结果，再把**每个**图标模板在这张图顶栏上的
       * 最好分数报出来，不管过没过阈值。
       *
       * 为什么需要：识别失败时用户只看到「还差体力」，但这句话背后可能是
       * 「模板根本对不上」「对得上但差一点没阈值」「找到了但数字没取到」三种
       * 完全不同的毛病，光看那句提示没法区分。把分数摆出来，用户（和我）才能
       * 知道该换模板、调阈值，还是根本没救。
       */
      let iconProbe = null
      if (String(ctx.query.deep || '') === '1') {
        try {
          const png = decodePNG(buf)
          iconProbe = probeIcons(png, { profile: profileForGame(game), keys: screenKeysWanted(game, ctx.body.keys) })
        } catch (err) {
          iconProbe = { error: `这张图解不了像素，体检做不了：${err.message}` }
        }
      }
      return {
        game: r.game,
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
        // 只在 ?deep=1 时有值；默认不带，免得每次识别都白花几百毫秒
        icon_probe: iconProbe,
        word_count: (r.candidates || []).length,
        template: templateStatus(game),
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
    // probe=1 是用户点了「重新检测」，强制真探一次。
    // 不 probe 也要保证「Umi-OCR 在不在」是刚探过的：ocrEngines() 是同步的，
    // 冷启动时它一律说 Umi-OCR 未安装 —— 于是设置页上半截说「未安装」、
    // 下半截「安装选项」（真探过）说「已装好」，同一屏上打架；识别也永远
    // 轮不到 Umi-OCR。ensureEnginesProbed 带 TTL 缓存，不会每次都白等。
    const st = probe ? await probeEnginesStatus({ force: true }) : await ensureEnginesProbed()
    // 顺手把 Python 视觉进程拉起来（不 await）：它在后台载模型 + 预热要 5 秒左右，
    // 等用户真点「识别画面」的时候就已经热了。没装依赖就什么都不做，
    // 状态页会告诉他去哪儿装。
    if (!st.backend?.online && st.backend?.deps_ready !== false) void ensureVisionStarted().catch(() => {})
    // 资源表跟着 `?game=` 走：前端要按订单的游戏显示该记哪几个
    const game = clampStr(ctx.query.game, 40)
    return { ...st, screen: process.platform === 'win32', templates: templateStatus(game), resources: screenResourcesFor(game), min_score: MIN_SCORE }
  })

  /**
   * 用户点击「识别画面」后，把**这一单那个游戏**的窗口切到前台；后续截屏会裁取这个窗口。
   * game 传订单上的游戏名：鸣潮和异环的窗口特征不一样，切错了后面全认错。
   */
  post('/api/ocr/screen/focus', async (ctx) => {
    const game = clampStr(ctx.body?.game, 40)
    const r = await focusGameWindow({ game })
    if (!r.ok) fail(400, r.error || '没有切换到游戏窗口', 'game_focus_failed')
    return r
  })

  /** 流程只用 B / M 打开对应界面，再用 ESC 返回；后端也限制为这三个按键。 */
  post('/api/ocr/screen/key', async (ctx) => {
    const key = clampStr(ctx.body.key, 4).toUpperCase()
    if (!['B', 'M', 'ESC'].includes(key)) fail(400, '只允许发送 B、M 或 ESC。', 'bad_game_key')
    const r = await sendGameKey(key)
    if (!r.ok) fail(400, r.error || '没有向鸣潮发送按键', 'game_key_failed')
    return r
  })

  /**
   * 认完之后把前台还给「切到游戏之前那个窗口」——也就是用户点「识别画面」的浏览器。
   * 窗口句柄是 focus 那一步顺手记下来的，这里不需要任何参数；没有可返回的窗口时
   * 直接 ok（不算失败），因为这不是流程的必要环节。
   */
  post('/api/ocr/screen/return', async () => {
    const r = await returnToPreviousWindow()
    if (!r.ok) fail(400, r.error || '没有切回原来的窗口', 'screen_return_failed')
    return r
  })

  /**
   * 认当前屏幕并**投票**：同一 id 连续调用，同一个数字要认到 `min_votes` 次（默认 2）才采纳。
   * 这是「数量要准确」的落点：认一次就写进去的旧行为没有了。
   * 返回里 agreed 是过了票的、pending 是还在核对的，前端两种都要显示。
   */
  post('/api/ocr/screen', async (ctx) => {
    // 同上：看屏幕之前先探一次，别让首选引擎白白闲置
    const st = await ensureEnginesProbed()
    if (!st.available) fail(400, '这台机器上用不了屏幕识别（需要有可用的 OCR）', 'no_screen')
    const game = clampStr(ctx.body.game, 40)
    const r = await recognizeScreenOnce({
      id: clampStr(ctx.body.session, 40) || 'default',
      game,
      stage: clampStr(ctx.body.stage, 20),
      keys: screenKeysWanted(game, ctx.body.keys),
      minVotes: Math.max(1, Math.min(6, int(ctx.body.min_votes, 2) || 2)),
      minScore: num(ctx.body.min_score, MIN_SCORE) || MIN_SCORE,
    })
    if (!r.ok) fail(400, r.error || '识别失败', 'screen_failed')
    return {
      game: r.game,
      resources: r.resources,
      agreed: r.agreed,
      pending: r.pending,
      votes: r.votes,
      hits: r.hits,
      seen: r.seen,
      // 和 /api/ocr 那条一样把锚点带出来：调识别的时候，「锚点定在哪、多少分」
      // 是判断「为什么这个数没认到」的第一手信息。
      anchor: r.anchor,
      frames: r.frames,
      size: r.size,
      engine: r.engine,
      ms: r.ms,
      // 这一帧暂存的凭据：前端拿着它在保存进度时取回原图（见 /api/ocr/screen/frame）
      frame_token: r.frame_token || null,
      want: screenResourcesFor(game),
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

  /** 环境自检：这个引擎到底跑不跑得起来（Umi-OCR 是探它的本地 HTTP 服务） */
  post('/api/ocr/install/health', async (ctx) => {
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

  /**
   * 只截图、不识别：切到游戏 → 按 F2（游戏自带截图键）→ 抓一张画面 → 暂存。
   *
   * 和上面 /api/ocr/screen 的分工：那条是「打开界面读数字」，这条纯粹是
   * 「留一张图」。所以：
   *   · 不需要任何 OCR 引擎（截图跟认字没关系，没装引擎也能用）；
   *   · 不去碰游戏 UI（不按 B/M、不开背包），截到的就是用户当前那一屏；
   *   · 认数字那套完全不走，所以也不会因为「认不出来」而失败。
   *
   * 返回的 frame_token 交给前端：用户点「记下」时取回、压缩、挂到进度上，
   * 和识别画面留下的帧走同一条路（见 /api/ocr/screen/frame）。
   */
  post('/api/ocr/screen/shot', async (ctx) => {
    const key = (clampStr(ctx.body.key, 6).toUpperCase() || 'F2')
    if (!['F2', 'F12'].includes(key)) bad('只支持 F2 / F12 这两个截图键', 'bad_key')
    const r = await captureGameFrame({ game: clampStr(ctx.body.game, 40), key })
    if (!r.ok) fail(400, r.error || '没能截到游戏画面', 'shot_failed')
    return {
      frame_token: r.frame_token,
      bytes: r.bytes,
      key: r.key,
      window: r.window,
      warnings: r.warnings || [],
    }
  })

  /** 清掉一次「看屏幕」的投票记录（换了一张单、或者用户点了重来） */
  post('/api/ocr/screen/reset', (ctx) => resetVotes(clampStr(ctx.body.session, 40) || 'default'))

  /**
   * 取走识别时暂存的那一帧原始截图（见 src/screen-stash.mjs）。
   *
   * 给谁用：用户在进度表单上点保存时，前端把这一阶段最终采纳的那一帧取回来，
   * 在浏览器里压缩（browser-image-compression，压到 1MB 以内）再上传到
   * /api/uploads，最后挂到这条进度的 media 上 —— 于是时间线上就能看到、
   * 也能随时下载。
   *
   * 为什么不在识别时就存进 uploads：识别一轮最多 6 帧，用户很可能看完就走，
   * 那样会留下永远没人引用的孤儿图片。暂存的帧**取走即删**，没取就过期。
   */
  get('/api/ocr/screen/frame', (ctx) => {
    const token = clampStr(ctx.query.token, 60)
    if (!token) bad('缺少 token', 'missing_token')
    const frame = takeFrame(token)
    if (!frame) fail(404, '这一帧已经过期或已被取走，请重新识别画面', 'frame_gone')
    ctx.res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': frame.buf.length,
      'Cache-Control': 'no-store',
      // 帧里有游戏画面，别让它进任何中间缓存
      'X-Content-Type-Options': 'nosniff',
    })
    ctx.res.end(frame.buf)
  })

  /* ============================================================
     Python 视觉后端（屏幕识别的 OCR 那一层）
     ============================================================

     它是**可选**的一层：装了更好（有置信度、能对小字裁出来放大再认），
     没装/起不来就往旧引擎链退（RapidOCR-json → Windows 自带 OCR），
     屏幕识别照样能用。所以这一组接口全是「查看状态 / 装 / 起 / 停 / 自检」，
     没有一个会挡住识别。
     ============================================================ */

  /**
   * 后端的完整状态：依赖、进程、模型、日志尾部。
   * `?probe=1` 强制重新探测依赖（用户刚点完「一键安装」时用）。
   */
  get('/api/ocr/backend', async (ctx) => {
    const probe = String(ctx.query.probe || '') === '1'
    const deps = visionDependencyStatus({ force: probe })
    const health = await probeVisionHealth({ timeoutMs: 2500, force: true })
    return {
      ...visionBackendStatus(),
      deps,
      install: deps.install,
      health: health.ok ? health.payload : null,
      health_error: health.ok ? '' : health.error,
      log_tail: visionLogTail(40),
      engines: ocrEngines().engines,
    }
  })

  /**
   * 一键装依赖：建 data/vision-venv → pip install -r requirements.txt。
   * 后台跑，立刻返回 job id（前端轮询进度）。
   */
  post('/api/ocr/backend/install', () => {
    const r = startVisionDependencyInstall()
    if (!r.ok) fail(400, r.error || '开始安装失败', r.code || 'install_failed')
    return r
  })

  get('/api/ocr/backend/install/status', (ctx) => visionDependencyInstallStatus(clampStr(ctx.query.job, 60)))

  /** 手动启动（正常情况下程序启动时就会自己起，这里给「起不来再试一次」用） */
  post('/api/ocr/backend/start', async () => {
    resetVisionBlock()
    // force：用户明确点了「启动」，那就无视 XFC_VISION_AUTOSTART=0
    const r = await ensureVisionStarted({ force: true })
    if (!r.ok) fail(400, r.error || '启动失败', 'vision_start_failed')
    return { ok: true, ...visionBackendStatus() }
  })

  post('/api/ocr/backend/stop', () => stopVisionSidecar())

  /** 自检：真认一张图 + 数字块 rec-only，不看「进程活着」就当能用 */
  post('/api/ocr/backend/health', async () => {
    const r = await visionHealthCheck()
    if (!r.ok) fail(400, r.error || '自检没通过', 'vision_health_failed')
    return r
  })

  /**
   * 图标模板：列出现用的、上传一个自己抠的。
   * 换了游戏版本、图标美术变了，用户可以自己截一张顶栏图上传，
   * 程序在给定的小矩形里现场抠出图标本体存成模板（存 data/resource-icons，不动程序自带的）。
   * **`game` 决定给哪一套模板**：两个游戏的「体力」是两张不同的图，不带游戏会存错地方。
   */
  get('/api/ocr/icons', (ctx) => {
    const game = clampStr(ctx.query.game, 40)
    return { game: profileForGame(game).id, templates: templateStatus(game), resources: screenResourcesFor(game) }
  })

  post('/api/ocr/icons', (ctx) => {
    const game = clampStr(ctx.body.game, 40)
    const keys = screenResourcesFor(game)
    const key = clampStr(ctx.body.key, 20)
    const file = templateFileFor(game, key)
    if (!file || !keys.includes(key)) fail(400, `只支持这几种资源：${keys.join(' / ')}`, 'bad_key')
    const box = ctx.body.box || {}
    const boxNum = (v, d) => {
      const n = Number(v)
      return Number.isFinite(n) ? Math.round(n) : d
    }
    const region = { x: boxNum(box.x, 0), y: boxNum(box.y, 0), w: Math.max(8, boxNum(box.w, 120)), h: Math.max(8, boxNum(box.h, 60)) }
    const { name, buf } = saveDataURL(ctx.body.data_url, 'icon', { maxBytes: MAX_OCR_IMAGE_BYTES })
    // 这张图只被我们自己的解码器读，中文路径无所谓 —— project 档
    const tmp = scratchFile(`xfc-icon-src-${process.pid}-${Date.now()}`, '.png')
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
      loadTemplates({ force: true, profile: profileForGame(game) })
      return { ok: true, key, game: profileForGame(game).id, file: out, box: picked.box, size: [picked.img.width, picked.img.height], from: name, templates: templateStatus(game) }
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
    'media_accounts',
    'media_materials',
    'media_tasks',
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

  /**
   * 整包备份：数据库快照 + 上传文件，打包成 .tar.gz 直接下载。
   *
   * 和上面 /api/backup/export 的分工：
   *   · export  → JSON，**只搬业务数据**，用来「导入」覆盖现有库；
   *   · archive → tar.gz，**连图片素材一起**，用来「整机还原」。
   * 截图现在会留在时间线上，图片成了业务数据的一部分，
   * 所以只导 JSON 已经不算完整备份了 —— 这就是这个接口存在的理由。
   *
   * 数据一致性：数据库不走文件拷贝（WAL 模式下正在写时拷出来可能是半旧的页），
   * 而是 db.serialize() 让 SQLite 自己给一份含 WAL 的一致性快照。
   */
  get('/api/backup/archive', async (ctx) => {
    let snapshot
    try {
      snapshot = db.serialize()
    } catch (err) {
      fail(500, `拿不到数据库快照：${err.message}`, 'snapshot_failed')
    }
    const { stream, tarBytes, uploads, skipped } = streamArchive({ dbSnapshot: snapshot })

    const filename = archiveFilename()
    // 中文文件名必须同时给 filename*（RFC 5987）：老写法的 filename= 只有 ASCII 能表达，
    // 浏览器拿到中文会变成乱码或被丢掉。
    ctx.res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="backup.tar.gz"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
      // 长度要压完才知道，所以不发 Content-Length，走 chunked
    })

    ctx.res.on('close', () => {
      // 用户中途取消下载：把流收掉，别让 gzip 还在往一个断掉的 socket 里写
      stream.destroy()
    })

    // 等到响应真的写完（'finish'）或者连接断了（'close'）才收工。
    // 只等 stream 的 'end' 是不够的：那只是 gzip 读完了 tar，字节还堆在 socket 缓冲里，
    // 这时候处理器返回就会去写 JSON —— 而那里写着「如果响应已结束就别再写」，
    // 于是要么抢写要么静默丢掉。等 'finish' 语义才对。
    // 'close' 也要resolve：客户端取消时 'finish' 不会来，只等它会把这次请求永远挂住。
    await new Promise((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve()
      }
      stream.on('error', (err) => {
        console.error('[backup] 归档流出错：', err.message)
        ctx.res.destroy()
        settle()
      })
      ctx.res.on('finish', settle)
      ctx.res.on('close', settle)
      // 挂监听之前就已经结束了的情况（客户端一发起就断开），上面两个事件不会再触发
      if (ctx.res.writableFinished || ctx.res.destroyed) settle()
      stream.pipe(ctx.res)
    })

    console.log(
      `  归档完成：tar ${tarBytes} 字节 · 上传件 ${uploads.length} 个` +
        (skipped.length ? ` · 跳过 ${skipped.length} 个（见归档内 README.txt）` : '')
    )
  })

  /* ===== 清空业务数据（保留登录与保险箱设置） ===== */
  post('/api/system/reset', (ctx) => {
    if (ctx.body?.confirm !== 'CLEAR') bad('需要确认才可清空', 'need_confirm')
    const tables = ['integration_outbox', 'media_tasks', 'media_materials', 'media_accounts', 'orders', 'order_items', 'order_progress', 'payments', 'quotes', 'credentials', 'customers', 'services', 'service_tiers', 'service_options', 'service_categories', 'games', 'vault_audit']
    transaction(() => {
      for (const t of tables) db.prepare(`DELETE FROM ${t}`).run()
    })
    return { ok: true, cleared: tables.length }
  })
}
