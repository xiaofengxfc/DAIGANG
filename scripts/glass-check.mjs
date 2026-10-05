/**
 * 白玻璃外观自检
 *
 * 这个脚本的存在理由：改版之后要能证明「玻璃真的生效了、颜色真的收敛了」，
 * 而不是靠肉眼扫一眼截图。它做三件事：
 *
 *   1. 用计算样式断言外观契约（柔光层在、玻璃有 backdrop-filter、
 *      侧栏文字是深色、没有横向溢出、深色主题也玻璃化）；
 *   2. 每个页面在浅色 / 深色下各截一张图，存到 shots/glass/，供人看；
 *   3. 顺带守住「没有页面报错」。
 *
 * 用法：
 *   node scripts/glass-check.mjs               跑一遍（有问题退出码 1）
 *   node scripts/glass-check.mjs --no-shots    不截图，只跑断言
 *   XFC_GLASS_CDP_PORT=9444 node scripts/glass-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { startTestApp } from './lib/test-app.mjs'
import { findBrowser, launchBrowser, sleep, waitFor } from './lib/cdp.mjs'

const PASSWORD = 'glass-check-pass-8888'
const VAULT_PASSWORD = 'glass-check-vault-8888'
const SHOTS = !process.argv.includes('--no-shots')
const SHOT_DIR = path.resolve('shots/glass')

const ROUTES = [
  { hash: '/', label: '总览', sel: '.react-ledger' },
  { hash: '/orders', label: '订单', sel: '.orders-page' },
  { hash: '/customers', label: '客户', sel: '.customers-page' },
  { hash: '/price', label: '价格表', sel: '.price-page' },
  { hash: '/games', label: '游戏', sel: '.games-page' },
  { hash: '/finance', label: '财务', sel: '.finance-page' },
  { hash: '/quotes', label: '报价单', sel: '.quotes-page' },
  { hash: '/media', label: '自媒体', sel: '.media-page' },
  { hash: '/vault', label: '保险箱', sel: '.vault-page' },
  { hash: '/settings', label: '设置', sel: '.settings-page' },
]

let pass = 0
const failures = []

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    const text = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail)
    console.log(`  ✗ ${name}${text ? `  →  ${text.slice(0, 220)}` : ''}`)
  }
}

const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 44 - title.length))}`)

/* ---------------- 种一份够看的样本数据 ---------------- */

async function api(base, method, route, body, cookie = '') {
  const res = await fetch(base + route, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const raw = await res.text()
  let parsed = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* 非 JSON 就留着原文 */
  }
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []
  const sid = setCookies.find((c) => c.startsWith('xfc_sid='))
  return { status: res.status, body: parsed, cookie: sid ? sid.split(';')[0] : '' }
}

async function seed(base) {
  const setup = await api(base, 'POST', '/api/setup', {
    password: PASSWORD,
    confirm: PASSWORD,
    business_name: '星轨代肝小铺',
    admin_name: '老板',
    vault_password: VAULT_PASSWORD,
  })
  if (setup.status !== 200) throw new Error(`初始化失败：HTTP ${setup.status} ${JSON.stringify(setup.body)}`)
  const cookie = setup.cookie

  const game = await api(base, 'POST', '/api/games', {
    name: '鸣潮',
    short_name: 'MC',
    servers: ['官服', 'B服'],
    currency: '星声',
    note: '2.4 版本深渊刷新',
  }, cookie)
  const gid = game.body.id
  const category = await api(base, 'POST', '/api/categories', { name: '日常托管', game_id: gid }, cookie)
  const cid = category.body.id

  const fixed = await api(base, 'POST', '/api/services', {
    name: '每日委托',
    category_id: cid,
    game_id: gid,
    price_type: 'fixed',
    base_price: 8,
    description: '每天清体力 + 委托，交截图',
  }, cookie)
  const tiered = await api(base, 'POST', '/api/services', {
    name: '深渊代打',
    category_id: cid,
    game_id: gid,
    price_type: 'per_unit',
    base_price: 30,
    unit_label: '层',
    min_qty: 1,
    currency_amount: 300,
  }, cookie)
  await api(base, 'POST', `/api/services/${tiered.body.id}/tiers`, { min_qty: 1, max_qty: 5, unit_price: 30 }, cookie)
  await api(base, 'POST', `/api/services/${tiered.body.id}/tiers`, { min_qty: 6, max_qty: 12, unit_price: 25 }, cookie)
  await api(base, 'POST', '/api/services', {
    name: '全图鉴补漏',
    category_id: cid,
    game_id: gid,
    price_type: 'per_unit',
    base_price: 15,
    unit_label: '个',
    min_qty: 1,
  }, cookie)

  const customer = await api(base, 'POST', '/api/customers', { name: '林小满', phone: '13900000001', note: '老客户，只走微信' }, cookie)
  const customer2 = await api(base, 'POST', '/api/customers', { name: '周听澜', phone: '13900000002' }, cookie)

  const order = await api(base, 'POST', '/api/orders', {
    customer_id: customer.body.id,
    game_id: gid,
    title: '鸣潮 · 深渊 12 层 + 日常',
    items: [
      { service_id: tiered.body.id, quantity: 12 },
      { service_id: fixed.body.id, quantity: 1 },
    ],
    paid_amount: 200,
  }, cookie)
  await api(base, 'POST', '/api/orders', {
    customer_id: customer2.body.id,
    game_id: gid,
    title: '鸣潮 · 日常托管一个月',
    items: [{ service_id: fixed.body.id, quantity: 30 }],
  }, cookie)

  await api(base, 'POST', '/api/credentials', {
    customer_id: customer.body.id,
    game_id: gid,
    account: 'linxiaoman@example.com',
    password: 'not-a-real-password',
    note: '官服账号',
  }, cookie)

  return { orderId: order.body.id, customerId: customer.body.id }
}

