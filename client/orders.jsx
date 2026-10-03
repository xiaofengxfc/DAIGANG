import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Check, Clock3, ListFilter, Plus, Search, Users, WalletCards } from 'lucide-react'
import { api, ORDER_STATUS_LABEL, STATUS_TONE } from './lib/api.js'
import { fmtDay, fmtMoney, remainInfo } from './lib/formatters.js'
import { paymentDrawer, progressDrawer } from './lib/legacy-features.js'

const FILTERS = [
  { key: 'open', label: '在做的' },
  { key: 'daily_done', label: '今日已完成' },
  { key: 'pending_confirm', label: '待确认' },
  { key: 'pending_pay', label: '待付款' },
  { key: 'in_progress', label: '进行中' },
  { key: 'pending_accept', label: '待验收' },
  { key: 'due', label: '没收齐' },
  { key: 'done', label: '已完成' },
  { key: '', label: '全部' },
]

const SORTS = [
  { value: '', label: '最新在前' },
  { value: 'oldest', label: '最早在前' },
  { value: 'customer', label: '按客户排' },
  { value: 'amount', label: '按金额排' },
]

const STATUS_LABEL = ORDER_STATUS_LABEL

const iconProps = (size = 15) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

function StatusBadge({ order }) {
  const tone = STATUS_TONE[order.status] || 'muted'
  return <span className={`react-status react-status--${tone}`}><i />{order.status_label || STATUS_LABEL[order.status] || order.status || '未指定'}</span>
}

function DueLabel({ order }) {
  if (!order.due_at) return <span className="orders-cell__muted">未设交付</span>
  const completed = ['done', 'cancelled'].includes(order.status)
  const info = completed ? { kind: 'ok', text: '' } : remainInfo(order.ordered_at, order.due_at)
  return (
    <span className="orders-due">
      <span>{fmtDay(order.due_at)}</span>
      {info.kind === 'invalid' ? <em className="orders-due__bad">填错了</em> : info.text ? <em className={`orders-due__${info.kind}`}>{info.text}</em> : null}
    </span>
  )
}

function CustomerCell({ order, navigate }) {
  if (!order.customer_id) return <span className="orders-cell__muted">散客</span>
  const count = Number(order.customer_order_count) || 0
  return (
    <button className="orders-customer" type="button" title={`看 ${order.customer_name || '这个客户'} 的档案`} onClick={(event) => { event.stopPropagation(); navigate(`/customers/${order.customer_id}`) }}>
      {order.customer_avatar ? <img src={order.customer_avatar} alt="" loading="lazy" /> : <span className="orders-customer__avatar">{(order.customer_name || '?').slice(0, 1)}</span>}
      <span>
        <b>{order.customer_name || '没填名字'}</b>
        <small>{order.customer_phone || (count > 1 ? `第 ${count} 单` : '客户档案')}</small>
      </span>
    </button>
  )
}

