import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  ClipboardList,
  Command,
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
import { ordersView, customersView, priceView, categoryForm, gamesView, vaultView, financeView, quotesView, openQuoteComposer, settingsView, vaultgate } from './lib/legacy-features.js'
import DashboardPage from './dashboard.jsx'
import OrdersPage from './orders.jsx'
import CustomersPage from './customers.jsx'
import GamesPage from './games.jsx'
import PricePage from './price.jsx'
import FinancePage from './finance.jsx'
import QuotesPage from './quotes.jsx'
import MediaPage from './media.jsx'
import { toast, toastErr } from './lib/legacy-ui.js'
import LegacyPage from './app/legacy-page.jsx'
import ActionsSlot from './app/actions-slot.jsx'
import OverlayHost from './app/overlay-host.jsx'
import { openGameForm } from './game-form.jsx'
import { openCustomerForm } from './customer-form.jsx'
import { navigate as go, parseRoute } from './app/router.js'
import './styles.css'

const NAV = [
  { seg: '', label: '总览', icon: LayoutDashboard, group: '工作台' },
  { seg: 'orders', label: '订单', icon: ClipboardList, group: '工作台', view: ordersView, badge: (c) => c.open },
  { seg: 'customers', label: '客户', icon: Users, group: '业务', view: customersView },
  { seg: 'price', label: '价格表', icon: Tags, group: '业务', view: priceView },
  { seg: 'games', label: '游戏', icon: Gamepad2, group: '业务', view: gamesView },
  { seg: 'vault', label: '保险箱', icon: LockKeyhole, group: '工具', view: vaultView, badge: (c) => c.credentials },
  { seg: 'finance', label: '财务', icon: WalletCards, group: '工具', view: financeView },
  { seg: 'quotes', label: '报价单', icon: FileText, group: '工具', view: quotesView },
  { seg: 'media', label: '自媒体', icon: Radio, group: '工具', badge: (c) => c.media_pending },
  { seg: 'settings', label: '设置', icon: Settings2, group: '工具', view: settingsView },
]

const NAV_BY_SEG = new Map(NAV.map((item) => [item.seg, item]))

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
          {setup ? '数据写入本机 data/ 目录，可随时整体备份。' : '忘记密码时可使用 scripts/reset-password.mjs 重置登录密码。'}
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

