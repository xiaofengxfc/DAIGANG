/**
 * 界面冒烟：真浏览器 + 真后端，走一遍主要页面，专门守住
 * 「React 页面调旧命令式表单」那条缝。
 *
 *   npm run test:ui            跑一遍，有问题就退出码 1
 *   npm run test:ui -- --shots 顺手把每个页面截一张图存到 shots/ui-smoke/
 *
 * 为什么要有它：后端接口有 242 项断言兜着，但界面这一层一条自动化都没有。
 * React 的列表页直接 import 旧模块里的抽屉/表单（paymentDrawer、servicePeek、
 * openQuoteComposer…），这类调用只有在真点下去的时候才会炸——接口测试看不见，
 * 构建也看不见。这里就是把「点一下」变成断言。
 *
 * 检查三件事：页面渲染出内容、没有页面报错、关键交互能打开抽屉。
 * 没装 Edge/Chrome 的机器上会明确跳过（退出码 0），不会假装测过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { startTestApp } from './lib/test-app.mjs'
import { findBrowser, launchBrowser, sleep, waitFor } from './lib/cdp.mjs'

const PASSWORD = 'ui-smoke-pass-8888'
const VAULT_PASSWORD = 'ui-smoke-vault-8888'
const SHOTS = process.argv.includes('--shots')
const SHOT_DIR = path.resolve('shots/ui-smoke')
const KEEP = process.env.XFC_SMOKE_KEEP === '1'

let pass = 0
const failures = []

function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    const text = detail === undefined ? '' : typeof detail === 'string' ? detail : JSON.stringify(detail)
    console.log(`  ✗ ${name}${text ? `  →  ${text.slice(0, 240)}` : ''}`)
  }
}

const section = (title) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 46 - title.length))}`)

/* ---------------- 种一份最小数据（走接口，不走界面） ---------------- */

async function api(base, method, route, body, cookie = '') {
  const res = await fetch(base + route, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
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
    business_name: 'UI冒烟小铺',
    admin_name: '老板',
    vault_password: VAULT_PASSWORD,
  })
  if (setup.status !== 200) throw new Error(`初始化失败：HTTP ${setup.status} ${JSON.stringify(setup.body)}`)
  const cookie = setup.cookie

  const game = await api(base, 'POST', '/api/games', { name: 'UI冒烟游戏', short_name: 'UI', servers: ['官服'], currency: '星声' }, cookie)
  const category = await api(base, 'POST', '/api/categories', { name: 'UI大类', game_id: game.body.id }, cookie)
  const service = await api(base, 'POST', '/api/services', {
    name: 'UI服务项',
    category_id: category.body.id,
    game_id: game.body.id,
    price_type: 'fixed',
    base_price: 12,
    description: '界面冒烟用的服务项',
  }, cookie)
  const customer = await api(base, 'POST', '/api/customers', { name: 'UI客户', phone: '13900000001' }, cookie)
  const order = await api(base, 'POST', '/api/orders', {
    customer_id: customer.body.id,
    game_id: game.body.id,
    title: 'UI冒烟单',
    items: [{ service_id: service.body.id, quantity: 1 }],
  }, cookie)
  if (order.status !== 200) throw new Error(`建单失败：HTTP ${order.status} ${JSON.stringify(order.body)}`)

  return { cookie, orderNo: order.body.order_no, game: 'UI冒烟游戏', customer: 'UI客户', service: 'UI服务项' }
}

/* ---------------- 页面检查 ---------------- */

const ROUTES = [
  { hash: '/', label: '总览', sel: '.react-shell', text: '待确认' },
  { hash: '/orders', label: '订单', sel: '.orders-page', text: 'UI客户' },
  { hash: '/customers', label: '客户', sel: '.customers-page', text: 'UI客户' },
  { hash: '/price', label: '价格表', sel: '.price-page', text: 'UI服务项' },
  { hash: '/games', label: '游戏', sel: '.games-page', text: 'UI冒烟游戏' },
  { hash: '/finance', label: '财务', sel: '.finance-page', text: '财务' },
  { hash: '/quotes', label: '报价单', sel: '.quotes-page', text: '报价单' },
  { hash: '/media', label: '自媒体', sel: '.media-page', text: '自媒体' },
  { hash: '/vault', label: '保险箱（旧视图）', sel: '.react-main__inner', text: '保险箱' },
  { hash: '/settings', label: '设置（旧视图）', sel: '.react-main__inner', text: '设置' },
]

async function gotoHash(cdp, hash) {
  await cdp.eval(`location.hash = ${JSON.stringify('#' + hash)}`)
  await sleep(400)
}

