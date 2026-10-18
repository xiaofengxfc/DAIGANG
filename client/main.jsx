import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  ChevronDown,
  ClipboardList,
  Command,
  Compass,
  FileText,
  Gamepad2,
  LayoutDashboard,
  LockKeyhole,
  LogOut,
  Moon,
  MoreHorizontal,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Sun,
  Tags,
  Users,
  WalletCards,
} from 'lucide-react'
import { api } from './lib/api.js'
import { openQuoteComposer } from './pages/quote-composer.jsx'
import DashboardPage from './pages/dashboard.jsx'
import OrdersPage from './pages/orders.jsx'
import CustomersPage from './pages/customers.jsx'
import CustomerDetailPage from './pages/customer-detail.jsx'
import GamesPage from './pages/games.jsx'
import PricePage from './pages/price.jsx'
import FinancePage from './pages/finance.jsx'
import QuotesPage from './pages/quotes.jsx'
import MediaPage from './pages/media.jsx'
import VaultPage from './pages/vault.jsx'
import SettingsPage from './pages/settings.jsx'
import { toast, toastErr } from './app/toast-store.js'

import NotFound from './app/not-found.jsx'
import OverlayHost from './app/overlay-host.jsx'
import ToastHost from './app/toast.jsx'
import { OrderComposerRoute } from './pages/order-composer.jsx'
import OrderDetailPage from './pages/order-detail.jsx'
import { openGameForm } from './pages/game-form.jsx'
import { openCustomerForm } from './pages/customer-form.jsx'
import { navigate as go, parseRoute } from './app/router.js'
import './styles.css'
// 第 5 版视觉层排最后：同优先级下它永远赢旧规则。
// 旧样式一行没删，回退只需去掉这一行。
import './theme.css'

const NAV = [
  { seg: '', label: '总览', icon: LayoutDashboard, group: '工作台' },
  { seg: 'orders', label: '订单', icon: ClipboardList, group: '工作台', badge: (c) => c.open },
  { seg: 'customers', label: '客户', icon: Users, group: '业务' },
  { seg: 'price', label: '价格表', icon: Tags, group: '业务' },
  { seg: 'games', label: '游戏', icon: Gamepad2, group: '业务' },
  { seg: 'vault', label: '保险箱', icon: LockKeyhole, group: '工具', badge: (c) => c.credentials },
  { seg: 'finance', label: '财务', icon: WalletCards, group: '工具' },
  { seg: 'quotes', label: '报价单', icon: FileText, group: '工具' },
  { seg: 'media', label: '自媒体', icon: Radio, group: '工具', badge: (c) => c.media_pending },
  { seg: 'settings', label: '设置', icon: Settings2, group: '工具' },
]

const NAV_BY_SEG = new Map(NAV.map((item) => [item.seg, item]))

/* 顶栏一级只放五个高频页 —— 十个平铺在顶部会挤成一条标签墙，
   而且「设置」「报价单」这类一天开两次的页面不该和「订单」同权重。
   其余的进「更多」下拉，位置仍然只有一次点击。 */
const PRIMARY_NAV = NAV.filter((item) => ['', 'orders', 'customers', 'price', 'games'].includes(item.seg))
const MORE_NAV = NAV.filter((item) => !PRIMARY_NAV.includes(item))
/* 手机底部标签：最多五个位置（含「更多」），所以这里只放四个 */
const MOBILE_NAV = NAV.filter((item) => ['', 'orders', 'customers', 'price'].includes(item.seg))

/* 主题：浅色（白玻璃）是默认，深色是同一套玻璃在暗处的版本。
   模块加载时就写一次 data-theme —— 否则登录页会先用默认色渲染一遍，
   登录成功进 Shell 才切过去，中间闪一下。 */
const THEME_KEY = 'xfc.theme'

function readTheme() {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
}

applyTheme(readTheme())

