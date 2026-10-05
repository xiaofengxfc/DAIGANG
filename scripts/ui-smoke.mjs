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
const DETAIL_TEXT = '详情页记的一条：把本周的活动清完了'
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
  // 每天都做的服务项：单位写成「30天」，开单台要能据此自动填交付日期
  const daily = await api(base, 'POST', '/api/services', {
    name: 'UI日体',
    category_id: category.body.id,
    game_id: game.body.id,
    price_type: 'daily',
    is_daily: true,
    base_price: 2,
    unit_label: '30天',
    min_qty: 1,
  }, cookie)
  const order = await api(base, 'POST', '/api/orders', {
    customer_id: customer.body.id,
    game_id: game.body.id,
    title: 'UI冒烟单',
    items: [{ service_id: service.body.id, quantity: 1 }],
  }, cookie)
  if (order.status !== 200) throw new Error(`建单失败：HTTP ${order.status} ${JSON.stringify(order.body)}`)

  // 留着给「详情页里删整张单」那条链路用（不影响上面那张单的断言）
  const doomedOrder = await api(base, 'POST', '/api/orders', {
    customer_id: customer.body.id,
    game_id: game.body.id,
    title: 'UI待删单',
    items: [{ service_id: service.body.id, quantity: 1 }],
  }, cookie)

  return {
    cookie,
    orderId: order.body.id,
    orderNo: order.body.order_no,
    customerId: customer.body.id,
    game: 'UI冒烟游戏',
    customer: 'UI客户',
    service: 'UI服务项',
    categoryId: category.body.id,
    tiered: 'UI阶梯服务',
    daily: daily.body.name,
    doomed: doomed.body.name,
    doomedOrderId: doomedOrder.body.id,
    doomedOrderNo: doomedOrder.body.order_no,
  }
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
  { hash: '/vault', label: '保险箱', sel: '.vault-page', text: '保险箱' },
  { hash: '/settings', label: '设置', sel: '.settings-page', text: '设置' },
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

/** 开单台底部那个合计 */
const totalText = (cdp) => cdp.eval(`(${TOP_DRAWER})?.querySelector('.quote-sheet__totalfig')?.textContent || ''`)

/** 开单台里勾一行服务项（按名字找） */
function pickService(cdp, name) {
  return cdp.eval(`(() => {
    const row = [...document.querySelectorAll(${JSON.stringify(`${OPEN_DRAWER} .pickrow`)})].find((r) => (r.querySelector('.pickrow__name') || {}).textContent?.trim() === ${JSON.stringify(name)})
    if (!row) return false
    row.querySelector('.pickrow__main').click()
    return true
  })()`)
}

/**
 * 点订单行里的某个动作按钮。
 * 订单行整行是个 role=button 的 article，按单号找到行，再按 title 找按钮。
 */
function clickRowAction(cdp, orderNo, title) {
  return cdp.eval(`(() => {
    const row = [...document.querySelectorAll('.orders-row')].find((r) => r.innerText.includes(${JSON.stringify(orderNo)}))
    if (!row) return false
    const button = [...row.querySelectorAll('button')].find((b) => (b.title || '').includes(${JSON.stringify(title)}))
    if (!button) return false
    button.click()
    return true
  })()`)
}

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

/** 顶层弹窗（modal），跟 TOP_DRAWER 一个道理 */
const TOP_MODAL = '[...document.querySelectorAll("dialog.modal[open]")].pop()'

