/* ============================================================
   外壳：导航轨 / 顶栏 / 路由 / 全局搜索 / 主题
   ============================================================ */

import { api, setApiHandlers } from './api.js'
import { h, mount, clear, icon, debounce, fmtMoney } from './dom.js'
import { toastErr, drawer, skeletonRows, toast } from './ui.js'
import { refreshVault, syncVault, vaultLockButton, resetVaultListeners } from './vaultgate.js'

import dashboardView from './views/dashboard.js'
import ordersView from './views/orders.js'
import customersView from './views/customers.js'
import priceView from './views/price.js'
import gamesView from './views/games.js'
import vaultView from './views/vault.js'
import financeView from './views/finance.js'
import quotesView from './views/quotes.js'
import settingsView from './views/settings.js'
import { renderGate, renderSetup } from './views/gate.js'

/* ---------------- 导航表 ---------------- */

export const NAV = [
  { seg: '', label: '总览', icon: 'dashboard', view: dashboardView, tab: true },
  { seg: 'orders', label: '订单', icon: 'orders', view: ordersView, tab: true, badge: (c) => c.open },
  { seg: 'customers', label: '客户', icon: 'customers', view: customersView, tab: true },
  { seg: 'price', label: '价格表', icon: 'price', view: priceView, tab: true },
  { seg: 'games', label: '游戏', icon: 'games', view: gamesView },
  { seg: 'vault', label: '保险箱', icon: 'vault', view: vaultView, badge: (c) => c.credentials },
  { seg: 'finance', label: '财务', icon: 'finance', view: financeView },
  { seg: 'quotes', label: '报价单', icon: 'quotes', view: quotesView },
  { seg: 'settings', label: '设置', icon: 'settings', view: settingsView },
]

const state = {
  me: null,
  settings: {},
  counts: {},
  route: { seg: '', sub: '', query: new URLSearchParams() },
}

/* ---------------- 路由 ---------------- */

