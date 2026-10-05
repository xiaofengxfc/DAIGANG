import React, { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Edit3, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { LOGIN_TYPE_LABEL, PAY_KIND_LABEL, PAY_METHOD_LABEL, STATUS_TONE, api } from './lib/api.js'
import { fmtDate, fmtDay, fmtMoney, remainInfo } from './lib/formatters.js'
import { CopyButton } from './app/copy-button.jsx'
import Modal from './app/modal.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { toast, toastErr } from './app/toast-store.js'
import { openCustomerForm } from './customer-form.jsx'
import { openOrderComposer } from './order-composer.jsx'

/* ============================================================
   客户档案（React 版）
   ============================================================

   原来是 public/js/views/customers.js 里的 renderCustomerDetail()：一位客户的
   全部 —— 在做/已结束的订单、收款流水、联系方式、账目、登录凭证（只露脱敏提示，
   明文要去保险箱）。

   这是旧栈里最后一个页面。搬完它，public/js/views/ 下面就只剩没人再 import 的
   旧代码了。

   两处顺手搬过来的小件：订单行和「归档 / 彻底删除」的三选一确认框
   （旧的是 ui.js 的 choiceDialog()）。
   ============================================================ */

const iconProps = (size) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

export default function CustomerDetailPage({ route, navigate, onReload, reloadKey }) {
  const id = route.sub
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await api.get(`/api/customers/${id}/profile`)
      setProfile(data)
      setError('')
    } catch (err) {
      setError(err?.message || String(err))
      setProfile(null)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  const reload = useCallback(async () => {
    await load()
    if (onReload) await onReload()
  }, [load, onReload])

  if (error) return <div className="refactor-alert" role="alert">{error}</div>
  if (!profile) return <div className="refactor-loading"><span /><span /><span /></div>

  const customer = profile.customer
  const summary = profile.summary
  const orders = profile.orders || []
  const payments = profile.payments || []
  const credentials = profile.credentials || []

  async function editProfile() {
    const saved = await openCustomerForm(customer, { title: '改客户资料' })
    if (saved) reload()
  }

  async function restore() {
    try {
      await api.patch(`/api/customers/${customer.id}`, { status: 'active' })
      toast(`客户「${customer.name}」已恢复`, 'ok')
      reload()
    } catch (err) {
      toastErr(err)
    }
  }

  return (
    <div className="customer-detail">
      <header className="customer-detail__head">
        <div className="cluster" style={{ gap: 'var(--sp-3)', alignItems: 'center' }}>
          {customer.avatar
            ? <img className="avatar avatar--lg" src={customer.avatar} alt="" style={{ flex: 'none' }} />
            : <div className="avatar avatar--lg" style={{ flex: 'none' }}>{(customer.name || '?').slice(0, 1)}</div>}
          <div className="pagehead__txt">
            <h1>{customer.name}</h1>
            <p className="pagehead__sub">
              {`${summary.order_count} 张单 · 累计 ¥${fmtMoney(summary.order_total)}${summary.due_total > 0.001 ? ` · 还欠 ¥${fmtMoney(summary.due_total)}` : ' · 已结清'}`}
            </p>
          </div>
        </div>
        <div className="customer-detail__actions">
          <button className="refactor-button refactor-button--primary" type="button" onClick={() => openOrderComposer({ navigate, onReload: reload }, { presetCustomer: customer.id })}>
            <Plus {...iconProps(14)} />给 TA 开单
          </button>
          <button className="refactor-button" type="button" onClick={editProfile}><Edit3 {...iconProps(14)} />改资料</button>
          {customer.status === 'archived' ? (
            <button className="refactor-button" type="button" onClick={restore}><RefreshCw {...iconProps(14)} />恢复</button>
          ) : null}
          <button className="react-mini-button" type="button" title="归档或彻底删除这位客户" onClick={() => removeCustomer(customer, { navigate, reload })}>
            <Trash2 {...iconProps(14)} />
          </button>
          <button className="refactor-button" type="button" onClick={() => navigate('/customers')}>返回列表</button>
        </div>
      </header>

      <div className="split">
        <div className="stack">
          <section className="panel">
            <div className="panel__body">
              <SectionHead
                title="订单"
                note={`${orders.length} 张`}
                action={orders.length ? <button className="btn btn--sm" type="button" onClick={() => navigate(`/orders?customer_id=${customer.id}&status=`)}>看全部</button> : null}
              />
            </div>
            {orders.length ? (
              <CustomerOrders customer={customer} orders={orders} navigate={navigate} />
            ) : (
              <div className="panel__body">
                <div className="empty">
                  <div className="empty__title">还没有单</div>
                  <p className="empty__body">给这个客户开第一张单。</p>
                  <button className="refactor-button refactor-button--primary" type="button" onClick={() => openOrderComposer({ navigate, onReload: reload }, { presetCustomer: customer.id })}>开单</button>
                </div>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel__body"><SectionHead title="收款流水" note={`${payments.length} 笔`} /></div>
            {payments.length ? (
              <div className="itemlist">
                {payments.map((payment) => (
                  <div className="item" key={payment.id} style={{ cursor: 'default' }}>
                    <div className="item__main">
                      <div className="item__title">
                        {PAY_KIND_LABEL[payment.kind] || payment.kind}
                        <span className="tag">{PAY_METHOD_LABEL[payment.method] || payment.method}</span>
                      </div>
                      <div className="item__meta">
                        <span>{fmtDay(payment.paid_at)}</span>
                        <span>{payment.order_no || ''}</span>
                        {payment.note ? <span>{payment.note}</span> : null}
                      </div>
                    </div>
                    <div className="item__right">
                      <div className={`item__fig ${payment.kind === 'refund' ? 'tone-oxblood' : 'tone-jade'}`}>
                        {`${payment.kind === 'refund' ? '−' : '+'}¥${fmtMoney(payment.amount)}`}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="panel__body"><p className="dim sm">还没有收款记录。</p></div>
            )}
          </section>
        </div>

        <div className="stack">
          <section className="panel">
            <div className="panel__body"><SectionHead title="联系方式" /></div>
            <div className="panel__body" style={{ paddingTop: '0' }}>
              <div className="stack stack--tight">
                <dl className="kv">
                  <dt>手机号</dt>
                  <dd>{customer.phone ? <span className="cluster"><span className="mono">{customer.phone}</span><CopyButton text={customer.phone} /></span> : <span className="dim">没填</span>}</dd>
                  <dt>微信</dt>
                  <dd>{customer.wechat ? <span className="cluster"><span className="mono">{customer.wechat}</span><CopyButton text={customer.wechat} /></span> : <span className="dim">没填</span>}</dd>
                  <dt>QQ</dt>
                  <dd>{customer.qq ? <span className="mono">{customer.qq}</span> : <span className="dim">没填</span>}</dd>
                  <dt>来源</dt>
                  <dd>{customer.source || '—'}</dd>
                  <dt>建档</dt>
                  <dd>{fmtDate(customer.created_at)}</dd>
                </dl>
                {customer.tags?.length ? <div className="cluster">{customer.tags.map((tag) => <span className="tag" key={tag}>{tag}</span>)}</div> : null}
                {customer.note ? <div className="note">{customer.note}</div> : null}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel__body"><SectionHead title="账目" /></div>
            <div className="panel__body" style={{ paddingTop: '0' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px' }}>
                <span className="dim">累计订单额</span>
                <span className="num">{`¥${fmtMoney(summary.order_total)}`}</span>
                <span className="dim tone-jade">已收</span>
                <span className="num tone-jade">{`¥${fmtMoney(summary.paid_total)}`}</span>
                <span className="dim">{summary.due_total > 0.001 ? '还欠' : '尾款'}</span>
                <span className="num">{summary.due_total > 0.001 ? <span className="tone-amber">{`¥${fmtMoney(summary.due_total)}`}</span> : '0'}</span>
                <span className="dim">在做的单</span>
                <span className="num">{String(summary.active_orders)}</span>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel__body">
              <SectionHead
                title="登录凭证"
                note={`${credentials.length} 条`}
                action={<button className="btn btn--sm" type="button" onClick={() => navigate(`/vault?customer=${customer.id}`)}>去保险箱</button>}
              />
            </div>
            <div className="panel__body" style={{ paddingTop: '0' }}>
              {credentials.length ? (
                <div className="itemlist">
                  {credentials.map((cred) => (
                    <div className="item" key={cred.id} style={{ cursor: 'default' }}>
                      <div className="item__main">
                        <div className="item__title">
                          {cred.label || '未命名'}
                          <span className="tag">{LOGIN_TYPE_LABEL[cred.login_type] || cred.login_type}</span>
                        </div>
                        <div className="item__meta">
                          <span>{cred.game_name || '未指定'}</span>
                          <span>{cred.server || ''}</span>
                          <span className="mono">{cred.masked_hint}</span>
                        </div>
                      </div>
                      <button className="btn btn--sm" type="button" onClick={() => navigate(`/vault?customer=${customer.id}&c=${cred.id}`)}>去保险箱</button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="dim sm">这个客户还没有登记游戏登录凭证。</p>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function SectionHead({ title, note, action = null }) {
  return (
    <div className="sechead">
      <h3>{title}</h3>
      {note ? <span className="sechead__note">{note}</span> : null}
      {action ? <><div style={{ flex: '1' }} />{action}</> : null}
    </div>
  )
}

/** 在做 / 已结束 的一张订单行 */
function OrderLine({ order, navigate }) {
  const done = ['done', 'cancelled'].includes(order.status)
  const info = done ? { kind: 'ok', text: '' } : remainInfo(order.ordered_at, order.due_at)
  const due = Number(order.due_total) || 0
  return (
    <button className="item" type="button" onClick={() => navigate(`/orders/${order.id}`)}>
      <div className="item__main">
        <div className="item__title">
          {order.order_no}
          <Lamp label={order.status_label} tone={STATUS_TONE[order.status] || 'muted'} />
          {!done && info.text ? <span className={`duepill duepill--${info.kind}`}>{info.text}</span> : null}
        </div>
        <div className="item__meta">
          <span>{order.title || '没写标题'}</span>
          <span>{fmtDay(order.ordered_at)}</span>
          {order.due_at ? <span>{`交付 ${fmtDay(order.due_at)}`}</span> : null}
        </div>
      </div>
      <div className="item__right">
        <div className="item__fig">{`¥${fmtMoney(order.total)}`}</div>
        <div className="tbl__meta">{due > 0.001 ? <span className="tone-amber">{`未收 ¥${fmtMoney(due)}`}</span> : <span className="dim">已结清</span>}</div>
      </div>
    </button>
  )
}

/**
 * 客户名下的订单。
 * 客户会反复下单，单多了不能一股脑铺开 —— 先列在做的，已结束的收在后面，
 * 各自封顶，剩下的给个「还有 N 张」。
 */
function CustomerOrders({ customer, orders, navigate }) {
  const ACTIVE_MAX = 6
  const CLOSED_MAX = 3
  const active = orders.filter((order) => !['done', 'cancelled'].includes(order.status))
  const closed = orders.filter((order) => ['done', 'cancelled'].includes(order.status))
  const unpaid = active.filter((order) => Number(order.due_total) > 0.001).length

  return (
    <div>
      <div className="custorder__sum">
        <span>{`在做 ${active.length}`}</span>
        {closed.length ? <span className="dim">{`· 已结束 ${closed.length}`}</span> : null}
        {unpaid ? <span className="tone-amber">{`· ${unpaid} 张没收齐`}</span> : null}
      </div>
      <div className="itemlist">
        {active.slice(0, ACTIVE_MAX).map((order) => <OrderLine key={order.id} order={order} navigate={navigate} />)}
        {active.length > ACTIVE_MAX ? (
          <button className="item item--more" type="button" onClick={() => navigate(`/orders?customer_id=${customer.id}&status=open`)}>
            <span className="sm">{`还有 ${active.length - ACTIVE_MAX} 张在做的单`}</span>
            <ArrowRight {...iconProps(13)} />
          </button>
        ) : null}
        {closed.length ? (
          <>
            <div className="custorder__sep"><span className="sm dim">已结束</span></div>
            {closed.slice(0, CLOSED_MAX).map((order) => <OrderLine key={order.id} order={order} navigate={navigate} />)}
            {closed.length > CLOSED_MAX ? (
              <button className="item item--more" type="button" onClick={() => navigate(`/orders?customer_id=${customer.id}&status=`)}>
                <span className="sm">{`还有 ${closed.length - CLOSED_MAX} 张已结束的单`}</span>
                <ArrowRight {...iconProps(13)} />
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

function Lamp({ label, tone = 'muted' }) {
  return <span className={`lamp lamp--${tone}`}>{label}</span>
}

/* ---------------- 处理一位客户：归档，或者彻底删除 ---------------- */

async function removeCustomer(customer, { navigate, reload }) {
  let profile = null
  try {
    profile = await api.get(`/api/customers/${customer.id}/profile`)
  } catch {
    /* 拿不到档案也照样让他处理 */
  }
  const orders = profile?.summary?.order_count ?? 0
  const creds = profile?.credentials?.length ?? 0
  const quotes = profile?.quotes?.length ?? 0
  const busy = orders + creds + quotes > 0

  const choice = await choiceDialog({
    title: `处理客户「${customer.name}」`,
    message: busy
      ? `这位客户名下有 ${orders} 张订单、${creds} 条登录凭证、${quotes} 份报价单。`
      : '这位客户名下还没有订单、凭证和报价单。',
    archiveLabel: busy ? '归档客户' : null,
    archiveHint: '先从这个列表里收起来。订单、凭证、报价单全部原地不动，随时可以用上面的「已归档」找回来。',
    deleteLabel: busy ? '彻底删除（连带凭证）' : '彻底删除',
    deleteHint: creds
      ? `这位客户存着 ${creds} 条登录凭证（游戏账号密码），彻底删除会把这 ${creds} 条一起删掉，删了就找不回来。` +
        (orders ? `另外 ${orders} 张订单会失去客户关联 —— 单号、服务内容、冻结的客户名和收款记录都还在。` : '')
      : orders
        ? `${orders} 张订单会失去客户关联，但单号、服务内容、冻结的客户名和收款记录都还在。`
        : '直接删掉，不影响任何其它数据。',
  })
  if (!choice) return
  try {
    if (choice === 'archive') {
      await api.patch(`/api/customers/${customer.id}`, { status: 'archived' })
      toast(`客户「${customer.name}」已归档`, 'ok')
      navigate('/customers')
    } else {
      await api.del(`/api/customers/${customer.id}`, { hard: '1' })
      toast(`客户「${customer.name}」已彻底删除`, 'ok')
      navigate('/customers')
    }
    void reload
  } catch (err) {
    toastErr(err)
  }
}

/** 三选一：归档 / 彻底删除 / 取消。旧 ui.js 的 choiceDialog() 的 React 版 */
export function choiceDialog({ title, message, archiveLabel, archiveHint, deleteLabel, deleteHint }) {
  return openOverlay((close) => (
    <Modal
      title={title}
      wide
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>取消</button>
          {archiveLabel ? <button className="btn" type="button" onClick={() => close('archive')}>{archiveLabel}</button> : null}
          <button className="btn btn--danger" type="button" onClick={() => close('delete')}>{deleteLabel}</button>
        </>
      }
    >
      <div className="stack stack--tight">
        <p style={{ lineHeight: '1.75' }}>{message}</p>
        {archiveLabel && archiveHint ? <div className="note note--ok"><strong>{`${archiveLabel}：`}</strong><span>{archiveHint}</span></div> : null}
        {deleteHint ? <div className="note note--alert"><strong>{`${deleteLabel}：`}</strong><span>{deleteHint}</span></div> : null}
      </div>
    </Modal>
  ))
}
