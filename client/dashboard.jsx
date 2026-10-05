import React from 'react'
import { ArrowUpRight, Check, Clock3, CreditCard, ListTodo, Plus, WalletCards } from 'lucide-react'
import { api, ORDER_STATUS_LABEL, PAY_KIND_LABEL, PAY_METHOD_LABEL, STATUS_TONE } from './lib/api.js'
import { fmtDay, fmtDayFull, fmtMoney, todayStr } from './lib/formatters.js'
import { toast, toastErr } from './app/toast-store.js'
import { confirmDelete } from './app/confirm.jsx'
import { openPaymentForm } from './payment-form.jsx'
import { openProgressForm } from './progress-form.jsx'

const STATUS_LABEL = ORDER_STATUS_LABEL

const iconProps = (size = 16) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

function LedgerCell({ label, value, tone = '', hint, onClick }) {
  return (
    <button className={`react-ledger__cell${tone ? ` is-${tone}` : ''}`} type="button" title={hint} disabled={!onClick} onClick={onClick}>
      <span>{label}</span>
      <b>{value}</b>
    </button>
  )
}

function DashboardLedger({ data, navigate }) {
  const c = data.counts || {}
  const today = data.today || todayStr()
  return (
    <section className="react-ledger">
      <header className="react-ledger__head">
        <div>
          <strong>今日台面</strong>
          <span>{fmtDayFull(today)}</span>
        </div>
        <span className="react-ledger__summary">本月已收 ¥{fmtMoney(data.month_money?.received)} · 利润 ¥{fmtMoney(data.month_money?.profit)}</span>
      </header>
      <div className="react-ledger__body">
        <div className="react-ledger__group">
          <LedgerCell label="待确认" value={c.pending_confirm || 0} tone={c.pending_confirm ? 'alert' : ''} hint="客户下单了，等你确认" onClick={() => navigate('/orders?status=pending_confirm')} />
          <LedgerCell label="待付款" value={c.pending_pay || 0} tone={c.pending_pay ? 'alert' : ''} hint="还没收到钱" onClick={() => navigate('/orders?status=pending_pay')} />
          <LedgerCell label="进行中" value={c.in_progress || 0} hint="正在做的单" onClick={() => navigate('/orders?status=in_progress')} />
          <LedgerCell label="待验收" value={c.pending_accept || 0} tone={c.pending_accept ? 'alert' : ''} hint="做完了等客户点头" onClick={() => navigate('/orders?status=pending_accept')} />
        </div>
        <div className="react-ledger__group react-ledger__group--money">
          <LedgerCell label="今日新单" value={`¥${fmtMoney(data.today_money?.ordered_amount)}`} hint={`${data.today_money?.ordered_count || 0} 单`} />
          <LedgerCell label="今日已收" value={`¥${fmtMoney(data.today_money?.received)}`} onClick={() => navigate('/finance')} />
          <LedgerCell label="未收余额" value={`¥${fmtMoney(data.receivables)}`} tone={data.receivables > 0 ? 'due' : ''} hint="所有未结清订单的尾款合计" onClick={() => navigate('/orders?due=1')} />
        </div>
      </div>
    </section>
  )
}

function EmptyOnboarding({ navigate }) {
  return (
    <section className="react-dashboard-empty">
      <div className="react-dashboard-empty__icon"><ListTodo {...iconProps(21)} /></div>
      <h2>帐桌支好了，先录第一批价格</h2>
      <p>这个后台不预置任何数据。按下面顺序录入，十分钟就能接手第一单。</p>
      <ol>
        <li>在「游戏」里添加正在代肝的游戏和区服。</li>
        <li>在「价格表」里建立日常、周常、活动等分类。</li>
        <li>在分类下添加服务项，选择计价方式并填单价。</li>
        <li>需要阶梯价或加急之类的增项，就在服务项里继续添加。</li>
        <li>录入客户后，从「订单」开出第一单。</li>
      </ol>
      <div className="react-dashboard-empty__actions">
        <button className="refactor-button refactor-button--primary" type="button" onClick={() => navigate('/games')}><Plus {...iconProps(15)} />先加一个游戏</button>
        <button className="refactor-button" type="button" onClick={() => navigate('/price')}>直接去价格表</button>
      </div>
    </section>
  )
}

function StatusBadge({ status, label }) {
  return <span className={`react-status react-status--${STATUS_TONE[status] || 'muted'}`}><i />{label || STATUS_LABEL[status] || status || '未指定'}</span>
}

