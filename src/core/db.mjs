import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { DB_FILE, DATA_DIR, UPLOAD_DIR, MEDIA_COOKIE_DIR } from './config.mjs'
import { localDate, makeNo } from './util.mjs'

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(UPLOAD_DIR, { recursive: true })
fs.mkdirSync(MEDIA_COOKIE_DIR, { recursive: true })

export const db = new DatabaseSync(DB_FILE)

db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')
db.exec('PRAGMA busy_timeout = 5000')

/**
 * 迁移按顺序执行，一次只前进不后退。
 * 加字段就往数组末尾追加一条，不要改历史条目。
 */
const MIGRATIONS = [
  // ---- v1 初始结构 ----
  `
  CREATE TABLE settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '',
    updated_at  TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE sessions (
    token        TEXT PRIMARY KEY,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    ip           TEXT DEFAULT '',
    ua           TEXT DEFAULT ''
  );
  CREATE INDEX idx_sessions_expires ON sessions (expires_at);

  CREATE TABLE games (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    short_name  TEXT NOT NULL DEFAULT '',
    icon        TEXT NOT NULL DEFAULT '',
    servers     TEXT NOT NULL DEFAULT '[]',
    status      TEXT NOT NULL DEFAULT 'active',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_games_status ON games (status, sort_order);

  CREATE TABLE service_categories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER REFERENCES games (id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    sort_order  INTEGER NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_categories_game ON service_categories (game_id, sort_order);

  CREATE TABLE services (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id   INTEGER REFERENCES service_categories (id) ON DELETE SET NULL,
    game_id       INTEGER REFERENCES games (id) ON DELETE SET NULL,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    price_type    TEXT NOT NULL DEFAULT 'fixed',
    unit_label    TEXT NOT NULL DEFAULT '',
    base_price    REAL NOT NULL DEFAULT 0,
    min_qty       REAL NOT NULL DEFAULT 1,
    max_qty       REAL,
    package_items TEXT NOT NULL DEFAULT '[]',
    status        TEXT NOT NULL DEFAULT 'active',
    sort_order    INTEGER NOT NULL DEFAULT 0,
    note          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX idx_services_cat ON services (category_id, sort_order);
  CREATE INDEX idx_services_game ON services (game_id, status);

  CREATE TABLE service_tiers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id  INTEGER NOT NULL REFERENCES services (id) ON DELETE CASCADE,
    min_qty     REAL NOT NULL DEFAULT 1,
    max_qty     REAL,
    unit_price  REAL NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_tiers_service ON service_tiers (service_id, sort_order);

  CREATE TABLE service_options (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id       INTEGER REFERENCES services (id) ON DELETE CASCADE,
    kind             TEXT NOT NULL DEFAULT 'addon',
    name             TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    price            REAL NOT NULL DEFAULT 0,
    price_mode       TEXT NOT NULL DEFAULT 'fixed',
    default_selected INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active',
    sort_order       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
  CREATE INDEX idx_options_service ON service_options (service_id, sort_order);

  CREATE TABLE customers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL DEFAULT '',
    wechat      TEXT NOT NULL DEFAULT '',
    qq          TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',
    note        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_customers_phone ON customers (phone);
  CREATE INDEX idx_customers_name ON customers (name);

  CREATE TABLE credentials (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id  INTEGER NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    game_id      INTEGER REFERENCES games (id) ON DELETE SET NULL,
    label        TEXT NOT NULL DEFAULT '',
    login_type   TEXT NOT NULL DEFAULT 'qrcode',
    server       TEXT NOT NULL DEFAULT '',
    role_name    TEXT NOT NULL DEFAULT '',
    masked_hint  TEXT NOT NULL DEFAULT '',
    payload_enc  TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'active',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX idx_credentials_customer ON credentials (customer_id, status);

  CREATE TABLE vault_audit (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    credential_id INTEGER,
    customer_id   INTEGER,
    action        TEXT NOT NULL,
    target        TEXT NOT NULL DEFAULT '',
    actor         TEXT NOT NULL DEFAULT '',
    ip            TEXT NOT NULL DEFAULT '',
    ua            TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL
  );
  CREATE INDEX idx_audit_created ON vault_audit (created_at DESC);

  CREATE TABLE orders (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no       TEXT NOT NULL UNIQUE,
    customer_id    INTEGER REFERENCES customers (id) ON DELETE SET NULL,
    game_id        INTEGER REFERENCES games (id) ON DELETE SET NULL,
    title          TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'pending_confirm',
    customer_name  TEXT NOT NULL DEFAULT '',
    game_name      TEXT NOT NULL DEFAULT '',
    items_subtotal REAL NOT NULL DEFAULT 0,
    addon_total    REAL NOT NULL DEFAULT 0,
    discount       REAL NOT NULL DEFAULT 0,
    total          REAL NOT NULL DEFAULT 0,
    platform_fee   REAL NOT NULL DEFAULT 0,
    cost           REAL NOT NULL DEFAULT 0,
    ordered_at     TEXT NOT NULL,
    due_at         TEXT,
    completed_at   TEXT,
    note           TEXT NOT NULL DEFAULT '',
    internal_note  TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE INDEX idx_orders_status ON orders (status, ordered_at DESC);
  CREATE INDEX idx_orders_customer ON orders (customer_id, ordered_at DESC);

  CREATE TABLE order_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id     INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    kind         TEXT NOT NULL DEFAULT 'service',
    ref_id       INTEGER,
    name         TEXT NOT NULL,
    spec         TEXT NOT NULL DEFAULT '',
    price_type   TEXT NOT NULL DEFAULT 'fixed',
    unit_label   TEXT NOT NULL DEFAULT '',
    unit_price   REAL NOT NULL DEFAULT 0,
    quantity     REAL NOT NULL DEFAULT 1,
    amount       REAL NOT NULL DEFAULT 0,
    snapshot     TEXT NOT NULL DEFAULT '{}',
    sort_order   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_order_items_order ON order_items (order_id, sort_order);

  CREATE TABLE order_progress (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id          INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
    happened_on       TEXT NOT NULL,
    content           TEXT NOT NULL,
    resources_before  TEXT NOT NULL DEFAULT '',
    resources_after   TEXT NOT NULL DEFAULT '',
    media             TEXT NOT NULL DEFAULT '[]',
    note              TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL
  );
  CREATE INDEX idx_progress_order ON order_progress (order_id, happened_on DESC);

  CREATE TABLE payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER REFERENCES orders (id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers (id) ON DELETE SET NULL,
    kind        TEXT NOT NULL DEFAULT 'deposit',
    amount      REAL NOT NULL DEFAULT 0,
    method      TEXT NOT NULL DEFAULT 'wechat',
    status      TEXT NOT NULL DEFAULT 'confirmed',
    paid_at     TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
  );
  CREATE INDEX idx_payments_order ON payments (order_id);
  CREATE INDEX idx_payments_paid ON payments (paid_at DESC);

  CREATE TABLE quotes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_no    TEXT NOT NULL UNIQUE,
    customer_id INTEGER REFERENCES customers (id) ON DELETE SET NULL,
    game_id     INTEGER REFERENCES games (id) ON DELETE SET NULL,
    title       TEXT NOT NULL DEFAULT '',
    items       TEXT NOT NULL DEFAULT '[]',
    total       REAL NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    valid_until TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX idx_quotes_created ON quotes (created_at DESC);
  `,

  // v2：客户头像
  `ALTER TABLE customers ADD COLUMN avatar TEXT NOT NULL DEFAULT '';`,

  // v3：包天/日体那种「今天做完了，明天还接着做」的单。
  // 存的是标记当天的日期，不是布尔值 —— 第二天日期对不上就自动回到「在做的」，
  // 不需要定时任务去重置。
  `ALTER TABLE orders ADD COLUMN daily_done_on TEXT;`,

  // v4：哪些大类是「每天都要做」的（日常、日体、包天…）。
  // 按名字先猜一遍，之后可以在价格表里自己改。
  `ALTER TABLE service_categories ADD COLUMN is_daily INTEGER NOT NULL DEFAULT 0;
   UPDATE service_categories
      SET is_daily = 1
    WHERE name LIKE '%日常%' OR name LIKE '%日体%' OR name LIKE '%包天%' OR name LIKE '%每日%';`,

  // v5：单个服务项也能单独指定「每天做」。
  // 留空(NULL) = 跟着它所在的大类走，所以以后往「日常」大类里加服务项不用再设一遍；
  // 1 / 0 = 在这个服务项上强制覆盖大类。
  `ALTER TABLE services ADD COLUMN is_daily INTEGER;`,

  // v6：游客留言板。
  //
  // 这一条**必须留在原位、不要删**：游客区那批代码回滚过一次，
  // 但线上库已经被盖成了 user_version = 6，guest_messages 表也已经建好。
  // 如果这里留空，新库跑完只有 5 条、老库停在 6，两边版本号就错开了，
  // 后面所有迁移在「老库」上会被整条跳过。
  // 用 IF NOT EXISTS 写，两边谁先谁后都不会炸。
  `
  CREATE TABLE IF NOT EXISTS guest_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname   TEXT NOT NULL DEFAULT '',
    contact    TEXT NOT NULL DEFAULT '',
    game_name  TEXT NOT NULL DEFAULT '',
    content    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'new',
    order_id   INTEGER REFERENCES orders (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_guest_messages_status ON guest_messages (status, created_at DESC);
  `,

  // v7：每个游戏的「对外提示」（界面上不写「公告」两个字）。
  // 和 note（自己看的备注）分开：提示是对外给客户看的，
  // 生成的价格表图片 / Word 文档会把它放在最上方。
  `ALTER TABLE games ADD COLUMN notice TEXT NOT NULL DEFAULT '';`,

  // v8：大类也能写一条对外提示，排在那个大类的名字下面、服务项上面。
  // 和 games.notice 是同一套做法，只是层级低一级。
  `ALTER TABLE service_categories ADD COLUMN notice TEXT NOT NULL DEFAULT '';`,

  // v9：游戏货币。
  // games.currency 是这个游戏里客户最认的那种货币的名字（原石 / 星声 / 纠缠之缘…），
  // services.currency_amount 是这个服务项能让客户拿到多少 ——
  // 一个游戏一种，留空表示这个游戏没配货币，服务项上那个数就不显示。
  `ALTER TABLE games ADD COLUMN currency TEXT NOT NULL DEFAULT '';
   ALTER TABLE services ADD COLUMN currency_amount REAL;`,

  // v10：ERPNext 本地变更队列。
  // 业务写入先落本地队列，ERPNext 离线、未配置或稍后切换时也不会丢变更。
  // 队列只保存来源表和 ID，不保存 credentials 等敏感字段。
  `
  CREATE TABLE integration_outbox (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    provider        TEXT NOT NULL DEFAULT 'erpnext',
    entity_type     TEXT NOT NULL,
    source_id       INTEGER NOT NULL,
    event_type      TEXT NOT NULL DEFAULT 'upsert',
    status          TEXT NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0,
    payload         TEXT NOT NULL DEFAULT '{}',
    last_error      TEXT NOT NULL DEFAULT '',
    next_attempt_at TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    processed_at    TEXT,
    UNIQUE(provider, entity_type, source_id)
  );
  CREATE INDEX idx_outbox_status ON integration_outbox (provider, status, next_attempt_at, id);
  CREATE INDEX idx_outbox_source ON integration_outbox (provider, entity_type, source_id);
  `,

  // v11：清理已经回滚、且当前代码完全不再使用的游客留言板遗留表。
  // v6 的历史迁移仍保留，避免老库版本号错乱；这里只删除当前确认为空的废弃表。
  `DROP TABLE IF EXISTS guest_messages;`,

  // v12：自媒体发布模块。素材文件落在 data/uploads/media，业务数据独立于订单域。
  `
  CREATE TABLE IF NOT EXISTS media_accounts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    platform     TEXT NOT NULL,
    account_name TEXT NOT NULL,
    profile_url  TEXT NOT NULL DEFAULT '',
    auth_state   TEXT NOT NULL DEFAULT 'pending',
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_accounts_platform ON media_accounts (platform, auth_state);

  CREATE TABLE IF NOT EXISTS media_materials (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT NOT NULL,
    file_path   TEXT NOT NULL,
    mime_type   TEXT NOT NULL DEFAULT 'application/octet-stream',
    file_size   INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_materials_created ON media_materials (created_at DESC);

  CREATE TABLE IF NOT EXISTS media_tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL DEFAULT '',
    topics       TEXT NOT NULL DEFAULT '[]',
    platform_keys TEXT NOT NULL DEFAULT '[]',
    account_ids  TEXT NOT NULL DEFAULT '[]',
    material_ids TEXT NOT NULL DEFAULT '[]',
    publish_at   TEXT,
    status       TEXT NOT NULL DEFAULT 'queued',
    result       TEXT NOT NULL DEFAULT '{}',
    error_msg    TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_media_tasks_status ON media_tasks (status, publish_at, id DESC);
  `,

  // v13：媒体账号的 Playwright storage_state 登录态路径。文件只存本机 data/media-cookies。
  `ALTER TABLE media_accounts ADD COLUMN cookie_path TEXT NOT NULL DEFAULT '';`,

  /**
   * v14：B站自动比价的扫描任务。
   *
   * 为什么落库而不是只放内存：一次扫描要下载+抽帧+OCR 好几分钟，结果里带着
   * 「哪个视频、哪一帧、认出了什么」这些证据。只放内存的话，进程一重启
   * （改了代码重启是常事）预览就没了，用户得重跑一遍才能接着确认。
   * result 存整个结果 JSON，字段还会随解析器迭代调整，不适合拆成列。
   */
  `
  CREATE TABLE IF NOT EXISTS price_scan_jobs (
    id         TEXT PRIMARY KEY,
    game_id    INTEGER REFERENCES games (id) ON DELETE SET NULL,
    game_name  TEXT NOT NULL DEFAULT '',
    keyword    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'running',
    stage      TEXT NOT NULL DEFAULT '',
    result     TEXT NOT NULL DEFAULT '{}',
    error_msg  TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_price_scan_jobs_created ON price_scan_jobs (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_price_scan_jobs_game ON price_scan_jobs (game_id, created_at DESC);
  `,

  /**
   * 每个视频的**原始识别结果**，用来避免重复扫描同一个视频。
   *
   * 扫一次一个视频要花十几秒（下载 → ffmpeg 抽帧 → 逐帧 OCR），而这几步的结果
   * 只取决于视频本身，跟游戏、库内服务项、AI 配置都无关。同一个关键词搜出来的
   * 视频高度重合，所以第二次扫的时候大半时间都白花了。
   *
   * 存的是 `visionOcr` 的原始 words（不是解析后的成品），这样：
   *   · 解析规则改了、库内服务项改了、AI 开关变了 —— 都会重新跑一遍，结果永远新鲜；
   *   · 只有「下载 / 抽帧 / OCR」这三步被跳过，而它们正是耗时的大头。
   * 8 KB 左右一个视频，很便宜。
   *
   * `version` 是失效开关：抽帧参数（间隔、上限）变了、或者识别引擎换了，
   * 老结果就不再等价，得重扫。
   */
  `
  CREATE TABLE IF NOT EXISTS bili_video_cache (
    bvid       TEXT PRIMARY KEY,
    version    TEXT NOT NULL DEFAULT '',
    ocr_frames INTEGER NOT NULL DEFAULT 0,
    frames     TEXT NOT NULL DEFAULT '[]',
    frames_dir TEXT NOT NULL DEFAULT '',
    at         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_bili_video_cache_at ON bili_video_cache (at DESC);
  `,

  /**
   * AI 甄别的结果也缓存起来。
   *
   * 加这一列是因为缓存了识别结果之后，**AI 成了新的耗时大头**：实测复用缓存的那次
   * 总共 40 秒，其中 AI 占 36 秒（下载和 OCR 只剩 0.9 秒）。既然做缓存是为了
   * 「不重复干活」，那这 36 秒也得省。
   *
   * 存的是**模型的原始回复**而不是加工后的判断，这样重放走的是完全相同的
   * 校验、改名、剔除逻辑 —— 缓存不会绕过任何一道安全闸。
   *
   * `ai_sig` 是「这份回复在什么前提下才作数」：模型名 + 库内服务名 + 解析版本。
   * 任何一样变了就重新问模型，所以库改了服务项、换了模型都会立刻生效。
   */
  `
  ALTER TABLE bili_video_cache ADD COLUMN ai_sig TEXT NOT NULL DEFAULT '';
  ALTER TABLE bili_video_cache ADD COLUMN ai_result TEXT NOT NULL DEFAULT '';
  `,

  /**
   * 服务项的「别名」—— 视频里是怎么写这一项的。
   *
   * 为什么需要它：新加一个游戏时库里没有服务项，比价必然 0 匹配。所以要让
   * **扫描结果能直接建成服务项**。但建的时候名字得由用户定（价格表上要好看），
   * 而视频里的写法往往完全不同：
   *
   *   用户建的名字：`挪德卡莱满探`
   *   视频里写的：  `挪德卡莱满探+前置任务+神瞳`
   *
   * 后者含 `+`，被判定成「打包价」，按规矩**只认同名服务项**（这是为了防止把
   * 一个打包价摊给单项）。所以光靠模糊匹配是匹不上的，得把视频原话记下来当别名。
   *
   * 一行一个，用换行分隔 —— 这样在界面上就是一个普通的文本框，能直接看、直接改。
   */
  `
  ALTER TABLE services ADD COLUMN aliases TEXT NOT NULL DEFAULT '';
  `,

  /**
   * 「待添加的服务项」—— 从比价结果里整理出来、但还没决定要不要进价格表的项。
   *
   * 为什么不直接在比价面板里点一下就建：
   *
   *   比价面板里你看不到**这个大类现在已经有什么**。而「这一项要不要建」恰恰
   *   要看这个 —— 原神的「主线」下面已经有 7.0、7.1 了，视频里那个「主线」
   *   是重复的还是新版本？在比价面板里判断不了，得回到价格表里看。
   *
   * 所以流程拆成两步：比价面板里勾选 = **存成待添加**（不建）；回价格表，
   * 在每个大类下面看到它们，一个一个决定加还是删。
   *
   * `aliases` 存视频里的原话，和 services.aliases 一个规矩（一行一个）——
   * 真正建进价格表时要带过去，否则短名字下次还是匹不上。
   */
  `
  CREATE TABLE IF NOT EXISTS service_drafts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id     INTEGER,
    category_id INTEGER,
    name        TEXT NOT NULL,
    price       REAL NOT NULL DEFAULT 0,
    aliases     TEXT NOT NULL DEFAULT '',
    why         TEXT NOT NULL DEFAULT '',
    source_job  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_service_drafts_game ON service_drafts (game_id, category_id);
  `,

  /**
   * 报价单要有「折扣」这一列。
   *
   * 以前没有：算总价时算了折扣（total 是对的），可是没地方存，转成订单时
   * 只能拿 total 当 items_subtotal、折扣记 0 —— 于是订单里「明细合计 50、
   * 小计 40」，改一次明细价格就自己从 40 涨回 50。
   * 老数据默认 0，行为不变。
   */
  `
  ALTER TABLE quotes ADD COLUMN discount REAL NOT NULL DEFAULT 0;
  `,
]

export function migrate() {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version || 0)
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[i])
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }
  return MIGRATIONS.length
}

/* ---------------- settings ---------------- */

export function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  return row ? row.value : fallback
}

export function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value ?? ''), new Date().toISOString())
}

export function getSettings(keys) {
  const out = {}
  for (const k of keys) out[k] = getSetting(k, '')
  return out
}

/** 每次写入业务表都要更新 updated_at，这里统一取时间 */
export const stamp = () => new Date().toISOString()

/**
 * 生成 DH250714-001 形式的单号：前缀 + 年月日 + 当日流水号。
 * 从 1 开始往上找一个没被占用的号，当日超过 9999 单才退化成随机串。
 */
export function nextSerialNo(prefix, table, column) {
  const day = localDate()
  for (let seq = 1; seq <= 9999; seq++) {
    const candidate = makeNo(prefix, day, seq)
    const hit = db.prepare(`SELECT 1 AS x FROM ${table} WHERE ${column} = ?`).get(candidate)
    if (!hit) return candidate
  }
  return `${prefix}${day.replace(/-/g, '').slice(2)}-${Date.now().toString(36).toUpperCase()}`
}
