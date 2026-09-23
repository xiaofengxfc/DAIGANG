/**
 * 后端接口冒烟测试：从零初始化到下单、收款、保险箱取用、财务结算，全流程跑一遍。
 *
 *   先启动一个干净的实例：
 *     set XFC_DATA_DIR=./data-smoke && node server.mjs --port 8790 --local
 *   再跑：
 *     node scripts/smoke.mjs
 */
import zlib from 'node:zlib'
// 纯函数，不连数据库，可以直接拿来验「凌晨 4 点换日」的边界
import { bizDate, localDate, DAY_START_HOUR } from '../src/util.mjs'

const BASE = process.env.XFC_BASE || 'http://127.0.0.1:8790'

let cookie = ''
let pass = 0
const failures = []

async function api(method, path, body) {
  const headers = {}
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await res.text()
  let json = raw
  try {
    json = JSON.parse(raw)
  } catch {}
  return { status: res.status, body: json, headers: res.headers }
}

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail !== undefined ? `  →  ${JSON.stringify(detail).slice(0, 300)}` : ''}`)
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`)
}

async function main() {
  console.log(`目标：${BASE}`)

  /* ---------- 初始化 ---------- */
  section('初始化与登录')
  let r = await api('GET', '/api/auth/me')
  ok('未初始化时 setup=false', r.body.setup === false, r.body)

  r = await api('GET', '/api/dashboard')
  ok('未登录访问看板返回 401', r.status === 401, r.status)

  r = await api('POST', '/api/setup', { password: 'abc123', confirm: 'nope' })
  ok('两次密码不一致被拒', r.status === 400 && r.body.code === 'password_mismatch', r.body)

  r = await api('POST', '/api/setup', { password: '123', confirm: '123' })
  ok('弱密码被拒', r.status === 400 && r.body.code === 'weak_password', r.body)

  r = await api('POST', '/api/setup', {
    password: 'admin-pass-8888',
    confirm: 'admin-pass-8888',
    business_name: '夜班代肝',
    admin_name: '老板',
    vault_password: 'Vault-Secret-2024',
  })
  ok('初始化成功', r.status === 200 && r.body.ok === true, r.body)
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : []
  const sidCookie = setCookies.find((c) => c.startsWith('xfc_sid='))
  ok('下发会话 Cookie', Boolean(sidCookie), setCookies)
  if (sidCookie) cookie = sidCookie.split(';')[0]

  r = await api('GET', '/api/auth/me')
  ok('初始化后已登录', r.body.authenticated === true, r.body)
  ok('保险箱已配置且已解锁', r.body.vault?.configured === true && r.body.vault?.unlocked === true, r.body.vault)

  r = await api('POST', '/api/setup', { password: 'x', confirm: 'x' })
  ok('重复初始化被拒', r.status === 409, r.body)

  /* ---------- 游戏 / 分类 / 服务 ---------- */
  section('游戏 · 分类 · 服务与价格')
  r = await api('POST', '/api/games', { name: '原神', short_name: 'YS', servers: ['天空岛', '世界树'], note: '主号在天空岛' })
  ok('新建游戏', r.status === 200 && r.body.id > 0, r.body)
  const gameId = r.body.id
  ok('区服存成数组', Array.isArray(r.body.servers) && r.body.servers.length === 2, r.body.servers)

  r = await api('POST', '/api/games', { name: '原神' })
  ok('重名游戏被拒', r.status === 400 && r.body.code === 'duplicate', r.body)

  r = await api('POST', '/api/games', { name: '崩坏：星穹铁道', short_name: '崩铁' })
  const game2 = r.body.id

  r = await api('POST', '/api/categories', { name: '日常', game_id: gameId })
  ok('新建分类', r.status === 200 && r.body.id > 0, r.body)
  const catId = r.body.id

  // 「日常」这种名字的大类，建的时候没传 is_daily 也要自动认出来
  ok('新建「日常」大类自动勾上每天做', r.body.is_daily === true, String(r.body.is_daily))
  r = await api('POST', '/api/categories/append', { name: '活动' })
  const tmpCatId = r.body.id
  ok('新建「活动」大类不会被误勾', r.body.is_daily === false, String(r.body.is_daily))
  // 引用列不给值要存成 NULL —— 存成 '' 会撞外键
  r = await api('POST', '/api/services/append', { name: '没指定游戏的临时项', category_id: catId, base_price: 1 })
  const tmpSvcId = r.body.id
  ok('新建服务项不给 game_id 也能成（外键不能再报错）', r.status === 200 && r.body.id > 0, `${r.status} ${JSON.stringify(r.body).slice(0, 70)}`)
  ok('没给 game_id 时确实是 null，不是空字符串', r.body.game_id === null, JSON.stringify(r.body.game_id))
  // 可空 bool 的 NULL 要保住：跟随大类 ≠ 否
  ok('服务项没设 is_daily 时是 null（跟随大类）', r.body.is_daily === null, JSON.stringify(r.body.is_daily))
  r = await api('POST', '/api/services/append', { name: '强制一次性的', category_id: catId, base_price: 1, is_daily: 0 })
  const tmpSvc2 = r.body.id
  ok('显式设成 0 就是 false，不被 NULL 混掉', r.body.is_daily === false, JSON.stringify(r.body.is_daily))
  r = await api('PATCH', `/api/services/${tmpSvc2}`, { is_daily: null })
  ok('还能改回 null（跟随大类）', r.body.is_daily === null, JSON.stringify(r.body.is_daily))
  // 全部清掉：留着会让后面「几个大类 / 几个服务项」的统计全对不上
  await api('DELETE', `/api/services/${tmpSvcId}?hard=1`)
  await api('DELETE', `/api/services/${tmpSvc2}?hard=1`)
  r = await api('DELETE', `/api/categories/${tmpCatId}?hard=1`)
  ok('临时大类和服务项都清理干净', r.status === 200, r.status)

  r = await api('POST', '/api/services', {
    name: '每日委托',
    category_id: catId,
    game_id: gameId,
    price_type: 'daily',
    base_price: 5,
    unit_label: '天',
    description: '每天清完 4 个委托 + 领取奖励',
    package_items: ['4 个每日委托', '派遣', '纪行经验'],
  })
  ok('新建服务项（按天）', r.status === 200 && r.body.base_price === 5, r.body)
  const svcDaily = r.body.id

  r = await api('POST', '/api/services', {
    name: '深渊 12 层',
    category_id: catId,
    game_id: gameId,
    price_type: 'per_unit',
    base_price: 30,
    unit_label: '层',
    min_qty: 1,
  })
  const svcAbyss = r.body.id
  ok('新建服务项（按数量）', r.status === 200, r.body)

  r = await api('POST', `/api/services/${svcAbyss}/tiers`, { min_qty: 1, max_qty: 5, unit_price: 30 })
  ok('加阶梯价 1-5 层 30 元', r.status === 200, r.body)
  r = await api('POST', `/api/services/${svcAbyss}/tiers`, { min_qty: 6, max_qty: 12, unit_price: 25 })
  ok('加阶梯价 6-12 层 25 元', r.status === 200, r.body)

  r = await api('POST', '/api/options', { service_id: svcDaily, kind: 'addon', name: '加急', price: 20, price_mode: 'percent', description: '插队优先做，加价 20%' })
  ok('新建增项（按百分比加价）', r.status === 200, r.body)
  const addonRush = r.body.id

  r = await api('POST', '/api/options', { service_id: null, kind: 'addon', name: '不动原石', price: 0, description: '全程不消耗原石' })
  ok('新建通用增项', r.status === 200, r.body)
  const addonNoGem = r.body.id

  r = await api('GET', '/api/pricebook')
  ok('价格总览返回分类', r.body.categories?.length === 1, r.body.categories?.length)
  ok('价格总览里服务带阶梯和增项', r.body.categories?.[0]?.services?.[0]?.tiers !== undefined, r.body.categories?.[0]?.services?.[0])

  r = await api('GET', `/api/services/${svcAbyss}/full`)
  ok('单服务完整视角含 2 档阶梯', r.body.tiers?.length === 2, r.body.tiers?.length)

  r = await api('GET', '/api/games')
  ok('游戏列表带服务数统计', r.body.items?.[0]?.service_count >= 1, r.body.items?.[0])

  /* ---------- 客户 ---------- */
  section('客户')
  r = await api('POST', '/api/customers', { name: '小王', phone: '13800138000', wechat: 'wang_ys', qq: '10001', source: '微信', tags: ['爽快', '老客户'], note: '只在晚上回复' })
  ok('新建客户', r.status === 200 && r.body.id > 0, r.body)
  const custId = r.body.id
  ok('标签存成数组', Array.isArray(r.body.tags) && r.body.tags.length === 2, r.body.tags)

  r = await api('POST', '/api/customers', { name: '冒名', phone: '13800138000' })
  ok('手机号重复被拒', r.status === 400 && r.body.code === 'duplicate', r.body)

  r = await api('POST', '/api/customers', { name: '没手机号的' })
  ok('没有手机号可以建多个', r.status === 200, r.body)

  /* ---------- 保险箱 ---------- */
  section('凭证保险箱')
  r = await api('POST', '/api/credentials', {
    customer_id: custId,
    game_id: gameId,
    label: '小王主号',
    login_type: 'password',
    server: '天空岛',
    role_name: '旅行者',
    secret: { account: 'wang_ys@qq.com', phone: '13800138000', password: 'SuperSecret123', bind_phone: '13800138000', security_question: '母亲姓名', security_answer: '张三', note: '不要动原石' },
  })
  ok('新建凭证', r.status === 200 && r.body.id > 0, r.body)
  const credId = r.body.id
  ok('列表只露脱敏提示', /^\w{2}\*+@qq\.com$/.test(r.body.masked_hint || ''), r.body.masked_hint)
  ok('返回体里没有密文字段', r.body.payload_enc === undefined, Object.keys(r.body))

  r = await api('GET', '/api/credentials')
  const credListRow = r.body.items?.[0]
  ok('凭证列表不含 payload_enc', credListRow && credListRow.payload_enc === undefined, Object.keys(credListRow || {}))
  ok('凭证列表带客户名', credListRow?.customer_name === '小王', credListRow?.customer_name)

  const dbRaw = await api('GET', `/api/credentials/${credId}`)
  ok('单条凭证详情也不含密文', dbRaw.body.payload_enc === undefined, Object.keys(dbRaw.body))

  r = await api('POST', '/api/vault/lock')
  ok('手动落锁', r.body.unlocked === false, r.body)

  r = await api('POST', `/api/credentials/${credId}/reveal`, {})
  ok('锁定状态下取用被拒 423', r.status === 423 && r.body.code === 'vault_locked', r.body)

  r = await api('POST', '/api/vault/unlock', { password: 'wrong-password' })
  ok('保险箱密码错误被拒', r.status === 400, r.body)

  r = await api('POST', '/api/vault/unlock', { password: 'Vault-Secret-2024' })
  ok('保险箱解锁成功', r.body.unlocked === true, r.body)

  r = await api('POST', `/api/credentials/${credId}/reveal`, { action: 'view' })
  ok('解锁后能取到明文', r.body.secret?.password === 'SuperSecret123', r.body.secret)
  ok('明文里带密保问题', r.body.secret?.security_question === '母亲姓名', r.body.secret)

  r = await api('POST', `/api/credentials/${credId}/reveal`, { action: 'copy', field: 'password' })
  ok('复制动作也能取到', r.body.secret?.password === 'SuperSecret123', r.body)

  r = await api('GET', '/api/vault/audit')
  const actions = (r.body.items || []).map((a) => a.action)
  ok('审计记录了 view', actions.includes('credential.view'), actions)
  ok('审计记录了 copy', actions.includes('credential.copy'), actions)
  ok('审计记录了解锁', actions.includes('vault.unlock'), actions)
  ok('审计里有操作人', r.body.items?.[0]?.actor === '老板', r.body.items?.[0]?.actor)

  r = await api('POST', '/api/vault/setup', { password: 'another-one-123' })
  ok('保险箱重复设置被拒', r.status === 400, r.body)

  /* ---------- 订单 ---------- */
  section('订单 · 快照 · 状态机')
  r = await api('POST', '/api/orders', {
    customer_id: custId,
    game_id: gameId,
    status: 'pending_pay',
    items: [
      { service_id: svcDaily, quantity: 30, option_ids: [addonRush, addonNoGem] },
      { service_id: svcAbyss, quantity: 8 },
    ],
    discount: 10,
    platform_fee: 6,
    cost: 40,
  })
  ok('新建订单', r.status === 200 && r.body.id > 0, r.body)
  const orderId = r.body.id
  const order = r.body
  ok('单号形如 DHyymmdd-NNN', /^DH\d{6}-\d{3}$/.test(order.order_no || ''), order.order_no)
  ok('每日委托 5×30=150 + 加急 20% 30 = 180', order.items?.[0]?.amount === 180, order.items?.[0])
  ok('深渊 8 层命中第二档 25 元 = 200', order.items?.[1]?.amount === 200, order.items?.[1])
  ok('小计 150+200=350', order.items_subtotal === 350, order.items_subtotal)
  ok('增项合计 30', order.addon_total === 30, order.addon_total)
  ok('总价 350+30-10=370', order.total === 370, order.total)
  ok('利润 370-6-40=324', order.profit === 324, order.profit)
  ok('快照记下套餐内容', order.package_contents?.length === 3, order.package_contents)
  ok('快照记下增项', order.addon_summary?.length === 2, order.addon_summary)
  ok('订单冻结了客户名', order.customer_name === '小王', order.customer_name)
  ok('订单冻结了游戏名', order.game_name === '原神', order.game_name)

  // 改价格表，老订单不受影响
  await api('PATCH', `/api/services/${svcDaily}`, { base_price: 99 })
  r = await api('GET', `/api/orders/${orderId}`)
  ok('改价后老订单单价仍是 5', r.body.items?.[0]?.unit_price === 5, r.body.items?.[0]?.unit_price)
  ok('改价后老订单总价仍是 370', r.body.total === 370, r.body.total)
  // 验证完了把价格改回去，后面的报价单测试才有确定的数字
  await api('PATCH', `/api/services/${svcDaily}`, { base_price: 5 })

  r = await api('GET', '/api/orders?status=open')
  ok('按进行中筛选订单', (r.body.items || []).some((o) => o.id === orderId), r.body.items?.length)
  ok('列表带未收金额', r.body.items?.[0]?.due_total === 370, r.body.items?.[0]?.due_total)
  // 客户反复下单时，列表要能看出这是他的第几单
  ok(
    '列表带这个客户一共下过几单',
    r.body.items?.every((o) => typeof o.customer_order_count === 'number'),
    r.body.items?.map((o) => `${o.customer_name}:${o.customer_order_count}`).join(', ')
  )
  r = await api('GET', '/api/orders?sort=customer')
  ok('支持按客户排序', r.status === 200 && Array.isArray(r.body.items), r.status)
  const names = (r.body.items || []).map((o) => o.customer_name || '')
  ok('按客户排序后同名相邻', names.every((n, i) => i === 0 || n >= names[i - 1]), names.join(' | ').slice(0, 80))
  r = await api('GET', `/api/orders?customer_id=${custId}`)
  ok('支持按客户筛单', (r.body.items || []).every((o) => o.customer_id === custId), r.body.items?.length)

  // 列表里要能直接看到客户手机号
  const withCust = (r.body.items || []).find((o) => o.customer_id === custId)
  ok('订单行带客户手机号', withCust?.customer_phone === '13800138000', withCust?.customer_phone)

  /* ---- 今日已完成（日体那种天天要做的单） ---- */
  const statusBefore = (await api('GET', `/api/orders/${orderId}`)).body.status
  r = await api('POST', `/api/orders/${orderId}/daily-done`, { done: true })
  ok('能标成今日已完成', r.status === 200 && r.body.daily_done_today === true, `daily_done_on=${r.body.daily_done_on}`)
  ok('标今日完成不改订单状态（不是整单完成）', r.body.status === statusBefore && r.body.status !== 'done', `${statusBefore} → ${r.body.status}`)
  // 「今天」是凌晨 4 点换日的那个 bizDate，不是日历日期
  ok('标的是「干活的今天」，不是日历日期', r.body.daily_done_on === bizDate(), `${r.body.daily_done_on} vs bizDate=${bizDate()}`)
  r = await api('GET', '/api/orders?status=open&limit=300')
  ok('标完就从「在做」列表里挪走了', !(r.body.items || []).some((o) => o.id === orderId), `${r.body.items?.length} 张在做`)
  r = await api('GET', '/api/orders?status=daily_done&limit=300')
  ok('「今日已完成」列表里能找到', (r.body.items || []).some((o) => o.id === orderId), r.body.items?.length)
  r = await api('POST', `/api/orders/${orderId}/daily-done`, { done: false })
  ok('能撤销今日完成', r.body.daily_done_today === false && !r.body.daily_done_on, String(r.body.daily_done_on))
  r = await api('GET', '/api/orders?status=open&limit=300')
  ok('撤销后回到「在做」', (r.body.items || []).some((o) => o.id === orderId), '')

  // 换日点是凌晨 4 点：干到后半夜的人，凌晨 1 点做完的日体不该算第二天
  ok(`换日点是凌晨 ${DAY_START_HOUR} 点`, DAY_START_HOUR === 4, String(DAY_START_HOUR))
  ok('凌晨 0:30 归前一天', bizDate(new Date('2026-09-22T00:30:00')) === '2026-09-21', bizDate(new Date('2026-09-22T00:30:00')))
  ok('凌晨 3:59 还归前一天', bizDate(new Date('2026-09-22T03:59:00')) === '2026-09-21', bizDate(new Date('2026-09-22T03:59:00')))
  ok('凌晨 4:00 算新的一天', bizDate(new Date('2026-09-22T04:00:00')) === '2026-09-22', bizDate(new Date('2026-09-22T04:00:00')))
  ok('白天不受影响', bizDate(new Date('2026-09-22T12:00:00')) === '2026-09-22', bizDate(new Date('2026-09-22T12:00:00')))
  ok('跨年也对（1月1日凌晨2点 → 上一年12月31日）', bizDate(new Date('2026-01-01T02:00:00')) === '2025-12-31', bizDate(new Date('2026-01-01T02:00:00')))
  ok('localDate 还是老老实实的日历日期', localDate(new Date('2026-09-22T02:00:00')) === '2026-09-22', localDate(new Date('2026-09-22T02:00:00')))

  r = await api('POST', `/api/orders/${orderId}/status`, { status: 'done' })
  ok('待付款不能直接改已完成', r.status === 400 && r.body.code === 'bad_transition', r.body)

  // 整单做完之后就不该再让它标今日完成了。
  // 用一张临时单测，测完立刻删掉 —— 否则后面那些「一共几张单」的统计全会被带偏。
  r = await api('POST', '/api/orders', {
    customer_id: custId,
    game_id: gameId,
    items: [{ service_id: svcDaily, quantity: 1 }],
  })
  const closedOrderId = r.body.id
  await api('POST', `/api/orders/${closedOrderId}/status`, { status: 'in_progress' })
  await api('POST', `/api/orders/${closedOrderId}/status`, { status: 'done' })
  r = await api('POST', `/api/orders/${closedOrderId}/daily-done`, { done: true })
  ok('已完成的单不给标今日完成', r.status === 400 && r.body.code === 'order_closed', `${r.status} ${r.body.code}`)
  r = await api('DELETE', `/api/orders/${closedOrderId}`)
  ok('临时单已清理（不影响后面的统计）', r.status === 200, r.status)

  /* ---- 拆单：把一张单里的若干服务项挪到新单，两边各自结算 ---- */
  r = await api('POST', '/api/orders', {
    customer_id: custId,
    game_id: gameId,
    title: '待拆的单',
    items: [
      { service_id: svcDaily, quantity: 10 },
      { service_id: svcAbyss, quantity: 4 },
    ],
    discount: 10,
    platform_fee: 5,
    cost: 3,
  })
  const splitId = r.body.id
  const beforeSplit = r.body
  ok('建好待拆的单', beforeSplit.items.length === 2, `${beforeSplit.order_no} ¥${beforeSplit.total}`)
  const keepItem = beforeSplit.items.find((i) => i.ref_id === svcDaily)
  const moveItem = beforeSplit.items.find((i) => i.ref_id === svcAbyss)

  r = await api('POST', `/api/orders/${splitId}/split`, { item_ids: [moveItem.id] })
  ok('拆单返回新单和原单', r.status === 200 && !!r.body.created?.id && !!r.body.original?.id, `${r.status}`)
  const created = r.body.created
  const original = r.body.original
  ok('新单号跟原单不一样', created.order_no !== original.order_no, `${original.order_no} → ${created.order_no}`)
  ok('新单拿走了被勾的那一项', created.items.length === 1 && created.items[0].ref_id === svcAbyss, created.items.map((i) => i.name).join('、'))
  ok('原单只剩没勾的那一项', original.items.length === 1 && original.items[0].ref_id === svcDaily, original.items.map((i) => i.name).join('、'))
  ok('原单金额 = 剩下的项 - 折扣', Math.abs(original.total - Math.max(0, keepItem.amount - 10)) < 0.01, `¥${original.total}（项 ¥${keepItem.amount} - 折 10）`)
  ok('新单金额 = 拆走那一项的钱', Math.abs(created.total - moveItem.amount) < 0.01, `¥${created.total} vs ¥${moveItem.amount}`)
  ok('两边的项钱加起来没变', Math.abs(original.items_subtotal + created.items_subtotal - beforeSplit.items_subtotal) < 0.01, `${original.items_subtotal} + ${created.items_subtotal} vs ${beforeSplit.items_subtotal}`)
  ok('折扣/手续费/成本留在原单', original.discount === 10 && original.platform_fee === 5 && original.cost === 3, `${original.discount}/${original.platform_fee}/${original.cost}`)
  ok('新单这几项从 0 开始', created.discount === 0 && created.platform_fee === 0 && created.cost === 0, `${created.discount}/${created.platform_fee}/${created.cost}`)
  ok('客户/游戏/日期照抄过去', created.customer_id === beforeSplit.customer_id && created.game_id === beforeSplit.game_id && created.ordered_at === beforeSplit.ordered_at, '')
  ok('标题标了来源', /拆出/.test(created.title) && /拆自/.test(created.note || ''), `${created.title} / ${created.note}`)

  // 拆完两边各自走各自的
  r = await api('POST', `/api/orders/${created.id}/status`, { status: 'in_progress' })
  r = await api('POST', `/api/orders/${created.id}/status`, { status: 'done' })
  ok('拆出来的新单能单独标完成', r.body.status === 'done', r.body.status_label)
  const origAfter = (await api('GET', `/api/orders/${splitId}`)).body
  ok('原单状态不受影响', origAfter.status === beforeSplit.status, `${beforeSplit.status_label} → ${origAfter.status_label}`)
  r = await api('POST', '/api/payments', { order_id: created.id, kind: 'full', method: '微信', amount: created.total, paid_at: '2026-09-21' })
  ok('新单能单独收款', r.status === 200, r.status)
  ok('收的钱只算在新单上', (await api('GET', `/api/orders/${created.id}`)).body.paid_total === created.total, '')
  ok('原单一分钱没收（没被带过去）', (await api('GET', `/api/orders/${splitId}`)).body.paid_total === 0, '')

  // 边界
  r = await api('POST', `/api/orders/${splitId}/split`, { item_ids: [] })
  ok('一项都没勾会被拒', r.status === 400 && r.body.code === 'nothing_selected', r.body.code)
  r = await api('POST', `/api/orders/${splitId}/split`, { item_ids: [(await api('GET', `/api/orders/${splitId}`)).body.items[0].id] })
  ok('全拆走会被拒（原单不能空）', r.status === 400 && r.body.code === 'leaves_nothing', r.body.code)
  r = await api('POST', `/api/orders/${splitId}/split`, { item_ids: [999999] })
  ok('不属于这张单的明细会被拒', r.status === 400 && r.body.code === 'bad_item', r.body.code)
  r = await api('GET', `/api/orders/${splitId}`)
  ok('被拒之后原单毫发无损', r.body.items.length === 1 && r.body.total === original.total, `${r.body.items.length} 项 ¥${r.body.total}`)

  // 清掉拆出来的两张（新单有收款，得带 force）
  await api('DELETE', `/api/orders/${created.id}?force=1`)
  r = await api('DELETE', `/api/orders/${splitId}`)
  ok('拆单测试的临时单都清理了', r.status === 200, r.status)

  /* ---- 拆单：已经收过钱的单，收款要能跟着分（不然两张单的账都是错的） ---- */
  r = await api('POST', '/api/orders', {
    customer_id: custId,
    game_id: gameId,
    title: '收过钱再拆',
    items: [
      { service_id: svcDaily, quantity: 10 },
      { service_id: svcAbyss, quantity: 4 },
    ],
  })
  const paidSplitId = r.body.id
  const paidBefore = r.body
  await api('POST', '/api/payments', { order_id: paidSplitId, kind: 'full', method: '微信', amount: paidBefore.total, paid_at: '2026-09-21' })
  await api('POST', `/api/orders/${paidSplitId}/progress`, { happened_on: '2026-09-19', content: '拆之前记的进度' })
  const paidBefore2 = (await api('GET', `/api/orders/${paidSplitId}`)).body
  ok('先把这张单收满 + 记一条进度', Math.abs(paidBefore2.paid_total - paidBefore2.total) < 0.01 && paidBefore2.progress.length === 1, `已收 ¥${paidBefore2.paid_total} / 进度 ${paidBefore2.progress.length} 条`)
  ok('收款记录本来就该带单号', paidBefore2.payments.every((p) => p.order_no === paidBefore2.order_no), paidBefore2.payments.map((p) => p.order_no || '(空)').join(','))

  const moveIt = paidBefore2.items.find((i) => i.ref_id === svcAbyss)
  r = await api('POST', `/api/orders/${paidSplitId}/split`, { item_ids: [moveIt.id], progress: 'move' })
  const pOrig = r.body.original
  const pNew = r.body.created
  ok('默认按比例把收款分了', r.body.payments_moved === 1, `分了 ${r.body.payments_moved} 笔`)
  ok('★ 两张单的已收加起来 = 原来那笔', Math.abs(pOrig.paid_total + pNew.paid_total - paidBefore2.paid_total) < 0.02, `${pOrig.paid_total} + ${pNew.paid_total} vs ${paidBefore2.paid_total}`)
  ok('★ 原单正好结清（不再多收）', Math.abs(pOrig.paid_total - pOrig.total) < 0.02 && pOrig.overpaid < 0.01, `总 ¥${pOrig.total} 已收 ¥${pOrig.paid_total}`)
  ok('★ 新单也正好结清', Math.abs(pNew.paid_total - pNew.total) < 0.02 && pNew.overpaid < 0.01, `总 ¥${pNew.total} 已收 ¥${pNew.paid_total}`)
  ok('分出来的那笔标了来源', (pNew.payments[0]?.note || '').includes('拆自'), pNew.payments[0]?.note)
  ok('两边收款记录都带单号', pOrig.payments.every((p) => p.order_no === pOrig.order_no) && pNew.payments.every((p) => p.order_no === pNew.order_no), `${pOrig.payments[0]?.order_no} / ${pNew.payments[0]?.order_no}`)
  ok('★ 选了「跟到新单」，进度整批搬过去了', pNew.progress.length === 1 && pOrig.progress.length === 0, `原 ${pOrig.progress.length} / 新 ${pNew.progress.length}`)

  // 选「全留在原单」也行，但要老实告诉你多收了
  r = await api('POST', '/api/orders', {
    customer_id: custId,
    game_id: gameId,
    title: '收款留原单',
    items: [
      { service_id: svcDaily, quantity: 10 },
      { service_id: svcAbyss, quantity: 4 },
    ],
  })
  const keepPayId = r.body.id
  await api('POST', '/api/payments', { order_id: keepPayId, kind: 'full', method: '微信', amount: r.body.total, paid_at: '2026-09-21' })
  const keepCur = (await api('GET', `/api/orders/${keepPayId}`)).body
  r = await api('POST', `/api/orders/${keepPayId}/split`, { item_ids: [keepCur.items.find((i) => i.ref_id === svcAbyss).id], payments: 'keep' })
  ok('选「全留在原单」就不分收款', r.body.payments_moved === 0, String(r.body.payments_moved))
  ok('★ 原单因此变「多收」，返回里报了数', r.body.original_overpaid > 0.001, `多收 ¥${r.body.original_overpaid}`)
  ok('新单还欠全款', Math.abs(r.body.created.due_total - r.body.created.total) < 0.01, `还欠 ¥${r.body.created.due_total}`)

  await api('DELETE', `/api/orders/${pNew.id}?force=1`)
  await api('DELETE', `/api/orders/${pOrig.id}?force=1`)
  await api('DELETE', `/api/orders/${r.body.created.id}?force=1`)
  r = await api('DELETE', `/api/orders/${keepPayId}?force=1`)
  ok('收过钱再拆的临时单也清理了', r.status === 200, r.status)

  /* ---------- 收款 ---------- */
  section('收款与状态推进')
  r = await api('POST', '/api/payments', { order_id: orderId, amount: 200, method: 'wechat', kind: 'deposit', note: '定金' })
  ok('记一笔定金 200', r.status === 200 && r.body.id > 0, r.body)
  ok('没收满不推进状态', r.body.advanced_to === null, r.body.advanced_to)

  r = await api('GET', `/api/orders/${orderId}`)
  ok('已收 200，尾款 170', r.body.paid_total === 200 && r.body.due_total === 170, { paid: r.body.paid_total, due: r.body.due_total })

  r = await api('POST', '/api/payments', { order_id: orderId, amount: 170, method: 'alipay', kind: 'balance', note: '尾款' })
  ok('收满后自动推进到进行中', r.body.advanced_to === 'in_progress', r.body.advanced_to)

  r = await api('GET', `/api/orders/${orderId}`)
  ok('订单状态已是进行中', r.body.status === 'in_progress', r.body.status)
  ok('尾款归零', r.body.due_total === 0, r.body.due_total)

  r = await api('POST', '/api/payments', { order_id: orderId, amount: 50, method: 'wechat', kind: 'refund', note: '少打一层退了点' })
  ok('记一笔退款', r.status === 200, r.body)
  r = await api('GET', `/api/orders/${orderId}`)
  ok('退款后已收变 320', r.body.paid_total === 320, r.body.paid_total)

  /* ---------- 进度 ---------- */
  section('进度时间线')
  r = await api('POST', `/api/orders/${orderId}/progress`, {
    happened_on: '2024-06-01',
    content: '清完今日委托 + 派遣，深渊打到第 6 层',
    resources_before: '原石 12000 / 树脂 160',
    resources_after: '原石 12400 / 树脂 40',
    media: ['https://example.com/shot1.png', 'https://example.com/shot2.png'],
    note: '第 6 层差一颗星',
  })
  ok('新增进度', r.status === 200 && r.body.id > 0, r.body)
  ok('进度截图存成数组', Array.isArray(r.body.media) && r.body.media.length === 2, r.body.media)
  const progressId = r.body.id

  r = await api('PATCH', `/api/progress/${progressId}`, { content: '清完今日委托 + 派遣，深渊打到第 7 层' })
  ok('修改进度内容', r.body.content.includes('第 7 层'), r.body.content)

  r = await api('GET', `/api/orders/${orderId}`)
  ok('订单详情带进度', r.body.progress?.length === 1, r.body.progress?.length)

  r = await api('DELETE', `/api/progress/${progressId}`)
  ok('删除进度', r.body.deleted === true, r.body)

  /* ---------- 状态流转 ---------- */
  section('状态流转')
  r = await api('POST', `/api/orders/${orderId}/status`, { status: 'pending_accept', note: '做完了，等验收' })
  ok('进行中 → 待验收', r.body.status === 'pending_accept', r.body.status)
  ok('改状态自动补一条进度', r.body.progress?.some((p) => p.content.includes('待验收')), r.body.progress?.map((p) => p.content))

  r = await api('POST', `/api/orders/${orderId}/status`, { status: 'done' })
  ok('待验收 → 已完成', r.body.status === 'done' && r.body.completed_at, r.body.status)
  ok('已完成带完成时间', Boolean(r.body.completed_at), r.body.completed_at)

  r = await api('GET', `/api/customers/${custId}/profile`)
  ok('客户全景：订单/收款/凭证都在', r.body.orders?.length === 1 && r.body.payments?.length === 3 && r.body.credentials?.length === 1, {
    o: r.body.orders?.length,
    p: r.body.payments?.length,
    c: r.body.credentials?.length,
  })
  ok('客户全景汇总金额正确', r.body.summary?.order_total === 370 && r.body.summary?.paid_total === 320, r.body.summary)

  /* ---------- 报价单 ---------- */
  section('报价单')
  r = await api('POST', '/api/quotes/preview', {
    items: [{ service_id: svcDaily, quantity: 30 }, { service_id: svcAbyss, quantity: 12 }],
  })
  ok('报价试算：每日 5×30=150 + 深渊 12 层命中 25/层=300 → 450', r.body.total === 450, r.body.total)

  r = await api('POST', '/api/quotes', {
    customer_id: custId,
    game_id: gameId,
    title: '小王 6 月代肝报价',
    items: [{ service_id: svcDaily, quantity: 30 }, { service_id: svcAbyss, quantity: 12 }],
    note: '包月更划算',
    valid_days: 5,
  })
  ok('保存报价单', r.status === 200 && /^BJ\d{6}-\d{3}$/.test(r.body.quote_no || ''), r.body.quote_no)
  const quoteId = r.body.id
  ok('报价单总价 450', r.body.total === 450, r.body.total)

  r = await api('GET', `/api/quotes/${quoteId}/text`)
  ok('生成报价单文本', typeof r.body.text === 'string' && r.body.text.includes('合计：450'), r.body.text?.slice(0, 120))
  ok('报价单文本含服务明细', r.body.text.includes('每日委托') && r.body.text.includes('深渊 12 层'), r.body.text?.slice(0, 200))

  r = await api('POST', `/api/quotes/${quoteId}/convert`)
  ok('报价单转订单', r.body.ok === true && r.body.order_id > 0, r.body)
  const convertedOrderId = r.body.order_id
  r = await api('GET', `/api/orders/${convertedOrderId}`)
  ok('转出的订单带快照明细', r.body.items?.length === 2 && r.body.total === 450, { n: r.body.items?.length, t: r.body.total })
  // 转出来的明细必须还能对回价格表里的服务项，否则「改明细」整单一条都改不了
  ok(
    '转出的明细保留了服务项关联（ref_id）',
    r.body.items.every((i) => i.ref_id != null),
    r.body.items.map((i) => `${i.name}:ref_id=${i.ref_id}`).join(', ')
  )
  // 改一条明细的数量，确认真的存下去了（以前这种情况整单明细都发不出去）
  const convItems = r.body.items
  const convTotal = Number(r.body.total)
  const firstQty = Number(convItems[0].quantity)
  const firstPrice = Number(convItems[0].unit_price)
  const bumpQty = firstQty + 2
  // 单价要一起带上，否则服务端会当成「没有改价」而按价格表重算
  const withQty = (q) => ({
    items: convItems.map((i, idx) => ({ service_id: i.ref_id, quantity: idx === 0 ? q : i.quantity, unit_price: i.unit_price })),
  })
  r = await api('PATCH', `/api/orders/${convertedOrderId}`, withQty(bumpQty))
  ok('改明细能保存（不再被整单忽略）', r.status === 200, r.status)
  r = await api('GET', `/api/orders/${convertedOrderId}`)
  ok('数量改动同步到了订单', Number(r.body.items[0].quantity) === bumpQty, r.body.items.map((i) => `${i.name}×${i.quantity}`).join(', '))
  ok('总价跟着重算了', Number(r.body.total) === convTotal + 2 * firstPrice, `${convTotal} → ${r.body.total}`)
  ok('明细条数没变（没被删掉）', r.body.items.length === 2, `${r.body.items.length} 条`)
  // 改回原样，免得影响后面财务口径的断言
  await api('PATCH', `/api/orders/${convertedOrderId}`, withQty(firstQty))
  r = await api('GET', `/api/orders/${convertedOrderId}`)
  ok('改回原数量后金额复原', Number(r.body.total) === convTotal, `${r.body.total} vs ${convTotal}`)

  /* ---------- 客户：归档 / 真删 ---------- */
  section('客户归档与真删')
  r = await api('POST', '/api/customers', { name: '待处理客户' })
  const tmpCust = r.body.id
  r = await api('DELETE', `/api/customers/${tmpCust}`)
  ok('客户默认删除=归档', r.body.archived === true, r.body)
  r = await api('GET', `/api/customers/${tmpCust}`)
  ok('归档后客户还在（状态 archived）', r.body.status === 'archived', r.body.status)
  r = await api('PATCH', `/api/customers/${tmpCust}`, { status: 'active' })
  ok('客户能从归档恢复', r.body.status === 'active', r.body.status)
  r = await api('DELETE', `/api/customers/${tmpCust}?hard=1`)
  ok('客户带 hard=1 才是真删', r.body.deleted === true, r.body)
  r = await api('GET', `/api/customers/${tmpCust}`)
  ok('真删后客户没了', r.status === 404, String(r.status))

  /* ---------- 导出：图片模型 / Word 文档 ---------- */
  section('导出价格表')
  r = await api('GET', '/api/pricebook/export-model')
  ok('导出模型有抬头', typeof r.body.shopName === 'string' && r.body.shopName.length > 0, r.body.shopName)
  ok('导出模型带大类和服务项', (r.body.groups || []).length > 0 && r.body.itemCount > 0, `groups=${r.body.groups?.length} items=${r.body.itemCount}`)
  const flatItems = (r.body.groups || []).flatMap((g) => g.items || [])
  ok('每项都带了格式化好的价格', flatItems.every((i) => typeof i.price === 'string' && i.price.startsWith('¥')), flatItems[0]?.price)
  ok('模型列出了涉及的每个游戏', Array.isArray(r.body.gameOptions) && r.body.gameOptions.length >= 1, JSON.stringify(r.body.gameOptions))

  // 「深渊 12 层」配了阶梯价，导出里应该出现阶梯提示
  const tieredItem = flatItems.find((i) => i.name === '深渊 12 层')
  ok('阶梯价被转成价格提示', !!tieredItem?.hint, tieredItem?.hint || '(没有 hint)')
  // 「每日委托」挂了加急增项
  const addonItem = flatItems.find((i) => i.name === '每日委托')
  ok('增项被写进说明', (addonItem?.notes || []).some((n) => n.includes('增项')), JSON.stringify(addonItem?.notes))
  ok('套餐内容被写进说明', (addonItem?.notes || []).some((n) => n.startsWith('含 ')), JSON.stringify(addonItem?.notes))

  // 按游戏拆开：单独导一个游戏，不能混进别的游戏
  const gameKeys = (r.body.gameOptions || []).filter((g) => g.key)
  if (gameKeys.length) {
    const only = gameKeys[0]
    const one = await api('GET', `/api/pricebook/export-model?game_id=${only.key}`)
    const names = [...new Set((one.body.groups || []).map((g) => g.gameName))]
    ok('单独导出的那份不含别的游戏', names.length <= 1, names.join(' / '))
    ok('单独导出只统计这个游戏的服务项', one.body.totalServices === only.count, `${one.body.totalServices} vs ${only.count}`)
  } else {
    ok('单独导出的那份不含别的游戏', true, '(只有一个游戏)')
    ok('单独导出只统计这个游戏的服务项', true, '(只有一个游戏)')
  }

  // Word 文档
  const docRes = await fetch(`${BASE}/api/pricebook/export.docx`, { headers: cookie ? { cookie } : {} })
  ok('docx 返回 200', docRes.status === 200, String(docRes.status))
  ok('docx MIME 正确', (docRes.headers.get('content-type') || '').includes('wordprocessingml'), docRes.headers.get('content-type'))
  ok('docx 带中文文件名', (docRes.headers.get('content-disposition') || '').includes("filename*=UTF-8''"))
  const docBuf = Buffer.from(await docRes.arrayBuffer())
  ok('docx 是合法 ZIP（PK 头）', docBuf[0] === 0x50 && docBuf[1] === 0x4b && docBuf[2] === 0x03 && docBuf[3] === 0x04)
  ok('docx 有实际内容', docBuf.length > 1200, `${docBuf.length} bytes`)

  const readZip = (b) => {
    let eocd = -1
    for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
    if (eocd < 0) return null
    const count = b.readUInt16LE(eocd + 10)
    let off = b.readUInt32LE(eocd + 16)
    const out = []
    for (let i = 0; i < count; i++) {
      const nameLen = b.readUInt16LE(off + 28)
      const extraLen = b.readUInt16LE(off + 30)
      const commentLen = b.readUInt16LE(off + 32)
      const method = b.readUInt16LE(off + 10)
      const compSize = b.readUInt32LE(off + 20)
      const localOff = b.readUInt32LE(off + 42)
      const name = b.slice(off + 46, off + 46 + nameLen).toString('utf8')
      const dataStart = localOff + 30 + b.readUInt16LE(localOff + 26) + b.readUInt16LE(localOff + 28)
      const raw = b.slice(dataStart, dataStart + compSize)
      out.push({ name, data: method === 8 ? zlib.inflateRawSync(raw) : raw })
      off += 46 + nameLen + extraLen + commentLen
    }
    return out
  }
  const parts = readZip(docBuf)
  ok(
    'docx 三个必需部件都在',
    ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'].every((n) => parts?.some((e) => e.name === n)),
    (parts || []).map((e) => e.name).join(', ')
  )
  const docXml = parts?.find((e) => e.name === 'word/document.xml')?.data.toString('utf8') || ''
  ok('document.xml 是合法 XML', docXml.startsWith('<?xml') && docXml.includes('<w:document ') && docXml.includes('</w:document>'))
  ok('XML 转义正确（无裸 &）', !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(docXml))
  const docTexts = [...docXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])
  ok('文档里有服务名', docTexts.includes('每日委托'), docTexts.slice(0, 8).join(' | '))
  ok('文档里有价格文本', docTexts.some((t) => t.startsWith('¥')))

  /* 公告：每个游戏一条，导出时放在最上方（图片和 Word 共用一个模型） */
  const NOTICE = '冒烟测试公告：周一到周五下单送一天'
  r = await api('PATCH', `/api/games/${gameId}`, { notice: NOTICE })
  ok('游戏能存公告', r.body.notice === NOTICE, r.body.notice)

  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  ok('单游戏导出把公告取到了', r.body.notice === NOTICE, r.body.notice)
  ok('游戏提示提到最上方后，大类上就不再重复', (r.body.groups || []).every((g) => !g.gameNotice))

  const noticeRes = await fetch(`${BASE}/api/pricebook/export.docx?game_id=${gameId}`, {
    headers: cookie ? { cookie } : {},
  })
  const noticeXml =
    readZip(Buffer.from(await noticeRes.arrayBuffer()))
      ?.find((e) => e.name === 'word/document.xml')
      ?.data.toString('utf8') || ''
  const noticeTexts = [...noticeXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])
  const iNotice = noticeTexts.indexOf(NOTICE)
  const iFirstCat = noticeTexts.indexOf('日常')
  ok('docx 里不再出现「公告」两个字', !noticeTexts.includes('公告'), noticeTexts.slice(0, 8).join(' | '))
  ok('docx 里公告正文排在第一个大类之前', iNotice >= 0 && iFirstCat > iNotice, `正文@${iNotice} 大类@${iFirstCat}`)
  ok('公告带暖色底纹和朱砂竖线', noticeXml.includes('w:fill="FDF1EA"') && noticeXml.includes('w:color="B33A22"'))

  // 清空之后不能有残留（老游戏的 notice 默认是空串）
  await api('PATCH', `/api/games/${gameId}`, { notice: '' })
  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  ok('公告清空后导出里就没有了', !r.body.notice && (r.body.groups || []).every((g) => !g.gameNotice), r.body.notice)

  /* 大类提示：排在这个大类的名字下面、服务项上面 */
  const CAT_NOTICE = '大类提示冒烟：按层数计价，10 层起接'
  r = await api('PATCH', `/api/categories/${catId}`, { notice: CAT_NOTICE })
  ok('大类能存提示', r.body.notice === CAT_NOTICE, r.body.notice)

  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const catGroup = (r.body.groups || []).find((g) => g.name === '日常')
  ok('导出模型里大类带上了自己的提示', catGroup?.catNotice === CAT_NOTICE, catGroup?.catNotice)
  ok('大类提示和游戏提示是两个字段', catGroup?.gameNotice === '', JSON.stringify(catGroup?.gameNotice))

  const catRes = await fetch(`${BASE}/api/pricebook/export.docx?game_id=${gameId}`, {
    headers: cookie ? { cookie } : {},
  })
  const catXml =
    readZip(Buffer.from(await catRes.arrayBuffer()))
      ?.find((e) => e.name === 'word/document.xml')
      ?.data.toString('utf8') || ''
  const catTexts = [...catXml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1])
  const iCat = catTexts.indexOf('日常')
  const iCatNotice = catTexts.indexOf(CAT_NOTICE)
  const iItem = catTexts.indexOf('每日委托')
  ok(
    'docx 里大类提示排在大类名之后、服务项之前',
    iCat >= 0 && iCatNotice > iCat && iItem > iCatNotice,
    `大类@${iCat} 提示@${iCatNotice} 服务项@${iItem}`
  )
  ok('大类提示也带暖色底纹和朱砂竖线', catXml.includes('w:fill="FDF1EA"') && catXml.includes('w:color="B33A22"'))
  ok('docx 里同样不出现「公告」两个字', !catTexts.includes('公告'))

  await api('PATCH', `/api/categories/${catId}`, { notice: '' })
  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  ok('大类提示清空后导出里就没有了', (r.body.groups || []).every((g) => !g.catNotice))

  /* 游戏货币：名字配在游戏上，数量配在服务项上 */
  r = await api('PATCH', `/api/games/${gameId}`, { currency: '原石' })
  ok('游戏能存货币名', r.body.currency === '原石', r.body.currency)

  const m0 = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const firstName = (m0.body.groups || []).flatMap((g) => g.items)[0]?.name
  const svcList = await api('GET', '/api/services?limit=600')
  const target = (svcList.body.items || []).find((s) => s.name === firstName)
  ok('找得到一个能改的服务项', Boolean(target), firstName)

  r = await api('PATCH', `/api/services/${target.id}`, { currency_amount: 200 })
  ok('服务项能存可获得数量', Number(r.body.currency_amount) === 200, r.body.currency_amount)

  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const withGain = (r.body.groups || []).flatMap((g) => g.items).find((i) => i.name === firstName)
  ok('导出模型里带上「可得 原石 200」', withGain?.gain === '可得 原石 200', withGain?.gain)

  const gainRes = await fetch(`${BASE}/api/pricebook/export.docx?game_id=${gameId}`, {
    headers: cookie ? { cookie } : {},
  })
  const gainTexts =
    readZip(Buffer.from(await gainRes.arrayBuffer()))
      ?.find((e) => e.name === 'word/document.xml')
      ?.data.toString('utf8')
      .match(/<w:t[^>]*>([^<]*)<\/w:t>/g)
      ?.map((t) => t.replace(/<[^>]+>/g, '')) || []
  ok('docx 里也有这一行', gainTexts.includes('可得 原石 200'), gainTexts.filter((t) => t.includes('可得')).join(' | '))

  // 游戏没配货币名 → 光有数量也不显示（免得出现一个没有单位的数字）
  await api('PATCH', `/api/games/${gameId}`, { currency: '' })
  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const noName = (r.body.groups || []).flatMap((g) => g.items).find((i) => i.name === firstName)
  ok('游戏没配货币名时不显示那个数', noName?.gain === '', JSON.stringify(noName?.gain))

  // 数量留空 → 也不显示
  await api('PATCH', `/api/games/${gameId}`, { currency: '原石' })
  await api('PATCH', `/api/services/${target.id}`, { currency_amount: null })
  r = await api('GET', `/api/pricebook/export-model?game_id=${gameId}`)
  const noAmt = (r.body.groups || []).flatMap((g) => g.items).find((i) => i.name === firstName)
  ok('数量留空时不显示', noAmt?.gain === '', JSON.stringify(noAmt?.gain))

  // 收尾：别把货币名留给后面的用例
  await api('PATCH', `/api/games/${gameId}`, { currency: '' })

  /* ---------- 财务 ---------- */
  section('财务')
  r = await api('GET', '/api/finance/summary?from=2020-01-01&to=2099-01-01')
  ok('财务汇总：订单额 820', r.body.totals?.order_total === 820, r.body.totals)
  ok('财务汇总：总收 370 / 退款 50 / 净收 320', r.body.totals?.received === 370 && r.body.totals?.refunded === 50 && r.body.totals?.net_received === 320, r.body.totals)
  ok('财务汇总：应收余额 500', r.body.totals?.due_total === 500, r.body.totals)
  ok('应收列表有未结清的单', r.body.receivables?.length >= 1, r.body.receivables?.length)
  ok('按支付方式分组', Array.isArray(r.body.by_method) && r.body.by_method.length >= 2, r.body.by_method)
  ok('按游戏分组', Array.isArray(r.body.by_game) && r.body.by_game[0]?.game_name === '原神', r.body.by_game)
  ok('按日序列非空', Array.isArray(r.body.daily) && r.body.daily.length > 2, r.body.daily?.length)

  /* ---------- 看板 / 搜索 ---------- */
  section('看板与搜索')
  r = await api('GET', '/api/dashboard')
  ok('看板统计各状态', typeof r.body.counts?.pending_confirm === 'number', r.body.counts)
  ok('看板有待收款单', r.body.unpaid_orders?.length >= 1, r.body.unpaid_orders?.length)
  ok('看板有进行中调度列表', Array.isArray(r.body.open_orders), r.body.open_orders?.length)
  ok('看板带本月利润', typeof r.body.month_money?.profit === 'number', r.body.month_money)

  r = await api('GET', '/api/search?q=小王')
  ok('搜客户命中', r.body.customers?.length === 1, r.body.customers)
  r = await api('GET', '/api/search?q=每日委托')
  ok('搜服务命中', r.body.services?.length >= 1, r.body.services)

  /* ---------- 上传 / 排序 / 归档 ---------- */
  section('上传 · 排序 · 归档')
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  r = await api('POST', '/api/uploads', { data_url: png, prefix: 'icon' })
  ok('上传图片返回可访问路径', r.status === 200 && r.body.url?.startsWith('/uploads/'), r.body)
  if (r.body.url) {
    const img = await fetch(BASE + r.body.url)
    ok('上传的图片能取回', img.status === 200 && img.headers.get('content-type') === 'image/png', img.status)
  }
  r = await api('POST', '/api/uploads', { data_url: 'data:text/html;base64,PHNjcmlwdD4=' })
  ok('非图片上传被拒', r.status === 400, r.body)

  r = await api('POST', '/api/games', { name: '绝区零' })
  const game3 = r.body.id
  r = await api('POST', '/api/reorder/games', { ids: [game3, gameId, game2] })
  ok('拖拽排序成功', r.body.count === 3, r.body)
  r = await api('GET', '/api/games')
  ok('排序生效', r.body.items?.[0]?.name === '绝区零', r.body.items?.map((g) => g.name))

  r = await api('GET', `/api/games/${gameId}/usage`)
  ok('游戏用量统计（2 个服务 / 2 张单）', r.body.services === 2 && r.body.orders === 2, r.body)

  r = await api('DELETE', `/api/games/${game3}`)
  ok('删除游戏=归档', r.body.archived === true, r.body)
  r = await api('GET', '/api/games')
  ok('归档的游戏状态是 archived', r.body.items?.find((g) => g.id === game3)?.status === 'archived', r.body.items?.map((g) => [g.name, g.status]))
  r = await api('GET', '/api/games?status=active')
  ok('按上架状态筛选', r.body.items?.every((g) => g.status === 'active'), r.body.items?.map((g) => g.status))

  /* ---------- 删除保护 / 备份 ---------- */
  section('删除保护与备份')
  r = await api('DELETE', `/api/orders/${orderId}`)
  ok('收过款的订单不允许直接删', r.status === 400 && r.body.code === 'has_payments', r.body)

  r = await api('GET', '/api/backup/export')
  ok('导出备份包含各表', r.body.data?.orders?.length === 2 && r.body.data?.credentials?.length === 1, r.body.counts)
  ok('备份说明里提示密文', String(r.body.note).includes('密文'), r.body.note)

  r = await api('POST', '/api/backup/import', { payload: r.body })
  ok('导入需要确认', r.status === 400 && r.body.code === 'need_confirm', r.body)

  /* ---------- 设置 / 改密 ---------- */
  section('设置与改密')
  r = await api('PATCH', '/api/settings', { business_name: '小枫代肝', contact: '微信 xiaofeng', evil_key: 'x' })
  ok('保存设置', r.body.business_name === '小枫代肝', r.body)
  ok('未声明的设置键被忽略', r.body.evil_key === undefined, Object.keys(r.body))

  r = await api('POST', '/api/vault/password', { current: 'Vault-Secret-2024', next: 'NewVaultPass-99' })
  ok('改保险箱密码并重加密', r.body.ok === true && r.body.reencrypted === 1, r.body)
  r = await api('POST', `/api/credentials/${credId}/reveal`, { action: 'view' })
  ok('改密后旧密文仍能解开', r.body.secret?.password === 'SuperSecret123', r.body.secret)

  /* ---------- 退出与登录 ---------- */
  section('退出与重新登录')
  r = await api('POST', '/api/auth/logout')
  ok('退出登录', r.body.ok === true, r.body)
  cookie = ''
  r = await api('GET', '/api/dashboard')
  ok('退出后访问被拒', r.status === 401, r.status)
  r = await api('POST', '/api/auth/login', { password: 'wrong' })
  ok('错误密码登录被拒', r.status === 400, r.body)
  r = await api('POST', '/api/auth/login', { password: 'admin-pass-8888' })
  ok('正确密码登录成功', r.body.ok === true, r.body)
  const sc = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).find((c) => c.startsWith('xfc_sid='))
  if (sc) cookie = sc.split(';')[0]
  r = await api('GET', '/api/auth/me')
  ok('重新登录后状态正常', r.body.authenticated === true, r.body)

  /* ---------- 结果 ---------- */
  console.log(`\n${'═'.repeat(52)}`)
  console.log(`  通过 ${pass} 项，失败 ${failures.length} 项`)
  if (failures.length) {
    console.log('  失败清单：')
    for (const f of failures) console.log(`    · ${f}`)
  }
  console.log(`${'═'.repeat(52)}\n`)
  process.exit(failures.length ? 1 : 0)
}

main().catch((err) => {
  console.error('\n冒烟测试崩了：', err)
  process.exit(2)
})