function OrderRow({ order, navigate, onReload }) {
  const due = Number(order.due_total) || 0
  return (
    <article className="react-order-row" role="button" tabIndex="0" onClick={() => navigate(`/orders/${order.id}`)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') navigate(`/orders/${order.id}`) }}>
      <div className="react-order-row__main">
        <div className="react-order-row__title"><b>{order.order_no}</b><StatusBadge status={order.status} label={order.status_label} /></div>
        <div className="react-order-row__meta"><span>{order.customer_name || '散客'}</span><span>{order.title || '未填写标题'}</span></div>
      </div>
      <div className="react-order-row__game">{order.game_name || '未指定游戏'}</div>
      <div className="react-order-row__progress">{order.progress_count ? `${order.progress_count} 条进度` : '还没记进度'}</div>
      <div className="react-order-row__money"><b>¥{fmtMoney(order.total)}</b><span className={due > 0.001 ? 'is-due' : ''}>{due > 0.001 ? `尾款 ¥${fmtMoney(due)}` : '已结清'}</span></div>
      <div className="react-order-row__actions" onClick={(event) => event.stopPropagation()}>
        <button className="react-mini-button" type="button" title="记进度" onClick={() => openProgressForm(order, onReload)}><Clock3 {...iconProps(14)} /></button>
        {due > 0.001 ? <button className="react-mini-button" type="button" title="记收款" onClick={() => openPaymentForm(order, onReload)}><WalletCards {...iconProps(14)} /></button> : null}
        <button className="react-mini-button" type="button" title="看详情" onClick={() => navigate(`/orders/${order.id}`)}><ArrowUpRight {...iconProps(14)} /></button>
      </div>
    </article>
  )
}

function OpenOrders({ orders, count, navigate, onReload }) {
  return (
    <section className="react-dashboard-panel">
      <header className="react-dashboard-panel__head"><div><h2>进行中调度</h2><span>按交付时间排在前面的订单</span></div><span className="react-dashboard-panel__count">{count || 0} 单未结束</span></header>
      {orders.length ? <div className="react-orders-list">{orders.map((order) => <OrderRow key={order.id} order={order} navigate={navigate} onReload={onReload} />)}</div> : <div className="react-panel-empty"><ListTodo {...iconProps(19)} /><b>现在手上没有在做的单</b><span>开一单试试，价格会在下单时冻结。</span><button className="refactor-button" type="button" onClick={() => navigate('/orders/new')}><Plus {...iconProps(14)} />开一张新单</button></div>}
      {orders.length ? <footer className="react-dashboard-panel__foot"><button className="refactor-button" type="button" onClick={() => navigate('/orders?status=open')}>看全部在做的单 <ArrowUpRight {...iconProps(14)} /></button></footer> : null}
    </section>
  )
}

function SideList({ title, note, rows, renderRow }) {
  if (!rows.length) return null
  return <section className="react-dashboard-panel react-dashboard-panel--side"><header className="react-dashboard-panel__head"><div><h2>{title}</h2><span>{note}</span></div></header><div className="react-side-list">{rows.map(renderRow)}</div></section>
}

function DashboardSide({ data, navigate, onReload }) {
  return (
    <div className="react-dashboard-side">
      <SideList title="停滞提醒" note="两天没记进度了" rows={data.stale_orders || []} renderRow={(order) => <button className="react-side-row" key={order.id} type="button" onClick={() => navigate(`/orders/${order.id}`)}><span><b>{order.order_no}</b><small>{order.customer_name || '散客'} · 上次 {fmtDay(order.last_progress_on)}</small></span><em>{order.idle_days} 天</em></button>} />
      <SideList title="还没收齐" note="点一下就能记收款" rows={data.unpaid_orders || []} renderRow={(order) => <div className="react-side-row" key={order.id}><span><b>{order.order_no}</b><small>{order.customer_name || '散客'} · {order.title || '未填写标题'}</small></span><div><strong>¥{fmtMoney(order.due_total)}</strong><button className="react-mini-button" type="button" title="记收款" onClick={() => openPaymentForm(order, onReload)}><CreditCard {...iconProps(14)} /></button></div></div>} />
      <SideList title="最近收款" note="最新确认的资金记录" rows={data.recent_payments || []} renderRow={(payment) => <div className="react-side-row" key={payment.id}><span><b>{payment.customer_name || '散客'}</b><small>{payment.order_no || '未挂订单'} · {fmtDay(payment.paid_at)}</small></span><div><strong className={payment.kind === 'refund' ? 'is-refund' : 'is-paid'}>{payment.kind === 'refund' ? '−' : '+'}¥{fmtMoney(payment.amount)}</strong><button className="react-mini-button" type="button" title="删除这笔收款" onClick={async () => { const ok = await confirmDelete({ title: '删掉这笔收款？', message: `${payment.customer_name || '散客'} · ${PAY_KIND_LABEL[payment.kind] || payment.kind} ¥${fmtMoney(payment.amount)}` }); if (!ok) return; try { await api.del(`/api/payments/${payment.id}`); toast('已删除这笔收款', 'ok'); onReload() } catch (err) { toastErr(err) } }}><Check {...iconProps(14)} /></button></div></div>} />
    </div>
  )
}

export default function DashboardPage({ data, navigate, onReload }) {
  if (!data) return <div className="refactor-loading"><span /><span /><span /></div>
  const counts = data.counts || {}
  const empty = !counts.games && !counts.customers && !counts.open && !counts.done
  return <div className="react-dashboard"><DashboardLedger data={data} navigate={navigate} />{empty ? <EmptyOnboarding navigate={navigate} /> : <div className="react-dashboard-grid"><OpenOrders orders={data.open_orders || []} count={counts.open} navigate={navigate} onReload={onReload} /><DashboardSide data={data} navigate={navigate} onReload={onReload} /></div>}</div>
}