export function parseRoute(hash) {
  const raw = String(hash || location.hash || '#/').replace(/^#/, '')
  const [path, qs] = raw.split('?')
  const parts = path.split('/').filter(Boolean)
  return {
    seg: parts[0] || '',
    sub: parts[1] || '',
    rest: parts.slice(2),
    query: new URLSearchParams(qs || ''),
  }
}

export function navigate(to, { replace = false } = {}) {
  const target = String(to).startsWith('#') ? String(to) : `#${to}`
  const current = location.hash || '#/'

  if (replace) {
    history.replaceState(null, '', target)
    runRoute()
    return
  }

  location.hash = target
  // hash 没变就不会有 hashchange（比如点当前这一项，或只改了查询串），
  // 这时候自己重画一次，免得「点了没反应」。
  if ((location.hash || '#/') === current) runRoute()
}

/* ---------------- 应用对象（给视图用） ---------------- */

const app = {
  state,
  navigate,
  get route() {
    return state.route
  },
  /** 重画当前页 + 刷新导航上的角标 */
  async reload() {
    await Promise.all([runRoute(), refreshCounts()])
  },
  refreshCounts,
  setActions,
  openOrder: (id) => navigate(`/orders/${id}`),
  openCustomer: (id) => navigate(`/customers/${id}`),
  openQuoteComposer: null, // 由 quotes 视图注入
  vault: () => import('./vaultgate.js'),
}

/* ---------------- DOM 骨架 ---------------- */

const root = document.getElementById('root')
let shell = null
let railNav = null
let tabsNav = null
let topbarTitle = null
let topbarActions = null
let mainInner = null
let searchWrap = null
let searchInput = null
let searchPop = null
let topbarEl = null

function shellNodes() {
  const brand = h(
    'div.rail__brand',
    h('div.rail__mark', '代'),
    h(
      'div',
      { style: { minWidth: '0' } },
      h('div.rail__name', '代肝运营台'),
      h('div.rail__sub', { id: 'rail-sub' }, '本机私有')
    )
  )

  railNav = h('div.rail__nav', { role: 'navigation', 'aria-label': '主模块' })

  const themeBtn = h('button.navitem', { type: 'button', onclick: toggleTheme })
  const lockBtnWrap = h('div', { style: { padding: '0 2px 0 0' } })
  const logoutBtn = h(
    'button.navitem',
    {
      type: 'button',
      onclick: async () => {
        await api.post('/api/auth/logout')
        toast('已退出登录', 'ok')
        boot()
      },
    },
    h('span.navitem__ico', icon('logout', 17)),
    h('span.navitem__label', '退出登录')
  )

  const rail = h(
    'aside.rail',
    brand,
    railNav,
    h(
      'div.rail__foot',
      h(
        'div',
        { style: { display: 'flex', gap: '6px', padding: '0 4px 6px' } },
        h(
          'button.btn.btn--sm',
          {
            type: 'button',
            onclick: () => navigate('/quotes'),
            style: { flex: '1' },
          },
          '做报价单'
        )
      ),
      themeBtn,
      logoutBtn
    )
  )

  // 主题按钮文字随主题走
  const paintTheme = (dark) => {
    themeBtn.replaceChildren(
      h('span.navitem__ico', icon(dark ? 'moon' : 'sun', 17)),
      h('span.navitem__label', dark ? '深色帐桌' : '浅色帐桌'),
      h('span.navitem__badge', '切换')
    )
  }
  themePainters.length = 0
  themePainters.push(paintTheme)
  paintTheme(document.documentElement.getAttribute('data-theme') !== 'light')
  // 注意：这个按钮的点击已经在上面 h() 的 onclick 里绑过了。
  // 这里绝不能再 addEventListener 一次 —— 一次点击会 toggle 两下（深→浅→深），
  // 表现就是"点了没反应、切不过去"。

  // 顶栏
  searchInput = h('input', {
    type: 'search',
    placeholder: '搜客户 / 手机号 / 单号 / 服务',
    'aria-label': '全局搜索',
    autocomplete: 'off',
    spellcheck: 'false',
  })
  searchPop = h('div.search__pop', { hidden: true })
  searchWrap = h(
    'div.search',
    h(
      'div.search__box',
      icon('search', 16),
      searchInput,
      h('span.search__kbd', '/')
    ),
    searchPop
  )
  const searchToggle = h(
    'button.btn.btn--icon.btn--quiet.search-toggle',
    { type: 'button', 'aria-label': '搜索', onclick: () => toggleMobileSearch() },
    icon('search', 17)
  )

  topbarTitle = h('div.topbar__title', '总览')
  topbarActions = h('div.cluster', { style: { gap: '6px' } })

  // 保险箱锁扣放在顶栏，手机和电脑都够得着
  const lockBtn = vaultLockButton()
  lockBtn.classList.add('btn--sm')

  topbarEl = h(
    'header.topbar',
    topbarTitle,
    h('div.topbar__spacer'),
    searchWrap,
    searchToggle,
    lockBtn,
    topbarActions
  )

  mainInner = h('div.main__inner')
  const main = h('main.main', { id: 'main' }, mainInner)

  tabsNav = h('nav.tabs', { role: 'navigation', 'aria-label': '主模块（手机）' })

  shell = h('div.shell', rail, topbarEl, main, tabsNav)
  return shell
}

export function setActions(...nodes) {
  if (!topbarActions) return
  clear(topbarActions)
  for (const n of nodes.flat()) if (n) topbarActions.appendChild(n)
}

/* ---------------- 主题 ---------------- */

const themePainters = []

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.setAttribute('data-theme', mode)
  else document.documentElement.removeAttribute('data-theme')
  const dark = mode !== 'light'
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', dark ? '#0b0d10' : '#f7f8fa')
  for (const paint of themePainters) {
    try {
      paint(dark)
    } catch {
      /* 忽略单个画笔的故障 */
    }
  }
}