/** 给最上层弹窗里的某个字段塞值（保险箱密码框就是这种） */
function fillModalField(cdp, selector, value) {
  return cdp.eval(`(() => {
    const top = ${TOP_MODAL}
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

/** 提交最上层抽屉 */function submitTopDrawer(cdp) {
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

/** 点弹窗（modal）页脚里带这段文字的按钮 */
function clickModalButton(cdp, text) {
  return cdp.eval(`(() => {
    const dlg = [...document.querySelectorAll('dialog.modal[open]')].pop()
    if (!dlg) return false
    const btn = [...dlg.querySelectorAll('button')].find((b) => b.textContent.includes(${JSON.stringify(text)}))
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
 * 「黄金形状」断言：把一个表单的结构钉死（标题、宽窄、字段顺序 + 半宽/整宽、
 * 控件类型、页脚按钮）。
 *
 * 迁移期间这些表单是「新旧并排量一遍」来保证不走样的；旧表单下线之后没有对照物了，
 * 就把量出来的那一版当基准写死 —— 以后谁改坏了结构，这里会红。
 *
 * fields 里带「｜整」的是整宽（field--full），不带的是半宽。
 */
function checkFormShape(ok, form, expected, prefix = '') {
  ok(`${prefix}量到了表单`, Boolean(form))
  if (!form) return
  const shape = form.fields.map((f) => `${f.label}${f.half ? '' : '｜整'}`)
  if (expected.title !== undefined) ok(`${prefix}标题是「${expected.title}」`, form.title === expected.title, form.title)
  if (expected.wide !== undefined) ok(`${prefix}抽屉宽窄对（wide=${expected.wide}）`, form.wide === expected.wide, form.wide)
  if (expected.fields) ok(`${prefix}字段顺序和半宽/整宽对`, JSON.stringify(shape) === JSON.stringify(expected.fields), `实际 ${shape.join(' / ')}`)
  if (expected.controls) {
    const controls = form.fields.map((f) => f.control)
    ok(`${prefix}控件类型对`, JSON.stringify(controls) === JSON.stringify(expected.controls), `实际 ${controls.join('/')}`)
  }
  if (expected.foot) ok(`${prefix}页脚按钮对`, JSON.stringify(form.foot) === JSON.stringify(expected.foot), `实际 ${form.foot.join('/')}`)
}

/**
 * 把「新 React 表单」和「旧命令式表单」并排比一遍。
 * 迁移最怕的是结构悄悄变了（少个字段、宽度不对、页脚按钮换了），
 * 这些东西肉眼不一定当场看得出来，量出来比最实在。
 */
function compareForms(ok, legacy, fresh, { prefix = '', checkTitle = true, checkFoot = true } = {}) {
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
  if (checkFoot) ok(`${prefix}页脚按钮一致`, JSON.stringify(legacy.foot) === JSON.stringify(fresh.foot), `旧 ${legacy.foot.join('/')} 新 ${fresh.foot.join('/')}`)
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

    section('点开抽屉')
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
      // 列表里不止一张单（还有一张留着给删单用），所以只认抽屉里该有的字段，不认具体单号
      expectText: '应收',
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

    /* ---- 订单：记进度 / 记收款（真提交）---- */
    section('订单 · 记进度 / 记收款')
    {
      const before = cdp.errors.length

      // 进度 / 收款这两张表以前是「新旧并排量一遍」，现在旧表单随着旧详情页一起下线了，
      // 就按「长得对 + 真的能提交」来测：结构断言在下面那组黄金形状里。
      await gotoHash(cdp, '/orders')
      ok('订单行上有「记进度」', await waitFor(cdp, `Boolean(document.querySelector('.orders-row button[title="记进度"]'))`, { tries: 30, interval: 200 }))
      await clickRowAction(cdp, fixture.orderNo, '记进度')
      ok('React「记一条进度」抽屉打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      checkFormShape(ok, await measureForm(cdp), {
        title: '记一条进度',
        wide: false,
        fields: ['日期', '资源对比 · 做之前｜整', '资源对比 · 做之后｜整', '这次做了什么｜整', '截图 / 录屏链接｜整', '备注｜整'],
        controls: ['INPUT', 'INPUT', 'INPUT', 'TEXTAREA', 'INPUT', 'TEXTAREA'],
        foot: ['取消', '记下'],
      }, '记进度：')

      // 资源对比：三个框 + 其他 + 两个识别按钮，两边都要在
      const resText = await topText(cdp)
      ok('资源对比两排都在', resText.includes('资源对比 · 做之前') && resText.includes('资源对比 · 做之后'), resText.slice(0, 200))
      ok('三个资源框都在', ['星声', '体力', '贝币'].every((key) => resText.includes(key)), resText.slice(0, 200))
      ok('两个识别按钮都在', resText.includes('识别画面') && resText.includes('识别截图'))
      ok('还没有上一条进度时不写来历', !resText.includes('「做之前」带的是'), resText.slice(0, 240))

      // 填一条真进度：做之前 100/50 → 做之后 80/20，「本次消耗」要自己算出来
      await fillTopField(cdp, 'input[aria-label="资源对比 · 做之前 星声"]', '100')
      await fillTopField(cdp, 'input[aria-label="资源对比 · 做之前 体力"]', '50')
      await fillTopField(cdp, 'input[aria-label="资源对比 · 做之后 星声"]', '80')
      await fillTopField(cdp, 'input[aria-label="资源对比 · 做之后 体力"]', '20')
      ok('「本次消耗」自己算出来了', await waitFor(cdp, `((${TOP_DRAWER})?.innerText || '').includes('本次消耗：星声 −20 · 体力 −30')`, { tries: 25, interval: 200 }), (await topText(cdp)).slice(-160))
      await fillTopField(cdp, '#progress-content', 'UI冒烟：清完今日委托')
      await submitTopDrawer(cdp)
      ok('记完抽屉自己关掉', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 40, interval: 200 }), await drawerCount(cdp))

      const saved = await api(app.base, 'GET', `/api/orders/${fixture.orderId}`, undefined, fixture.cookie)
      const progress = (saved.body.progress || [])[0]
      ok('进度落库了（做之前 100/50）', progress && progress.resources_before === '星声 100 体力 50', progress && progress.resources_before)
      ok('进度落库了（做之后 80/20）', progress && progress.resources_after === '星声 80 体力 20', progress && progress.resources_after)
      ok('进度内容也存对了', progress && progress.content === 'UI冒烟：清完今日委托', progress && progress.content)
      ok('订单行上的进度条数跟着变了', await waitFor(cdp, `[...document.querySelectorAll('.orders-row')].some((r) => r.innerText.includes('1 条'))`, { tries: 30, interval: 200 }))

      // 再开一次：这次「做之前」应该带上一条的「做之后」
      await clickRowAction(cdp, fixture.orderNo, '记进度')
      await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 })
      ok('「做之前」自动带上了上一条的「做之后」', await cdp.eval(`(${TOP_DRAWER})?.querySelector('input[aria-label="资源对比 · 做之前 星声"]')?.value === '80'`), await cdp.eval(`(${TOP_DRAWER})?.querySelector('input[aria-label="资源对比 · 做之前 星声"]')?.value`))
      ok('并且说清了来历', (await topText(cdp)).includes('「做之前」带的是上一条的「做之后」'), (await topText(cdp)).slice(0, 200))
      await closeTopDrawer(cdp)

      // ---- 记收款 ----
      await gotoHash(cdp, '/orders')
      await clickRowAction(cdp, fixture.orderNo, '记收款')
      ok('React「记一笔收款」抽屉打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      checkFormShape(ok, await measureForm(cdp), {
        title: '记一笔收款',
        wide: false,
        fields: ['金额（元）', '类型', '收款方式', '日期', '备注｜整'],
        controls: ['INPUT', 'SELECT', 'SELECT', 'INPUT', 'INPUT'],
        foot: ['取消', '记下'],
      }, '记收款：')

      // 默认金额就是还差的钱，类型默认「全款」
      ok('金额默认填「还差」的数', (await cdp.eval(`document.querySelector('#payment-amount')?.value`)) === '12', await cdp.eval(`document.querySelector('#payment-amount')?.value`))
      ok('类型默认「全款」', (await cdp.eval(`document.querySelector('#payment-kind')?.value`)) === 'full', await cdp.eval(`document.querySelector('#payment-kind')?.value`))
      ok('收款方式默认微信', (await cdp.eval(`document.querySelector('#payment-method')?.value`)) === 'wechat')

      // 先来一个空金额，应该被拦住
      await fillTopField(cdp, '#payment-amount', '')
      await submitTopDrawer(cdp)
      ok('空金额被拦住', await waitFor(cdp, `${drawerCountText} === 1`, { tries: 20, interval: 200 }) && (await topText(cdp)).includes('请填写金额'), (await topText(cdp)).slice(0, 160))

      // 记一笔 5 元定金
      await fillTopField(cdp, '#payment-amount', '5')
      await fillTopField(cdp, '#payment-kind', 'deposit')
      await submitTopDrawer(cdp)
      ok('记完抽屉自己关掉', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 40, interval: 200 }), await drawerCount(cdp))

      const paid = await api(app.base, 'GET', `/api/orders/${fixture.orderId}`, undefined, fixture.cookie)
      ok('订单上已收 5 元', Number(paid.body.paid_total) === 5, paid.body.paid_total)
      ok('还差 7 元', Number(paid.body.due_total) === 7, paid.body.due_total)
      ok('列表上的欠款跟着变了', await waitFor(cdp, `[...document.querySelectorAll('.orders-row')].some((r) => r.innerText.includes('还差 ¥7'))`, { tries: 30, interval: 200 }), await cdp.eval(`[...document.querySelectorAll('.orders-row')].map((r) => r.innerText.replace(/\\s+/g, ' ')).join(' | ')`))
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 开单台：挑服务、算钱、自动填交付日期 ---- */
    section('开单台 · 挑服务算钱')
    {
      const before = cdp.errors.length

      // 旧开单台跟着旧订单详情页一起下线了，这里改成「黄金形状」断言：
      // 字段顺序、半宽/整宽、控件类型、页脚按钮都钉住，改坏了就红。
      await gotoHash(cdp, '/orders/new')
      ok('React 开单台打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 40, interval: 200 }))
      checkFormShape(ok, await measureForm(cdp), {
        title: '开一张新单',
        wide: true,
        fields: ['客户', '游戏', '下单日期', '交付日期', '｜整', '订单标题｜整', '折扣（元）', '平台手续费（元）', '成本（元）', '给客户看的备注｜整', '只有自己看得到的备注｜整'],
        controls: ['SELECT', 'SELECT', 'INPUT', 'INPUT', 'custom', 'INPUT', 'INPUT', 'INPUT', 'INPUT', 'TEXTAREA', 'TEXTAREA'],
        foot: ['取消', '开单'],
      }, '开单台：')

      // 搜出来勾上：默认数量 = 起订量，钱按基准价
      await fillTopField(cdp, 'input[type="search"]', fixture.service)
      await sleep(350)
      ok('搜出 1 行服务项', (await cdp.eval(`document.querySelectorAll(${JSON.stringify(`${OPEN_DRAWER} .pickrow`)}).length`)) === 1, await cdp.eval(`document.querySelectorAll(${JSON.stringify(`${OPEN_DRAWER} .pickrow`)}).length`))
      ok('勾上了这一行', await pickService(cdp, fixture.service))
      ok('合计按基准价 ¥12', await waitFor(cdp, `(${TOP_DRAWER})?.querySelector('.quote-sheet__totalfig')?.textContent === '¥12'`, { tries: 25, interval: 200 }), await totalText(cdp))
      ok('行上写清了按什么算', (await topText(cdp)).includes('按 1 单 算，基准单价 ¥12'), (await topText(cdp)).slice(0, 200))

      // 数量 / 改价
      await fillTopField(cdp, `input[aria-label="${fixture.service} 数量"]`, '3')
      ok('数量 3 → ¥36', await waitFor(cdp, `(${TOP_DRAWER})?.querySelector('.quote-sheet__totalfig')?.textContent === '¥36'`, { tries: 25, interval: 200 }), await totalText(cdp))
      await fillTopField(cdp, `input[aria-label="${fixture.service} 单价"]`, '10')
      ok('改价 10 → ¥30', await waitFor(cdp, `(${TOP_DRAWER})?.querySelector('.quote-sheet__totalfig')?.textContent === '¥30'`, { tries: 25, interval: 200 }), await totalText(cdp))
      await fillTopField(cdp, `input[aria-label="${fixture.service} 单价"]`, '')
      ok('清掉改价 → 回到 ¥36', await waitFor(cdp, `(${TOP_DRAWER})?.querySelector('.quote-sheet__totalfig')?.textContent === '¥36'`, { tries: 25, interval: 200 }), await totalText(cdp))

      // 改价填了非数字：标红，并且退回基准价 —— 绝不能变成 ¥0
      await fillTopField(cdp, `input[aria-label="${fixture.service} 单价"]`, 'abc')
      ok('非数字的改价标红了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(`${OPEN_DRAWER} input.is-bad`)}))`, { tries: 20, interval: 200 }))
      ok('非数字时仍按基准价算 ¥36（不会变 ¥0）', (await totalText(cdp)) === '¥36', await totalText(cdp))
      await fillTopField(cdp, `input[aria-label="${fixture.service} 单价"]`, '')

      // 阶梯价：8 层要按 6-12 那一档的 25 元算
      await fillTopField(cdp, 'input[type="search"]', fixture.tiered)
      await sleep(350)
      await pickService(cdp, fixture.tiered)
      await fillTopField(cdp, `input[aria-label="${fixture.tiered} 数量"]`, '8')
      ok('8 层按阶梯价 ¥25 算', await waitFor(cdp, `((${TOP_DRAWER})?.innerText || '').includes('按 8 层 算，基准单价 ¥25')`, { tries: 25, interval: 200 }), (await topText(cdp)).slice(0, 240))
      ok('两项合计 ¥236（36 + 200）', await waitFor(cdp, `(${TOP_DRAWER})?.querySelector('.quote-sheet__totalfig')?.textContent === '¥236'`, { tries: 25, interval: 200 }), await totalText(cdp))

      // 每天都做的服务项：交付日期按「30天」自动填
      await fillTopField(cdp, 'input[type="search"]', fixture.daily)
      await sleep(350)
      await pickService(cdp, fixture.daily)
      ok('交付日期自动填上了', await waitFor(cdp, `(document.querySelector('#composer-due-at')?.value || '') !== ''`, { tries: 25, interval: 200 }), await cdp.eval(`document.querySelector('#composer-due-at')?.value`))
      ok('说清了是自动填的', (await topText(cdp)).includes(`按「${fixture.daily}」30 天自动填的`), (await topText(cdp)).slice(0, 200))
      ok('还剩几天也算出来了', /剩余 \d+ 天/.test(await topText(cdp)), (await topText(cdp)).slice(0, 160))

      // 折扣 → 合计
      await fillTopField(cdp, '#composer-discount', '6')
      ok('扣掉折扣 → ¥232', await waitFor(cdp, `(${TOP_DRAWER})?.querySelector('.quote-sheet__totalfig')?.textContent === '¥232'`, { tries: 25, interval: 200 }), await totalText(cdp))
      const summary = await cdp.eval(`(${TOP_DRAWER})?.querySelector('.stack--tight')?.innerText.replace(/\\s+/g, ' ') || ''`)
      ok('汇总四行都对', summary.includes('服务小计（3 项） ¥238') && summary.includes('增项合计 ¥0') && summary.includes('折扣 −¥6') && summary.includes('利润预估 ¥232'), summary)

      // 没选客户先提交：要拦住，抽屉不能关
      await submitTopDrawer(cdp)
      ok('没选客户被拦住', await waitFor(cdp, `[...document.querySelectorAll('.toasts .toast')].some((t) => t.textContent.includes('先选客户'))`, { tries: 25, interval: 200 }), await cdp.eval(`[...document.querySelectorAll('.toasts .toast')].map((t) => t.textContent).join(' / ')`))
      ok('被拦住时抽屉不关', (await drawerCount(cdp)) === 1, await drawerCount(cdp))

      // 选上客户，真开一张
      await fillTopField(cdp, '#composer-customer', String(fixture.customerId))
      await submitTopDrawer(cdp)
      ok('开完单抽屉自己关掉', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 40, interval: 200 }), await drawerCount(cdp))
      ok('跳到了新单详情', await waitFor(cdp, `/^#\\/orders\\/\\d+$/.test(location.hash)`, { tries: 30, interval: 200 }), await cdp.eval('location.hash'))

      const newId = (await cdp.eval('location.hash')).split('/').pop()
      const created = await api(app.base, 'GET', `/api/orders/${newId}`, undefined, fixture.cookie)
      ok('新单合计 ¥232', Number(created.body.total) === 232, created.body.total)
      ok('折扣 6 记下了', Number(created.body.discount) === 6, created.body.discount)
      ok('三条明细都在', (created.body.items || []).length === 3, (created.body.items || []).map((item) => `${item.name}×${item.quantity}`).join(' / '))
      const fixedLine = (created.body.items || []).find((item) => item.name === fixture.service)
      ok('UI服务项 3 单 × ¥12', fixedLine && Number(fixedLine.quantity) === 3 && Number(fixedLine.unit_price) === 12, fixedLine && `${fixedLine.quantity} × ${fixedLine.unit_price}`)
      const tierLine = (created.body.items || []).find((item) => item.name === fixture.tiered)
      ok('UI阶梯服务 8 层 × ¥25（服务端算的阶梯价和界面对得上）', tierLine && Number(tierLine.unit_price) === 25 && Number(tierLine.quantity) === 8, tierLine && `${tierLine.quantity} × ${tierLine.unit_price}`)
      const dailyLine = (created.body.items || []).find((item) => item.name === fixture.daily)
      ok('UI日体 1 × ¥2', dailyLine && Number(dailyLine.unit_price) === 2, dailyLine && `${dailyLine.quantity} × ${dailyLine.unit_price}`)
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 报价单：挑服务、长报价单、复制文字、存下来 ---- */
    section('报价单 · 做一张')
    {
      const before = cdp.errors.length

      await gotoHash(cdp, '/quotes')
      ok('报价单页有「做报价单」', await waitFor(cdp, `Boolean(document.querySelector('.refactor-top-action'))`, { tries: 30, interval: 200 }))
      await cdp.eval(`document.querySelector('.refactor-top-action').click()`)
      ok('React 报价单抽屉打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 40, interval: 200 }))
      checkFormShape(ok, await measureForm(cdp), {
        title: '做一张报价单',
        wide: true,
        fields: ['抬头｜整', '客户｜整', '游戏｜整', '有效期至｜整', '备注｜整'],
        controls: ['INPUT', 'SELECT', 'SELECT', 'INPUT', 'TEXTAREA'],
        foot: ['关闭', '复制文字', '存成报价单'],
      }, '报价单：')
      ok('空着的时候右边写着「勾几个服务项」', (await topText(cdp)).includes('右边勾几个服务项'), (await topText(cdp)).slice(0, 200))

      // 勾一个服务项：报价单要实时长出来
      await fillTopField(cdp, 'input[type="search"]', fixture.service)
      await sleep(350)
      ok('搜出 1 行', (await cdp.eval(`document.querySelectorAll(${JSON.stringify(`${OPEN_DRAWER} .pickrow`)}).length`)) === 1)
      ok('勾上了', await pickService(cdp, fixture.service))
      ok('报价单里出现这一行', await waitFor(cdp, `((${TOP_DRAWER})?.innerText || '').includes('12 元/单 × 1 = 12 元')`, { tries: 25, interval: 200 }), (await topText(cdp)).slice(0, 240))
      await fillTopField(cdp, `input[aria-label="${fixture.service} 数量"]`, '3')
      ok('数量 3 → 合计 ¥36', await waitFor(cdp, `(${TOP_DRAWER})?.querySelector('.quote-sheet__totalfig')?.textContent === '¥36'`, { tries: 25, interval: 200 }), await totalText(cdp))
      ok('底部写着已选 1 项', (await topText(cdp)).includes('1 已选'), (await topText(cdp)).slice(-120))

      // 看文字版 → 复制
      await clickTopDrawer(cdp, '看文字版')
      ok('文字版出来了', await waitFor(cdp, `((${TOP_DRAWER})?.querySelector('pre.plaintext')?.textContent || '').includes('合计：36 元')`, { tries: 25, interval: 200 }), await cdp.eval(`(${TOP_DRAWER})?.querySelector('pre.plaintext')?.textContent?.slice(0, 120) || ''`))
      ok('文字版里有抬头和序号', (await cdp.eval(`(${TOP_DRAWER})?.querySelector('pre.plaintext')?.textContent || ''`)).includes('【代肝报价单】') && (await cdp.eval(`(${TOP_DRAWER})?.querySelector('pre.plaintext')?.textContent || ''`)).includes('1. '))
      await captureClipboard(cdp)
      await clickTopDrawer(cdp, '复制文字')
      ok('复制到剪贴板了', await waitFor(cdp, `(window.__copied || '').includes('合计：36 元')`, { tries: 25, interval: 200 }), String(await readClipboard(cdp)).slice(0, 80))
      ok('复制成功还说了句', await waitFor(cdp, `[...document.querySelectorAll('.toasts .toast')].some((t) => t.textContent.includes('已复制'))`, { tries: 25, interval: 200 }))

      // 存下来
      await submitTopDrawer(cdp)
      ok('存完抽屉自己关掉', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 40, interval: 200 }), await drawerCount(cdp))
      const list = await api(app.base, 'GET', '/api/quotes?limit=200', undefined, fixture.cookie)
      const saved = (list.body.items || []).find((quote) => Number(quote.total) === 36)
      ok('接口里落了这张报价单', Boolean(saved), (list.body.items || []).map((quote) => `${quote.quote_no} ¥${quote.total}`).join(' / '))
      ok('合计和服务端算的一样（¥36）', saved && Number(saved.total) === 36, saved && saved.total)
      ok('列表里也能看到', await waitFor(cdp, `(document.querySelector('.quotes-page')?.innerText || '').includes('¥36')`, { tries: 40, interval: 200 }), await cdp.eval(`document.querySelector('.quotes-page')?.innerText?.replace(/\\s+/g, ' ')?.slice(0, 200) || ''`))

      // 列表里点开文字版（这个弹窗以前是旧 ui.js 的 modal）
      await cdp.eval(`document.querySelector('.quotes-row__main').click()`)
      ok('文字版弹窗打开了', await waitFor(cdp, `Boolean(document.querySelector('dialog.modal[open]'))`, { tries: 25, interval: 200 }))
      ok('弹窗里是那张报价单的文字', await waitFor(cdp, `(document.querySelector('dialog.modal[open] .quotes-plaintext')?.textContent || '').includes('合计：36 元')`, { tries: 25, interval: 200 }))
      await captureClipboard(cdp)
      await clickModalButton(cdp, '复制')
      ok('弹窗里也能复制', await waitFor(cdp, `(window.__copied || '').includes('合计：36 元')`, { tries: 25, interval: 200 }))
      await clickModalButton(cdp, '关闭')
      ok('弹窗关掉了', await waitFor(cdp, `${modalCountText} === 0`, { tries: 25, interval: 200 }), await modalCount(cdp))
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

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

    /* ---- 游戏表单：金标准形状 ---- */
    section('游戏表单 · 形状')
    {
      // 旧视图删掉之后没得对比了，改成把当前结构写死在这儿
      await gotoHash(cdp, '/games')
      await clickTopAction(cdp, '新建游戏')
      ok('React 游戏表单打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      checkFormShape(ok, await measureForm(cdp), {
        title: '新建游戏',
        wide: true,
        fields: ['游戏名', '简称', '图标｜整', '区服列表｜整', '货币名称', '顶部提示｜整', '状态', '排序', '备注｜整'],
        controls: ['INPUT', 'INPUT', 'INPUT', 'INPUT', 'INPUT', 'TEXTAREA', 'SELECT', 'INPUT', 'TEXTAREA'],
        foot: ['取消', '保存'],
      }, '游戏表单：')
      await cdp.eval(`document.querySelector(${JSON.stringify(OPEN_DRAWER)}).close()`)
      await sleep(300)
    }

    /* ---- 客户表单：金标准形状 + 填表提交 ---- */
    section('客户表单 · 形状与提交')
    {
      const before = cdp.errors.length

      await gotoHash(cdp, '/customers')
      await clickTopAction(cdp, '新建客户')
      ok('React 客户表单打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      checkFormShape(ok, await measureForm(cdp), {
        title: '新客户',
        wide: false,
        fields: ['头像｜整', '昵称｜整', '手机号', '微信', 'QQ', '来源', '标签｜整', '备注｜整'],
        controls: ['INPUT', 'INPUT', 'INPUT', 'INPUT', 'INPUT', 'SELECT', 'INPUT', 'TEXTAREA'],
        foot: ['取消', '保存'],
      }, '客户表单：')

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

    /* ---- 客户档案：最后一个旧页面，现在也是 React 了 ---- */
    section('客户档案 · 详情页')
    {
      const before = cdp.errors.length

      await gotoHash(cdp, `/customers/${fixture.customerId}`)
      ok('客户档案页渲染出来了', await waitFor(cdp, `Boolean(document.querySelector('.customer-detail'))`, { tries: 40, interval: 200 }))
      const text = await cdp.eval(`document.querySelector('.customer-detail')?.innerText?.replace(/\\s+/g, ' ') || ''`)
      ok('抬头是这位客户', text.includes(fixture.customer), text.slice(0, 140))
      ok('五个面板都在', ['订单', '收款流水', '联系方式', '账目', '登录凭证'].every((key) => text.includes(key)), text.slice(0, 240))
      ok('联系方式里露了手机号', text.includes('13900000001'), text.slice(0, 240))
      ok('账目里有累计订单额', text.includes('累计订单额'))
      ok('有「给 TA 开单」', text.includes('给 TA 开单'))

      // 改资料 → React 客户表单（同一个表单，只是标题不同）
      await clickInMain(cdp, '改资料')
      ok('改资料打开了 React 客户表单', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 30, interval: 200 }))
      const editShape = await measureForm(cdp)
      ok('标题是「改客户资料」', editShape && editShape.title === '改客户资料', editShape && editShape.title)
      ok('改资料时字段还是那八个', Boolean(editShape) && editShape.fields.length === 8, editShape && editShape.fields.length)
      await cdp.eval(`document.querySelector(${JSON.stringify(OPEN_DRAWER)}).close()`)
      await sleep(300)

      // 「归档 / 彻底删除」的三选一（旧的是 ui.js 的 choiceDialog）
      await cdp.eval(`[...document.querySelectorAll('.customer-detail__actions button')].find((b) => b.title === '归档或彻底删除这位客户')?.click()`)
      ok('三选一确认框打开了', await waitFor(cdp, `${modalCountText} === 1`, { tries: 30, interval: 200 }), await modalCount(cdp))
      const choice = await cdp.eval(`(${TOP_MODAL})?.innerText?.replace(/\\s+/g, ' ') || ''`)
      ok('确认框里说清了名下有多少东西', choice.includes('订单') && choice.includes('凭证'), choice.slice(0, 220))
      ok('有「归档客户」也有「彻底删除」', choice.includes('归档客户') && choice.includes('彻底删除'), choice.slice(0, 220))
      ok('还提醒了删掉之后订单会怎样', choice.includes('失去客户关联'), choice.slice(0, 260))
      await clickModalButton(cdp, '取消')
      ok('取消后确认框关掉', await waitFor(cdp, `${modalCountText} === 0`, { tries: 25, interval: 200 }))
      ok('客户还好端端在档案页上', await waitFor(cdp, `Boolean(document.querySelector('.customer-detail'))`, { tries: 25, interval: 200 }))

      // 点一张订单要能进订单详情
      await cdp.eval(`document.querySelector('.customer-detail .itemlist button.item')?.click()`)
      ok('点订单跳到了订单详情', await waitFor(cdp, `location.hash.startsWith('#/orders/')`, { tries: 30, interval: 200 }), await cdp.eval(`location.hash`))
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

      // 吐司：React 页面弹的提示现在由 React 画（以前是 ui.js 往 body 上挂 DOM）
      ok('复制后弹出了吐司', await waitFor(cdp, `[...document.querySelectorAll('.toasts .toast')].some((t) => t.textContent.includes('报价已复制'))`, { tries: 25, interval: 200 }), await cdp.eval(`[...document.querySelectorAll('.toasts .toast')].map((t) => t.className + '|' + t.textContent).join(' / ')`))
      ok('吐司带上了 ok 色调', await cdp.eval(`Boolean(document.querySelector('.toasts .toast--ok'))`))
      ok('页面上只有一个吐司容器（新旧共用一份，不会弹两遍）', (await cdp.eval(`document.querySelectorAll('.toasts').length`)) === 1, await cdp.eval(`document.querySelectorAll('.toasts').length`))

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

    /* ---- 价格表：导出（预览 + 真下载）---- */
    section('价格表 · 导出')
    {
      const before = cdp.errors.length

      await gotoHash(cdp, '/price')
      await clickInMain(cdp, '导出')
      ok('React 导出抽屉打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      checkFormShape(ok, await measureForm(cdp), {
        title: '导出价格表',
        wide: true,
        fields: ['导出范围｜整', '图片内容｜整', '带说明文字｜整', '联系方式｜整', '页脚说明｜整'],
        controls: ['SELECT', 'custom', 'INPUT', 'INPUT', 'INPUT'],
        foot: ['关闭', '生成 Word 文档', '生成图片'],
      }, '导出器：')

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

    /* ---- 订单详情：记进度 / 记收款 / 推进状态 / 分享 / 删收款 / 删单 ---- */
    section('订单详情 · 记进度 / 记收款 / 推进状态 / 分享进度')
    {
      const before = cdp.errors.length
      const text = () => cdp.eval(`document.querySelector('.react-main__inner')?.innerText.replace(/\\s+/g, ' ') || ''`)

      await gotoHash(cdp, `/orders/${fixture.orderId}`)
      ok('详情页出来了（单号在抬头）', await waitFor(cdp, `(document.querySelector('.react-main__inner')?.innerText || '').includes(${JSON.stringify(fixture.orderNo)})`, { tries: 30, interval: 200 }))
      const head = await text()
      ok('抬头写了客户和游戏', head.includes(fixture.customer) && head.includes(fixture.game), head.slice(0, 160))
      ok('五步状态轨在', (await cdp.eval('document.querySelectorAll(".track__step").length')) === 5, await cdp.eval('document.querySelectorAll(".track__step").length'))
      ok('服务明细里有 UI服务项', head.includes(fixture.service), head.slice(0, 200))
      ok('钱那一栏有合计 / 已收 / 利润', head.includes('合计') && head.includes('已收') && head.includes('利润'), head.slice(0, 200))
      ok('收款记录那栏在', head.includes('收款记录'), head.slice(0, 200))

      // 记进度：走详情页的「记一条」
      const progressBefore = ((await api(app.base, 'GET', `/api/orders/${fixture.orderId}`, undefined, fixture.cookie)).body.progress || []).length
      ok('点开了记进度抽屉', await clickInMain(cdp, '记一条'), await text())
      ok('React 记进度抽屉打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 25, interval: 200 }))
      await fillTopField(cdp, 'textarea[name="content"]', DETAIL_TEXT)
      await submitTopDrawer(cdp)
      ok('提交后抽屉关掉', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 40, interval: 200 }), await drawerCount(cdp))
      ok('时间线上出现了这条', await waitFor(cdp, `(document.querySelector('.react-main__inner')?.innerText || '').includes(${JSON.stringify(DETAIL_TEXT)})`, { tries: 40, interval: 200 }), (await text()).slice(0, 240))
      const progressAfter = ((await api(app.base, 'GET', `/api/orders/${fixture.orderId}`, undefined, fixture.cookie)).body.progress || []).length
      ok('进度落库了', progressAfter === progressBefore + 1, `${progressBefore} → ${progressAfter}`)
      ok('时间线头部条数跟着变了', (await text()).includes(`进度时间线 ${progressAfter} 条`), (await text()).slice(0, 120))

      // 改一条进度（时间线上的编辑按钮）
      ok('时间线上有编辑按钮', await cdp.eval(`Boolean(document.querySelector('.react-main__inner .timeline button[title="编辑"]'))`))
      await cdp.eval(`document.querySelector('.react-main__inner .timeline button[title="编辑"]').click()`)
      ok('改进度抽屉打开了', await waitFor(cdp, `(${TOP_DRAWER})?.querySelector('.drawer__title')?.textContent === '改这条进度'`, { tries: 25, interval: 200 }), await topTitle(cdp))
      await fillTopField(cdp, 'textarea[name="content"]', `${DETAIL_TEXT}（改过）`)
      await submitTopDrawer(cdp)
      ok('改完时间线上是新的内容', await waitFor(cdp, `(document.querySelector('.react-main__inner')?.innerText || '').includes(${JSON.stringify(`${DETAIL_TEXT}（改过）`)})`, { tries: 40, interval: 200 }))

      // 记收款：详情页右侧那个「记一笔收款」
      ok('点开了记收款抽屉', await clickInMain(cdp, '记一笔收款'))
      ok('React 记收款抽屉打开了', await waitFor(cdp, `(${TOP_DRAWER})?.querySelector('.drawer__title')?.textContent === '记一笔收款'`, { tries: 25, interval: 200 }), await topTitle(cdp))
      await fillTopField(cdp, '#payment-amount', '7')
      await submitTopDrawer(cdp)
      ok('收完钱抽屉关掉', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 40, interval: 200 }), await drawerCount(cdp))
      // 前面「订单 · 记进度 / 记收款」那节已经收过 5 元定金，这 7 元正好收齐。
      // 注意：金额栏那几行是 grid 里的 inline span，innerText 不会自动加空格，
      // 所以按「标签后面那个数字」来认，别拿整页文字拼。
      const moneyCell = (label) => `(() => {
        const spans = [...document.querySelectorAll('.react-main__inner .panel span')]
        const at = spans.findIndex((s) => s.textContent === ${JSON.stringify(label)})
        return at >= 0 ? (spans[at + 1] || {}).textContent || '' : ''
      })()`
      ok('已收变成 ¥12（5 + 7）', await waitFor(cdp, `${moneyCell('已收')} === '¥12'`, { tries: 40, interval: 200 }), await cdp.eval(moneyCell('已收')))
      ok('抬头写着「已结清」', (await text()).includes('已结清'), (await text()).slice(0, 240))
      ok('收款记录里两笔都在', (await text()).includes('收款记录 2 笔'), (await text()).slice(0, 240))

      // 分享进度：弹窗 + 预览图 + 文字
      ok('点开了分享进度', await clickInMain(cdp, '分享进度'))
      ok('分享弹窗打开了', await waitFor(cdp, `Boolean(document.querySelector('dialog.modal[open]'))`, { tries: 25, interval: 200 }))
      ok('预览图是现画的 PNG（data URL）', await waitFor(cdp, `(document.querySelector('dialog.modal[open] .report-preview img')?.src || '').startsWith('data:image/png')`, { tries: 30, interval: 200 }), await cdp.eval(`String(document.querySelector('dialog.modal[open] .report-preview img')?.src || '').slice(0, 30)`))
      ok('文字里有单号', (await cdp.eval(`document.querySelector('dialog.modal[open] .report-text')?.textContent || ''`)).includes(fixture.orderNo))
      ok('文字里有刚记的那条进度', (await cdp.eval(`document.querySelector('dialog.modal[open] .report-text')?.textContent || ''`)).includes(DETAIL_TEXT))
      await captureClipboard(cdp)
      await clickModalButton(cdp, '复制文字')
      ok('复制文字进了剪贴板', await waitFor(cdp, `(window.__copied || '').includes(${JSON.stringify(fixture.orderNo)})`, { tries: 25, interval: 200 }), String(await readClipboard(cdp)).slice(0, 60))
      await captureDownloads(cdp)
      await clickModalButton(cdp, '存成图片')
      ok('存图用的文件名是「店铺-进度-单号.png」', await waitFor(cdp, `(window.__downloads || []).length > 0`, { tries: 30, interval: 200 }), JSON.stringify(await cdp.eval('window.__downloads')))
      const png = (await cdp.eval('window.__downloads'))[0]
      ok('文件名对得上', png && png.name === `UI冒烟小铺-进度-${fixture.orderNo}.png`, png && png.name)
      await clickModalButton(cdp, '关闭')
      ok('分享弹窗关掉了', await waitFor(cdp, `${modalCountText} === 0`, { tries: 25, interval: 200 }), await modalCount(cdp))

      // 推进状态：走详情页的「推进状态」
      ok('点开了推进状态', await clickInMain(cdp, '推进状态'))
      ok('React 推进状态抽屉打开了', await waitFor(cdp, `(${TOP_DRAWER})?.querySelector('.drawer__title')?.textContent === '推进状态'`, { tries: 25, interval: 200 }), await topTitle(cdp))
      await fillTopField(cdp, 'select[name="status"]', 'in_progress')
      await submitTopDrawer(cdp)
      ok('推进后抽屉关掉', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 40, interval: 200 }), await drawerCount(cdp))
      const advanced = await api(app.base, 'GET', `/api/orders/${fixture.orderId}`, undefined, fixture.cookie)
      ok('状态真的推进了', advanced.body.status === 'in_progress', advanced.body.status)
      ok('状态轨上「进行中」变成当前步', await waitFor(cdp, `(document.querySelector('.react-main__inner .track__step--now')?.textContent || '') === '进行中'`, { tries: 30, interval: 200 }), await cdp.eval(`document.querySelector('.react-main__inner .track__step--now')?.textContent || ''`))

      // 删一笔收款（两笔里删掉一笔）
      const payCount = (advanced.body.payments || []).length
      ok('收款记录里有两笔可删', payCount === 2, payCount)
      await cdp.eval(`document.querySelector('.react-main__inner .itemlist button[title="删除这笔"]').click()`)
      ok('删之前问了', await waitFor(cdp, `Boolean(document.querySelector('dialog.modal[open]'))`, { tries: 25, interval: 200 }))
      await clickModalButton(cdp, '删除')
      const payPanel = () => cdp.eval(`([...document.querySelectorAll('.react-main__inner .panel')].map((p) => p.innerText.replace(/\\s+/g, ' ')).find((t) => t.includes('收款记录')) || '')`)
      ok('删完剩一笔', await waitFor(cdp, `([...document.querySelectorAll('.react-main__inner .panel')].map((p) => p.innerText.replace(/\\s+/g, ' ')).find((t) => t.includes('收款记录')) || '').includes('1 笔')`, { tries: 30, interval: 200 }), await payPanel())
      const afterDelete = await api(app.base, 'GET', `/api/orders/${fixture.orderId}`, undefined, fixture.cookie)
      ok('库里也只剩一笔', (afterDelete.body.payments || []).length === 1, (afterDelete.body.payments || []).length)

      // 删单：拿那张「待删」的单试
      await gotoHash(cdp, `/orders/${fixture.doomedOrderId}`)
      ok('待删的单打开了', await waitFor(cdp, `(document.querySelector('.react-main__inner')?.innerText || '').includes(${JSON.stringify(fixture.doomedOrderNo)})`, { tries: 30, interval: 200 }))
      await cdp.eval(`document.querySelector('.react-main__inner button[title="删除订单"]').click()`)
      ok('删单前问了', await waitFor(cdp, `Boolean(document.querySelector('dialog.modal[open]'))`, { tries: 25, interval: 200 }))
      await clickModalButton(cdp, '删除')
      ok('删完回订单列表', await waitFor(cdp, `/^#\\/orders(\\?|$)/.test(location.hash)`, { tries: 40, interval: 200 }), await cdp.eval('location.hash'))
      const gone = await api(app.base, 'GET', `/api/orders/${fixture.doomedOrderId}`, undefined, fixture.cookie)
      ok('这张单真的没了', gone.status === 404, gone.status)
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 财务：区间切换 + 对账 + 点一行进订单 ---- */
    section('财务 · 区间与对账')
    {
      const before = cdp.errors.length

      await gotoHash(cdp, '/finance?range=thisYear')
      ok('财务页渲染出来了', await waitFor(cdp, `Boolean(document.querySelector('.finance-page'))`, { tries: 40, interval: 200 }))
      const headText = await cdp.eval(`document.querySelector('.finance-page__head')?.innerText?.replace(/\\s+/g, ' ') || ''`)
      ok('抬头写着区间和订单数', /\d{4}-\d{2}-\d{2} → \d{4}-\d{2}-\d{2} · \d+ 张订单/.test(headText), headText)
      ok('区间按钮是这五个', await cdp.eval(`[...document.querySelectorAll('.finance-ranges button')].map((b) => b.textContent.trim()).join('/')`) === '本月/上月/近 30 天/今年/自定义', await cdp.eval(`[...document.querySelectorAll('.finance-ranges button')].map((b) => b.textContent.trim()).join('/')`))
      ok('「今年」是选中态', (await cdp.eval(`document.querySelector('.finance-ranges button.is-active')?.textContent.trim()`)) === '今年')

      // 生效的区间看那两个日期框（预设区间的 from/to 是页面算的，不在 URL 里）
      const range = () => cdp.eval(`(() => { const inputs = document.querySelectorAll('.finance-date-picker input[type=date]'); return { from: inputs[0]?.value || '', to: inputs[1]?.value || '' } })()`)
      // 区间账单里的每一格都要和接口对得上（按当前区间查一次接口）
      const cellNumber = (label) => cdp.eval(`(() => {
        const cell = [...document.querySelectorAll('.finance-ledger__cell')].find((c) => c.innerText.includes(${JSON.stringify(label)}))
        const m = (cell?.innerText || '').replace(/,/g, '').match(/-?\\d+(?:\\.\\d+)?/)
        return m ? Number(m[0]) : null
      })()`)
      const span = await range()
      const fin = await api(app.base, 'GET', `/api/finance/summary?from=${span.from}&to=${span.to}`, undefined, fixture.cookie)
      const totals = fin.body.totals || {}
      ok('区间账单列了八项', (await cdp.eval(`document.querySelectorAll('.finance-ledger__cell').length`)) === 8, await cdp.eval(`document.querySelectorAll('.finance-ledger__cell').length`))
      for (const [label, key] of [['订单额', 'order_total'], ['总收款', 'received'], ['退款', 'refunded'], ['净收', 'net_received'], ['应收余额', 'due_total'], ['利润', 'profit']]) {
        const shown = await cellNumber(label)
        ok(`「${label}」和接口一致`, shown === Number(totals[key] || 0), `${shown} vs ${totals[key]}`)
      }

      const pays = await api(app.base, 'GET', `/api/payments?from=${span.from}&to=${span.to}&limit=400`, undefined, fixture.cookie)
      const flowCount = await cdp.eval(`(() => { const panel = [...document.querySelectorAll('.finance-panel')].find((p) => p.innerText.includes('收款流水')); return panel ? panel.querySelectorAll('.finance-table button').length : -1 })()`)
      ok('收款流水的笔数和接口一致', flowCount === (pays.body.items || []).length, `${flowCount} vs ${(pays.body.items || []).length}`)

      // 换区间：点「本月」→ URL 和数字都跟着换
      await cdp.eval(`[...document.querySelectorAll('.finance-ranges button')].find((b) => b.textContent.trim() === '本月').click()`)
      ok('点「本月」换了 URL', await waitFor(cdp, `location.hash.includes('range=thisMonth')`, { tries: 30, interval: 200 }), await cdp.eval(`location.hash`))
      ok('「本月」变成选中态', (await cdp.eval(`document.querySelector('.finance-ranges button.is-active')?.textContent.trim()`)) === '本月')
      const monthSpan = await range()
      const monthFin = await api(app.base, 'GET', `/api/finance/summary?from=${monthSpan.from}&to=${monthSpan.to}`, undefined, fixture.cookie)
      const monthTotal = Number((monthFin.body.totals || {}).order_total || 0)
      ok('换区间后订单额跟着重算', await waitFor(cdp, `(() => {
        const cell = [...document.querySelectorAll('.finance-ledger__cell')].find((c) => c.innerText.includes('订单额'))
        const m = (cell?.innerText || '').replace(/,/g, '').match(/-?\\d+(?:\\.\\d+)?/)
        return m ? Number(m[0]) === ${monthTotal} : false
      })()`, { tries: 30, interval: 200 }), `${await cellNumber('订单额')} vs ${monthTotal}`)
      ok('本月的区间确实比今年短', monthSpan.from > span.from, `${monthSpan.from} vs ${span.from}`)

      // 自定义：把当前 from/to 原样应用一遍，URL 要变成 custom
      await cdp.eval(`[...document.querySelectorAll('.finance-ranges button')].find((b) => b.textContent.trim() === '自定义').click()`)
      ok('点「自定义」走 custom 区间', await waitFor(cdp, `location.hash.includes('range=custom') && location.hash.includes('from=') && location.hash.includes('to=')`, { tries: 30, interval: 200 }), await cdp.eval(`location.hash`))
      const customSpan = await range()
      ok('自定义的 from/to 就是刚才那两个', customSpan.from === monthSpan.from && customSpan.to === monthSpan.to, JSON.stringify(customSpan))

      // 点一行收款流水 → 进那张订单
      await gotoHash(cdp, '/finance?range=thisYear')
      await waitFor(cdp, `Boolean(document.querySelector('.finance-page'))`, { tries: 30, interval: 200 })
      const rowOrderNo = await cdp.eval(`(() => {
        const panel = [...document.querySelectorAll('.finance-panel')].find((p) => p.innerText.includes('收款流水'))
        const row = panel?.querySelector('.finance-table button')
        return row ? (row.innerText.match(/DH\\d+-\\d+/) || [''])[0] : ''
      })()`)
      ok('收款流水里有能点的一行', Boolean(rowOrderNo), rowOrderNo)
      await cdp.eval(`(() => {
        const panel = [...document.querySelectorAll('.finance-panel')].find((p) => p.innerText.includes('收款流水'))
        panel.querySelector('.finance-table button').click()
      })()`)
      ok('点一行跳到了那张订单', await waitFor(cdp, `location.hash.startsWith('#/orders/')`, { tries: 30, interval: 200 }), await cdp.eval(`location.hash`))
      ok('跳过去的正是这一单', (await cdp.eval(`document.querySelector('.react-main__inner')?.innerText || ''`)).includes(rowOrderNo), rowOrderNo)
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 保险箱：登记 → 锁着的样子 → 解开看明文 → 审计 ---- */
    section('保险箱 · 登记与取用')
    {
      const before = cdp.errors.length

      // 初始化时带了保险箱密码，这会儿是解开的。先落锁，从「锁着」这个状态开始测。
      await api(app.base, 'POST', '/api/vault/lock', {}, fixture.cookie)
      await gotoHash(cdp, '/')
      await gotoHash(cdp, '/vault')
      ok('保险箱页渲染出来了', await waitFor(cdp, `Boolean(document.querySelector('.vault-page'))`, { tries: 40, interval: 200 }))
      ok('默认是锁着的', await waitFor(cdp, `(document.querySelector('.vault-page')?.innerText || '').includes('保险箱已锁定')`, { tries: 30, interval: 200 }), await cdp.eval(`document.querySelector('.vault-page')?.innerText?.replace(/\\s+/g, ' ')?.slice(0, 160) || ''`))
      ok('空的时候给出「保险箱是空的」', (await cdp.eval(`document.querySelector('.vault-page')?.innerText || ''`)).includes('保险箱是空的'))

      // 点「登记凭证」：先撞上独立密码这道门
      await clickInMain(cdp, '登记凭证')
      ok('门禁弹窗打开了', await waitFor(cdp, `${modalCountText} === 1`, { tries: 30, interval: 200 }), await modalCount(cdp))
      ok('门禁上写着「解开保险箱」', (await cdp.eval(`(${TOP_MODAL})?.innerText || ''`)).includes('解开保险箱'))
      ok('门禁里有个密码框', (await cdp.eval(`Boolean(${TOP_MODAL}?.querySelector('input[type="password"]'))`)) === true)

      // 先拿错密码试一次
      await fillModalField(cdp, 'input[type="password"]', 'definitely-wrong')
      await clickModalButton(cdp, '解开')
      ok('密码错了会当场报错', await waitFor(cdp, `(${TOP_MODAL})?.querySelector('.note--alert')?.textContent?.length > 0`, { tries: 30, interval: 200 }), await cdp.eval(`(${TOP_MODAL})?.querySelector('.note--alert')?.textContent || ''`))
      ok('错了还留在门禁上', (await modalCount(cdp)) === 1)

      // 再用对密码
      await fillModalField(cdp, 'input[type="password"]', VAULT_PASSWORD)
      await clickModalButton(cdp, '解开')
      ok('解开后门禁自己关掉', await waitFor(cdp, `${modalCountText} === 0`, { tries: 40, interval: 200 }), await modalCount(cdp))
      ok('解锁后接着弹出登记表单', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 40, interval: 200 }), await drawerCount(cdp))
      ok('顶上那行也变成已解开', await waitFor(cdp, `(document.querySelector('.vault-page')?.innerText || '').includes('保险箱已解开')`, { tries: 30, interval: 200 }))
      checkFormShape(ok, await measureForm(cdp), {
        title: '新登记一条登录凭证',
        wide: true,
        controls: ['SELECT', 'SELECT', 'INPUT', 'SELECT', 'INPUT', 'INPUT', 'INPUT', 'INPUT', 'INPUT', 'INPUT', 'INPUT', 'INPUT', 'TEXTAREA'],
        foot: ['取消', '加密保存'],
      }, '凭证表单：')

      // 填一条：客户 + 账号密码
      await fillTopField(cdp, '#credential-customer', String(fixture.customerId))
      await fillTopField(cdp, '#credential-label', 'UI凭证')
      await fillTopField(cdp, '#credential-account', 'smoke-account-001')
      await fillTopField(cdp, '#credential-password', 'smoke-pass-001')
      await submitTopDrawer(cdp)
      ok('存完表单自己关掉', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 40, interval: 200 }), await drawerCount(cdp))
      ok('列表里出现这条凭证', await waitFor(cdp, `(document.querySelector('.vault-page')?.innerText || '').includes('UI凭证')`, { tries: 40, interval: 200 }), await cdp.eval(`document.querySelector('.vault-page')?.innerText?.replace(/\\s+/g, ' ')?.slice(0, 240) || ''`))
      ok('列表里没漏出明文账号', (await cdp.eval(`document.querySelector('.vault-page')?.innerText || ''`)).includes('smoke-account-001') === false)

      // 落锁 → 列表重新封上
      await clickInMain(cdp, '落锁')
      ok('落锁后变回锁定状态', await waitFor(cdp, `(document.querySelector('.vault-page')?.innerText || '').includes('保险箱已锁定')`, { tries: 30, interval: 200 }))
      ok('落锁后内容重新封上', await waitFor(cdp, `(document.querySelector('.vault-page')?.innerText || '').includes('内容已加密封存')`, { tries: 30, interval: 200 }))

      // 点「解开查看」→ 门禁 → 明文
      await clickInMain(cdp, '解开查看')
      ok('又要了一次密码', await waitFor(cdp, `${modalCountText} === 1`, { tries: 30, interval: 200 }))
      await fillModalField(cdp, 'input[type="password"]', VAULT_PASSWORD)
      await clickModalButton(cdp, '解开')
      ok('明文弹窗出来了', await waitFor(cdp, `((${TOP_MODAL})?.innerText || '').includes('smoke-account-001')`, { tries: 40, interval: 200 }), await cdp.eval(`(${TOP_MODAL})?.innerText?.replace(/\\s+/g, ' ')?.slice(0, 200) || ''`))
      ok('明文里也有密码', (await cdp.eval(`(${TOP_MODAL})?.innerText || ''`)).includes('smoke-pass-001'))
      ok('提示这次取用记了审计', (await cdp.eval(`(${TOP_MODAL})?.innerText || ''`)).includes('记入审计日志'))

      // 复制单个字段（复制也算一次取用）
      await captureClipboard(cdp)
      await cdp.eval(`(${TOP_MODAL})?.querySelector('.secretgrid__v button')?.click()`)
      ok('复制到了账号', await waitFor(cdp, `(window.__copied || '').includes('smoke-account-001')`, { tries: 30, interval: 200 }), String(await readClipboard(cdp)).slice(0, 60))
      await clickModalButton(cdp, '看完了，关掉')
      ok('明文弹窗关掉', await waitFor(cdp, `${modalCountText} === 0`, { tries: 30, interval: 200 }))

      // 审计日志：看和复制各留一笔
      await clickInMain(cdp, '取用记录')
      ok('审计抽屉打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 30, interval: 200 }), await drawerCount(cdp))
      ok('审计里记了查看', await waitFor(cdp, `((${TOP_DRAWER})?.innerText || '').includes('查看')`, { tries: 30, interval: 200 }))
      ok('审计里也记了复制', (await topText(cdp)).includes('复制'), (await topText(cdp)).replace(/\s+/g, ' ').slice(0, 200))
      ok('审计里有操作人', (await topText(cdp)).includes('操作人'))
      await clickTopDrawer(cdp, '关掉')
      ok('审计抽屉关掉了', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 30, interval: 200 }))

      // 删掉这条，别留给别的用例
      await cdp.eval(`(() => {
        const rows = [...document.querySelectorAll('.vault-page .item')]
        const row = rows.find((r) => r.innerText.includes('UI凭证'))
        const btn = row && [...row.querySelectorAll('button')].find((b) => b.title === '删除凭证')
        if (btn) btn.click()
        return Boolean(btn)
      })()`)
      ok('删除前会问一句', await waitFor(cdp, `${modalCountText} === 1`, { tries: 30, interval: 200 }))
      await clickModalButton(cdp, '删除')
      ok('删完列表里没有它了', await waitFor(cdp, `(document.querySelector('.vault-page')?.innerText || '').includes('UI凭证') === false`, { tries: 40, interval: 200 }), await cdp.eval(`document.querySelector('.vault-page')?.innerText?.replace(/\\s+/g, ' ')?.slice(0, 200) || ''`))
      const creds = await api(app.base, 'GET', '/api/credentials?limit=50', undefined, fixture.cookie)
      ok('接口里也删干净了', (creds.body.items || []).every((item) => item.label !== 'UI凭证'), JSON.stringify(creds.body.items || []).slice(0, 160))
      ok('这一串操作没有页面报错', cdp.errors.length === before, cdp.errors.slice(before, before + 2))
    }

    /* ---- 设置：最后一个旧页面 ---- */
    section('设置 · 店铺 / 安全 / 数据')
    {
      const before = cdp.errors.length

      await gotoHash(cdp, '/settings')
      ok('设置页渲染出来了', await waitFor(cdp, `Boolean(document.querySelector('.settings-page'))`, { tries: 40, interval: 200 }))
      const text = await cdp.eval(`document.querySelector('.settings-page')?.innerText?.replace(/\\s+/g, ' ') || ''`)
      ok('五块都在：店铺信息 / 安全 / 屏幕识别 / 数据 / 安全须知', ['店铺信息', '安全', '屏幕识别', '数据', '安全须知'].every((key) => text.includes(key)), text.slice(0, 260))
      ok('店铺名是种下去那个', text.includes(fixture.shop || 'UI冒烟小铺'), text.slice(0, 160))
      ok('安全须知读了要花一分钟', text.includes('值得花一分钟读完'))
      ok('数据量那行把几样都数了一遍', text.includes('张订单') && text.includes('位客户') && text.includes('个服务项'))

      // 店铺信息 → 修改
      await clickInMain(cdp, '修改')
      ok('店铺信息表单打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 30, interval: 200 }))
      checkFormShape(ok, await measureForm(cdp), {
        title: '店铺信息',
        wide: false,
        fields: ['店铺 / 招牌名｜整', '怎么称呼你', '联系方式', '报价单页脚｜整', '报价默认有效期（天）', '开单默认备注'],
        controls: ['INPUT', 'INPUT', 'INPUT', 'INPUT', 'INPUT', 'INPUT'],
        foot: ['取消', '保存'],
      }, '店铺信息：')

      // 招牌名是必填，清空要被拦住
      await fillTopField(cdp, '#settings-shop-business-name', '')
      await submitTopDrawer(cdp)
      ok('空招牌名被拦住', await waitFor(cdp, `Boolean(${TOP_DRAWER}?.querySelector('.err:not([hidden])'))`, { tries: 25, interval: 200 }), await cdp.eval(`(${TOP_DRAWER})?.querySelector('.err:not([hidden])')?.textContent || ''`))
      ok('拦住时抽屉不关', (await drawerCount(cdp)) === 1)

      // 填回去，顺手改个联系方式
      await fillTopField(cdp, '#settings-shop-business-name', 'UI冒烟小铺')
      await fillTopField(cdp, '#settings-shop-contact', '微信 ui-smoke')
      await submitTopDrawer(cdp)
      ok('保存后抽屉自己关掉', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 40, interval: 200 }), await drawerCount(cdp))
      ok('页面上换成新的联系方式', await waitFor(cdp, `(document.querySelector('.settings-page')?.innerText || '').includes('微信 ui-smoke')`, { tries: 40, interval: 200 }), await cdp.eval(`document.querySelector('.settings-page')?.innerText?.replace(/\\s+/g, ' ')?.slice(0, 200) || ''`))
      const savedSettings = await api(app.base, 'GET', '/api/settings', undefined, fixture.cookie)
      ok('接口里也存下了', savedSettings.body.contact === '微信 ui-smoke', savedSettings.body.contact)
      ok('招牌名没被改坏', savedSettings.body.business_name === 'UI冒烟小铺', savedSettings.body.business_name)

      // 改登录密码：只看形状，不动真密码（改了后面就没法登录了）
      await clickInMain(cdp, '改密码')
      ok('改密码表单打开了', await waitFor(cdp, `Boolean(document.querySelector(${JSON.stringify(OPEN_DRAWER)}))`, { tries: 30, interval: 200 }))
      checkFormShape(ok, await measureForm(cdp), {
        title: '改登录密码',
        wide: false,
        fields: ['当前密码｜整', '新密码｜整', '再输一次新密码｜整'],
        controls: ['INPUT', 'INPUT', 'INPUT'],
        foot: ['取消', '改密码'],
      }, '改密码：')
      await clickTopDrawer(cdp, '取消')
      ok('取消后关掉', await waitFor(cdp, `${drawerCountText} === 0`, { tries: 25, interval: 200 }))

      // 保险箱那行：这会儿是解开的（前面刚在保险箱里解过）
      ok('保险箱那行写着已解开', (await cdp.eval(`document.querySelector('.settings-page')?.innerText || ''`)).includes('已解开'), await cdp.eval(`document.querySelector('.settings-page')?.innerText?.replace(/\\s+/g, ' ')?.slice(0, 400) || ''`))

      // 导出备份：下载件要出现，文件名要认得出来
      await captureDownloads(cdp)
      await clickInMain(cdp, '导出')
      ok('备份文件下载下来了', await waitFor(cdp, `(window.__downloads || []).some((d) => d.name.includes('备份') && d.name.endsWith('.json'))`, { tries: 40, interval: 200 }), JSON.stringify(await cdp.eval(`window.__downloads || []`)).slice(0, 200))
      ok('导出后还说了句导了多少', await waitFor(cdp, `[...document.querySelectorAll('.toasts .toast')].some((t) => t.textContent.includes('备份已导出'))`, { tries: 25, interval: 200 }))

      // 清空业务数据：危险动作，先弹确认
      await clickInMain(cdp, '清空')
      ok('清空前弹了确认框', await waitFor(cdp, `${modalCountText} === 1`, { tries: 30, interval: 200 }), await modalCount(cdp))
      const danger = await cdp.eval(`(${TOP_MODAL})?.innerText?.replace(/\\s+/g, ' ') || ''`)
      ok('确认框说清了不可撤销', danger.includes('不可撤销') || danger.includes('保留登录密码'), danger.slice(0, 220))
      await clickModalButton(cdp, '取消')
      ok('取消后什么都没清', await waitFor(cdp, `${modalCountText} === 0`, { tries: 25, interval: 200 }))
      const stillThere = await api(app.base, 'GET', '/api/backup/counts', undefined, fixture.cookie)
      ok('数据还在', Number(stillThere.body.orders) > 0, JSON.stringify(stillThere.body))
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