/* ---------------- 外观断言 ---------------- */

const glassOf = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)})
  if (!el) return null
  const s = getComputedStyle(el)
  return {
    backdrop: s.backdropFilter || s.webkitBackdropFilter || '',
    background: s.backgroundColor,
    borderColor: s.borderTopColor,
    color: s.color,
    shadow: s.boxShadow,
  }
})()`

const rgb = (value) => {
  const m = String(value).match(/rgba?\(([^)]+)\)/)
  if (!m) return null
  const parts = m[1].split(',').map((n) => Number(n.trim()))
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
}

/** 相对亮度（0 黑 / 1 白），用来判断"这行字是深色还是浅色" */
const luma = (value) => {
  const c = rgb(value)
  if (!c) return null
  const f = (n) => {
    const v = n / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

async function checkTheme(cdp, theme, expectDark) {
  await cdp.eval(`localStorage.setItem('xfc.theme', ${JSON.stringify(theme)})`)
  await cdp.send('Page.reload', { ignoreCache: false })
  await waitFor(cdp, `Boolean(document.querySelector('.react-shell'))`, { tries: 40, interval: 200 })
  await sleep(500)

  const tag = expectDark ? '深色' : '浅色'

  // 1. 柔光层必须在：毛玻璃没有可透的东西就是一块死白
  const glow = await cdp.eval(`(() => {
    const s = getComputedStyle(document.body, '::before')
    return { bg: s.backgroundImage, pos: s.position, z: s.zIndex }
  })()`)
  ok(`${tag}：柔光层在（body::before 有径向渐变）`, /radial-gradient/.test(glow.bg), glow.bg.slice(0, 90))
  ok(`${tag}：柔光层固定在视口上`, glow.pos === 'fixed', glow.pos)

  // 2. 画布底色跟着主题走
  const canvas = await cdp.eval(`getComputedStyle(document.documentElement).backgroundColor`)
  const canvasLuma = luma(canvas)
  ok(
    `${tag}：画布底色 ${expectDark ? '偏暗' : '偏亮'}（${canvas}）`,
    canvasLuma !== null && (expectDark ? canvasLuma < 0.12 : canvasLuma > 0.7),
    canvas
  )

  // 3. 玻璃：侧栏 / 顶栏 / 面板都要有 backdrop-filter
  for (const [label, sel] of [
    ['侧栏', '.react-sidebar'],
    ['顶栏', '.react-topbar'],
    ['总览抬头', '.react-ledger'],
    ['总览面板', '.react-dashboard-panel'],
  ]) {
    const g = await cdp.eval(glassOf(sel))
    ok(`${tag}：${label}是毛玻璃（backdrop-filter: blur）`, Boolean(g) && /blur/.test(g.backdrop), g && g.backdrop)
  }

  // 4. 侧栏文字必须是深色 —— 这是从"深色侧栏"切到"白玻璃"最容易漏的地方
  const navColor = await cdp.eval(`(() => {
    const el = document.querySelector('.react-sidebar .refactor-navitem span')
    return el ? getComputedStyle(el).color : ''
  })()`)
  const navLuma = luma(navColor)
  ok(
    `${tag}：侧栏导航文字对比正确（${navColor}）`,
    navLuma !== null && (expectDark ? navLuma > 0.5 : navLuma < 0.5),
    navColor
  )

  // 5. 描边要退场：侧栏不该再有一条"实色"右边框
  const railBorder = await cdp.eval(`getComputedStyle(document.querySelector('.react-sidebar')).borderRightColor`)
  const rb = rgb(railBorder)
  ok(`${tag}：侧栏分隔线是淡的（alpha < 0.25）`, rb !== null && rb.a < 0.25, railBorder)

  // 6. 每个页面都不能横向溢出
  for (const route of ROUTES) {
    await cdp.eval(`location.hash = ${JSON.stringify('#' + route.hash)}`)
    await sleep(450)
    const geo = await cdp.eval(`({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth,
      main: document.querySelector('.react-main__inner') ? document.querySelector('.react-main__inner').scrollWidth : 0
    })`)
    ok(`${tag}·${route.label}：没有横向溢出`, geo.sw <= geo.iw + 1, `scrollWidth ${geo.sw} > 视口 ${geo.iw}`)
  }

  // 7. 截图
  if (SHOTS) {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    for (const route of ROUTES) {
      await cdp.eval(`location.hash = ${JSON.stringify('#' + route.hash)}`)
      const found = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(route.sel)}))`, { tries: 25, interval: 200 })
      await sleep(500)
      const info = await cdp.eval('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })')
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: Math.min(1440, info.w), height: Math.min(info.h, 2600), scale: 1 },
      })
      const file = path.join(SHOT_DIR, `${theme}-${route.label}${found ? '' : '-未渲染'}.png`)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    }
    console.log(`  · 截图 → shots/glass/（${theme}）`)
  }
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const browserPath = process.env.XFC_UI_BROWSER || ''
  if (!browserPath && !findBrowser()) {
    console.log('\n  没找到 Edge / Chrome，跳过外观自检。\n')
    return { skipped: true }
  }

  const app = await startTestApp()
  console.log(`\n  外观自检实例：${app.base}`)

  let browser = null
  try {
    await seed(app.base)
    browser = await launchBrowser({
      port: Number(process.env.XFC_GLASS_CDP_PORT || 9444),
      width: 1440,
      height: 900,
      browserPath,
    })
    const { cdp } = browser

    section('登录页')
    await cdp.send('Page.navigate', { url: app.base + '/' })
    const gate = await waitFor(cdp, `Boolean(document.querySelector('.refactor-gate'))`, { tries: 40, interval: 200 })
    ok('未登录时停在登录页', gate)
    const gateGlass = await cdp.eval(glassOf('.refactor-gate__panel'))
    ok('登录卡片是毛玻璃', Boolean(gateGlass) && /blur/.test(gateGlass.backdrop), gateGlass && gateGlass.backdrop)
    ok(
      '登录页不再铺网格底纹（交给柔光层）',
      await cdp.eval(`getComputedStyle(document.querySelector('.refactor-gate')).backgroundImage === 'none'`),
      await cdp.eval(`getComputedStyle(document.querySelector('.refactor-gate')).backgroundImage`)
    )
    if (SHOTS) {
      fs.mkdirSync(SHOT_DIR, { recursive: true })
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(SHOT_DIR, 'light-登录页.png'), Buffer.from(shot.data, 'base64'))
    }

    const status = await cdp.eval(
      `fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)} }) }).then((r) => r.status)`
    )
    ok('登录接口返回 200', status === 200, `HTTP ${status}`)

    section('外壳精简度')
    await cdp.send('Page.reload', { ignoreCache: false })
    await waitFor(cdp, `Boolean(document.querySelector('.react-shell'))`, { tries: 40, interval: 200 })
    await sleep(500)
    ok(
      '顶栏不再有 eyebrow「工作台」',
      (await cdp.eval(`document.querySelectorAll('.react-topbar .refactor-eyebrow').length`)) === 0
    )
    ok('顶栏不再有「本机运行」状态条', (await cdp.eval(`document.querySelectorAll('.react-online').length`)) === 0)
    ok(
      '侧栏不再有三行分组小标题',
      (await cdp.eval(`document.querySelectorAll('.react-sidebar__nav h2').length`)) === 0
    )
    ok(
      '侧栏底部收成两行（开新单 + 图标行）',
      (await cdp.eval(`document.querySelectorAll('.react-sidebar__footer > *').length`)) === 2,
      await cdp.eval(`document.querySelectorAll('.react-sidebar__footer > *').length`)
    )
    const labels = await cdp.eval(
      `[...document.querySelectorAll('.react-sidebar__footer .react-sidebar__button')].map((b) => b.textContent.trim())`
    )
    ok('主题/退出按钮只留图标（不再占一整行文字）', labels.every((t) => t === ''), JSON.stringify(labels))

    section('浅色主题')
    await checkTheme(cdp, 'light', false)

    section('深色主题')
    await checkTheme(cdp, 'dark', true)

    section('收尾')
    ok('全程没有页面报错', cdp.errors.length === 0, cdp.errors.slice(0, 3))
  } finally {
    if (browser) await browser.close()
    await app.stop()
  }
  return {}
}

let result = {}
try {
  result = await main()
} catch (err) {
  console.error('\n  外观自检崩了：' + (err.message || err))
  process.exitCode = 1
}

if (!result.skipped && !process.exitCode) {
  console.log('\n' + '═'.repeat(52))
  console.log(`  通过 ${pass} 项，失败 ${failures.length} 项`)
  if (failures.length) {
    console.log('  失败项：')
    for (const f of failures) console.log(`    · ${f}`)
  }
  console.log('═'.repeat(52) + '\n')
  if (failures.length) process.exitCode = 1
}