function toggleTheme() {
  const now = document.documentElement.getAttribute('data-theme')
  const next = now === 'light' ? 'dark' : 'light'
  applyTheme(next)
  try {
    localStorage.setItem('xfc.theme', next)
  } catch {}
  toast(next === 'light' ? '换成浅色帐桌' : '换成深色帐桌', 'info', 1400)
}

function initTheme() {
  let saved = null
  try {
    saved = localStorage.getItem('xfc.theme')
  } catch {}
  applyTheme(saved)
}

/* ---------------- 全局搜索 ---------------- */

let searchHits = []
let searchActive = -1

async function runSearch(q) {
  if (!q || q.trim().length < 1) {
    searchPop.hidden = true
    searchHits = []
    return
  }
  let data
  try {
    data = await api.get('/api/search', { q: q.trim() })
  } catch {
    return
  }
  const groups = [
    ['客户', data.customers, (r) => ({ label: r.name, meta: r.phone || r.wechat || r.qq || '', go: `/customers/${r.id}` })],
    [
      '订单',
      data.orders,
      (r) => ({ label: `${r.order_no} ${r.title || ''}`, meta: `${r.customer_name || ''} ${r.status_label || ''} ¥${fmtMoney(r.total)}`, go: `/orders/${r.id}` }),
    ],
    ['服务', data.services, (r) => ({ label: r.name, meta: `¥${fmtMoney(r.base_price)} · ${r.status === 'archived' ? '已下架' : '在架'}`, go: `/price?s=${r.id}` })],
    ['游戏', data.games, (r) => ({ label: r.name, meta: r.short_name || '', go: `/games` })],
    ['凭证', data.credentials, (r) => ({ label: r.label || r.masked_hint, meta: `${r.server || ''} ${r.masked_hint || ''}`, go: `/vault?c=${r.id}` })],
  ]

  searchHits = []
  clear(searchPop)
  let any = false
  for (const [name, rows, map] of groups) {
    if (!rows || !rows.length) continue
    any = true
    const g = h('div.search__group', h('div.search__grouplbl', name))
    for (const row of rows) {
      const m = map(row)
      const idx = searchHits.length
      searchHits.push(m.go)
      g.appendChild(
        h(
          'button.search__hit',
          {
            type: 'button',
            'data-idx': String(idx),
            onclick: () => {
              closeSearch()
              navigate(m.go)
            },
          },
          h('span.truncate', m.label),
          h('span.mono.tiny', m.meta)
        )
      )
    }
    searchPop.appendChild(g)
  }
  if (!any) searchPop.appendChild(h('div.search__group', h('div.empty__body', { style: { padding: '10px 8px' } }, '没搜到。试试单号、手机号或者服务名。')))
  searchActive = -1
  searchPop.hidden = false
}

function closeSearch() {
  searchPop.hidden = true
  searchActive = -1
  topbarEl.classList.remove('topbar--searching')
}

function toggleMobileSearch() {
  if (topbarEl.classList.contains('topbar--searching')) {
    closeSearch()
    searchInput.blur()
  } else {
    topbarEl.classList.add('topbar--searching')
    setTimeout(() => searchInput.focus(), 40)
  }
}

function moveSearch(delta) {
  const buttons = [...searchPop.querySelectorAll('.search__hit')]
  if (!buttons.length) return
  searchActive = (searchActive + delta + buttons.length + 1) % (buttons.length + 1)
  if (searchActive >= buttons.length) searchActive = delta > 0 ? 0 : buttons.length - 1
  // 用 data-active="1"，和 CSS 里的 [data-active='1'] 对齐
  // （toggleAttribute 只会写出空串，选择器匹配不上）
  buttons.forEach((b, i) => {
    if (i === searchActive) b.setAttribute('data-active', '1')
    else b.removeAttribute('data-active')
  })
  buttons[searchActive].scrollIntoView({ block: 'nearest' })
}

