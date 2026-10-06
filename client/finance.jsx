import React, { useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, CalendarDays, CircleDollarSign, CreditCard, TrendingUp } from 'lucide-react'
import { api, PAY_METHOD_LABEL, STATUS_TONE } from './lib/api.js'
import { fmtDay, fmtMoney, fmtDate, monthStart, todayStr } from './lib/formatters.js'

const iconProps = (size = 16) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

function rangeFor(key) {
  const now = new Date()
  const year = now.getFullYear()
  const month = now.getMonth()
  if (key === 'last30') { const from = new Date(); from.setDate(from.getDate() - 29); return { from: fmtDate(from.toISOString()), to: todayStr(), label: '近 30 天' } }
  if (key === 'thisYear') return { from: `${year}-01-01`, to: todayStr(), label: '今年' }
  if (key === 'lastMonth') { const first = new Date(year, month - 1, 1); const last = new Date(year, month, 0); return { from: fmtDate(first.toISOString()), to: fmtDate(last.toISOString()), label: '上月' } }
  return { from: monthStart(), to: todayStr(), label: '本月' }
}

function Tone({ status, label }) {
  return <span className={`finance-status finance-status--${STATUS_TONE[status] || 'muted'}`}><i />{label || status}</span>
}

function MoneyCell({ label, value, tone = '' }) {
  return <div className={`finance-ledger__cell${tone ? ` is-${tone}` : ''}`}><span>{label}</span><b>¥{fmtMoney(value)}</b></div>
}