/* 标记「正跑在桌面版外壳里」。
   桌面版用 titleBarStyle:'hidden'，右上角由 Electron 画三个系统按钮；
   网页顶栏得给它们让出位置，否则「刷新 / 主操作」会被压在按钮底下点不到。
   preload 是同步注入的，所以这里判空即可，不需要等 IPC ——
   浏览器打开时没有这个对象，也就不会加这个 class（冒烟测试走的正是这条路）。 */
if (window.daiganDesktop) document.documentElement.classList.add('is-desktop')

function iconProps(size = 17) {
  return { size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true }
}

function Field({ label, type = 'text', value, onChange, hint, autoComplete, required = false }) {
  return (
    <label className="refactor-field">
      <span className="refactor-field__label">
        {label}
        {required ? <b aria-hidden="true">*</b> : null}
      </span>
      <input
        className="refactor-input"
        type={type}
        value={value}
        required={required}
        autoComplete={autoComplete}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <span className="refactor-field__hint">{hint}</span> : null}
    </label>
  )
}

function Gate({ setup, onDone }) {
  const [form, setForm] = useState(
    setup
      ? { business_name: '我的代肝小铺', admin_name: '老板', password: '', confirm: '', vault_password: '' }
      : { password: '' }
  )
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    setError('')
    if (setup && form.password !== form.confirm) {
      setError('两次输入的登录密码不一致')
      return
    }
    setBusy(true)
    try {
      if (setup) await api.post('/api/setup', form)
      else await api.post('/api/auth/login', { password: form.password })
      onDone()
    } catch (err) {
      setError(err.message || '没能完成，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="refactor-gate">
      <section className="refactor-gate__panel">
        <div className="refactor-brand">
          <span className="refactor-brand__mark">代</span>
          <span>
            <b>代肝运营台</b>
            <small>本机私有 · 数据不出这台电脑</small>
          </span>
        </div>
        <div className="refactor-gate__heading">
          <span className="refactor-eyebrow">{setup ? '首次设置' : '安全登录'}</span>
          <h1>{setup ? '把帐桌支起来' : '欢迎回来'}</h1>
          <p>{setup ? '设置店铺信息和登录凭证，马上开始整理业务。' : '输入登录密码，继续处理今天的订单。'}</p>
        </div>
        <form className="refactor-form" onSubmit={submit}>
          {setup ? (
            <>
              <div className="refactor-form__grid">
                <Field label="店铺 / 招牌名" value={form.business_name} onChange={set('business_name')} required />
                <Field label="怎么称呼你" value={form.admin_name} onChange={set('admin_name')} required />
              </div>
              <Field label="登录密码" type="password" value={form.password} onChange={set('password')} autoComplete="new-password" hint="至少 6 位" required />
              <Field label="确认登录密码" type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required />
              <Field label="保险箱密码（可稍后设置）" type="password" value={form.vault_password} onChange={set('vault_password')} autoComplete="new-password" hint="用于加密游戏账号凭证，和登录密码分开" />
            </>
          ) : (
            <Field label="登录密码" type="password" value={form.password} onChange={set('password')} autoComplete="current-password" required />
          )}
          {error ? (
            <div className="refactor-alert" role="alert">
              <AlertCircle {...iconProps(16)} />
              <span>{error}</span>
            </div>
          ) : null}
          <button className="refactor-button refactor-button--primary refactor-button--block" disabled={busy} type="submit">
            {busy ? <RefreshCw className="spin" {...iconProps(16)} /> : setup ? <ShieldCheck {...iconProps(16)} /> : <ArrowUpRight {...iconProps(16)} />}
            {busy ? '正在处理…' : setup ? '建好，开始用' : '进入工作台'}
          </button>
        </form>
        <p className="refactor-gate__foot">
          {setup ? '数据写入本机 data/ 目录，可随时整体备份。' : '忘记密码时可使用 scripts/tools/reset-password.mjs 重置登录密码。'}
        </p>
      </section>
    </main>
  )
}

function SearchBox({ onNavigate }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => {
    const onKey = (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
      } else if (event.key === '/' && !typing) {
        event.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const text = query.trim()
    if (!text) {
      setResults(null)
      return undefined
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const data = await api.get('/api/search', { q: text })
        if (!cancelled) setResults(data)
      } catch {
        if (!cancelled) setResults({})
      }
    }, 180)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query])

  const hits = useMemo(() => {
    if (!results) return []
    return [
      ...(results.customers || []).map((row) => ({ group: '客户', label: row.name, meta: row.phone || row.wechat || '', go: `/customers/${row.id}` })),
      ...(results.orders || []).map((row) => ({ group: '订单', label: `${row.order_no} ${row.title || ''}`, meta: row.customer_name || '', go: `/orders/${row.id}` })),
      ...(results.services || []).map((row) => ({ group: '服务', label: row.name, meta: `¥${row.base_price || 0}`, go: `/price?s=${row.id}` })),
      ...(results.games || []).map((row) => ({ group: '游戏', label: row.name, meta: row.short_name || '', go: '/games' })),
      ...(results.credentials || []).map((row) => ({ group: '凭证', label: row.label || row.masked_hint, meta: row.server || '', go: `/vault?c=${row.id}` })),
    ]
  }, [results])

  return (
    <div className="refactor-search">
      <Search {...iconProps(16)} />
      <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索客户、订单、服务…" aria-label="全局搜索" />
      <kbd><Command {...iconProps(12)} /> K</kbd>
      {results ? (
        <div className="refactor-search__results">
          {hits.length ? hits.map((hit, index) => (
            <button key={`${hit.group}-${hit.label}-${index}`} type="button" onClick={() => { onNavigate(hit.go); setQuery(''); setResults(null) }}>
              <span><b>{hit.label}</b><small>{hit.meta}</small></span>
              <em>{hit.group}</em>
            </button>
          )) : <p>没有找到匹配内容</p>}
        </div>
      ) : null}
    </div>
  )
}