async function checkRoute(cdp, route, index) {
  const before = cdp.errors.length
  await gotoHash(cdp, route.hash)
  const found = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(route.sel)}))`, { tries: 30, interval: 200 })
  ok(`${route.label}：页面渲染出来（${route.sel}）`, found)
  const text = await cdp.eval('document.querySelector(".react-main__inner")?.innerText || ""')
  ok(`${route.label}：内容里有「${route.text}」`, text.includes(route.text), text.replace(/\s+/g, ' ').slice(0, 160))
  const errors = cdp.errors.slice(before)
  ok(`${route.label}：没有页面报错`, errors.length === 0, errors.slice(0, 2))

  if (SHOTS) {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const info = await cdp.eval('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })')
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.min(1280, info.w), height: Math.min(info.h, 2400), scale: 1 },
    })
    const file = path.join(SHOT_DIR, `${String(index).padStart(2, '0')}-${route.label.replace(/[（(].*?[)）]/g, '')}.png`)
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  }
}

/** 点一下某个按钮，等抽屉开出来，检查里面有没有该有的字，然后关掉 */
async function checkDrawer(cdp, { label, hash, click, expect, expectText }) {
  const before = cdp.errors.length
  await gotoHash(cdp, hash)
  const ready = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(click)}))`, { tries: 30, interval: 200 })
  ok(`${label}：按钮在（${click}）`, ready)
  if (!ready) return

  await cdp.eval(`document.querySelector(${JSON.stringify(click)}).click()`)
  const opened = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(expect)}))`, { tries: 25, interval: 200 })
  const dialogText = await cdp.eval(`document.querySelector(${JSON.stringify(expect)})?.innerText || ""`)
  ok(`${label}：抽屉打开了（${expect}）`, opened, dialogText.slice(0, 120))
  if (opened && expectText) ok(`${label}：抽屉里有「${expectText}」`, dialogText.includes(expectText), dialogText.replace(/\s+/g, ' ').slice(0, 160))
  const errors = cdp.errors.slice(before)
  ok(`${label}：打开过程没有报错`, errors.length === 0, errors.slice(0, 2))

  // 关掉，别影响下一项
  await cdp.eval(`document.querySelector(${JSON.stringify(expect)})?.close()`)
  await sleep(250)
}

/* ---------------- 主流程 ---------------- */

async function main() {
  const browserPath = process.env.XFC_UI_BROWSER || ''
  if (browserPath && !fs.existsSync(browserPath)) {
    // 还没起实例就先挡下来，免得白建一个数据目录
    console.error(`\n  XFC_UI_BROWSER 指向的浏览器不存在：${browserPath}\n`)
    return { crashed: true }
  }
  if (!browserPath && !findBrowser()) {
    console.log('\n  没找到 Edge / Chrome，跳过界面冒烟（装一个浏览器再跑，或用 XFC_UI_BROWSER 指定路径）。\n')
    return { skipped: true }
  }

  const app = await startTestApp()
  console.log(`\n  界面冒烟实例：${app.base}（数据目录 ${app.dataDir}）`)

  let browser = null
  let crashed = null
  try {
    const fixture = await seed(app.base)

    browser = await launchBrowser({ port: Number(process.env.XFC_UI_CDP_PORT || 9333), width: 1280, height: 900, browserPath })
    const { cdp } = browser

    section('登录')
    await cdp.send('Page.navigate', { url: app.base + '/' })
    const gate = await waitFor(cdp, `Boolean(document.querySelector('.refactor-gate'))`, { tries: 40, interval: 200 })
    ok('未登录时停在登录页', gate)
    const status = await cdp.eval(
      `fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: ${JSON.stringify(PASSWORD)} }) }).then((r) => r.status)`
    )
    ok('登录接口返回 200', status === 200, `HTTP ${status}`)
    await cdp.send('Page.reload', { ignoreCache: false })
    const shell = await waitFor(cdp, `Boolean(document.querySelector('.react-shell'))`, { tries: 40, interval: 200 })
    ok('登录后进入工作台外壳', shell)
    if (!shell) throw new Error('登录后没进到工作台，后面的页面检查没有意义')

    section('页面渲染')
    let index = 1
    for (const route of ROUTES) {
      await checkRoute(cdp, route, index++)
    }

    section('点开抽屉（React 调旧表单的那条缝）')
    await checkDrawer(cdp, {
      label: '价格表 · 看服务详情',
      hash: '/price',
      click: 'button[title="查看服务详情"]',
      expect: 'dialog.drawer[open]',
      expectText: fixture.service,
    })
    await checkDrawer(cdp, {
      label: '订单 · 记收款',
      hash: '/orders',
      click: 'button[title="记收款"]',
      expect: 'dialog.drawer[open]',
      expectText: fixture.orderNo,
    })
    await checkDrawer(cdp, {
      label: '订单 · 记进度',
      hash: '/orders',
      click: 'button[title="记进度"]',
      expect: 'dialog.drawer[open]',
      expectText: '这次做了什么',
    })
    await checkDrawer(cdp, {
      label: '报价单 · 做报价单（顶部动作）',
      hash: '/quotes',
      click: '.refactor-top-action',
      expect: 'dialog[open]',
    })

    section('收尾')
    ok('全程没有页面报错', cdp.errors.length === 0, cdp.errors.slice(0, 3))
  } catch (err) {
    crashed = err
  } finally {
    // 关浏览器失败也要保证实例关掉，否则进程会挂着
    if (browser) await browser.close().catch(() => {})
    await app.stop()
  }

  if (crashed) {
    console.error('\n界面冒烟崩了：', crashed)
    console.log(`\n  数据目录保留在 ${app.dataDir}（不需要就删掉）\n`)
    return { crashed: true }
  }

  console.log(`\n${'═'.repeat(52)}`)
  console.log(`  通过 ${pass} 项，失败 ${failures.length} 项`)
  if (failures.length) {
    console.log('  失败清单：')
    for (const name of failures) console.log(`    · ${name}`)
  }
  console.log(`${'═'.repeat(52)}\n`)

  if (!failures.length && !KEEP) fs.rmSync(app.dataDir, { recursive: true, force: true })
  else console.log(`  数据目录保留在 ${app.dataDir}（不需要就删掉）\n`)
  return { failures }
}

const result = await main()
process.exitCode = result.crashed || (result.failures && result.failures.length) ? 1 : 0
