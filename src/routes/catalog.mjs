import { db, stamp } from '../db.mjs'
import { get, post, patch, del } from '../http.mjs'
import { bad, notFound, int, clampStr, nextSortOrder } from '../util.mjs'
import { makeDef, registerCrud, getRow, createRow, updateRow, removeRow, listRows, shapeRow } from './_helpers.mjs'
import { buildExportModel } from '../priceexport.mjs'
import { buildDocx } from '../docx.mjs'

export const games = makeDef({
  table: 'games',
  listOrder: 'sort_order ASC, id ASC',
  searchColumns: ['name', 'short_name', 'note'],
  archiveInstead: true,
  columns: {
    name: { type: 'string', required: true, label: '游戏名', max: 80, unique: true, filter: true, trim: true },
    short_name: { type: 'string', label: '简称', max: 40 },
    icon: { type: 'string', label: '图标', max: 400 },
    servers: { type: 'strarray', label: '区服', max: 40 },
    status: { type: 'string', default: 'active', enum: ['active', 'archived'], filter: true },
    sort_order: { type: 'int', default: 0 },
    note: { type: 'text', label: '备注', max: 1000 },
  },
})

/** 名字看起来是不是「每天都要做」的那种大类。
 *  新建大类时拿它自动勾上，以后新加的「日常 / 每日委托」也能认出来，不用手动设。 */
export function looksDaily(name) {
  return /日常|日体|包天|每日|托管/.test(String(name || ''))
}

export const categories = makeDef({
  table: 'service_categories',
  listOrder: 'sort_order ASC, id ASC',
  searchColumns: ['name', 'note'],
  archiveInstead: true,
  columns: {
    game_id: { type: 'ref', label: '所属游戏', filter: true },
    name: { type: 'string', required: true, label: '分类名', max: 60, filter: true },
    // 每天都要做的大类（日常、日体、包天…）。开单时会标出来，
    // 标「今日已完成」时也靠它提醒你这张单里还有没有别的活。
    // 没显式传值时，按名字自动认一次 —— 所以后面新加的大类也能自动兼容。
    is_daily: {
      type: 'bool',
      default: 0,
      label: '每天都做',
      filter: true,
      validate: (value, body) => (body && 'is_daily' in body ? value : looksDaily(body && body.name) ? 1 : value),
    },
    status: { type: 'string', default: 'active', enum: ['active', 'archived'], filter: true },
    sort_order: { type: 'int', default: 0 },
    note: { type: 'text', max: 1000 },
  },
})

export const services = makeDef({
  table: 'services',
  listOrder: 'sort_order ASC, id ASC',
  limit: 500,
  searchColumns: ['name', 'description', 'note'],
  archiveInstead: true,
  columns: {
    category_id: { type: 'ref', label: '分类', filter: true },
    game_id: { type: 'ref', label: '游戏', filter: true },
    name: { type: 'string', required: true, label: '服务名', max: 120, filter: true },
    // 留空 = 跟着所在大类走（往「日常」大类里加的服务项自动就是每天做的）；
    // 想单独指定就选「是 / 否」，覆盖大类。
    is_daily: { type: 'bool', nullable: true, default: null, label: '每天都做', filter: true },
    description: { type: 'text', label: '说明', max: 2000 },
    price_type: {
      type: 'string',
      label: '计价方式',
      default: 'fixed',
      enum: ['fixed', 'daily', 'per_time', 'per_unit', 'package'],
      filter: true,
    },
    unit_label: { type: 'string', label: '单位', max: 20 },
    base_price: { type: 'money', label: '单价', default: 0 },
    min_qty: { type: 'number', label: '起订量', default: 1 },
    max_qty: { type: 'number', label: '封顶量', nullable: true, default: null },
    package_items: { type: 'json', label: '套餐内容', default: [] },
    status: { type: 'string', default: 'active', enum: ['active', 'archived'], filter: true },
    sort_order: { type: 'int', default: 0 },
    note: { type: 'text', label: '备注', max: 1000 },
  },
})