function NavItem({ item, active, count, onClick }) {
  const Icon = item.icon
  const badge = item.badge ? item.badge(count || {}) : 0
  return (
    <button className={`refactor-navitem${active ? ' is-active' : ''}`} type="button" onClick={onClick} aria-current={active ? 'page' : undefined}>
      <Icon {...iconProps(17)} />
      <span>{item.label}</span>
      {badge ? <b>{badge}</b> : null}
    </button>
  )
}

/* 顶栏一级导航项：胶囊 + 可选计数。
   图标只在窄屏（文字被隐藏）时才出现 —— 桌面上一排图标加文字会显得零碎。 */
function AppbarLink({ item, active, count, onClick }) {
  const Icon = item.icon
  return (
    <button className={`appbar__link${active ? ' is-active' : ''}`} type="button" onClick={onClick} aria-current={active ? 'page' : undefined}>
      <Icon className="appbar__link-icon" {...iconProps(15)} />
      <span>{item.label}</span>
      {item.badge ? <Badge value={item.badge(count || {})} /> : null}
    </button>
  )
}

function Badge({ value }) {
  if (!value) return null
  return <b className="appbar__badge">{value}</b>
}

/* 「更多」下拉：装次高频页面。
   点外面、按 Esc、选中一项都会收起 —— 一个开着不放的下拉框会挡住内容。 */