function wireSearch() {
  const fire = debounce(() => runSearch(searchInput.value), 180)
  searchInput.addEventListener('input', fire)
  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim()) runSearch(searchInput.value)
  })
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveSearch(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveSearch(-1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const buttons = [...searchPop.querySelectorAll('.search__hit')]
      const pick = searchActive >= 0 ? buttons[searchActive] : buttons[0]
      if (pick) pick.click()
    } else if (e.key === 'Escape') {
      closeSearch()
      searchInput.blur()
    }
  })

  document.addEventListener('click', (e) => {
    if (!searchWrap.contains(e.target) && !e.target.closest('.search-toggle')) closeSearch()
  })

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
    if (e.key === '/' && !typing) {
      e.preventDefault()
      searchInput.focus()
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      searchInput.focus()
    }
  })
}

/* 这两个是挂在 document 上的，登出再登录不能重复挂 */
let searchGlobalWired = false
function wireSearchGlobals() {
  if (searchGlobalWired) return
  searchGlobalWired = true

  document.addEventListener('click', (e) => {
    if (!searchWrap || searchWrap.contains(e.target) || e.target.closest('.search-toggle')) return
    closeSearch()
  })

  document.addEventListener('keydown', (e) => {
    if (!shell) return
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
    if (e.key === '/' && !typing) {
      e.preventDefault()
      searchInput?.focus()
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      searchInput?.focus()
    }
  })
}

/* ---------------- 导航 ---------------- */

/** 手机断点。底部标签只在真正需要时才建出来，桌面端不留空壳。 */
const mobileQuery = window.matchMedia('(max-width: 860px)')

function navButton(item, { compact = false } = {}) {
  const btn = compact
    ? h('button.tab', { type: 'button' })
    : h('button.navitem', { type: 'button' })
  btn.dataset.seg = item.seg
  const paint = () => {
    const badge = item.badge ? item.badge(state.counts || {}) : null
    // 注意：replaceChildren(null) 会插入文字 "null"，必须先把空值滤掉
    if (compact) {
      const kids = [icon(item.icon, 20), h('span', item.label)]
      if (badge) kids.push(h('span.tab__n', String(badge)))
      btn.replaceChildren(...kids)
    } else {
      const kids = [h('span.navitem__ico', icon(item.icon, 17)), h('span.navitem__label', item.label)]
      if (badge) kids.push(h('span.navitem__badge', String(badge)))
      btn.replaceChildren(...kids)
    }
  }
  paint()
  btn.addEventListener('click', () => navigate(item.seg ? `/${item.seg}` : '/'))
  return { btn, paint }
}

let paints = []

function buildNav() {
  clear(railNav)
  clear(tabsNav)
  paints = []

  const groups = [
    { label: '工作台', items: NAV.filter((item) => ['', 'orders'].includes(item.seg)) },
    { label: '业务', items: NAV.filter((item) => ['customers', 'price', 'games'].includes(item.seg)) },
    { label: '工具', items: NAV.filter((item) => ['vault', 'finance', 'quotes', 'settings'].includes(item.seg)) },
  ]

  for (const group of groups) {
    const section = h('div.navgroup', h('div.navgroup__label', group.label))
    for (const item of group.items) {
      const { btn, paint } = navButton(item, { compact: false })
      section.appendChild(btn)
      paints.push(paint)
    }
    railNav.appendChild(section)
  }

  paints.forEach((p) => p())

  // 手机上才有底部标签；桌面上这个容器保持空的
  if (!mobileQuery.matches) return

  for (const item of NAV.filter((n) => n.tab)) {
    const { btn, paint } = navButton(item, { compact: true })
    tabsNav.appendChild(btn)
    paints.push(paint)
  }

  const moreBtn = h('button.tab', { type: 'button' }, icon('more', 20), h('span', '更多'))
  moreBtn.addEventListener('click', () => {
    const rest = NAV.filter((n) => !n.tab)
    const moreDark = document.documentElement.getAttribute('data-theme') !== 'light'
    drawer({
      title: '全部模块',
      body: h(
        'div.stack.stack--tight',
        h(
          'div',
          { style: { display: 'grid', gap: '6px' } },
          rest.map((n) =>
            h(
              'button.navitem',
              {
                type: 'button',
                onclick: () => {
                  navigate(`/${n.seg}`)
                  document.querySelector('dialog.drawer[open]')?.close()
                },
              },
              h('span.navitem__ico', icon(n.icon, 17)),
              h('span.navitem__label', n.label),
              n.badge && state.counts ? h('span.navitem__badge', String(n.badge(state.counts) || '')) : null
            )
          )
        ),
        h('hr'),
        h(
          'button.navitem',
          {
            type: 'button',
            onclick: (e) => {
              toggleTheme()
              e.currentTarget.querySelector('.navitem__label').textContent =
                document.documentElement.getAttribute('data-theme') === 'light' ? '浅色帐桌' : '深色帐桌'
            },
          },
          h('span.navitem__ico', icon(moreDark ? 'moon' : 'sun', 17)),
          h('span.navitem__label', moreDark ? '深色帐桌' : '浅色帐桌'),
          h('span.navitem__badge', '切换')
        ),
        h(
          'button.navitem',
          {
            type: 'button',
            onclick: async () => {
              await api.post('/api/auth/logout')
              toast('已退出登录', 'ok')
              boot()
            },
          },
          h('span.navitem__ico', icon('logout', 17)),
          h('span.navitem__label', '退出登录')
        )
      ),
    })
  })
  tabsNav.appendChild(moreBtn)
}