export const tiers = makeDef({
  table: 'service_tiers',
  listOrder: 'sort_order ASC, min_qty ASC, id ASC',
  columns: {
    service_id: { type: 'ref', required: true, filter: true },
    min_qty: { type: 'number', default: 1 },
    max_qty: { type: 'number', nullable: true, default: null },
    unit_price: { type: 'money', default: 0 },
    sort_order: { type: 'int', default: 0 },
  },
})

export const options = makeDef({
  table: 'service_options',
  listOrder: 'sort_order ASC, id ASC',
  searchColumns: ['name', 'description'],
  archiveInstead: true,
  columns: {
    service_id: { type: 'ref', label: '绑定服务', filter: true },
    kind: { type: 'string', label: '类型', default: 'addon', enum: ['package', 'addon'], filter: true },
    name: { type: 'string', required: true, label: '名称', max: 80, filter: true },
    description: { type: 'text', label: '说明', max: 1000 },
    price: { type: 'money', label: '加价', default: 0 },
    price_mode: { type: 'string', label: '加价方式', default: 'fixed', enum: ['fixed', 'percent'] },
    default_selected: { type: 'bool', label: '默认选中', default: 0 },
    status: { type: 'string', default: 'active', enum: ['active', 'archived'], filter: true },
    sort_order: { type: 'int', default: 0 },
  },
})

/* ---------------- 联表装饰 ---------------- */

const nameMaps = () => ({
  games: new Map(db.prepare('SELECT id, name FROM games').all().map((r) => [r.id, r.name])),
  categories: new Map(db.prepare('SELECT id, name FROM service_categories').all().map((r) => [r.id, r.name])),
  customers: new Map(db.prepare('SELECT id, name FROM customers').all().map((r) => [r.id, r.name])),
})

function decorateServices(rows) {
  const map = nameMaps()
  return rows.map((r) => ({
    ...r,
    game_name: r.game_id ? map.games.get(r.game_id) || '' : '',
    category_name: r.category_id ? map.categories.get(r.category_id) || '' : '',
    tier_count: db.prepare('SELECT COUNT(*) AS c FROM service_tiers WHERE service_id = ?').get(r.id).c,
    option_count: db.prepare('SELECT COUNT(*) AS c FROM service_options WHERE service_id = ?').get(r.id).c,
  }))
}

/* ---------------- 注册 ---------------- */