function AppbarMore({ items, current, counts, onNavigate }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)
  const active = items.some((item) => item.seg === current.seg)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="appbar__more" ref={boxRef}>
      <button className={`appbar__link${active ? ' is-active' : ''}`} type="button" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>更多</span>
        <ChevronDown {...iconProps(14)} />
      </button>
      {open ? (
        <div className="appbar__menu" role="menu">
          {items.map((item) => {
            const Icon = item.icon
            const badge = item.badge ? item.badge(counts || {}) : 0
            return (
              <button key={item.seg} className={item.seg === current.seg ? 'is-active' : ''} type="button" role="menuitem" onClick={() => { setOpen(false); onNavigate(item.seg) }}>
                <Icon {...iconProps(15)} />
                <span>{item.label}</span>
                {badge ? <b>{badge}</b> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function Shell({ me, onLogout }) {
  const [route, setRoute] = useState(parseRoute())
  const [theme, setTheme] = useState(readTheme)
  const [counts, setCounts] = useState({})
  const [dashboard, setDashboard] = useState(null)
  const [settings, setSettings] = useState(me.settings || {})
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const onHash = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      /* 隐私模式下写不进去就算了，主题当次会话仍然生效 */
    }
  }, [theme])

  const refresh = useCallback(async () => {
    try {
      const dashboard = await api.get('/api/dashboard')
      setDashboard(dashboard)
      setCounts(dashboard.counts || {})
      setReloadKey((value) => value + 1)
    } catch (err) {
      toastErr(err)
    }
    try {
      const auth = await api.get('/api/auth/me')
      setSettings(auth.settings || {})
    } catch {}
  }, [])

  const createCustomer = useCallback(async () => {
    try {
      const saved = await openCustomerForm()
      if (saved) {
        toast(`客户「${saved.name}」已建档`, 'ok')
        await refresh()
      }
    } catch (err) {
      toastErr(err)
    }
  }, [refresh])

  const createGame = useCallback(async () => {
    try {
      const saved = await openGameForm()
      if (saved) await refresh()
    } catch (err) {
      toastErr(err)
    }
  }, [refresh])

  const createQuote = useCallback(async () => {
    try {
      await openQuoteComposer({ navigate: go, onReload: refresh })
    } catch (err) {
      toastErr(err)
    }
  }, [refresh])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 认不出来的地址不偷偷退回总览 —— 抬头和正文都明说「没有这一页」
  const current = NAV_BY_SEG.get(route.seg) || (route.seg ? { seg: route.seg, label: '没有这一页', icon: Compass } : NAV[0])
  const toggleTheme = () => setTheme((value) => (value === 'light' ? 'dark' : 'light'))
  const goTo = (seg) => go(seg ? `/${seg}` : '/')

  return (
    <div className="react-shell">
      {/* 顶栏：一条横贯全宽的玻璃条。
          导航从左侧竖轨搬到顶部横排，是因为这个后台的主内容是宽表 ——
          侧栏常年吃掉 236px，逼得表格缩字号、藏列、加横向滚动。
          一级放五个高频页，其余收进「更多」。 */}
      <header className="appbar">
        <div className="appbar__inner">
          <button className="appbar__brand" type="button" onClick={() => goTo('')} title="回到总览">
            <span className="appbar__mark">代</span>
            <span className="appbar__name">{settings.business_name || '代肝运营台'}</span>
          </button>
          <nav className="appbar__nav" aria-label="主导航">
            {PRIMARY_NAV.map((item) => (
              <AppbarLink key={item.seg || 'home'} item={item} active={current.seg === item.seg} count={counts} onClick={() => goTo(item.seg)} />
            ))}
            <AppbarMore items={MORE_NAV} current={current} counts={counts} onNavigate={goTo} />
          </nav>
          <div className="appbar__tools">
            <SearchBox onNavigate={go} />
            <button className="app-icon" type="button" title="刷新数据" aria-label="刷新数据" onClick={refresh}><RefreshCw {...iconProps(17)} /></button>
            <button className="app-icon" type="button" title={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'} aria-label={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'} onClick={toggleTheme}>{theme === 'light' ? <Moon {...iconProps(17)} /> : <Sun {...iconProps(17)} />}</button>
            <button className="app-icon" type="button" title="退出登录" aria-label="退出登录" onClick={onLogout}><LogOut {...iconProps(17)} /></button>
            <button className="refactor-button refactor-button--primary" type="button" onClick={() => go('/orders/new')}><Plus {...iconProps(15)} />开新单</button>
          </div>
        </div>
      </header>
      <div className="react-main">
        <div className="react-main__inner">
          {current.seg === '' ? <DashboardPage data={dashboard} navigate={go} onReload={refresh} /> : current.seg === 'orders' && !route.sub && route.query.get('new') !== '1' ? <OrdersPage route={route} navigate={go} onNew={() => go('/orders/new')} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'orders' && (route.sub === 'new' || route.query.get('new') === '1') ? <><OrdersPage route={route} navigate={go} onNew={() => go('/orders/new')} onReload={refresh} reloadKey={reloadKey} /><OrderComposerRoute navigate={go} onReload={refresh} /></> : current.seg === 'orders' && route.sub ? <OrderDetailPage key={`order-${route.sub}-${reloadKey}`} route={route} navigate={go} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'customers' && !route.sub ? <CustomersPage route={route} navigate={go} onNew={createCustomer} reloadKey={reloadKey} /> : current.seg === 'customers' && route.sub ? <CustomerDetailPage key={`customer-${route.sub}-${reloadKey}`} route={route} navigate={go} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'games' && !route.sub ? <GamesPage route={route} navigate={go} onNew={createGame} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'price' && !route.sub ? <PricePage route={route} navigate={go} onNewGame={createGame} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'finance' && !route.sub ? <FinancePage route={route} navigate={go} reloadKey={reloadKey} /> : current.seg === 'quotes' && !route.sub ? <QuotesPage route={route} navigate={go} onNew={createQuote} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'media' && !route.sub ? <MediaPage reloadKey={reloadKey} /> : current.seg === 'vault' && !route.sub ? <VaultPage route={route} navigate={go} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'settings' && !route.sub ? <SettingsPage route={route} navigate={go} onReload={refresh} reloadKey={reloadKey} /> : <NotFound route={route} navigate={go} />}
        </div>
      </div>
      <nav className="react-mobile-tabs" aria-label="移动端导航">
        {MOBILE_NAV.map((item) => <NavItem key={item.seg || 'home'} item={item} active={current.seg === item.seg} count={counts} onClick={() => goTo(item.seg)} />)}
        <button className={`refactor-navitem${MORE_NAV.some((item) => item.seg === current.seg) ? ' is-active' : ''}`} type="button" onClick={() => go('/settings')}><MoreHorizontal {...iconProps(18)} /><span>更多</span></button>
      </nav>
      {/* React 浮层（新式抽屉/对话框）挂在这里；旧 ui.js 的 dialog 仍然自己往 body 上挂 */}
      <OverlayHost />
    </div>
  )
}

function App() {
  const [me, setMe] = useState(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      setMe(await api.get('/api/auth/me'))
    } catch (err) {
      toastErr(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  if (loading || !me) return <><div className="refactor-boot"><Activity className="spin" {...iconProps(20)} />正在连接本机工作台…</div><ToastHost /></>
  if (!me.authenticated) return <><Gate setup={!me.setup} onDone={load} /><ToastHost /></>
  return <><Shell me={me} onLogout={async () => { await api.post('/api/auth/logout'); toast('已退出登录', 'ok'); load() }} /><ToastHost /></>
}

class AppErrorBoundary extends React.Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <main className="refactor-gate">
        <section className="refactor-gate__panel">
          <div className="refactor-alert"><AlertCircle {...iconProps(16)} /><span>工作台加载失败：{this.state.error.message || '未知错误'}</span></div>
          <button className="refactor-button refactor-button--primary refactor-button--block" type="button" onClick={() => window.location.reload()}>重新加载</button>
        </section>
      </main>
    )
  }
}

createRoot(document.getElementById('root')).render(<AppErrorBoundary><App /></AppErrorBoundary>)