function OrderRow({ order, navigate, onReload }) {
  const due = Number(order.due_total) || 0
  const title = order.title || '（没写标题）'
  return (
    <article className="orders-row" role="button" tabIndex={0} onClick={() => navigate(`/orders/${order.id}`)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(`/orders/${order.id}`) } }}>
      <div className="orders-row__order">
        <div className="orders-row__number">
          <b>{order.order_no}</b>
          {order.stale ? <span className="orders-tag orders-tag--amber">{order.idle_days} 天没动</span> : null}
          {order.daily_done_today ? <span className="orders-tag orders-tag--jade">今日已完成</span> : null}
        </div>
        <strong>{title}</strong>
      </div>
      <div className="orders-row__customer"><CustomerCell order={order} navigate={navigate} /></div>
      <div className="orders-row__game">{order.game_name || '未指定游戏'}</div>
      <div className="orders-row__progress">{order.progress_count ? <><b>{order.progress_count} 条</b><small>到 {fmtDay(order.last_progress_on)}</small></> : <span className="orders-cell__muted">还没记</span>}</div>
      <div className="orders-row__status"><StatusBadge order={order} /></div>
      <div className="orders-row__due"><DueLabel order={order} /></div>
      <div className="orders-row__money"><b>¥{fmtMoney(order.total)}</b><span className={due > 0.001 ? 'is-due' : ''}>{due > 0.001 ? `还差 ¥${fmtMoney(due)}` : '已结清'}</span></div>
      <div className="orders-row__actions" onClick={(event) => event.stopPropagation()}>
        <button className="react-mini-button" type="button" title="记进度" onClick={() => progressDrawer(order, onReload)}><Clock3 {...iconProps(14)} /></button>
        {due > 0.001 ? <button className="react-mini-button" type="button" title="记收款" onClick={() => paymentDrawer(order, onReload)}><WalletCards {...iconProps(14)} /></button> : null}
        <button className="react-mini-button" type="button" title="看详情" onClick={() => navigate(`/orders/${order.id}`)}><ArrowUpRight {...iconProps(14)} /></button>
      </div>
    </article>
  )
}

function EmptyOrders({ search, status, onNew }) {
  const title = search ? '没搜到符合条件的单' : status === 'open' ? '手上没有在做的单' : '这个状态下没有单'
  const body = search ? '换个单号、标题或者客户名试试。' : '开一张新单：选客户、挑服务，价格会自动算出来。'
  return <div className="orders-empty"><ListFilter {...iconProps(21)} /><b>{title}</b><span>{body}</span><button className="refactor-button refactor-button--primary" type="button" onClick={onNew}><Plus {...iconProps(15)} />开新单</button></div>
}

function toHref(filters) {
  const params = new URLSearchParams()
  params.set('status', filters.status || '')
  if (filters.q) params.set('q', filters.q)
  if (filters.customerId) params.set('customer_id', filters.customerId)
  if (filters.sort) params.set('sort', filters.sort)
  if (filters.due) params.set('due', '1')
  return `/orders?${params.toString()}`
}