function Shell({ me, onLogout }) {
  const [route, setRoute] = useState(parseRoute())
  const [theme, setTheme] = useState(() => localStorage.getItem('xfc.theme') || 'dark')
  const [actions, setActions] = useState([])
  const [counts, setCounts] = useState({})
  const [dashboard, setDashboard] = useState(null)
  const [settings, setSettings] = useState(me.settings || {})
  const [reloadKey, setReloadKey] = useState(0)
  const updateActions = useCallback((...nodes) => {
    setActions(nodes.flat(Infinity).filter(Boolean))
  }, [])

  useEffect(() => {
    const onHash = () => setRoute(parseRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('xfc.theme', theme)
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

  const createCategory = useCallback(async () => {
    try {
      const games = (await api.get('/api/games', { status: 'active', limit: 200 })).items || []
      const saved = await categoryForm({}, games)
      if (saved) await refresh()
    } catch (err) {
      toastErr(err)
    }
  }, [refresh])

  const createQuote = useCallback(async () => {
    try {
      await openQuoteComposer({ navigate: go, app: { reload: refresh } })
    } catch (err) {
      toastErr(err)
    }
  }, [refresh])

  useEffect(() => {
    refresh()
  }, [refresh])

  const current = NAV_BY_SEG.get(route.seg) || NAV[0]
  const groups = ['工作台', '业务', '工具']
  const toggleTheme = () => setTheme((value) => (value === 'light' ? 'dark' : 'light'))

  return (
    <div className="react-shell">
      <aside className="react-sidebar">
        <div className="react-sidebar__brand">
          <span className="refactor-brand__mark">代</span>
          <span>
            <b>{settings.business_name || '代肝运营台'}</b>
            <small>本机私有工作台</small>
          </span>
        </div>
        <nav className="react-sidebar__nav" aria-label="主导航">
          {groups.map((group) => (
            <section key={group}>
              <h2>{group}</h2>
              {NAV.filter((item) => item.group === group).map((item) => (
                <NavItem key={item.seg} item={item} active={current.seg === item.seg} count={counts} onClick={() => go(item.seg ? `/${item.seg}` : '/')} />
              ))}
            </section>
          ))}
        </nav>
        <div className="react-sidebar__footer">
          <button className="react-quick-action" type="button" onClick={() => go('/orders/new')}><Plus {...iconProps(16)} />开新单</button>
          <button className="react-sidebar__button" type="button" onClick={toggleTheme}>{theme === 'light' ? <Moon {...iconProps(16)} /> : <Sun {...iconProps(16)} />} {theme === 'light' ? '深色模式' : '浅色模式'}</button>
          <button className="react-sidebar__button" type="button" onClick={onLogout}><LogOut {...iconProps(16)} />退出登录</button>
        </div>
      </aside>
      <header className="react-topbar">
        <div className="react-topbar__title"><span className="refactor-eyebrow">工作台</span><h1>{current.label}</h1></div>
        <SearchBox onNavigate={go} />
        <div className="react-topbar__tools">
          <span className="react-online"><i />本机运行</span>
          <button className="react-icon-button" type="button" title="刷新数据" onClick={refresh}><RefreshCw {...iconProps(17)} /></button>
          {actions.length ? <ActionsSlot nodes={actions} /> : current.seg === 'customers' && !route.sub ? <button className="refactor-button refactor-button--primary refactor-top-action" type="button" onClick={createCustomer}><Plus {...iconProps(15)} />新建客户</button> : current.seg === 'games' && !route.sub ? <button className="refactor-button refactor-button--primary refactor-top-action" type="button" onClick={createGame}><Plus {...iconProps(15)} />新建游戏</button> : current.seg === 'price' && !route.sub ? null : current.seg === 'quotes' && !route.sub ? <button className="refactor-button refactor-button--primary refactor-top-action" type="button" onClick={createQuote}><Plus {...iconProps(15)} />做报价单</button> : current.seg === 'finance' && !route.sub ? null : current.seg === 'media' && !route.sub ? null : <button className="refactor-button refactor-button--primary refactor-top-action" type="button" onClick={() => go('/orders/new')}><Plus {...iconProps(15)} />开新单</button>}
        </div>
      </header>
      <main className="react-main">
        <div className="react-main__inner">
          {current.seg === '' ? <DashboardPage data={dashboard} navigate={go} onReload={refresh} /> : current.seg === 'orders' && !route.sub && route.query.get('new') !== '1' ? <OrdersPage route={route} navigate={go} onNew={() => go('/orders/new')} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'customers' && !route.sub ? <CustomersPage route={route} navigate={go} onNew={createCustomer} reloadKey={reloadKey} /> : current.seg === 'games' && !route.sub ? <GamesPage route={route} navigate={go} onNew={createGame} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'price' && !route.sub ? <PricePage route={route} navigate={go} onNewGame={createGame} onNewCategory={createCategory} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'finance' && !route.sub ? <FinancePage route={route} navigate={go} reloadKey={reloadKey} /> : current.seg === 'quotes' && !route.sub ? <QuotesPage route={route} navigate={go} onNew={createQuote} onReload={refresh} reloadKey={reloadKey} /> : current.seg === 'media' && !route.sub ? <MediaPage reloadKey={reloadKey} /> : <LegacyPage key={`${route.seg}/${route.sub}?${route.query.toString()}-${reloadKey}`} route={route} item={current} setActions={updateActions} onReload={refresh} counts={counts} settings={settings} vaultgate={vaultgate} navigate={go} />}
        </div>
      </main>
      <nav className="react-mobile-tabs" aria-label="移动端导航">
        {NAV.filter((item) => ['', 'orders', 'customers', 'price'].includes(item.seg)).map((item) => <NavItem key={item.seg} item={item} active={current.seg === item.seg} count={counts} onClick={() => go(item.seg ? `/${item.seg}` : '/')} />)}
        <button className="refactor-navitem" type="button" onClick={() => go('/settings')}><MoreHorizontal {...iconProps(18)} /><span>更多</span></button>
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

  if (loading || !me) return <div className="refactor-boot"><Activity className="spin" {...iconProps(20)} />正在连接本机工作台…</div>
  if (!me.authenticated) return <Gate setup={!me.setup} onDone={load} />
  return <Shell me={me} onLogout={async () => { await api.post('/api/auth/logout'); toast('已退出登录', 'ok'); load() }} />
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
