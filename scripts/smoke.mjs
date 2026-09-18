/**
 * 后端接口冒烟测试：从零初始化到下单、收款、保险箱取用、财务结算，全流程跑一遍。
 *
 *   先启动一个干净的实例：
 *     set XFC_DATA_DIR=./data-smoke && node server.mjs --port 8790 --local
 *   再跑：
 *     node scripts/smoke.mjs
 */
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

  r = await api('POST', `/api/orders/${orderId}/status`, { status: 'done' })
  ok('待付款不能直接改已完成', r.status === 400 && r.body.code === 'bad_transition', r.body)

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
