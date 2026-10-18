/**
 * 外观自检
 *
 * 这个脚本的存在理由：改版之后要能证明「契约真的生效了、颜色真的收敛了」，
 * 而不是靠肉眼扫一眼截图。它做三件事：
 *
 *   1. 用计算样式断言外观契约（**纯白扁平**：没有毛玻璃、没有柔光层、
 *      画布是一块平整的纯色、面板靠 1px 细线分层、文字对比度过 AA）；
 *   2. 每个页面在浅色 / 深色下各截一张图，存到 shots/glass/，供人看；
 *   3. 顺带守住「没有页面报错」。
 *
 * 历史：这个脚本原来叫「白玻璃自检」，断言的是反面 —— 柔光层必须存在、
 * 面板必须有 backdrop-filter、侧栏必须是半透明玻璃。第 3 版改成扁平之后
 * 那些断言全部反了过来。**它们不是被删掉，而是取了反**：
 * 「必须有模糊」变成「必须没有模糊」，「画布必须有渐变」变成「必须平整」。
 * 保留断言而不是删掉的理由很简单：扁平化最典型的做坏方式就是
 * 某处漏了一处 backdrop-filter / 一处渐变底，肉眼在截图里看不出来。
 *
 * 用法：
 *   node scripts/checks/glass-check.mjs               跑一遍（有问题退出码 1）
 *   node scripts/checks/glass-check.mjs --no-shots    不截图，只跑断言
 *   XFC_GLASS_CDP_PORT=9444 node scripts/checks/glass-check.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { startTestApp } from '../lib/test-app.mjs'
import { findBrowser, launchBrowser, sleep, waitFor } from '../lib/cdp.mjs'

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
const lumaOf = ({ r, g, b }) => {
  const f = (n) => {
    const v = n / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

const luma = (value) => {
  const c = rgb(value)
  return c ? lumaOf(c) : null
}

/** WCAG 对比度。判断"这行字读不读得出来"要用它，不能用亮度阈值 ——
    深色主题下一次要的浅灰（#a3adbd）亮度只有 0.41，对比度却有 8.6:1。

    **前景带 alpha 时必须先合成到背景上**。这条是踩出来的：侧栏曾经用
    rgba(238,240,245,0.66) 的近白字，早期版本只取 RGB、无视 alpha，于是
    把半透明白当成纯白，在浅色画布上算出 8:1 的假对比度 —— 断言全绿，
    实际文字几乎看不见。 */
function contrast(fg, bg) {
  const f = rgb(fg)
  const b = rgb(bg)
  if (!f || !b) return null
  // 背景本身是半透明（玻璃）时无法只凭两个颜色决定真实反差，宁可判不了
  if (b.a < 0.999) return null
  const fgColor = {
    r: f.r * f.a + b.r * (1 - f.a),
    g: f.g * f.a + b.g * (1 - f.a),
    b: f.b * f.a + b.b * (1 - f.a),
  }
  const la = lumaOf(fgColor)
  const lb = lumaOf(b)
  if (la === null || lb === null) return null
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * 采样真实像素。
 *
 * 这是唯一能证明「柔光真的画出来了」的办法：把截图当成 data URL 塞回页面，
 * 画进 canvas，再读 getImageData。如果柔光层被 html 底色盖住，
 * 画布上就是一块死板的纯色，几个采样点会完全相同 —— 那就露馅了。
 */
async function samplePixels(cdp, points) {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const dataUrl = 'data:image/png;base64,' + shot.data
  return cdp.eval(`(async () => {
    const img = new Image()
    img.src = ${JSON.stringify(dataUrl)}
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const pts = ${JSON.stringify(points)}
    return pts.map(([x, y]) => {
      const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data
      return [d[0], d[1], d[2]]
    })
  })()`)
}

const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2])

