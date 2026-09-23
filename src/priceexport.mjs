import { db } from './db.mjs'
import { money, num, parseJSON, clampStr } from './util.mjs'

/**
 * 价格表的「导出模型」。
 * 图片和 Word 文档都从这里出，保证两边内容一模一样。
 *
 * 设计原则：**跟着数据结构走，不跟着当前内容走。**
 * 以后你新加游戏、新加大类、新加服务项、配阶梯价、加增项，
 * 导出都会自动带上，不需要改这里。只导出在架的东西。
 *
 * 三类内容都会被收进来：
 *   1. 大类下面的服务项
 *   2. 没归到大类的服务项（落到「未分类」，绝不静默丢掉）
 *   3. 阶梯价、套餐内容、增项说明
 *
 * 同时会裁掉多余内容，保证一张图发出去好看：
 *   · 每个大类最多列 perCategory 项，多的折成「还有 N 项」
 *   · 最多列 maxCategories 个大类
 *   · 说明只保留有限的几行，太长的截断
 *   · 空的大类不导出
 */

const qty = (n) => {
  const v = num(n)
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

const DEFAULT_UNIT = { fixed: '单', daily: '天', per_time: '次', per_unit: '个', package: '套' }
const unitOf = (s) => s.unit_label || DEFAULT_UNIT[s.price_type] || '单'

/** 价格主文本 + 阶梯/起订提示 */
function priceOf(service, tiers) {
  const unit = unitOf(service)
  const list = (tiers || []).filter(Boolean)

  if (list.length) {
    const sorted = [...list].sort((a, b) => num(a.min_qty, 1) - num(b.min_qty, 1))
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const lo = num(first.min_qty, 1)
    const hi = first.max_qty === null || first.max_qty === undefined || first.max_qty === '' ? null : num(first.max_qty)
    const head = `¥${money(first.unit_price)} / ${unit}`
    if (sorted.length === 1) {
      const range = hi ? `${qty(lo)}-${qty(hi)}${unit}` : `${qty(lo)}${unit}起`
      return { price: head, hint: `${range}` }
    }
    const range = hi ? `${qty(lo)}-${qty(hi)}${unit}` : `${qty(lo)}${unit}起`
    return { price: head, hint: `${range}，最多到 ¥${money(last.unit_price)}/${unit}` }
  }

  const price = `¥${money(service.base_price)} / ${unit}`
  const min = num(service.min_qty, 1)
  return { price, hint: min > 1 ? `起订 ${qty(min)}${unit}` : '' }
}

const addonText = (o) =>
  `${o.name}${o.price_mode === 'percent' ? ` +${num(o.price)}%` : num(o.price) ? ` +${money(o.price)}元` : ''}`

export function buildExportModel(opts = {}) {
  const perCategory = Math.max(1, Math.min(60, num(opts.perCategory, 6)))
  const maxCategories = Math.max(1, Math.min(80, num(opts.maxCategories, 8)))
  const withDesc = opts.withDesc !== false
  const gameId = opts.gameId ? num(opts.gameId) : null

  const setting = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || ''

  /* ---------- 取数：全部在架内容 ---------- */
  const games = db.prepare("SELECT * FROM games WHERE status = 'active' ORDER BY sort_order ASC, id ASC").all()
  const gameById = new Map(games.map((g) => [g.id, g]))

  /* ---------- 公告 ---------- */
  // 每个游戏一条公告，导出时放在最上方。
  //
  // 提到最上方的前提是「这一份导出只面向一个游戏」：
  //   · 指定了 game_id → 就是它
  //   · 没指定、但在架游戏只有一个 → 也是它（合并导出其实也只出一份）
  //   · 多个游戏合并成一份 → 不能都塞最上面，改成跟在各自游戏小标题下面，
  //     免得「鸣潮的公告」被当成整张表的总说明。
  const noticeByGame = new Map()
  for (const g of games) {
    const t = String(g.notice || '').trim()
    if (t) noticeByGame.set(String(g.id), t)
  }
  let focusKey = ''
  if (gameId && gameById.has(gameId)) focusKey = String(gameId)
  else if (!gameId && games.length === 1) focusKey = String(games[0].id)
  const topNotice = focusKey ? clampStr(noticeByGame.get(focusKey) || '', 600) : ''

  let cats = db
    .prepare("SELECT * FROM service_categories WHERE status = 'active' ORDER BY sort_order ASC, id ASC")
    .all()
  if (gameId) cats = cats.filter((c) => !c.game_id || c.game_id === gameId)

  let services = db.prepare("SELECT * FROM services WHERE status = 'active' ORDER BY sort_order ASC, id ASC").all()
  if (gameId) services = services.filter((s) => !s.game_id || s.game_id === gameId)

  const tiersBy = new Map()
  for (const t of db.prepare('SELECT * FROM service_tiers ORDER BY sort_order ASC, min_qty ASC').all()) {
    if (!tiersBy.has(t.service_id)) tiersBy.set(t.service_id, [])
    tiersBy.get(t.service_id).push(t)
  }
  const optsBy = new Map()
  for (const o of db
    .prepare("SELECT * FROM service_options WHERE status = 'active' ORDER BY sort_order ASC, id ASC")
    .all()) {
    const key = o.service_id || 0
    if (!optsBy.has(key)) optsBy.set(key, [])
    optsBy.get(key).push(o)
  }

  const catById = new Map(cats.map((c) => [c.id, c]))

  /* ---------- 归类 ---------- */
  const makeItem = (s) => {
    const { price, hint } = priceOf(s, tiersBy.get(s.id))
    const notes = []
    if (withDesc && s.description) notes.push(clampStr(s.description, 60))
    const pkg = parseJSON(s.package_items, [])
    if (withDesc && Array.isArray(pkg) && pkg.length) notes.push(`含 ${pkg.slice(0, 6).join('、')}`)
    if (withDesc) {
      const addons = [...(optsBy.get(s.id) || []), ...(optsBy.get(0) || [])]
      const payable = addons.filter((o) => num(o.price) > 0)
      if (payable.length) notes.push(`增项：${payable.slice(0, 5).map(addonText).join('、')}`)
    }
    return { name: clampStr(s.name, 40), price, hint, notes }
  }

  // 有归属的大类 → 按大类分组；没有的 → 按游戏落到「未分类」
  const byCat = new Map()
  const orphansByGame = new Map()
  for (const s of services) {
    const cat = s.category_id ? catById.get(s.category_id) : null
    if (cat) {
      if (!byCat.has(cat.id)) byCat.set(cat.id, [])
      byCat.get(cat.id).push(s)
    } else {
      const key = s.game_id && gameById.has(s.game_id) ? String(s.game_id) : ''
      if (!orphansByGame.has(key)) orphansByGame.set(key, [])
      orphansByGame.get(key).push(s)
    }
  }

  /* ---------- 排组：按游戏 → 大类顺序，「未分类」放各组最后 ---------- */
  const sections = []
  const noticeShown = new Set()
  const pushSection = (cat, gameKey, list) => {
    const shown = list.slice(0, perCategory)
    // 合并导出时，游戏的提示挂在这个游戏的第一个大类上面，只出现一次
    let gameNotice = ''
    if (gameKey && gameKey !== focusKey && !noticeShown.has(gameKey)) {
      noticeShown.add(gameKey)
      gameNotice = clampStr(noticeByGame.get(gameKey) || '', 600)
    }
    sections.push({
      name: cat ? clampStr(cat.name, 40) : '未分类',
      isOrphan: !cat,
      gameKey,
      gameName: gameKey ? gameById.get(Number(gameKey))?.name || '' : '',
      gameNotice,
      // 大类自己的提示：排在它名字下面、服务项上面。
      // 「未分类」是临时的桶，没有真正的大类记录，所以没有提示。
      catNotice: cat ? clampStr(cat.notice || '', 400) : '',
      items: shown.map(makeItem),
      more: list.length - shown.length,
      total: list.length,
    })
  }

  const gameKeys = gameId ? [String(gameId)] : games.map((g) => String(g.id))
  const emitted = new Set()
  for (const key of gameKeys) {
    for (const c of cats) {
      if (String(c.game_id || '') !== (key === '' ? '' : key)) continue
      const list = byCat.get(c.id)
      if (list && list.length) {
        pushSection(c, key, list)
        emitted.add(c.id)
      }
    }
    const orph = orphansByGame.get(key)
    if (orph && orph.length) pushSection(null, key, orph)
  }
  // 通用大类（不属于任何游戏）
  for (const c of cats) {
    if (c.game_id || emitted.has(c.id)) continue
    const list = byCat.get(c.id)
    if (list && list.length) pushSection(c, '', list)
  }
  const genericOrphans = orphansByGame.get('')
  if (genericOrphans && genericOrphans.length) pushSection(null, '', genericOrphans)

  const totalServices = services.length
  const trimmed = sections.slice(0, maxCategories)
  const hiddenCategories = sections.length - trimmed.length
  const itemCount = trimmed.reduce((n, g) => n + g.items.length, 0)

  /* ---------- 抬头 ---------- */
  const today = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const dateStr = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`

  let subtitle = ''
  if (gameId) subtitle = gameById.get(gameId)?.name || ''
  else if (games.length === 1) subtitle = games[0].name
  else if (games.length > 1) subtitle = games.map((g) => g.name).slice(0, 3).join(' / ') + (games.length > 3 ? ` 等 ${games.length} 个游戏` : '')

  /* ---------- 这份导出里都涉及哪些游戏（前端据此按游戏拆成多份） ---------- */
  const perGame = new Map()
  for (const s of services) {
    const key = s.game_id && gameById.has(s.game_id) ? String(s.game_id) : ''
    perGame.set(key, (perGame.get(key) || 0) + 1)
  }
  const orderedKeys = [...games.map((g) => String(g.id)), ''].filter((k) => perGame.has(k))
  const gameOptions = orderedKeys.map((k) => ({
    key: k,
    name: k ? gameById.get(Number(k))?.name || '未知游戏' : '未指定游戏的通用项',
    count: perGame.get(k) || 0,
  }))

  return {
    shopName: clampStr(opts.shopName || setting('business_name') || '代肝价目表', 40),
    contact: clampStr(opts.contact !== undefined ? opts.contact : setting('contact') || '', 80),
    footer: clampStr(
      opts.footer !== undefined ? opts.footer : setting('quote_footer') || '价格随版本更新，以最新报价为准',
      120
    ),
    title: clampStr(opts.title || '代肝价目表', 40),
    subtitle,
    date: dateStr,
    // 提示：整份只面向一个游戏时在最上方显示（图片和 Word 都是）
    notice: topNotice,
    noticeGameName: focusKey ? gameById.get(Number(focusKey))?.name || '' : '',
    groups: trimmed,
    // 只有一张价格表时抬头已经写了游戏名；多张时才在正文里插游戏小标题
    multiGame: new Set(trimmed.map((g) => g.gameName).filter(Boolean)).size > 1,
    gameOptions,
    hiddenCategories,
    hiddenServices: sections.reduce((n, g) => n + g.more, 0),
    totalServices,
    itemCount,
  }
}
