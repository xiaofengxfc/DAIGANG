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
const NEW_GAME = 'UI新建游戏'
const NEW_CUSTOMER = 'UI新客户'
const NEW_CATEGORY = 'UI新大类'
const PROGRESS_TEXT = '清完今日委托，深渊打到第 7 层'
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
  // 带阶梯价的服务项：组合报价弹窗里的钱要对得上（1-5 层 30，6-12 层 25）
  const tiered = await api(base, 'POST', '/api/services', {
    name: 'UI阶梯服务',
    category_id: category.body.id,
    game_id: game.body.id,
    price_type: 'per_unit',
    base_price: 30,
    unit_label: '层',
    min_qty: 1,
    currency_amount: 300,
  }, cookie)
  await api(base, 'POST', `/api/services/${tiered.body.id}/tiers`, { min_qty: 1, max_qty: 5, unit_price: 30 }, cookie)
  await api(base, 'POST', `/api/services/${tiered.body.id}/tiers`, { min_qty: 6, max_qty: 12, unit_price: 25 }, cookie)
  // 留着给「详情抽屉里删服务项」那条链路用（没被任何订单用过，删得掉）
  const doomed = await api(base, 'POST', '/api/services', {
    name: 'UI待删服务',
    category_id: category.body.id,
    game_id: game.body.id,
    price_type: 'fixed',
    base_price: 1,
  }, cookie)
  const customer = await api(base, 'POST', '/api/customers', { name: 'UI客户', phone: '13900000001' }, cookie)
  const order = await api(base, 'POST', '/api/orders', {
    customer_id: customer.body.id,
    game_id: game.body.id,
    title: 'UI冒烟单',
    items: [{ service_id: service.body.id, quantity: 1 }],
  }, cookie)
  if (order.status !== 200) throw new Error(`建单失败：HTTP ${order.status} ${JSON.stringify(order.body)}`)

  return { cookie, orderNo: order.body.order_no, customerId: customer.body.id, game: 'UI冒烟游戏', customer: 'UI客户', service: 'UI服务项', categoryId: category.body.id, tiered: 'UI阶梯服务', doomed: doomed.body.name }
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

/**
 * 往输入框里塞值。
 * 直接 `el.value = x` 对 React 受控组件无效——React 内部记着上一次的值，
 * 看见没变化就不触发 onChange。必须走原型上的原生 setter，再补一个 input 事件，
 * React 的 value tracker 才会认（对旧表单同样有效，旧表单是提交时才读 DOM）。
 */