async function checkTheme(cdp, theme, expectDark) {
  await cdp.eval(`localStorage.setItem('xfc.theme', ${JSON.stringify(theme)})`)
  // 必须回到总览再重载：上一轮的循环可能把 hash 停在 /settings，
  // 那样页面上根本没有 .react-ledger，玻璃断言会拿到 null 变成假失败。
  await cdp.eval(`location.hash = '#/'`)
  await cdp.send('Page.reload', { ignoreCache: false })
  await waitFor(cdp, `Boolean(document.querySelector('.react-ledger'))`, { tries: 40, interval: 200 })
  await sleep(600)

  const tag = expectDark ? '深色' : '浅色'

  // 1. 柔光层必须**不存在**：扁平契约的第一条
  //    （白玻璃版这里断言的是 "body::before 有径向渐变"，现在是它的反面）
  const glow = await cdp.eval(`(() => {
    const s = getComputedStyle(document.body, '::before')
    return { bg: s.backgroundImage, content: s.content, display: s.display }
  })()`)
  ok(
    `${tag}：没有柔光层（body::before 不再画径向渐变）`,
    !/radial-gradient/.test(glow.bg) && (glow.content === 'none' || glow.display === 'none'),
    `content=${glow.content} display=${glow.display} bg=${glow.bg.slice(0, 60)}`
  )

  // 2. 画布底色跟着主题走
  const canvas = await cdp.eval(`getComputedStyle(document.documentElement).backgroundColor`)
  const canvasLuma = luma(canvas)
  ok(
    `${tag}：画布底色 ${expectDark ? '偏暗' : '偏亮'}（${canvas}）`,
    canvasLuma !== null && (expectDark ? canvasLuma < 0.12 : canvasLuma > 0.9),
    canvas
  )

  // 3. 扁平：侧栏 / 顶栏 / 面板都**不许**有毛玻璃
  for (const [label, sel] of [
    ['侧栏', '.react-sidebar'],
    ['顶栏', '.react-topbar'],
    ['总览抬头', '.react-ledger'],
    ['总览面板', '.react-dashboard-panel'],
  ]) {
    const g = await cdp.eval(glassOf(sel))
    const blurry = Boolean(g) && /blur\(\s*(?!0px)[\d.]+px/.test(String(g.backdrop))
    ok(`${tag}：${label}是平面（没有 backdrop-filter 的模糊）`, Boolean(g) && !blurry, g && g.backdrop)
  }

  // 4. 文字读得出来：用对比度，不用亮度阈值
  const navColor = await cdp.eval(`(() => {
    const el = document.querySelector('.react-sidebar .refactor-navitem span')
    return el ? getComputedStyle(el).color : ''
  })()`)
  const navRatio = contrast(navColor, canvas)
  ok(
    `${tag}：侧栏导航文字对比度 ${navRatio ? navRatio.toFixed(1) : '?'}:1 ≥ 4.5`,
    navRatio !== null && navRatio >= 4.5,
    navColor
  )

  const titleColor = await cdp.eval(`getComputedStyle(document.querySelector('.react-topbar__title h1')).color`)
  const titleRatio = contrast(titleColor, canvas)
  ok(
    `${tag}：顶栏标题对比度 ${titleRatio ? titleRatio.toFixed(1) : '?'}:1 ≥ 4.5`,
    titleRatio !== null && titleRatio >= 4.5,
    titleColor
  )

  // 5. 分层靠线：侧栏必须有一条**看得见**的右边框
  //    （白玻璃版断言的是 "alpha < 0.25"，即线要淡到几乎不存在；
  //      扁平化之后线是唯一的层次手段，太淡等于没有层次。）
  const railBorder = await cdp.eval(`(() => {
    const s = getComputedStyle(document.querySelector('.react-sidebar'))
    return { color: s.borderRightColor, width: s.borderRightWidth, style: s.borderRightStyle }
  })()`)
  const rb = rgb(railBorder.color)
  ok(
    `${tag}：侧栏有一条实线分隔（1px 且不透明）`,
    rb !== null && rb.a > 0.99 && parseFloat(railBorder.width) >= 1 && railBorder.style === 'solid',
    `${railBorder.width} ${railBorder.style} ${railBorder.color}`
  )

  // 6. 像素级：画布必须是**一块平整的纯色**（没有渐变、没有光斑）
  //    x=250 落在主内容左侧的排水沟里（侧栏 236px + 内边距），那里只有画布。
  const gutter = [
    [250, 150],
    [250, 380],
    [250, 620],
    [250, 820],
  ]
  const gutterPixels = await samplePixels(cdp, gutter)
  const flat = gutterPixels.every((p) => dist(p, gutterPixels[0]) === 0)
  ok(
    `${tag}：画布是平整纯色（没有渐变/光斑）`,
    flat,
    gutterPixels.map((p) => `rgb(${p.join(',')})`).join(' / ')
  )

  // 侧栏与画布同为白/同色是**预期行为**：靠那条 1px 线分开，不靠色差。
  // 这里守住的是「侧栏没有偷偷叠一层半透明底」——两者应当完全同色。
  const railPixel = await samplePixels(cdp, [[120, 380]])
  const railTint = dist(railPixel[0], gutterPixels[1])
  ok(
    `${tag}：侧栏没有叠半透明底（与画布同色，差 ${railTint}）`,
    railTint === 0,
    `侧栏 rgb(${railPixel[0].join(',')}) vs 画布 rgb(${gutterPixels[1].join(',')})`
  )

  // 7. 每个页面都不能横向溢出，并且不允许嵌套卡片
  //    嵌套卡片 = 一块带边框的面里面又包一块带边框的面，
  //    第二层边框不提供任何新信息，只是把边距吃窄了 ——
  //    DESIGN.md 明令禁止的就是这个。
  for (const route of ROUTES) {
    await cdp.eval(`location.hash = ${JSON.stringify('#' + route.hash)}`)
    await sleep(450)
    const geo = await cdp.eval(`({
      sw: document.documentElement.scrollWidth,
      iw: window.innerWidth
    })`)
    ok(`${tag}·${route.label}：没有横向溢出`, geo.sw <= geo.iw + 1, `scrollWidth ${geo.sw} > 视口 ${geo.iw}`)

    const nest = await cdp.eval(`(() => {
      const OVERLAY = /search__pop|refactor-search__results|drawer|modal|toast|stalebar/
      // 「页面级的面」= 一整块内容区域的承载面（.panel / 总览面板 / 账簿抬头）。
      // 这类东西套起来才是 DESIGN.md 禁止的"卡片套卡片"：第二层边框不提供
      // 任何新信息，只是把内边距吃掉一圈。
      //
      // 提示条（.note）、空状态（.media-inline-empty，虚线框）、安装进度（.install）
      // 是**内容块**，本来就该落在某个面里，不参与这条契约 —— 把它们算进来
      // 会让断言变成"凡是画了框的都违规"，测的是噪音而不是设计。
      const face = (el) => {
        const s = getComputedStyle(el)
        return (
          el.matches('.panel, .react-dashboard-panel, .react-ledger') &&
          parseFloat(s.borderTopWidth) >= 1 &&
          s.borderTopStyle === 'solid' &&
          parseFloat(s.borderTopLeftRadius) >= 1 &&
          el.getBoundingClientRect().width >= 280
        )
      }
      const all = [...document.querySelectorAll('.react-main *')].filter(face)
      const offenders = all.filter((el) => {
        if (OVERLAY.test(String(el.className || ''))) return false
        for (let p = el.parentElement; p && p !== document.querySelector('.react-main'); p = p.parentElement) {
          if (face(p)) return true
        }
        return false
      })
      return {
        total: all.length,
        offenders: offenders.slice(0, 6).map((el) => String(el.className || el.tagName).slice(0, 64)),
      }
    })()`)
    ok(
      `${tag}·${route.label}：没有嵌套卡片（${nest.total} 个页面级面，全是顶层）`,
      nest.offenders.length === 0,
      nest.offenders.join(' | ')
    )
  }

  // 8. 截图
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

/* ---------------- 价格表：单独看一遍 ---------------- */

async function checkPricePage(cdp) {
  await cdp.eval(`location.hash = '#/price'`)
  /**
   * 价格表**默认全部收起**（一屏先看完整棵大类树），服务行要点开才渲染。
   * 所以这里必须先点一次「全部展开」，不然永远等不到 `.price-service` ——
   * 这条断言在改成默认收起之后就一直是红的（`npm run check` 不含 glass，
   * 所以没人发现）。
   */
  const expanded = await cdp.eval(`(() => {
    const button = [...document.querySelectorAll('.price-catalog__tools button')].find((b) => b.textContent.includes('全部展开'))
    if (!button) return false
    button.click()
    return true
  })()`)
  if (!expanded) {
    ok('价格表：找得到「全部展开」', false, (await cdp.eval(`document.querySelector('.price-catalog__tools')?.innerText || ''`)).slice(0, 120))
    return
  }
  const ready = await waitFor(cdp, `Boolean(document.querySelector('.price-service'))`, { tries: 40, interval: 200 })
  ok('价格表：服务项渲染出来了', ready)
  if (!ready) return
  await sleep(500)

  // 价格表的层次：这一页原来是"一张纸"，group / workspace / category 三层都被
  // 拍平过（border:0; background:transparent）。扁平化之后这条约束变得更重要 ——
  // 只要有一层偷偷加了 backdrop-filter，就说明覆盖层又被写成玻璃了。
  const layers = await cdp.eval(`(() => {
    const glassy = (el) => {
      const f = getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter || 'none'
      if (!f || f === 'none') return false
      const m = String(f).match(/blur\\(\\s*([\\d.]+)px/)
      return Boolean(m) && parseFloat(m[1]) > 0
    }
    const names = ['.price-page', '.price-groups', '.price-group', '.price-workspace', '.price-category', '.price-directory', '.price-catalog']
    return names.map((sel) => {
      const el = document.querySelector(sel)
      if (!el) return { sel, glass: null }
      return { sel, glass: glassy(el), bg: getComputedStyle(el).backgroundColor }
    })
  })()`)
  const glassNames = layers.filter((l) => l.glass).map((l) => l.sel)
  ok(`价格表：整页没有毛玻璃（${glassNames.join(' / ') || '无'}）`, glassNames.length === 0, JSON.stringify(layers))

  // 抬头那行小标签和 h3 说的是同一件事（游戏名），属于噪音
  ok(
    '价格表：抬头不再压一行「当前价格表」小标签',
    (await cdp.eval(`document.querySelectorAll('.price-group__eyebrow').length`)) === 0
  )

  // 列宽必须放得下：5 列的 min-content 之和超过容器就是被挤压
  const cols = await cdp.eval(`(() => {
    const row = document.querySelector('.price-service')
    const labels = document.querySelector('.price-service__labels')
    const host = document.querySelector('.price-catalog')
    const cs = getComputedStyle(row)
    return {
      template: cs.gridTemplateColumns,
      columns: cs.gridTemplateColumns.split(' ').map((v) => parseFloat(v)),
      rowWidth: row.getBoundingClientRect().width,
      labelWidth: labels ? labels.getBoundingClientRect().width : 0,
      hostWidth: host.getBoundingClientRect().width,
      rowHeight: row.getBoundingClientRect().height,
      labelHeight: labels ? labels.getBoundingClientRect().height : 0,
    }
  })()`)
  const sum = cols.columns.reduce((a, b) => a + b, 0)
  // grid 的 gap 也要算进去，否则会低估
  const gap = 12 * (cols.columns.length - 1)
  ok(
    `价格表：服务行列宽放得下（列合计 ${Math.round(sum + gap)} ≤ 行宽 ${Math.round(cols.rowWidth)}）`,
    sum + gap <= cols.rowWidth + 1,
    cols.template
  )
  ok(
    `价格表：列头与服务行对齐（${Math.round(cols.labelWidth)} vs ${Math.round(cols.rowWidth)}）`,
    Math.abs(cols.labelWidth - cols.rowWidth) <= 1,
    `${cols.labelWidth} / ${cols.rowWidth}`
  )

  // 文字不能被裁掉
  const clipped = await cdp.eval(`(() => {
    const sel = ['.price-service__name b', '.price-service__main p', '.price-service__type b', '.price-service__money b', '.price-service__tiers b', '.price-category__toggle b', '.price-directory__item span']
    const out = []
    for (const s of sel) {
      for (const el of document.querySelectorAll(s)) {
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis') {
          out.push(s + ' :: ' + el.textContent.trim().slice(0, 24))
        }
      }
    }
    return out.slice(0, 8)
  })()`)
  ok('价格表：没有文字被硬裁（溢出而未省略号）', clipped.length === 0, clipped.join(' | '))

  // 字号：一行里的"主体"（服务名）不该比"数字"（价格）还小
  const type = await cdp.eval(`(() => {
    const px = (s) => {
      const el = document.querySelector(s)
      return el ? parseFloat(getComputedStyle(el).fontSize) : null
    }
    return {
      name: px('.price-service__name b'),
      desc: px('.price-service__main p'),
      price: px('.price-service__money b'),
      meta: px('.price-service__type b'),
      tier: px('.price-service__tiers b'),
      tag: px('.price-tag'),
      label: px('.price-service__labels'),
    }
  })()`)
  ok(
    `价格表：服务名字号 ${type.name}px ≥ 价格字号 ${type.price}px 的 0.9 倍`,
    type.name !== null && type.price !== null && type.name >= type.price * 0.9,
    JSON.stringify(type)
  )
  ok(
    `价格表：正文最小字号 ${Math.min(type.name, type.desc, type.meta, type.tier, type.tag)}px ≥ 10px`,
    Math.min(type.name, type.desc, type.meta, type.tier, type.tag) >= 10,
    JSON.stringify(type)
  )

  // 对比度：服务名 / 价格 / 说明
  const colors = await cdp.eval(`(() => {
    const c = (s) => {
      const el = document.querySelector(s)
      return el ? getComputedStyle(el).color : null
    }
    return { name: c('.price-service__name b'), desc: c('.price-service__main p'), price: c('.price-service__money b'), meta: c('.price-service__type b') }
  })()`)
  const sheet = await cdp.eval(`getComputedStyle(document.documentElement).backgroundColor`)
  for (const [label, value] of Object.entries(colors)) {
    const ratio = contrast(value, sheet)
    ok(
      `价格表：${label} 对比度 ${ratio ? ratio.toFixed(1) : '?'}:1 ≥ 4.5`,
      ratio !== null && ratio >= 4.5,
      value
    )
  }

  // 行高由内容决定（说明可能折成两行），所以看的是"齐不齐"，不是"一不一样"
  const heights = await cdp.eval(`[...document.querySelectorAll('.price-service')].map((el) => Math.round(el.getBoundingClientRect().height))`)
  const spread = Math.max(...heights) - Math.min(...heights)
  ok(
    `价格表：服务行高度齐（${heights.length} 行，落差 ${spread}px ≤ 24px）`,
    spread <= 24,
    `高度：${heights.join(', ')}`
  )

  if (SHOTS) {
    fs.mkdirSync(SHOT_DIR, { recursive: true })
    const info = await cdp.eval('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })')
    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: Math.min(1440, info.w), height: Math.min(info.h, 2600), scale: 1 },
    })
    fs.writeFileSync(path.join(SHOT_DIR, 'focus-价格表.png'), Buffer.from(shot.data, 'base64'))
    console.log('  · 截图 → shots/glass/focus-价格表.png')
  }

  /* ---- 窄屏再过一遍 ----
     这一页有好几段 media query（760px 折成一列、列头隐藏、缩进收窄），
     而外层刚被我加了 overflow: hidden —— 窄屏最容易在这里出横向溢出。 */
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  })
  await sleep(700)
  const mobile = await cdp.eval(`(() => {
    const sw = document.documentElement.scrollWidth
    const iw = window.innerWidth
    const row = document.querySelector('.price-service')
    const clipped = []
    for (const s of ['.price-service__name b', '.price-service__money b', '.price-category__toggle b', '.price-directory__item span']) {
      for (const el of document.querySelectorAll(s)) {
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== 'ellipsis') {
          clipped.push(s + ' :: ' + el.textContent.trim().slice(0, 20))
        }
      }
    }
    const glassy = (el) => {
      const f = getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter || 'none'
      if (!f || f === 'none') return false
      const m = String(f).match(/blur\\(\\s*([\\d.]+)px/)
      return Boolean(m) && parseFloat(m[1]) > 0
    }
    const all = [...document.querySelectorAll('.react-main *')].filter(glassy)
    const nested = all.filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (glassy(p)) return true
      return false
    })
    return {
      sw, iw,
      rowWidth: row ? Math.round(row.getBoundingClientRect().width) : 0,
      clipped: clipped.slice(0, 5),
      nested: nested.length,
      labelShown: document.querySelector('.price-service__labels') ? getComputedStyle(document.querySelector('.price-service__labels')).display : 'gone',
    }
  })()`)
  ok(`价格表·手机：没有横向溢出（${mobile.sw} ≤ ${mobile.iw}）`, mobile.sw <= mobile.iw + 1)
  ok('价格表·手机：没有文字被硬裁', mobile.clipped.length === 0, mobile.clipped.join(' | '))
  ok('价格表·手机：玻璃依然不嵌套', mobile.nested === 0, String(mobile.nested))
  ok('价格表·手机：列头已隐藏（改成一列布局）', mobile.labelShown === 'none' || mobile.labelShown === 'gone', mobile.labelShown)

  if (SHOTS) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(SHOT_DIR, 'focus-价格表-手机.png'), Buffer.from(shot.data, 'base64'))
    console.log('  · 截图 → shots/glass/focus-价格表-手机.png')
  }

  /* ---- 逐个宽度探一遍 ----
     服务行是 5 列固定最小宽的网格（最小合计 725px），左边还有 190px 的目录轨、
     外面还有约 100px 的内边距。中间宽度的窗口最容易放不下 ——
     而 .react-main 是 overflow-x: clip，放不下不会出滚动条，
     右侧的「价格」和「操作」会被**悄悄裁掉**，肉眼扫一眼根本看不出来。 */
  const widths = [1440, 1280, 1100, 1000, 900, 820, 390]
  const problems = []
  const measured = []
  for (const width of widths) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 720,
    })
    await sleep(600)
    const m = await cdp.eval(`(() => {
      const row = document.querySelector('.price-service')
      const host = document.querySelector('.price-catalog') || document.querySelector('.price-groups')
      if (!row || !host) return null
      const rb = row.getBoundingClientRect()
      const hb = host.getBoundingClientRect()
      return {
        width: window.innerWidth,
        docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        rowScroll: row.scrollWidth,
        rowClient: row.clientWidth,
        rowRight: Math.round(rb.right),
        hostRight: Math.round(hb.right),
        lastColRight: (() => {
          const acts = row.querySelector('.price-service__actions')
          return acts ? Math.round(acts.getBoundingClientRect().right) : null
        })(),
      }
    })()`)
    if (!m) {
      problems.push(`${width}px：量不到服务行`)
      continue
    }
    measured.push(`${m.width}px→行${m.rowClient}/内容${m.rowScroll}`)
    if (width === 1100 && SHOTS) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(path.join(SHOT_DIR, 'focus-价格表-中间宽度.png'), Buffer.from(shot.data, 'base64'))
      console.log('  · 截图 → shots/glass/focus-价格表-中间宽度.png')
    }
    // 行内容比行本身宽 = 网格放不下，被裁
    if (m.rowScroll > m.rowClient + 1) problems.push(`${width}px：行内容 ${m.rowScroll} > 行宽 ${m.rowClient}（被裁）`)
    // 最后一列（操作）越过了宿主容器右边界
    if (m.lastColRight !== null && m.lastColRight > m.hostRight + 1) {
      problems.push(`${width}px：操作列右缘 ${m.lastColRight} 越过容器 ${m.hostRight}`)
    }
    if (m.docOverflow > 1) problems.push(`${width}px：整页横向溢出 ${m.docOverflow}px`)
  }
  ok(`价格表：6 种宽度都放得下（${measured.join(' · ')}）`, problems.length === 0, problems.join(' | '))

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await sleep(400)
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
    const gateBlurry = Boolean(gateGlass) && /blur\(\s*(?!0px)[\d.]+px/.test(String(gateGlass.backdrop))
    ok('登录卡片是平面的（没有毛玻璃）', Boolean(gateGlass) && !gateBlurry, gateGlass && gateGlass.backdrop)
    ok(
      '登录页没有渐变底纹（纯白画布）',
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
    // 第 4 版（Notion 式侧栏）：分组标题回**来了**，但换了理由。
    // 第 3 版删掉它们，是因为当时那三行是 10px/700/字距 .08em 的全大写小标，
    // 配着半透明深色侧栏，确实像一层多余的装饰。
    // 现在侧栏是纯白 + 14px 导航项，一行 11px 灰字标题的作用变成"说清为什么这些项在一起" ——
    // 它比一条分隔线更能表达分组，而且不靠颜色。所以断言反过来：必须正好三组。
    ok(
      '侧栏有三行分组小标题（工作台/业务/工具）',
      (await cdp.eval(
        `JSON.stringify([...document.querySelectorAll('.react-sidebar__nav h2')].map((h) => h.textContent.trim()))`
      )) === JSON.stringify(['工作台', '业务', '工具']),
      await cdp.eval(
        `JSON.stringify([...document.querySelectorAll('.react-sidebar__nav h2')].map((h) => h.textContent.trim()))`
      )
    )
    // 选中态只能靠灰底和字重表达。左侧彩条是竖排导航里最容易"晃"的东西：
    // 滚动时它一直在视野边缘，而且把"你在哪"重复说了两遍（底色已经说过一次）。
    ok(
      '侧栏选中态没有左侧彩条',
      (await cdp.eval(
        `(() => {
           const active = document.querySelector('.react-sidebar .refactor-navitem.is-active')
           if (!active) return 'no-active'
           const before = getComputedStyle(active, '::before')
           return before.content === 'none' || before.content === 'normal' ? 'ok' : before.content + '|' + before.backgroundColor
         })()`
      )) === 'ok'
    )
    // 分组之间的分隔线也要一起去掉：标题已经承担了分组，再加线就是双重标注
    ok(
      '侧栏分组之间不再画分隔线',
      (await cdp.eval(
        `[...document.querySelectorAll('.react-navgroup + .react-navgroup')]
           .every((g) => getComputedStyle(g).borderTopWidth === '0px')`
      ))
    )
    // 页面抬头原来压着一行靛蓝小标签（业务清单 / 客户档案 / 资金看板…），
    // 和下面的 h2 说的是同一件事，是"颜色太杂"的主要来源。
    const headEyebrows = await cdp.eval(
      `[...document.querySelectorAll('.react-main [class*="page__head"], .react-main .customer-detail__head')]
         .reduce((n, head) => n + head.querySelectorAll('.refactor-eyebrow').length, 0)`
    )
    ok('页面抬头不再压一行小标签', headEyebrows === 0, `还剩 ${headEyebrows} 处`)
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

    // 回到浅色再看价格表：这是层次最容易做坏的一页
    await cdp.eval(`localStorage.setItem('xfc.theme', 'light')`)
    await cdp.send('Page.reload', { ignoreCache: false })
    await waitFor(cdp, `Boolean(document.querySelector('.react-shell'))`, { tries: 40, interval: 200 })
    await sleep(500)
    section('价格表细看')
    await checkPricePage(cdp)

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