export default function OrdersPage({ route, navigate, onNew, onReload, reloadKey }) {
  const queryFilters = useMemo(() => {
    const due = route.query.get('due') === '1'
    const status = due ? 'due' : route.query.has('status') ? route.query.get('status') || '' : 'open'
    return {
      status,
      q: route.query.get('q') || '',
      customerId: route.query.get('customer_id') || '',
      sort: route.query.get('sort') || '',
      due,
    }
  }, [route.query.toString()])
  const [search, setSearch] = useState(queryFilters.q)
  const [items, setItems] = useState(null)
  const [customer, setCustomer] = useState(null)
  const [error, setError] = useState('')
  const searchTimer = useRef(null)

  useEffect(() => setSearch(queryFilters.q), [queryFilters.q])

  useEffect(() => () => window.clearTimeout(searchTimer.current), [])

  useEffect(() => {
    let active = true
    setItems(null)
    setError('')
    const params = { limit: 300 }
    if (queryFilters.due) params.due = '1'
    else if (queryFilters.status) params.status = queryFilters.status
    if (queryFilters.q) params.q = queryFilters.q
    if (queryFilters.customerId) params.customer_id = queryFilters.customerId
    if (queryFilters.sort) params.sort = queryFilters.sort
    Promise.all([
      api.get('/api/orders', params),
      queryFilters.customerId ? api.get(`/api/customers/${queryFilters.customerId}`).catch(() => null) : Promise.resolve(null),
    ]).then(([data, customerData]) => {
      if (!active) return
      setItems(data.items || [])
      setCustomer(customerData)
    }).catch((err) => {
      if (!active) return
      setError(err.message || '订单列表加载失败')
      setItems([])
    })
    return () => { active = false }
  }, [queryFilters.status, queryFilters.q, queryFilters.customerId, queryFilters.sort, queryFilters.due, reloadKey])

  const update = (overrides) => navigate(toHref({ ...queryFilters, ...overrides }))
  const rows = items || []
  const total = rows.reduce((sum, row) => sum + (Number(row.total) || 0), 0)
  const due = rows.reduce((sum, row) => sum + (Number(row.due_total) || 0), 0)
  const customers = new Set(rows.filter((row) => row.customer_id).map((row) => row.customer_id)).size
  const walkIn = rows.filter((row) => !row.customer_id).length
  const title = queryFilters.customerId ? `${customer?.name || rows[0]?.customer_name || '这个客户'}的单` : queryFilters.due ? '没收齐的单' : queryFilters.status === 'open' ? '在做的单' : queryFilters.status === 'daily_done' ? '今日已完成' : '订单'

  return (
    <div className="orders-page">
      <header className="orders-page__head">
        <div><span className="refactor-eyebrow">业务清单</span><h2>{title}</h2><p>{rows.length ? `${rows.length} 张单 · ${customers} 位客户${walkIn ? ` + ${walkIn} 张散客` : ''} · 合计 ¥${fmtMoney(total)} · 未收 ¥${fmtMoney(due)}` : '按状态、客户和交付情况快速定位订单'}</p></div>
        <button className="refactor-button refactor-button--primary" type="button" onClick={onNew}><Plus {...iconProps(15)} />开新单</button>
      </header>
      <section className="orders-toolbar" aria-label="订单筛选">
        <div className="orders-filters" role="tablist" aria-label="订单状态">
          {FILTERS.map((filter) => {
            const active = filter.key === 'due' ? queryFilters.due : !queryFilters.due && queryFilters.status === filter.key
            return <button key={filter.key || 'all'} className={`orders-filter${active ? ' is-active' : ''}`} type="button" role="tab" aria-selected={active} onClick={() => update(filter.key === 'due' ? { status: 'open', due: true } : { status: filter.key, due: false })}>{filter.label}</button>
          })}
        </div>
        {queryFilters.customerId ? <button className="orders-chip" type="button" title="取消客户筛选" onClick={() => update({ customerId: '' })}><Users {...iconProps(13)} />只看「{customer?.name || '这个客户'}」<span aria-hidden="true">×</span></button> : null}
        <div className="orders-toolbar__spacer" />
        <select className="orders-select" aria-label="排序方式" value={queryFilters.sort} onChange={(event) => update({ sort: event.target.value })}>{SORTS.map((sort) => <option key={sort.value} value={sort.value}>{sort.label}</option>)}</select>
        <label className="orders-search"><Search {...iconProps(15)} /><input type="search" value={search} placeholder="搜单号 / 标题 / 客户名" onChange={(event) => { const value = event.target.value; setSearch(value); window.clearTimeout(searchTimer.current); searchTimer.current = window.setTimeout(() => update({ q: value.trim() }), 260) }} /><kbd>/</kbd></label>
      </section>
      {queryFilters.status === 'daily_done' ? <div className="orders-note"><Check {...iconProps(15)} /><span>这些是今天标了「今日已完成」的单，过了凌晨 4 点会自动回到「在做的」。点进订单可以撤销。</span></div> : null}
      {error ? <div className="refactor-alert" role="alert">{error}</div> : null}
      <section className="orders-panel">
        <div className="orders-table-head"><span>订单</span><span>客户</span><span>游戏</span><span>进度</span><span>状态</span><span>交付</span><span>金额</span><span>操作</span></div>
        {items === null ? <div className="refactor-loading"><span /><span /><span /></div> : rows.length ? <div className="orders-list">{rows.map((order) => <OrderRow key={order.id} order={order} navigate={navigate} onReload={onReload} />)}</div> : <EmptyOrders search={Boolean(queryFilters.q)} status={queryFilters.status} onNew={onNew} />}
      </section>
    </div>
  )
}