function markActive(seg) {
  const mark = (sel) => {
    document.querySelectorAll(sel).forEach((el) => {
      if (el.dataset.seg === seg) el.setAttribute('aria-current', 'page')
      else el.removeAttribute('aria-current')
    })
  }
  mark('.rail .navitem')
  mark('.tabs .tab')
}

/* ---------------- 计数 ---------------- */

export async function refreshCounts() {
  try {
    const d = await api.get('/api/dashboard')
    state.counts = d.counts || {}
    state.dashboard = d
  } catch {
    return
  }
  for (const p of paints) p()
}

/* ---------------- 渲染 ---------------- */

let rendering = false
let renderToken = 0
let lastRouteKey = null

async function runRoute() {
  if (!shell) return
  const route = parseRoute()
  state.route = route
  const item = NAV.find((n) => n.seg === route.seg) || NAV[0]

  // 换了页面就回到顶部；只是刷新数据（app.reload）则保持当前位置
  const routeKey = `${route.seg}/${route.sub}?${route.query.toString()}`
  const switched = routeKey !== lastRouteKey
  lastRouteKey = routeKey

  topbarTitle.textContent = item.label
  markActive(item.seg)
  setActions()
  closeSearch()

  const token = ++renderToken
  // 只有真的换页才铺骨架屏。
  // 同页刷新（保存完一个表单、删掉一条记录之类）保留旧内容直接换新的 ——
  // 否则中途内容被清空、页面高度塌成 6 行，浏览器会把滚动位置直接拽回顶部，
  // 表现就是「填完东西页面自己往上滑」。
  const keepScroll = switched ? 0 : window.scrollY
  if (switched) mount(mainInner, skeletonRows(6))

  const ctx = {
    route,
    seg: route.seg,
    sub: route.sub,
    query: route.query,
    app,
    navigate,
    setActions,
    reload: () => app.reload(),
  }

  try {
    const node = await item.view.render(ctx)
    if (token !== renderToken) return
    mount(mainInner, node)
    // 换页回到顶部；同页刷新把滚动位置放回去
    if (switched) {
      window.scrollTo({ top: 0, behavior: 'auto' })
    } else if (Math.abs(window.scrollY - keepScroll) > 1) {
      window.scrollTo({ top: keepScroll, behavior: 'auto' })
    }
  } catch (err) {
    if (token !== renderToken) return
    toastErr(err)
    mount(
      mainInner,
      h(
        'div.panel',
        h(
          'div.panel__body',
          h('div.empty', h('div.empty__title', '这一页没打开'), h('p.empty__body', err.message || '未知错误'), h('button.btn', { type: 'button', onclick: () => runRoute() }, '重试'))
        )
      )
    )
  }
}