export function register() {
  registerCrud('/api/games', games, {
    afterList: (rows) => {
      const svc = new Map(
        db.prepare("SELECT game_id, COUNT(*) AS c FROM services WHERE status = 'active' GROUP BY game_id").all().map((r) => [r.game_id, r.c])
      )
      const ord = new Map(
        db.prepare('SELECT game_id, COUNT(*) AS c FROM orders GROUP BY game_id').all().map((r) => [r.game_id, r.c])
      )
      return rows.map((r) => ({ ...r, service_count: svc.get(r.id) || 0, order_count: ord.get(r.id) || 0 }))
    },
  })

  registerCrud('/api/categories', categories, {
    afterList: (rows) => {
      const map = nameMaps()
      const cnt = new Map(
        db.prepare("SELECT category_id, COUNT(*) AS c FROM services WHERE status = 'active' GROUP BY category_id").all().map((r) => [r.category_id, r.c])
      )
      return rows.map((r) => ({
        ...r,
        game_name: r.game_id ? map.games.get(r.game_id) || '' : '',
        service_count: cnt.get(r.id) || 0,
      }))
    },
  })

  registerCrud('/api/services', services, {
    afterList: decorateServices,
  })

  registerCrud('/api/options', options, {
    afterList: (rows) => {
      const svc = new Map(db.prepare('SELECT id, name FROM services').all().map((r) => [r.id, r.name]))
      return rows.map((r) => ({ ...r, service_name: r.service_id ? svc.get(r.service_id) || '' : '通用增项' }))
    },
  })

  /* 阶梯价：按服务挂载 */
  get('/api/services/:id/tiers', (ctx) => ({
    items: db
      .prepare('SELECT * FROM service_tiers WHERE service_id = ? ORDER BY sort_order ASC, min_qty ASC')
      .all(int(ctx.params.id))
      .map((r) => shapeRow(tiers, r)),
  }))
  post('/api/services/:id/tiers', (ctx) => {
    const sid = int(ctx.params.id)
    if (!getRow(services, sid)) notFound('服务不存在')
    return createRow(tiers, { ...ctx.body, service_id: sid })
  })
  patch('/api/tiers/:id', (ctx) => updateRow(tiers, ctx.params.id, ctx.body))
  del('/api/tiers/:id', (ctx) => removeRow(tiers, ctx.params.id))

  /* 服务的增项/套餐 */
  get('/api/services/:id/options', (ctx) => ({
    items: db
      .prepare('SELECT * FROM service_options WHERE service_id = ? AND status <> ? ORDER BY sort_order ASC, id ASC')
      .all(int(ctx.params.id), 'archived')
      .map((r) => shapeRow(options, r)),
  }))

  /* 单个服务的完整视角：服务 + 阶梯 + 增项，报价和下单都用它 */
  get('/api/services/:id/full', (ctx) => {
    const id = int(ctx.params.id)
    const svc = getRow(services, id)
    if (!svc) notFound('服务不存在')
    return {
      service: decorateServices([svc])[0],
      tiers: db.prepare('SELECT * FROM service_tiers WHERE service_id = ? ORDER BY sort_order, min_qty').all(id).map((r) => shapeRow(tiers, r)),
      options: db
        .prepare("SELECT * FROM service_options WHERE (service_id = ? OR service_id IS NULL) AND status = 'active' ORDER BY sort_order, id")
        .all(id)
        .map((r) => shapeRow(options, r)),
    }
  })

  /* 删除前的用量核查，避免把老订单referenced的东西删掉 */
  get('/api/games/:id/usage', (ctx) => {
    const id = int(ctx.params.id)
    const count = (sql) => db.prepare(sql).get(id).c
    return {
      services: count('SELECT COUNT(*) AS c FROM services WHERE game_id = ?'),
      categories: count('SELECT COUNT(*) AS c FROM service_categories WHERE game_id = ?'),
      orders: count('SELECT COUNT(*) AS c FROM orders WHERE game_id = ?'),
      credentials: count('SELECT COUNT(*) AS c FROM credentials WHERE game_id = ?'),
    }
  })
  get('/api/categories/:id/usage', (ctx) => ({
    services: db.prepare('SELECT COUNT(*) AS c FROM services WHERE category_id = ?').get(int(ctx.params.id)).c,
  }))
  get('/api/services/:id/usage', (ctx) => ({
    order_items: db.prepare('SELECT COUNT(*) AS c FROM order_items WHERE ref_id = ?').get(int(ctx.params.id)).c,
  }))

  /* 拖拽排序：传一组 id，按数组顺序重排 */
  post('/api/reorder/:resource', (ctx) => {
    const table = { games: 'games', categories: 'service_categories', services: 'services', options: 'service_options' }[
      ctx.params.resource
    ]
    if (!table) bad('不支持排序的对象', 'bad_resource')
    const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : []
    if (!ids.length) bad('没有收到排序内容', 'empty_ids')
    const stmt = db.prepare(`UPDATE ${table} SET sort_order = ?, updated_at = ? WHERE id = ?`)
    const ts = stamp()
    db.exec('BEGIN')
    try {
      ids.forEach((id, i) => stmt.run((i + 1) * 10, ts, int(id)))
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
    return { ok: true, count: ids.length }
  })

  /* 新建时自动排到末尾 */
  post('/api/categories/append', (ctx) => createRow(categories, { ...ctx.body, sort_order: nextSortOrder(db, 'service_categories') }))
  post('/api/services/append', (ctx) => createRow(services, { ...ctx.body, sort_order: nextSortOrder(db, 'services') }))
  post('/api/options/append', (ctx) => createRow(options, { ...ctx.body, sort_order: nextSortOrder(db, 'service_options') }))

  /* 价格总览：报价单和价格查询都用这一份 */
  get('/api/pricebook', () => {
    const map = nameMaps()
    const svcRows = db
      .prepare("SELECT * FROM services WHERE status = 'active' ORDER BY sort_order ASC, id ASC")
      .all()
      .map((r) => shapeRow(services, r))
    const tierRows = db.prepare('SELECT * FROM service_tiers ORDER BY sort_order, min_qty').all().map((r) => shapeRow(tiers, r))
    const optRows = db
      .prepare("SELECT * FROM service_options WHERE status = 'active' ORDER BY sort_order, id")
      .all()
      .map((r) => shapeRow(options, r))
    const tiersBy = new Map()
    for (const t of tierRows) {
      if (!tiersBy.has(t.service_id)) tiersBy.set(t.service_id, [])
      tiersBy.get(t.service_id).push(t)
    }
    const optsBy = new Map()
    for (const o of optRows) {
      const key = o.service_id || 0
      if (!optsBy.has(key)) optsBy.set(key, [])
      optsBy.get(key).push(o)
    }
    const catRows = db
      .prepare("SELECT * FROM service_categories WHERE status = 'active' ORDER BY sort_order ASC, id ASC")
      .all()
      .map((r) => shapeRow(categories, r))

    return {
      games: db.prepare("SELECT * FROM games WHERE status = 'active' ORDER BY sort_order, id").all().map((r) => shapeRow(games, r)),
      categories: catRows.map((c) => ({
        ...c,
        game_name: c.game_id ? map.games.get(c.game_id) || '' : '',
        services: svcRows
          .filter((s) => s.category_id === c.id)
          .map((s) => ({
            ...s,
            game_name: s.game_id ? map.games.get(s.game_id) || '' : '',
            tiers: tiersBy.get(s.id) || [],
            options: [...(optsBy.get(s.id) || []), ...(optsBy.get(0) || [])],
          })),
      })),
      loose: svcRows
        .filter((s) => !s.category_id || !catRows.some((c) => c.id === s.category_id))
        .map((s) => ({
          ...s,
          game_name: s.game_id ? map.games.get(s.game_id) || '' : '',
          tiers: tiersBy.get(s.id) || [],
          options: [...(optsBy.get(s.id) || []), ...(optsBy.get(0) || [])],
        })),
      global_options: optsBy.get(0) || [],
    }
  })

  /* ============================================================
     导出：图片和文档都从同一个导出模型出，保证内容一致
     ============================================================ */

  const exportOpts = (query) => ({
    gameId: query.game_id ? int(query.game_id) : null,
    perCategory: query.per_category ? int(query.per_category, 6) : 6,
    maxCategories: query.max_categories ? int(query.max_categories, 8) : 8,
    withDesc: query.with_desc !== '0',
    title: query.title ? clampStr(query.title, 40) : '',
    shopName: query.shop_name ? clampStr(query.shop_name, 40) : '',
    contact: query.contact !== undefined ? clampStr(query.contact, 80) : undefined,
    footer: query.footer !== undefined ? clampStr(query.footer, 120) : undefined,
  })

  /** 导出模型（JSON）—— 前端拿它画图片 */
  get('/api/pricebook/export-model', (ctx) => buildExportModel(exportOpts(ctx.query)))

  /** Word 文档（.docx）—— 直接落盘下载 */
  get('/api/pricebook/export.docx', (ctx) => {
    const model = buildExportModel(exportOpts(ctx.query))
    const buf = buildDocx(model)
    const safe = `${model.shopName}-价目表-${model.date}`.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
    ctx.res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="price-list.docx"; filename*=UTF-8''${encodeURIComponent(safe)}.docx`,
      'Cache-Control': 'no-store',
    })
    ctx.res.end(buf)
    return undefined // 已经自己回过响应了
  })
}