async function fillField(cdp, selector, value) {
  return cdp.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing'
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()`)
}

const OPEN_DRAWER = 'dialog.drawer[open]'
const SUBMIT = `${OPEN_DRAWER} .drawer__foot button[type="submit"]`

/**
 * 给「某一行的数量框」塞值。
 * 组合报价弹窗里每行都有一个数量框，直接写 `.pickrow input.inp` 会命中第一行
 * （很可能是没勾的那个），所以必须先按行里的文字找到那一行。
 */
function fillRowQty(cdp, rowName, value) {
  return cdp.eval(`(() => {
    const row = [...document.querySelectorAll('dialog.modal[open] .pickrow')].find((r) => r.innerText.includes(${JSON.stringify(rowName)}))
    if (!row) return 'missing'
    const el = row.querySelector('input.inp')
    if (!el) return 'missing'
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()`)
}

/**
 * 把 navigator.clipboard.writeText 换成一个记录器。
 * 「复制给客户的报价」是这一页的核心产出之一，格式错了比报错还难发现，
 * 所以这里不去赌无头浏览器的剪贴板权限，直接把传进剪贴板 API 的那段字截下来看。
 */
function captureClipboard(cdp) {
  return cdp.eval(`(() => {
    window.__copied = null
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: (text) => { window.__copied = String(text); return Promise.resolve() } },
      })
      return true
    } catch (err) {
      return String((err && err.message) || err)
    }
  })()`)
}

const readClipboard = (cdp) => cdp.eval('window.__copied')

/**
 * 把 <a download> 的点击截下来。
 * 「生成图片 / 生成 Word」最后都是 downloadBlob() 造一个 a 元素点一下，
 * 这里拦住那一下，就能看出到底生成了什么文件名，而不必真往磁盘上写文件。
 */
function captureDownloads(cdp) {
  return cdp.eval(`(() => {
    window.__downloads = []
    const original = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        window.__downloads.push({ name: this.download, href: String(this.href).slice(0, 24) })
        return undefined
      }
      return original.apply(this, arguments)
    }
    return true
  })()`)
}

/** 价格表里所有服务项（页面就是这么读的，验证也用同一个接口） */
async function pricebookServices(app, cookie) {
  const res = await api(app.base, 'GET', '/api/pricebook?status=all', undefined, cookie)
  const services = []
  for (const category of res.body.categories || []) for (const service of category.services || []) services.push(service)
  for (const service of res.body.loose || []) services.push(service)
  return services
}

/** 顶层浮层：叠了好几层时，最后挂上去的那个才是用户看到的那层 */
const TOP_DRAWER = '[...document.querySelectorAll("dialog.drawer[open]")].pop()'

/** 点最上层抽屉里带这段文字的按钮 */
function clickTopDrawer(cdp, text) {
  return cdp.eval(`(() => {
    const top = ${TOP_DRAWER}
    if (!top) return false
    const btn = [...top.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

/** 给最上层抽屉里的某个字段塞值（表单叠了多层时不能只按 id 找） */
function fillTopField(cdp, selector, value) {
  return cdp.eval(`(() => {
    const top = ${TOP_DRAWER}
    const el = top && top.querySelector(${JSON.stringify(selector)})
    if (!el) return 'missing'
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()`)
}

/** 提交最上层抽屉 */
function submitTopDrawer(cdp) {
  return cdp.eval(`(() => {
    const top = ${TOP_DRAWER}
    const btn = top && top.querySelector('.drawer__foot button[type="submit"]')
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

const drawerCountText = 'document.querySelectorAll("dialog.drawer[open]").length'
const modalCountText = 'document.querySelectorAll("dialog.modal[open]").length'
const drawerCount = (cdp) => cdp.eval(drawerCountText)
const modalCount = (cdp) => cdp.eval(modalCountText)
const topText = (cdp) => cdp.eval(`(${TOP_DRAWER})?.innerText.replace(/\\s+/g, ' ') || ''`)
const topTitle = (cdp) => cdp.eval(`(${TOP_DRAWER})?.querySelector('.drawer__title')?.textContent || ''`)
const closeTopDrawer = (cdp) => cdp.eval(`(() => { const top = ${TOP_DRAWER}; if (top) top.close(); return true })()`)

/** 点主区域里带这段文字的按钮（旧视图和 React 页面的类名不同，按文字找最稳） */
function clickInMain(cdp, text, root = '.react-main__inner') {
  return cdp.eval(`(() => {
    const btn = [...document.querySelectorAll(${JSON.stringify(root + ' button')})].find((b) => b.textContent.includes(${JSON.stringify(text)}) && !b.disabled)
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

/** 点顶栏里带这段文字的动作按钮（旧视图的动作按钮类名和 React 的不一样，按文字找最稳） */
function clickTopAction(cdp, text) {
  return cdp.eval(`(() => {
    const btn = [...document.querySelectorAll('.react-topbar__tools button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))
    if (!btn) return false
    btn.click()
    return true
  })()`)
}

/**
 * 把「新 React 表单」和「旧命令式表单」并排比一遍。
 * 迁移最怕的是结构悄悄变了（少个字段、宽度不对、页脚按钮换了），
 * 这些东西肉眼不一定当场看得出来，量出来比最实在。
 */
function compareForms(ok, legacy, fresh, { prefix = '', checkTitle = true } = {}) {
  ok(`${prefix}两边都量到了`, Boolean(legacy) && Boolean(fresh))
  if (!legacy || !fresh) return
  if (checkTitle) ok(`${prefix}标题一致`, legacy.title === fresh.title, `${legacy.title} / ${fresh.title}`)
  ok(`${prefix}抽屉宽窄一致（wide=${fresh.wide}）`, legacy.wide === fresh.wide, `${legacy.wide} / ${fresh.wide}`)
  const legacyLabels = legacy.fields.map((f) => f.label)
  const freshLabels = fresh.fields.map((f) => f.label)
  ok(`${prefix}字段数量和顺序一致`, JSON.stringify(legacyLabels) === JSON.stringify(freshLabels), `旧 ${legacyLabels.join('/')} 新 ${freshLabels.join('/')}`)
  ok(`${prefix}半宽 / 整宽布局一致`, JSON.stringify(legacy.fields.map((f) => f.half)) === JSON.stringify(fresh.fields.map((f) => f.half)))
  ok(`${prefix}控件类型一致`, JSON.stringify(legacy.fields.map((f) => f.control)) === JSON.stringify(fresh.fields.map((f) => f.control)), `旧 ${legacy.fields.map((f) => f.control).join('/')} 新 ${fresh.fields.map((f) => f.control).join('/')}`)
  ok(`${prefix}提示文字都在`, JSON.stringify(legacy.fields.map((f) => f.hint)) === JSON.stringify(fresh.fields.map((f) => f.hint)))
  ok(`${prefix}抽屉宽度一致`, Math.abs(legacy.drawer.w - fresh.drawer.w) <= 1, `${legacy.drawer.w} / ${fresh.drawer.w}`)
  const widthDiff = legacy.fields
    .map((f, i) => ({ 字段: f.label, 旧: f.box.w, 新: fresh.fields[i] ? fresh.fields[i].box.w : null }))
    .filter((d) => d.新 === null || Math.abs(d.旧 - d.新) > 1)
  ok(`${prefix}每个字段的宽度一致`, widthDiff.length === 0, `宽度不同的字段：${JSON.stringify(widthDiff)}`)
  ok(`${prefix}页脚按钮一致`, JSON.stringify(legacy.foot) === JSON.stringify(fresh.foot), `旧 ${legacy.foot.join('/')} 新 ${fresh.foot.join('/')}`)
}

/**
 * 量一个抽屉表单的结构和几何。
 * 用来把「新 React 表单」和「旧命令式表单」放在一起比 —— 迁移最怕的是
 * 结构变了（少个字段、宽度不对、页脚按钮换了），肉眼不一定当场看得出来。
 */
function measureForm(cdp, root = OPEN_DRAWER) {
  return cdp.eval(`(() => {
    const dlg = document.querySelector(${JSON.stringify(root)})
    if (!dlg) return null
    const box = (el) => {
      const r = el.getBoundingClientRect()
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
    }
    const grid = dlg.querySelector('.formgrid')
    return {
      drawer: box(dlg),
      wide: dlg.classList.contains('drawer--wide'),
      title: (dlg.querySelector('.drawer__title') || {}).textContent || '',
      grid: grid ? box(grid) : null,
      fields: [...dlg.querySelectorAll('.field')].map((f) => ({
        label: ((f.querySelector('.lbl') || {}).textContent || '').replace('*', '').trim(),
        half: !f.classList.contains('field--full'),
        hint: Boolean(f.querySelector('.hint')),
        control: (f.querySelector('input,textarea,select') || {}).tagName || 'custom',
        box: box(f),
      })),
      foot: [...dlg.querySelectorAll('.drawer__foot button')].map((b) => b.textContent.trim()),
    }
  })()`)
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

  // 关掉，别影响下一项。关完必须真的一层不剩 ——
  // 只把 dialog 关掉、React 那边没卸载的话，残留的元素会污染后面的检查。
  await cdp.eval(`document.querySelector(${JSON.stringify(expect)})?.close()`)
  await sleep(250)
  const left = await cdp.eval(`document.querySelectorAll('dialog[open]').length`)
  ok(`${label}：关掉后没有残留浮层`, left === 0, `还剩 ${left} 层`)
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

    /* ---- 填表提交：新的 React 表单（游戏） ---- */
    section('填表提交 · 新的 React 表单（新建游戏）')
    {
      const before = cdp.errors.length
      await gotoHash(cdp, '/games')
      ok('游戏页有「新建游戏」顶部按钮', await waitFor(cdp, `Boolean(document.querySelector('.refactor-top-action'))`, { tries: 30, interval: 200 }))
      await cdp.eval(`document.querySelector('.refactor-top-action').click()`)
      ok('React 抽屉打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      const title = await cdp.eval(`document.querySelector('.drawer__title')?.textContent || ''`)
      ok('抽屉标题是「新建游戏」', title.includes('新建游戏'), title)

      // 空着直接提交：应当被校验拦住，抽屉不能关
      await cdp.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).click()`)
      await sleep(300)
      const errText = await cdp.eval(`document.querySelector(${JSON.stringify(`${OPEN_DRAWER} .err:not([hidden])`)})?.textContent || ''`)
      ok('空游戏名被校验拦住', errText.includes('请填写游戏名'), errText)
      ok('被拦住时抽屉不关', await cdp.eval(`Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`))

      await fillField(cdp, `${OPEN_DRAWER} #game-name`, NEW_GAME)
      await fillField(cdp, `${OPEN_DRAWER} #game-servers`, '官服, 国际服')
      await fillField(cdp, `${OPEN_DRAWER} #game-currency`, '星声')
      await cdp.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).click()`)

      ok('保存后抽屉自己关掉', await waitFor(cdp, `!document.querySelector(${JSON.stringify(OPEN_DRAWER)})`, { tries: 40, interval: 200 }))
      const listed = await waitFor(cdp, `(document.querySelector('.games-list')?.innerText || '').includes(${JSON.stringify(NEW_GAME)})`, { tries: 40, interval: 200 })
      ok('列表里出现了新游戏（保存后自动刷新）', listed, await cdp.eval(`document.querySelector('.games-list')?.innerText || ''`))

      const fetched = await api(app.base, 'GET', `/api/games?q=${encodeURIComponent(NEW_GAME)}`, undefined, fixture.cookie)
      const row = (fetched.body.items || [])[0]
      ok('接口里确实落了这条游戏', Boolean(row) && row.name === NEW_GAME, row)
      ok('区服按逗号拆成了数组', JSON.stringify(row && row.servers) === JSON.stringify(['官服', '国际服']), row && row.servers)
      ok('货币名称也存进去了', Boolean(row) && row.currency === '星声', row && row.currency)
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 新旧表单长得一样吗（几何对比） ---- */
    section('新旧表单对比 · 游戏表单')
    {
      // 旧的游戏表单还能从 /games/:id（旧视图接管的那条子路由）打开，
      // 正好拿来和新表单并排量一遍。
      await gotoHash(cdp, '/games/1')
      const legacyBtn = await waitFor(cdp, `[...document.querySelectorAll('.react-topbar__tools button')].some((b) => b.textContent.includes('新建游戏'))`, { tries: 30, interval: 200 })
      ok('旧视图那条路由上有「新建游戏」', legacyBtn)
      await clickTopAction(cdp, '新建游戏')
      const legacyOpened = await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 })
      ok('旧表单抽屉打开了', legacyOpened)
      const legacy = await measureForm(cdp)
      await cdp.eval(`document.querySelector(${JSON.stringify(OPEN_DRAWER)}).close()`)
      await sleep(300)

      await gotoHash(cdp, '/games')
      await clickTopAction(cdp, '新建游戏')
      await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 })
      const fresh = await measureForm(cdp)
      await cdp.eval(`document.querySelector(${JSON.stringify(OPEN_DRAWER)}).close()`)
      await sleep(300)

      compareForms(ok, legacy, fresh)
    }

    /* ---- 客户表单：几何对比 + 填表提交 ---- */
    section('客户表单 · 新旧对比与提交')
    {
      const before = cdp.errors.length

      // 旧的客户表单在客户档案详情页（/customers/:id，还是旧视图）的「改资料」里
      await gotoHash(cdp, `/customers/${fixture.customerId}`)
      const legacyReady = await waitFor(cdp, `[...document.querySelectorAll('.react-topbar__tools button')].some((b) => b.textContent.includes('改资料'))`, { tries: 30, interval: 200 })
      ok('客户档案页有「改资料」', legacyReady)
      await clickTopAction(cdp, '改资料')
      ok('旧客户表单打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      const legacy = await measureForm(cdp)
      await cdp.eval(`document.querySelector(${JSON.stringify(OPEN_DRAWER)}).close()`)
      await sleep(300)

      await gotoHash(cdp, '/customers')
      await clickTopAction(cdp, '新建客户')
      ok('React 客户表单打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      const fresh = await measureForm(cdp)
      // 标题本来就不同（「改客户资料」对「新客户」），其余结构必须一致
      compareForms(ok, legacy, fresh, { prefix: '客户表单：', checkTitle: false })

      // 空昵称提交要被拦住
      await cdp.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).click()`)
      await sleep(300)
      const errText = await cdp.eval(`document.querySelector(${JSON.stringify(`${OPEN_DRAWER} .err:not([hidden])`)})?.textContent || ''`)
      ok('空昵称被校验拦住', errText.includes('请填写昵称'), errText)
      ok('被拦住时抽屉不关', await cdp.eval(`Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`))

      await fillField(cdp, `${OPEN_DRAWER} #customer-name`, NEW_CUSTOMER)
      await fillField(cdp, `${OPEN_DRAWER} #customer-phone`, '13900000002')
      await fillField(cdp, `${OPEN_DRAWER} #customer-wechat`, 'ui_smoke_wx')
      await fillField(cdp, `${OPEN_DRAWER} #customer-tags`, '爽快, 老客户')
      await fillField(cdp, `${OPEN_DRAWER} #customer-source`, '闲鱼')
      await cdp.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).click()`)

      ok('保存后抽屉自己关掉', await waitFor(cdp, `!document.querySelector(${JSON.stringify(OPEN_DRAWER)})`, { tries: 40, interval: 200 }))
      const listed = await waitFor(cdp, `(document.querySelector('.customers-list')?.innerText || '').includes(${JSON.stringify(NEW_CUSTOMER)})`, { tries: 40, interval: 200 })
      ok('列表里出现了新客户（保存后自动刷新）', listed, await cdp.eval(`document.querySelector('.customers-list')?.innerText || ''`))

      const fetched = await api(app.base, 'GET', `/api/customers?q=${encodeURIComponent(NEW_CUSTOMER)}`, undefined, fixture.cookie)
      const row = (fetched.body.items || [])[0]
      ok('接口里确实落了这位客户', Boolean(row) && row.name === NEW_CUSTOMER, row)
      ok('标签按逗号拆成了数组', JSON.stringify(row && row.tags) === JSON.stringify(['爽快', '老客户']), row && row.tags)
      ok('来源存的是下拉里选的那项', Boolean(row) && row.source === '闲鱼', row && row.source)
      ok('微信也存进去了', Boolean(row) && row.wechat === 'ui_smoke_wx', row && row.wechat)
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- React 确认框（含取消路径） ---- */
    section('确认框 · 归档游戏')
    {
      const before = cdp.errors.length
      const clickArchive = () => cdp.eval(`(() => {
        const row = [...document.querySelectorAll('.games-row')].find((r) => r.innerText.includes(${JSON.stringify(NEW_GAME)}))
        if (!row) return false
        row.querySelector('button[title="归档游戏"]').click()
        return true
      })()`)
      const rowText = () => cdp.eval(`([...document.querySelectorAll('.games-row')].find((r) => r.innerText.includes(${JSON.stringify(NEW_GAME)})) || {}).innerText || ''`)

      await gotoHash(cdp, '/games')
      ok('找到要归档的那一行', await waitFor(cdp, `[...document.querySelectorAll('.games-row')].some((r) => r.innerText.includes(${JSON.stringify(NEW_GAME)}))`, { tries: 30, interval: 200 }))

      await clickArchive()
      ok('确认框弹出来了（React 的 dialog.modal）', await waitFor(cdp, `Boolean(document.querySelector('dialog.modal[open]'))`, { tries: 25, interval: 200 }))
      const modalTitle = await cdp.eval(`document.querySelector('dialog.modal[open] .modal__title')?.textContent || ''`)
      ok('确认框标题带上了游戏名', modalTitle.includes(NEW_GAME) && modalTitle.includes('归档'), modalTitle)

      // 先点取消：什么都不该发生
      await cdp.eval(`[...document.querySelectorAll('dialog.modal[open] .modal__foot button')].find((b) => b.textContent.includes('取消')).click()`)
      ok('取消后确认框关掉', await waitFor(cdp, `!document.querySelector('dialog.modal[open]')`, { tries: 25, interval: 200 }))
      await sleep(400)
      ok('取消之后游戏还是上架状态', !(await rowText()).includes('已归档'), await rowText())

      // 再点一次，这回确认
      await clickArchive()
      await waitFor(cdp, `Boolean(document.querySelector('dialog.modal[open]'))`, { tries: 25, interval: 200 })
      await cdp.eval(`[...document.querySelectorAll('dialog.modal[open] .modal__foot button')].find((b) => b.textContent.trim() === '归档').click()`)
      ok('确认后确认框关掉', await waitFor(cdp, `!document.querySelector('dialog.modal[open]')`, { tries: 25, interval: 200 }))
      const archived = await waitFor(cdp, `([...document.querySelectorAll('.games-row')].find((r) => r.innerText.includes(${JSON.stringify(NEW_GAME)})) || {}).innerText?.includes('已归档')`, { tries: 40, interval: 200 })
      ok('列表里那行变成已归档', archived, await rowText())

      const fetched = await api(app.base, 'GET', `/api/games?q=${encodeURIComponent(NEW_GAME)}`, undefined, fixture.cookie)
      ok('接口里状态也变成 archived 了', (fetched.body.items || [])[0]?.status === 'archived', (fetched.body.items || [])[0]?.status)
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 价格表：大类表单（几何对比 + 提交）---- */
    section('价格表 · 大类表单')
    {
      const before = cdp.errors.length

      // 旧大类表单：/price/1 是旧价格表视图接管的那条路由
      await gotoHash(cdp, '/price/1')
      ok('旧价格表视图里有「新建大类」', await waitFor(cdp, `[...document.querySelectorAll('.react-main__inner button')].some((b) => b.textContent.includes('新建大类'))`, { tries: 30, interval: 200 }))
      await clickInMain(cdp, '新建大类')
      ok('旧大类表单打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      const legacy = await measureForm(cdp)
      await cdp.eval(`document.querySelector(${JSON.stringify(OPEN_DRAWER)}).close()`)
      await sleep(300)

      await gotoHash(cdp, '/price')
      await clickInMain(cdp, '新建大类')
      ok('React 大类表单打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      const fresh = await measureForm(cdp)
      compareForms(ok, legacy, fresh)

      await cdp.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).click()`)
      await sleep(300)
      const errText = await cdp.eval(`document.querySelector(${JSON.stringify(`${OPEN_DRAWER} .err:not([hidden])`)})?.textContent || ''`)
      ok('空大类名被校验拦住', errText.includes('请填写大类名称'), errText)

      await fillField(cdp, `${OPEN_DRAWER} #category-name`, NEW_CATEGORY)
      await fillField(cdp, `${OPEN_DRAWER} #category-notice`, '本大类按层数计价，10 层起接。')
      await cdp.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).click()`)
      ok('保存后抽屉自己关掉', await waitFor(cdp, `!document.querySelector(${JSON.stringify(OPEN_DRAWER)})`, { tries: 40, interval: 200 }))
      const listed = await waitFor(cdp, `(document.querySelector('.price-page')?.innerText || '').includes(${JSON.stringify(NEW_CATEGORY)})`, { tries: 40, interval: 200 })
      ok('价格表里出现了新大类（保存后自动刷新）', listed)

      const fetched = await api(app.base, 'GET', '/api/categories', undefined, fixture.cookie)
      const row = (fetched.body.items || []).find((item) => item.name === NEW_CATEGORY)
      ok('接口里确实落了这个大类', Boolean(row), row)
      ok('没绑游戏就存成 null（通用）', Boolean(row) && row.game_id === null, row && row.game_id)
      ok('大类提示也存进去了', Boolean(row) && row.notice === '本大类按层数计价，10 层起接。', row && row.notice)
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 价格表：组合报价（钱要对）---- */
    section('价格表 · 组合报价')
    {
      const before = cdp.errors.length
      await gotoHash(cdp, '/price')
      ok('大类上有「组合报价」按钮', await waitFor(cdp, `Boolean(document.querySelector('button[title="组合报价"]'))`, { tries: 30, interval: 200 }))
      await cdp.eval(`document.querySelector('button[title="组合报价"]').click()`)
      ok('组合报价弹窗打开了', await waitFor(cdp, `Boolean(document.querySelector('dialog.modal[open] .picker'))`, { tries: 25, interval: 200 }))

      const modalText = () => cdp.eval(`document.querySelector('dialog.modal[open]')?.innerText || ''`)
      const copyDisabled = () => cdp.eval(`[...document.querySelectorAll('dialog.modal[open] .modal__foot button')].find((b) => b.textContent.includes('复制报价'))?.disabled`)
      const sumText = () => cdp.eval(`document.querySelector('dialog.modal[open] .sumline')?.innerText.replace(/\\s+/g, ' ') || ''`)
      const pickRow = (name) => cdp.eval(`(() => {
        const row = [...document.querySelectorAll('dialog.modal[open] .pickrow')].find((r) => r.innerText.includes(${JSON.stringify(name)}))
        if (!row) return false
        row.querySelector('.pickrow__main').click()
        return true
      })()`)

      ok('没勾之前「复制报价」是灰的', (await copyDisabled()) === true)
      ok('合计一开始是 ¥0', (await sumText()).includes('¥0'), await sumText())

      ok('勾上带阶梯价的服务项', await pickRow('UI阶梯服务'))
      await sleep(250)
      ok('勾 1 层时按第一档 ¥30 算', (await sumText()).includes('¥30'), await sumText())
      ok('勾上之后「复制报价」可以点了', (await copyDisabled()) === false)

      // 数量改成 8 → 命中第二档（6-12 层 25 元/层）→ 200
      ok('把阶梯服务那一行的数量改成 8', (await fillRowQty(cdp, 'UI阶梯服务', '8')) === '8')
      await sleep(300)
      ok('改成 8 层自动套第二档，合计 ¥200', (await sumText()).includes('¥200'), await sumText())
      ok('行内提示写清了单价', (await modalText()).includes('单价 ¥25'), (await modalText()).replace(/\s+/g, ' ').slice(0, 200))

      // 再加一个固定价 12 的服务项 → 212
      ok('再勾一个固定价服务项', await pickRow('UI服务项'))
      await sleep(300)
      ok('两项合计 ¥212', (await sumText()).includes('¥212'), await sumText())
      ok('合计旁边显示已选几项', (await sumText()).includes('已选 2 项'), await sumText())

      // 复制出去的那段字是要直接粘给客户的，格式和旧版必须一字不差
      await captureClipboard(cdp)
      await cdp.eval(`[...document.querySelectorAll('dialog.modal[open] .modal__foot button')].find((b) => b.textContent.includes('复制报价')).click()`)
      await sleep(400)
      const copied = await readClipboard(cdp)
      ok('复制出去的报价单和旧版格式一致', copied === '【UI大类】\nUI服务项  1单 × ¥12 = ¥12\nUI阶梯服务  8层 × ¥25 = ¥200\n合计：¥212', JSON.stringify(copied))
      ok('复制完弹窗不关（方便接着调数量）', await cdp.eval(`Boolean(document.querySelector('dialog.modal[open]'))`))

      await cdp.eval(`[...document.querySelectorAll('dialog.modal[open] .modal__foot button')].find((b) => b.textContent.includes('关闭')).click()`)
      ok('关掉之后弹窗没了', await waitFor(cdp, `!document.querySelector('dialog.modal[open]')`, { tries: 25, interval: 200 }))
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 价格表：服务项表单（几何对比 + 校验 + 提交）---- */
    section('价格表 · 服务项表单')
    {
      const before = cdp.errors.length

      // 旧表单：/price/1 由旧价格表视图接管；服务行藏在大类里，先点开大类
      await gotoHash(cdp, '/price/1')
      ok('旧价格表里有大类', await waitFor(cdp, `Boolean(document.querySelector('.pcat__head'))`, { tries: 30, interval: 200 }))
      await cdp.eval(`document.querySelector('.pcat__head').click()`)
      ok('展开大类后能看到服务行', await waitFor(cdp, `Boolean(document.querySelector('button[title="改这个服务项"]'))`, { tries: 25, interval: 200 }))
      await cdp.eval(`document.querySelector('button[title="改这个服务项"]').click()`)
      ok('旧服务项表单打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      const legacy = await measureForm(cdp)
      await cdp.eval(`document.querySelector(${JSON.stringify(OPEN_DRAWER)}).close()`)
      await sleep(300)

      await gotoHash(cdp, '/price')
      await cdp.eval(`document.querySelector('button[title="编辑服务"]').click()`)
      ok('React 服务项表单打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      const fresh = await measureForm(cdp)
      compareForms(ok, legacy, fresh)

      // 游戏↔大类联动：清掉大类再提交，应当被「先选大类」拦住（旧版是自定义块报的错）
      await fillField(cdp, `${OPEN_DRAWER} #service-category`, '')
      await cdp.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).click()`)
      await sleep(300)
      const catErr = await cdp.eval(`document.querySelector(${JSON.stringify(`${OPEN_DRAWER} .note--alert`)})?.textContent || ''`)
      ok('没选大类时被拦住', catErr.includes('请先选一个大类'), catErr)
      ok('被拦住时抽屉不关', await cdp.eval(`Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`))

      // 选回大类，清空服务名 → 应当提示填服务名
      await fillField(cdp, `${OPEN_DRAWER} #service-category`, String(fixture.categoryId))
      await fillField(cdp, `${OPEN_DRAWER} #service-name`, '')
      await cdp.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).click()`)
      await sleep(300)
      const nameErr = await cdp.eval(`document.querySelector(${JSON.stringify(`${OPEN_DRAWER} .err:not([hidden])`)})?.textContent || ''`)
      ok('空服务名被校验拦住', nameErr.includes('请填写服务名'), nameErr)

      // 填好保存：改基准价 + 可获得货币
      await fillField(cdp, `${OPEN_DRAWER} #service-name`, fixture.service)
      await fillField(cdp, `${OPEN_DRAWER} #service-base-price`, '31')
      await fillField(cdp, `${OPEN_DRAWER} #service-currency`, '200')
      await cdp.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).click()`)
      ok('保存后抽屉自己关掉', await waitFor(cdp, `!document.querySelector(${JSON.stringify(OPEN_DRAWER)})`, { tries: 40, interval: 200 }))

      const saved = (await pricebookServices(app, fixture.cookie)).find((service) => service.name === fixture.service)
      ok('基准价改成了 31', saved && Number(saved.base_price) === 31, saved && saved.base_price)
      ok('可获得货币存成了 200', saved && Number(saved.currency_amount) === 200, saved && saved.currency_amount)
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 价格表：服务项详情抽屉（浮层能叠三层）---- */
    section('价格表 · 服务项详情抽屉')
    {
      const before = cdp.errors.length
      await gotoHash(cdp, '/price')
      ok('服务行上有「查看服务详情」', await waitFor(cdp, `Boolean(document.querySelector('button[title="查看服务详情"]'))`, { tries: 30, interval: 200 }))
      await cdp.eval(`[...document.querySelectorAll('button[title="查看服务详情"]')].find((b) => b.closest('.price-service')?.innerText.includes(${JSON.stringify(fixture.tiered)})).click()`)
      ok('详情抽屉打开了', await waitFor(cdp, `${drawerCountText} === 1`, { tries: 25, interval: 200 }), await drawerCount(cdp))

      const text = await topText(cdp)
      ok('详情里有可获得货币', text.includes('可获得 星声 300'), text.slice(0, 200))
      ok('详情里列出了两档阶梯价', text.includes('1-5层：¥30/层') && text.includes('6-12层：¥25/层'), text.slice(0, 240))
      ok('详情里有四个动作按钮', ['改价格和说明', '阶梯价', '套餐与增项', '复制价款'].every((label) => text.includes(label)), text.slice(0, 300))

      await captureClipboard(cdp)
      await clickTopDrawer(cdp, '复制价款')
      await sleep(400)
      ok('复制价款复制的是「名字 ¥单价/单位」', (await readClipboard(cdp)) === `${fixture.tiered} ¥30/层`, JSON.stringify(await readClipboard(cdp)))

      // 第二层：阶梯价（叠在详情抽屉上）
      await clickTopDrawer(cdp, '阶梯价')
      ok('阶梯价抽屉叠上来了', await waitFor(cdp, `${drawerCountText} === 2`, { tries: 25, interval: 200 }), await drawerCount(cdp))
      ok('最上面那层标题是「阶梯价」', (await topTitle(cdp)) === '阶梯价', await topTitle(cdp))

      // 第三层：加一档
      await clickTopDrawer(cdp, '加一档')
      ok('加一档表单叠成了第三层', await waitFor(cdp, `${drawerCountText} === 3`, { tries: 25, interval: 200 }), await drawerCount(cdp))
      ok('最上面那层标题是「加一档阶梯价」', (await topTitle(cdp)) === '加一档阶梯价', await topTitle(cdp))

      // 填一档 13 层以上 20 元，存完只关掉这一层，阶梯价列表要刷新出来
      await fillTopField(cdp, '#tier-min_qty', '13')
      await fillTopField(cdp, '#tier-unit_price', '20')
      await submitTopDrawer(cdp)
      ok('存完第三层自己关掉', await waitFor(cdp, `${drawerCountText} === 2`, { tries: 40, interval: 200 }), await drawerCount(cdp))
      ok('阶梯价列表里出现了新的一档', await waitFor(cdp, `((${TOP_DRAWER})?.innerText || '').includes('13 ~ 不限 层')`, { tries: 30, interval: 200 }), (await topText(cdp)).slice(0, 200))

      const tiers = (await pricebookServices(app, fixture.cookie)).find((service) => service.name === fixture.tiered)?.tiers || []
      ok('新阶梯落到了接口里（13 层起 20 元）', tiers.some((tier) => Number(tier.min_qty) === 13 && Number(tier.unit_price) === 20), tiers)

      // 关掉阶梯价那层，回到详情抽屉
      await closeTopDrawer(cdp)
      ok('关掉一层后只剩详情抽屉', await waitFor(cdp, `${drawerCountText} === 1`, { tries: 25, interval: 200 }), await drawerCount(cdp))

      // 套餐与增项：列表要真的拉出来（旧版这里漏过 load()，打开永远是空的）
      await clickTopDrawer(cdp, '套餐与增项')
      ok('套餐与增项抽屉打开了', await waitFor(cdp, `${drawerCountText} === 2`, { tries: 25, interval: 200 }), await drawerCount(cdp))
      ok('列表拉出来了（不是空的加载态）', await waitFor(cdp, `((${TOP_DRAWER})?.innerText || '').includes('这个服务项专属')`, { tries: 30, interval: 200 }))
      ok('全局通用增项那一段也在', (await topText(cdp)).includes('全局通用增项'), (await topText(cdp)).slice(0, 240))

      // 加一个增项，看它出现在列表里
      await clickTopDrawer(cdp, '加增项')
      ok('加增项表单叠上来了', await waitFor(cdp, `${drawerCountText} === 3`, { tries: 25, interval: 200 }), await drawerCount(cdp))
      await fillTopField(cdp, '#option-name', 'UI加急')
      await fillTopField(cdp, '#option-price', '5')
      await submitTopDrawer(cdp)
      ok('存完只剩两层', await waitFor(cdp, `${drawerCountText} === 2`, { tries: 40, interval: 200 }), await drawerCount(cdp))
      ok('列表里出现了新增加项', await waitFor(cdp, `((${TOP_DRAWER})?.innerText || '').includes('UI加急')`, { tries: 30, interval: 200 }), (await topText(cdp)).slice(0, 240))
      ok('增项加价写的是 ¥5', (await topText(cdp)).includes('加 ¥5'), (await topText(cdp)).slice(0, 240))

      await closeTopDrawer(cdp)
      await closeTopDrawer(cdp)
      ok('全部关掉后一层不剩', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 25, interval: 200 }), await drawerCount(cdp))
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 价格表：详情抽屉里删服务项（确认框叠在抽屉上）---- */
    section('价格表 · 删服务项')
    {
      const before = cdp.errors.length
      await gotoHash(cdp, '/price')
      ok('待删服务在列表里', await waitFor(cdp, `(document.querySelector('.price-page')?.innerText || '').includes(${JSON.stringify(fixture.doomed)})`, { tries: 30, interval: 200 }))
      await cdp.eval(`[...document.querySelectorAll('button[title="查看服务详情"]')].find((b) => b.closest('.price-service')?.innerText.includes(${JSON.stringify(fixture.doomed)})).click()`)
      ok('详情抽屉打开了', await waitFor(cdp, `${drawerCountText} === 1`, { tries: 25, interval: 200 }), await drawerCount(cdp))

      await clickTopDrawer(cdp, '删除')
      ok('确认框叠在抽屉上面', await waitFor(cdp, `${modalCountText} === 1 && ${drawerCountText} === 1`, { tries: 25, interval: 200 }), await cdp.eval(`document.querySelectorAll('dialog[open]').length`))
      const confirmText = await cdp.eval(`[...document.querySelectorAll('dialog.modal[open]')].pop()?.innerText.replace(/\\s+/g, ' ') || ''`)
      ok('确认框问的是这个服务项', confirmText.includes(`真的删掉「${fixture.doomed}」？`), confirmText.slice(0, 160))

      // 先点取消：确认框关掉，抽屉还得在（不该把两层一起关掉）
      await cdp.eval(`[...document.querySelectorAll('dialog.modal[open] .modal__foot button')].find((b) => b.textContent.trim() === '取消').click()`)
      ok('取消后确认框关掉', await waitFor(cdp, `${modalCountText} === 0`, { tries: 25, interval: 200 }), await modalCount(cdp))
      ok('取消后详情抽屉还在', (await drawerCount(cdp)) === 1, await drawerCount(cdp))

      // 再点删除，这回确认
      await clickTopDrawer(cdp, '删除')
      await waitFor(cdp, `${modalCountText} === 1`, { tries: 25, interval: 200 })
      await cdp.eval(`[...document.querySelectorAll('dialog.modal[open] .modal__foot button')].find((b) => b.textContent.trim() === '删除').click()`)
      ok('删完抽屉自己关掉（删掉的东西不该还挂在屏幕上）', await waitFor(cdp, `document.querySelectorAll('dialog[open]').length === 0`, { tries: 40, interval: 200 }), await cdp.eval(`document.querySelectorAll('dialog[open]').length`))
      ok('列表里也没有它了', await waitFor(cdp, `!(document.querySelector('.price-page')?.innerText || '').includes(${JSON.stringify(fixture.doomed)})`, { tries: 40, interval: 200 }))

      const gone = (await pricebookServices(app, fixture.cookie)).find((service) => service.name === fixture.doomed)
      ok('接口里也查不到了（hard 删除）', !gone, gone && gone.status)
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 价格表：导出（几何对比 + 预览 + 真下载）---- */
    section('价格表 · 导出')
    {
      const before = cdp.errors.length

      // 旧导出器：/price/1 的顶栏动作（旧视图是 ctx.setActions 挂上去的，不在正文里）
      await gotoHash(cdp, '/price/1')
      ok('旧价格表视图顶栏有导出按钮', await waitFor(cdp, `[...document.querySelectorAll('.react-topbar__tools button')].some((b) => b.textContent.includes('导出图片/文档'))`, { tries: 30, interval: 200 }))
      await clickTopAction(cdp, '导出图片/文档')
      ok('旧导出抽屉打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      const legacy = await measureForm(cdp)
      await cdp.eval(`document.querySelector(${JSON.stringify(OPEN_DRAWER)}).close()`)
      await sleep(300)

      await gotoHash(cdp, '/price')
      await clickInMain(cdp, '导出')
      ok('React 导出抽屉打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      const fresh = await measureForm(cdp)
      compareForms(ok, legacy, fresh)

      // 预览是真的画出来的：canvas → data URL
      ok('预览图画出来了', await waitFor(cdp, `(document.querySelector(${JSON.stringify(`${OPEN_DRAWER} .exporter__preview img`)})?.src || '').startsWith('data:image/png')`, { tries: 40, interval: 250 }))
      const summary = await cdp.eval(`document.querySelector(${JSON.stringify(`${OPEN_DRAWER} .exporter__preview + .hint`)})?.textContent || ''`)
      ok('预览下面写清了会生成几份、多少项', summary.includes('会生成') && summary.includes('个服务项'), summary)

      // 换成「全部合并」→ 预览跟着重画
      await fillField(cdp, `${OPEN_DRAWER} #export-scope`, 'merged')
      ok('换范围后预览重新算', await waitFor(cdp, `(document.querySelector(${JSON.stringify(`${OPEN_DRAWER} .exporter__preview + .hint`)})?.textContent || '').includes('所有游戏合在一起')`, { tries: 30, interval: 250 }), await cdp.eval(`document.querySelector(${JSON.stringify(`${OPEN_DRAWER} .exporter__preview + .hint`)})?.textContent || ''`))

      // 真点一次「生成图片」和「生成 Word 文档」，把下载动作截下来看文件名
      await captureDownloads(cdp)
      await cdp.eval(`[...document.querySelector(${JSON.stringify(OPEN_DRAWER)}).querySelectorAll('.drawer__foot button')].find((b) => b.textContent.includes('生成图片')).click()`)
      ok('点「生成图片」触发了下载', await waitFor(cdp, `(window.__downloads || []).length > 0`, { tries: 40, interval: 250 }), JSON.stringify(await cdp.eval('window.__downloads')))
      const png = (await cdp.eval('window.__downloads'))[0]
      ok('图片文件名是「店铺-游戏-日期.png」', /^UI冒烟小铺-.+-\d{4}-\d{2}-\d{2}\.png$/.test(png.name), png.name)
      ok('下载的是 blob 地址', String(png.href).startsWith('blob:'), png.href)

      await cdp.eval(`window.__downloads = []`)
      await cdp.eval(`[...document.querySelector(${JSON.stringify(OPEN_DRAWER)}).querySelectorAll('.drawer__foot button')].find((b) => b.textContent.includes('生成 Word 文档')).click()`)
      ok('点「生成 Word 文档」触发了下载', await waitFor(cdp, `(window.__downloads || []).length > 0`, { tries: 60, interval: 300 }), JSON.stringify(await cdp.eval('window.__downloads')))
      const docx = (await cdp.eval('window.__downloads'))[0]
      ok('Word 文件名是「店铺-价目表-日期.docx」（合并模式不带游戏名）', /^UI冒烟小铺-价目表-\d{4}-\d{2}-\d{2}\.docx$/.test(docx.name), docx.name)

      await cdp.eval(`document.querySelector(${JSON.stringify(OPEN_DRAWER)}).close()`)
      ok('导出抽屉关掉后没有残留', await waitFor(cdp, `document.querySelectorAll('dialog[open]').length === 0`, { tries: 25, interval: 200 }), await cdp.eval(`document.querySelectorAll('dialog[open]').length`))
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 填表提交：旧的命令式表单（记进度） ---- */
    section('填表提交 · 旧的命令式表单（记进度）')
    {
      const before = cdp.errors.length
      await gotoHash(cdp, '/orders')
      ok('订单行一开始是「还没记」', await waitFor(cdp, `(document.querySelector('.orders-row__progress')?.innerText || '').includes('还没记')`, { tries: 30, interval: 200 }))
      await cdp.eval(`document.querySelector('button[title="记进度"]').click()`)
      ok('旧抽屉打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      await fillField(cdp, `${OPEN_DRAWER} textarea[name="content"]`, PROGRESS_TEXT)
      await cdp.eval(`document.querySelector(${JSON.stringify(SUBMIT)}).click()`)
      ok('提交后抽屉关闭', await waitFor(cdp, `!document.querySelector(${JSON.stringify(OPEN_DRAWER)})`, { tries: 40, interval: 200 }))
      const shown = await waitFor(cdp, `(document.querySelector('.orders-row__progress')?.innerText || '').includes('1 条')`, { tries: 40, interval: 200 })
      ok('列表里进度变成「1 条」（旧表单提交后列表刷新了）', shown, await cdp.eval(`document.querySelector('.orders-row__progress')?.innerText || ''`))
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

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
