import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, ContactRound, Plus, Search, WalletCards } from 'lucide-react'
import { api } from '../lib/api.js'
import { fmtMoney } from '../lib/formatters.js'

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'due', label: '有欠款' },
  { key: 'repeat', label: '回头客' },
]

const iconProps = (size = 16) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

function CustomerAvatar({ customer }) {
  if (customer.avatar) return <img className="customers-avatar" src={customer.avatar} alt="" loading="lazy" />
  return <span className="customers-avatar customers-avatar--fallback">{(customer.name || '?').slice(0, 1)}</span>
}

function CustomerRow({ customer, navigate }) {
  const due = Number(customer.due_total) || 0
  const tags = Array.isArray(customer.tags) ? customer.tags.slice(0, 3) : []
  return (
    <article className="customers-row" role="button" tabIndex={0} onClick={() => navigate(`/customers/${customer.id}`)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigate(`/customers/${customer.id}`) } }}>
      <div className="customers-row__identity">
        <CustomerAvatar customer={customer} />
        <div>
          <div className="customers-row__name"><b>{customer.name || '未命名客户'}</b>{customer.status === 'archived' ? <span className="customers-tag customers-tag--archived">已归档</span> : null}{tags.map((tag) => <span className="customers-tag" key={tag}>{tag}</span>)}</div>
          <div className="customers-row__contact"><span>{customer.phone || '没填手机号'}</span>{customer.wechat ? <span>微信 {customer.wechat}</span> : null}{customer.qq ? <span>QQ {customer.qq}</span> : null}</div>
        </div>
      </div>
      <div className="customers-row__source">{customer.source || '未注明来源'}</div>
      <div className="customers-row__orders"><b>{customer.order_count || 0}</b><small>张订单</small></div>
      <div className="customers-row__money"><b className={due > 0.001 ? 'is-due' : ''}>{due > 0.001 ? `¥${fmtMoney(due)}` : `¥${fmtMoney(customer.order_total)}`}</b><small>{due > 0.001 ? '未收余额' : '累计订单额'}</small></div>
      <div className="customers-row__credentials"><WalletCards {...iconProps(14)} /><span>{customer.credential_count || 0}</span></div>
      <button className="react-mini-button customers-row__open" type="button" title="看客户档案" onClick={(event) => { event.stopPropagation(); navigate(`/customers/${customer.id}`) }}><ArrowUpRight {...iconProps(15)} /></button>
    </article>
  )
}

function EmptyCustomers({ filtered, onNew }) {
  return <div className="customers-empty"><ContactRound {...iconProps(22)} /><b>{filtered ? '没有符合条件的客户' : '还没有客户'}</b><span>{filtered ? '换个关键词试试，或者清空筛选。' : '建立客户档案后，可以直接查看订单、收款和登录凭证。'}</span><button className="refactor-button refactor-button--primary" type="button" onClick={onNew}><Plus {...iconProps(15)} />建第一个客户</button></div>
}

function toHref(filters) {
  const params = new URLSearchParams()
  if (filters.q) params.set('q', filters.q)
  if (filters.only) params.set('only', filters.only)
  return `/customers${params.toString() ? `?${params.toString()}` : ''}`
}

export default function CustomersPage({ route, navigate, onNew, reloadKey }) {
  const filters = useMemo(() => ({ q: route.query.get('q') || '', only: route.query.get('only') || '' }), [route.query.toString()])
  const [search, setSearch] = useState(filters.q)
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const searchTimer = useRef(null)

  useEffect(() => setSearch(filters.q), [filters.q])
  useEffect(() => () => window.clearTimeout(searchTimer.current), [])

  useEffect(() => {
    let active = true
    setItems(null)
    setError('')
    api.get('/api/customers', { limit: 500, q: filters.q }).then((data) => {
      if (active) setItems(data.items || [])
    }).catch((err) => {
      if (!active) return
      setItems([])
      setError(err.message || '客户列表加载失败')
    })
    return () => { active = false }
  }, [filters.q, reloadKey])

  const all = items || []
  const archivedCount = all.filter((customer) => customer.status === 'archived').length
  let rows = all
  if (filters.only === 'archived') rows = rows.filter((customer) => customer.status === 'archived')
  else rows = rows.filter((customer) => customer.status !== 'archived')
  if (filters.only === 'due') rows = rows.filter((customer) => Number(customer.due_total) > 0.001)
  if (filters.only === 'repeat') rows = rows.filter((customer) => Number(customer.order_count) >= 2)

  const update = (overrides) => navigate(toHref({ ...filters, ...overrides }))
  const title = filters.only === 'archived' ? '已归档客户' : filters.only === 'due' ? '有欠款的客户' : filters.only === 'repeat' ? '回头客' : '客户'

  return (
    <div className="customers-page">
      <header className="customers-page__head">
        <div><h2>{title}</h2><p>{rows.length ? `${rows.length} 位${rows.length !== all.length ? ` · 共 ${all.length} 位` : ''}` : '集中查看客户联系信息、订单和收款情况'}</p></div>
        <button className="refactor-button refactor-button--primary" type="button" onClick={onNew}><Plus {...iconProps(15)} />新建客户</button>
      </header>
      <section className="customers-toolbar" aria-label="客户筛选">
        <div className="customers-filters" role="tablist" aria-label="客户类型">
          {FILTERS.map((filter) => <button key={filter.key || 'all'} className={`customers-filter${filters.only === filter.key ? ' is-active' : ''}`} type="button" role="tab" aria-selected={filters.only === filter.key} onClick={() => update({ only: filter.key })}>{filter.label}</button>)}
          {archivedCount ? <button className={`customers-filter${filters.only === 'archived' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={filters.only === 'archived'} onClick={() => update({ only: 'archived' })}>已归档 {archivedCount}</button> : null}
        </div>
        <div className="customers-toolbar__spacer" />
        <label className="customers-search"><Search {...iconProps(15)} /><input type="search" value={search} placeholder="搜昵称 / 手机号 / 微信 / QQ" onChange={(event) => { const value = event.target.value; setSearch(value); window.clearTimeout(searchTimer.current); searchTimer.current = window.setTimeout(() => update({ q: value.trim() }), 260) }} /><kbd>/</kbd></label>
      </section>
      {error ? <div className="refactor-alert" role="alert">{error}</div> : null}
      <section className="customers-panel">
        <div className="customers-table-head"><span>客户</span><span>来源</span><span>订单</span><span>金额</span><span>凭证</span><span> </span></div>
        {items === null ? <div className="refactor-loading"><span /><span /><span /></div> : rows.length ? <div className="customers-list">{rows.map((customer) => <CustomerRow key={customer.id} customer={customer} navigate={navigate} />)}</div> : <EmptyCustomers filtered={Boolean(filters.q || filters.only)} onNew={onNew} />}
      </section>
    </div>
  )
}