export default function FinancePage({ route, navigate, reloadKey }) {
  const query = useMemo(() => {
    const preset = route.query.get('range') || 'thisMonth'
    const range = preset === 'custom' ? { from: route.query.get('from') || monthStart(), to: route.query.get('to') || todayStr(), label: '自定义' } : rangeFor(preset)
    return { preset, ...range }
  }, [route.query.toString()])
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [from, setFrom] = useState(query.from)
  const [to, setTo] = useState(query.to)

  useEffect(() => { setFrom(query.from); setTo(query.to) }, [query.from, query.to])
  useEffect(() => {
    let active = true
    setData(null)
    setError('')
    Promise.all([api.get('/api/finance/summary', { from: query.from, to: query.to }), api.get('/api/payments', { from: query.from, to: query.to, limit: 400 })]).then(([summary, payments]) => { if (active) setData({ summary, payments: payments.items || [] }) }).catch((err) => { if (active) { setData({ summary: { totals: {}, daily: [], receivables: [], by_method: [], by_game: [] }, payments: [] }); setError(err.message || '财务数据加载失败') } })
    return () => { active = false }
  }, [query.from, query.to, reloadKey])

  const goRange = (preset) => navigate(`/finance?range=${preset}`)
  const applyCustom = () => navigate(`/finance?range=custom&from=${from}&to=${to}`)
  const summary = data?.summary || { totals: {}, daily: [], receivables: [], by_method: [], by_game: [] }
  const totals = summary.totals || {}
  const daily = (summary.daily || []).slice(-31)
  const maxDay = Math.max(1, ...daily.map((item) => Math.max(Number(item.ordered) || 0, Number(item.received) || 0)))

  return (
    <div className="finance-page">
      <header className="finance-page__head"><div><h2>财务</h2><p>{query.from} → {query.to} · {totals.order_count || 0} 张订单</p></div><div className="finance-date-picker"><CalendarDays {...iconProps(15)} /><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /><span>至</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /><button className="refactor-button" type="button" onClick={applyCustom}>查看</button></div></header>
      <nav className="finance-ranges" aria-label="财务区间">{[['thisMonth', '本月'], ['lastMonth', '上月'], ['last30', '近 30 天'], ['thisYear', '今年']].map(([key, label]) => <button key={key} className={query.preset === key ? 'is-active' : ''} type="button" onClick={() => goRange(key)}>{label}</button>)}<button className={query.preset === 'custom' ? 'is-active' : ''} type="button" onClick={applyCustom}>自定义</button></nav>
      {error ? <div className="refactor-alert" role="alert">{error}</div> : null}
      <section className="finance-ledger"><header><strong>区间账单</strong><span>{query.label}</span></header><div className="finance-ledger__grid"><MoneyCell label="订单额" value={totals.order_total} /><MoneyCell label="总收款" value={totals.received} tone="paid" /><MoneyCell label="退款" value={totals.refunded} tone="refund" /><MoneyCell label="净收" value={totals.net_received} tone="paid" /><MoneyCell label="应收余额" value={totals.due_total} tone="due" /><MoneyCell label="手续费" value={totals.platform_fee} /><MoneyCell label="成本" value={totals.cost} /><MoneyCell label="利润" value={totals.profit} tone="profit" /></div></section>
      {data === null ? <div className="refactor-loading"><span /><span /><span /></div> : <div className="finance-grid"><div className="finance-main"><section className="finance-panel"><header><div><h3>每日开单</h3><span>按下单日统计</span></div><TrendingUp {...iconProps(17)} /></header><div className="finance-bars">{daily.length ? daily.map((item) => <div className="finance-bar" key={item.date} style={{ height: `${Math.max(5, (Number(item.ordered) / maxDay) * 100)}%` }} title={`${fmtDay(item.date)}：开单 ¥${fmtMoney(item.ordered)} · 收款 ¥${fmtMoney(item.received)}`} />) : <span className="finance-empty-text">暂无数据</span>}</div><div className="finance-bars__legend"><span>开单额</span><span>{daily[0] ? fmtDay(daily[0].date) : ''} → {daily.at(-1) ? fmtDay(daily.at(-1).date) : ''}</span></div></section><section className="finance-panel"><header><div><h3>还没结清的单</h3><span>{summary.receivables?.length || 0} 张 · 合计 ¥{fmtMoney((summary.receivables || []).reduce((sum, row) => sum + (Number(row.due_total) || 0), 0))}</span></div><CircleDollarSign {...iconProps(17)} /></header>{summary.receivables?.length ? <div className="finance-table">{summary.receivables.map((order) => <button key={order.id} type="button" onClick={() => navigate(`/orders/${order.id}`)}><span><b>{order.order_no}</b><small>{order.customer_name || '散客'} · {order.title || '未写标题'}</small></span><Tone status={order.status} label={order.status_label} /><strong>¥{fmtMoney(order.due_total)}</strong><ArrowUpRight {...iconProps(14)} /></button>)}</div> : <p className="finance-empty-text">都收齐了。</p>}</section><section className="finance-panel"><header><div><h3>收款流水</h3><span>{data.payments.length} 笔</span></div><CreditCard {...iconProps(17)} /></header>{data.payments.length ? <div className="finance-table">{data.payments.map((payment) => <button key={payment.id} type="button" onClick={() => payment.order_id && navigate(`/orders/${payment.order_id}`)}><span><b>{fmtDay(payment.paid_at)} · {payment.order_no || '未挂订单'}</b><small>{payment.customer_name || '散客'} · {PAY_METHOD_LABEL[payment.method] || payment.method} · {payment.note || ''}</small></span><strong className={payment.kind === 'refund' ? 'is-refund' : 'is-paid'}>{payment.kind === 'refund' ? '−' : '+'}¥{fmtMoney(payment.amount)}</strong></button>)}</div> : <p className="finance-empty-text">这段时间没有收款记录。</p>}</section></div><aside className="finance-side"><section className="finance-panel"><header><div><h3>按收款方式</h3><span>净收款</span></div></header>{summary.by_method?.length ? <div className="finance-breakdown">{summary.by_method.map((item) => <div key={item.method}><span>{PAY_METHOD_LABEL[item.method] || item.method}<small>{item.count} 笔</small></span><b>¥{fmtMoney(item.amount)}</b></div>)}</div> : <p className="finance-empty-text">暂无。</p>}</section><section className="finance-panel"><header><div><h3>按游戏</h3><span>订单额与利润</span></div></header>{summary.by_game?.length ? <div className="finance-breakdown">{summary.by_game.map((item) => <div key={item.game_name}><span>{item.game_name || '未指定游戏'}<small>{item.order_count} 单 · 利润 ¥{fmtMoney(item.profit)}</small></span><b>¥{fmtMoney(item.order_total)}</b></div>)}</div> : <p className="finance-empty-text">暂无。</p>}</section><section className="finance-panel finance-panel--note"><header><div><h3>统计口径</h3></div></header><p>订单额按下单日归集，收款按到账日归集。净收 = 总收款 - 退款；利润 = 订单额 - 平台手续费 - 成本。</p></section></aside></div>}
    </div>
  )
}