/* ---------------- 启动 ---------------- */

/**
 * 后端还是旧进程的提示条。
 *
 * 界面是每次刷新重新读盘的，后端却是启动时加载的那个进程 ——
 * 代码更新后不重启，新加的字段会被后端静默丢掉（填了没反应，也不报错）。
 * 这个提示条就是替人把「该重启了」说出来。关掉后本次会话不再打扰。
 */
let staleBar = null
function showStaleNotice(stale) {
  if (!stale || staleBar) return
  const KEY = 'xfc.stale.dismissed'
  try {
    if (sessionStorage.getItem(KEY) === '1') return
  } catch {
    /* 存不进去就一直显示，也行 */
  }
  const close = () => {
    try {
      sessionStorage.setItem(KEY, '1')
    } catch {
      /* 忽略 */
    }
    staleBar?.remove()
    staleBar = null
  }
  staleBar = h(
    'div.stalebar',
    h('span.stalebar__ico', '!'),
    h('span', '程序改过但还没重启 —— 新加的字段现在存不进去。关掉启动窗口、重新双击 start.cmd 就好。'),
    h('button.stalebar__x', { type: 'button', title: '知道了', onclick: close }, '×')
  )
  document.body.appendChild(staleBar)
}

async function boot() {
  initTheme()
  clear(root)

  let me
  try {
    me = await api.get('/api/auth/me')
  } catch (err) {
    clear(root)
    root.appendChild(
      h(
        'div.gate',
        h(
          'div.gate__card',
          h('div.gate__mark', '代'),
          h('h1', '连不上后台'),
          h('p.muted', err.message || '请确认启动窗口还开着，然后刷新这一页。'),
          h('button.btn.btn--primary', { type: 'button', onclick: () => boot() }, '重试')
        )
      )
    )
    return
  }

  state.me = me
  state.settings = me.settings || {}
  document.title = (me.settings?.business_name || '代肝价格表') + ' · 私用运营台'
  showStaleNotice(me.stale)

  // 拿到状态了就把启动遮罩撤掉，别挡着登录页
  document.getElementById('boot')?.remove()

  if (!me.setup) {
    clear(root)
    root.appendChild(await renderSetup({ onDone: boot }))
    return
  }

  if (!me.authenticated) {
    clear(root)
    root.appendChild(renderGate({ onDone: boot }))
    return
  }

  syncVault(me.vault)
  resetVaultListeners() // 外壳要重建了，先丢掉指向旧锁扣的监听
  clear(root)
  shell = shellNodes()
  root.appendChild(shell)
  // 招牌名要等侧栏建好之后再写（之前是在建之前查的，永远查不到）
  const sub = shell.querySelector('#rail-sub')
  if (sub) sub.textContent = me.settings?.business_name || '本机私有'
  buildNav()
  wireSearch()
  wireSearchGlobals()
  // 转屏、拉窗口时重排导航
  const onBreakpoint = () => {
    buildNav()
    markActive(state.route.seg)
  }
  if (mobileQuery.addEventListener) mobileQuery.addEventListener('change', onBreakpoint)
  else if (mobileQuery.addListener) mobileQuery.addListener(onBreakpoint)
  await refreshCounts()
  await runRoute()
}

setApiHandlers({
  unauthorized: () => {
    // 会话过期：把界面交回登录页
    if (shell) {
      shell = null
      boot()
    }
  },
  vaultLocked: () => {
    refreshVault()
  },
})

// 导航的真正驱动力：hash 一变就重画。
// 这个监听器只能有这一个 —— 之前清理"重复监听"时把它连同 boot() 里那份一起删掉，
// 结果点导航只改地址栏、页面纹丝不动。
window.addEventListener('hashchange', () => {
  if (shell) runRoute()
})

export { app, state }
boot()
