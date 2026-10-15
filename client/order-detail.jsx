import React, { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Link as LinkIcon, Pencil, Plus, RefreshCw, Trash2, Wallet } from 'lucide-react'
import { PAY_KIND_LABEL, PAY_METHOD_LABEL, STATUS_FLOW, STATUS_TONE, api } from './lib/api.js'
import { fmtDateTime, fmtDay, fmtMoney, fmtQty, remainInfo } from './lib/formatters.js'
import { resourceDeltaList } from '../shared/resources.js'
import { canvasToBlob, downloadBlob } from '../public/js/pricecard.js'
import { renderProgressCard } from '../public/js/progresscard.js'
import { toast, toastErr } from './app/toast-store.js'
import { confirmDelete, confirmDialog } from './app/confirm.jsx'
import { copyText } from './lib/dom.js'
import Modal from './app/modal.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { openOrderComposer } from './order-composer.jsx'
import { openPaymentForm } from './payment-form.jsx'
import { openProgressForm, openEditProgressForm } from './progress-form.jsx'
import { openStatusForm } from './status-form.jsx'

/* ============================================================
   订单详情（React 版）
   ============================================================

   原来是 public/js/views/orders.js 的 renderDetail()，旧栈里最长的一页：
   抬头、五步状态轨、服务明细快照、进度时间线、钱、收款记录、备注，外加
   顶栏八个动作（记进度 / 记收款 / 今日已完成 / 标记完成 / 推进状态 / 改明细 / 拆单 / 删除）。

   动作栏放在页面头部（跟订单列表、价格表一致），不再塞进顶栏 ——
   顶栏那排按钮是旧栈 setActions() 的产物，React 页面自己画更清楚。
   ============================================================ */

const iconProps = (size) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

export default function OrderDetailPage({ route, navigate, onReload, reloadKey }) {
  const id = route.sub
  const [order, setOrder] = useState(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const data = await api.get(`/api/orders/${id}`)
      setOrder(data)
      setError('')
    } catch (err) {
      setError(err?.message || String(err))
      setOrder(null)
    }
  }, [id])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  const reload = useCallback(() => {
    load()
    if (onReload) onReload()
  }, [load, onReload])

  if (error) {
    return (
      <div className="orders-page">
        <div className="refactor-alert" role="alert">{error}</div>
      </div>
    )
  }
  if (!order) {
    return (
      <div className="orders-page">
        <div className="refactor-loading"><span /><span /><span /></div>
      </div>
    )
  }

  const closed = ['done', 'cancelled'].includes(order.status)

  /** 今日已完成：日体、包天那种天天要做的单，今天做完了先挪出「在做」，明天自己回来 */
  async function dailyDone(done) {
    // 撤销不用问。标记时如果这张单里还夹着「一次性的活」（比如 30天日体 + 两个活动），
    // 得先提醒一句 —— 标完整张单都会从「在做」里消失，别把没做的活动一起藏了。
    if (done && (order.other_items || []).length) {
      const yes = await confirmDialog({
        title: '这张单里还有别的活',
        message: `标成「今日已完成」之后，整张单这个「今天」都会从「在做」里消失，过了凌晨 4 点才回来。这张单里除了每天要做的，还有：${order.other_items.join('、')}。这些今天也做完了吗？`,
        confirmLabel: '都做完了，标吧',
      })
      if (!yes) return
    }
    try {
      await api.post(`/api/orders/${order.id}/daily-done`, { done })
      toast(done ? '标成今日完成，过了凌晨 4 点自动回到「在做的」' : '已撤销，回到「在做的」', 'ok', 3400)
      reload()
    } catch (err) {
      toastErr(err)
    }
  }

  /** 直接推进到已完成（状态机允许才能走，比如还没付钱的单会被拦下） */
  async function finishNow() {
    const yes = await confirmDialog({
      title: `把 ${order.order_no} 标成已完成？`,
      message: '整张单就结束了，不再出现在「在做的」里。如果这是每天都要做的日体单，应该用「今日已完成」。',
      confirmLabel: '标成已完成',
    })
    if (!yes) return
    try {
      await api.post(`/api/orders/${order.id}/status`, { status: 'done' })
      toast('订单已完成', 'ok')
      reload()
    } catch (err) {
      toastErr(err)
    }
  }

  async function removeOrder() {
    const yes = await confirmDelete({
      title: '删除这张单？',
      message: `订单 ${order.order_no} 及其进度、收款记录会一并消失，不能撤销。如果只是不做了，建议改成「已取消」。`,
    })
    if (!yes) return
    try {
      await api.del(`/api/orders/${order.id}`)
      toast('订单已删除', 'ok')
      navigate('/orders')
    } catch (err) {
      toastErr(err)
    }
  }

  async function removeProgress(progress) {
    const yes = await confirmDelete({ title: '删掉这条进度？', message: `${fmtDay(progress.happened_on)}：${String(progress.content || '').slice(0, 40)}` })
    if (!yes) return
    try {
      await api.del(`/api/progress/${progress.id}`)
      toast('已删除', 'ok')
      reload()
    } catch (err) {
      toastErr(err)
    }
  }

  async function removePayment(payment) {
    const yes = await confirmDelete({
      title: '删掉这笔记录？',
      message: `${PAY_KIND_LABEL[payment.kind] || payment.kind} ¥${fmtMoney(payment.amount)}（${payment.paid_at}）`,
    })
    if (!yes) return
    try {
      await api.del(`/api/payments/${payment.id}`)
      toast('已删除', 'ok')
      reload()
    } catch (err) {
      toastErr(err)
    }
  }

  const gainAll = gainTotalText(order.items)
  const remain = remainInfo(order.ordered_at, order.due_at)
  const ctx = { navigate, onReload: reload }

  return (
    <div className="orders-page">
      <header className="orders-page__head">
        <div>
          <h2>{order.order_no}</h2>
          <p>{order.title || '（没写标题）'}</p>
        </div>
        <div className="order-detail__actions">
          <button className="refactor-button" type="button" onClick={() => openProgressForm(order, reload)}><Pencil {...iconProps(14)} />记进度</button>
          {order.due_total > 0.001 ? <button className="refactor-button" type="button" onClick={() => openPaymentForm(order, reload)}><Wallet {...iconProps(14)} />记收款</button> : null}
          {!closed ? (
            <button className="refactor-button" type="button" title={order.daily_done_today ? '撤销今日完成，重新回到「在做」' : '今天这份做完了，先挪出「在做」，明天自动回来'} onClick={() => dailyDone(!order.daily_done_today)}>
              {order.daily_done_today ? <RefreshCw {...iconProps(14)} /> : <Check {...iconProps(14)} />}
              {order.daily_done_today ? '撤销今日完成' : '今日已完成'}
            </button>
          ) : null}
          {!closed && (order.next_statuses || []).includes('done') ? (
            <button className="refactor-button" type="button" title="整张单结束" onClick={finishNow}><Check {...iconProps(14)} />标记完成</button>
          ) : null}
          <button className="refactor-button" type="button" onClick={() => openStatusForm(order, reload)}>推进状态</button>
          <button className="refactor-button" type="button" onClick={() => openOrderComposer(ctx, { existing: order })}>改明细</button>
          {order.items.length > 1 ? <button className="refactor-button" type="button" title="把其中几个服务项拆成一张新单" onClick={() => openSplit(order, reload)}><Copy {...iconProps(14)} />拆单</button> : null}
          <button className="refactor-button order-detail__danger" type="button" title="删除订单" onClick={removeOrder}><Trash2 {...iconProps(14)} /></button>
        </div>
      </header>

      <div className="stack">
        {/* 抬头 */}
        <section className="panel">
          <div className="panel__body">
            <div className="cluster" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div style={{ minWidth: '0' }}>
                <div className="cluster">
                  <span className="mono strong">{order.order_no}</span>
                  <Lamp label={order.status_label} tone={STATUS_TONE[order.status] || 'muted'} />
                  <CopyIcon text={order.order_no} label="复单号" />
                </div>
                <h1 style={{ marginTop: '4px' }}>{order.title || '（没写标题）'}</h1>
                <div className="cluster sm dim" style={{ marginTop: '4px' }}>
                  <span>{order.customer_name || '散客'}</span>
                  <span>·</span>
                  <span>{order.game_name || '未指定游戏'}</span>
                  <span>·</span>
                  <span>{`下单 ${fmtDateTime(order.ordered_at)}`}</span>
                  {order.due_at ? <span>{`· 交付 ${fmtDay(order.due_at)}`}</span> : null}
                  {/* 交付日期还剩几天 —— 做完的单就不用提醒了 */}
                  {!closed && remain.kind !== 'none' ? (
                    remain.kind === 'invalid' ? <span className="duepill duepill--bad">交付日期填错了</span> : <span className={`duepill duepill--${remain.kind}`}>{remain.text}</span>
                  ) : null}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div className="cell__lbl">订单总额</div>
                <div style={{ fontFamily: 'var(--font-fig)', fontSize: 'var(--fs-2xl)', fontWeight: '600', letterSpacing: '-0.02em' }}>{`¥${fmtMoney(order.total)}`}</div>
                <div className="sm">
                  {order.due_total > 0.001 ? <span className="tone-amber">{`还差 ¥${fmtMoney(order.due_total)}`}</span> : <span className="tone-jade">已结清</span>}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 'var(--sp-4)' }}><OrderTrack status={order.status} statusLabel={order.status_label} /></div>
            {order.customer_id ? (
              <div className="cluster" style={{ marginTop: 'var(--sp-3)' }}>
                <button className="btn btn--sm" type="button" onClick={() => navigate(`/customers/${order.customer_id}`)}>看客户档案</button>
                {order.credentials?.length ? (
                  <button className="btn btn--sm" type="button" onClick={() => navigate(`/vault?customer=${order.customer_id}`)}>{`这个客户有 ${order.credentials.length} 条登录凭证`}</button>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>

        <div className="split">
          {/* 左：明细 + 进度 */}
          <div className="stack">
            <section className="panel">
              <div className="panel__body"><SectionHead title="服务明细（下单时的快照）" note="改价格表不影响这里" /></div>
              <div className="panel__body panel__body--flush"><ItemsList items={order.items} /></div>
              <div className="panel__foot">
                <span className="sm dim">{`共 ${order.items.length} 项`}</span>
                {/* 这张单所有明细加起来能让客户拿到多少货币（同一个货币才合计） */}
                {gainAll ? <span className="sm dim" style={{ marginLeft: '10px' }}>{`可得 ${gainAll}`}</span> : null}
                <div style={{ flex: '1' }} />
                <span className="sm dim">合计</span>
                <span className="strong">{`¥${fmtMoney(order.total)}`}</span>
              </div>
            </section>

            <section className="panel">
              <div className="panel__body">
                <SectionHead
                  title="进度时间线"
                  note={`${order.progress.length} 条`}
                  actions={
                    <>
                      <button className="btn btn--sm" type="button" onClick={() => shareProgress(order, ctx)}>分享进度</button>
                      <button className="btn btn--sm btn--primary" type="button" onClick={() => openProgressForm(order, reload)}><Plus {...iconProps(14)} />记一条</button>
                    </>
                  }
                />
              </div>
              <div className="panel__body" style={{ paddingTop: '0' }}>
                <ProgressTimeline
                  list={order.progress}
                  onEdit={(progress) =>
                    openEditProgressForm(
                      progress,
                      reload,
                      order.game_name,
                      (order.games || []).map((g) => g.name).filter(Boolean)
                    )
                  }
                  onDelete={removeProgress}
                />
              </div>
            </section>
          </div>

          {/* 右：钱、收款、备注 */}
          <div className="stack">
            <section className="panel">
              <div className="panel__body"><SectionHead title="钱" /></div>
              <div className="panel__body" style={{ paddingTop: '0' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', fontSize: 'var(--fs-base)' }}>
                  <span className="dim">服务小计</span>
                  <span className="num">{`¥${fmtMoney(order.items_subtotal)}`}</span>
                  <span className="dim">增项合计</span>
                  <span className="num">{`¥${fmtMoney(order.addon_total)}`}</span>
                  <span className="dim">折扣</span>
                  <span className="num">{`−¥${fmtMoney(order.discount)}`}</span>
                  <span className="dim">平台手续费</span>
                  <span className="num">{`¥${fmtMoney(order.platform_fee)}`}</span>
                  <span className="dim">成本</span>
                  <span className="num">{`¥${fmtMoney(order.cost)}`}</span>
                  <span className="strong" style={{ borderTop: '1px solid var(--line)', paddingTop: '6px', marginTop: '4px' }}>合计</span>
                  <span className="num strong" style={{ borderTop: '1px solid var(--line)', paddingTop: '6px', marginTop: '4px' }}>{`¥${fmtMoney(order.total)}`}</span>
                  <span className="dim tone-jade">已收</span>
                  <span className="num tone-jade">{`¥${fmtMoney(order.paid_total)}`}</span>
                  <span className="dim">{order.due_total > 0.001 ? '还差' : '尾款'}</span>
                  <span className="num">{order.due_total > 0.001 ? `¥${fmtMoney(order.due_total)}` : '0'}</span>
                  <span className="dim">利润</span>
                  <span className="num">{`¥${fmtMoney(order.profit)}`}</span>
                </div>
              </div>
              <div className="panel__body" style={{ paddingTop: '0' }}>
                <div className="cluster">
                  <button className="btn btn--sm btn--block" type="button" onClick={() => openPaymentForm(order, reload)}><Plus {...iconProps(14)} />记一笔收款</button>
                </div>
              </div>
            </section>

            <section className="panel">
              <div className="panel__body"><SectionHead title="收款记录" note={`${order.payments.length} 笔`} /></div>
              {order.payments.length ? (
                <div className="itemlist">
                  {order.payments.map((payment) => (
                    <div className="item" key={payment.id} style={{ cursor: 'default' }}>
                      <div className="item__main">
                        <div className="item__title">
                          {PAY_KIND_LABEL[payment.kind] || payment.kind}
                          <span className="tag">{PAY_METHOD_LABEL[payment.method] || payment.method}</span>
                        </div>
                        <div className="item__meta">
                          <span>{fmtDay(payment.paid_at)}</span>
                          {payment.note ? <span>{payment.note}</span> : null}
                        </div>
                      </div>
                      <div className="item__right">
                        <div className={`item__fig ${payment.kind === 'refund' ? 'tone-oxblood' : 'tone-jade'}`}>
                          {`${payment.kind === 'refund' ? '−' : '+'}¥${fmtMoney(payment.amount)}`}
                        </div>
                        <button className="btn btn--sm btn--quiet" type="button" title="删除这笔" onClick={() => removePayment(payment)}><Trash2 {...iconProps(13)} /></button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="panel__body"><p className="dim sm">还没有收款记录。</p></div>
              )}
            </section>

            {order.note || order.internal_note ? (
              <section className="panel">
                <div className="panel__body"><SectionHead title="备注" /></div>
                <div className="panel__body" style={{ paddingTop: '0' }}>
                  {order.note ? (
                    <div>
                      <div className="tbl__meta">给客户看的</div>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{order.note}</p>
                    </div>
                  ) : null}
                  {order.internal_note ? (
                    <div style={{ marginTop: '10px' }}>
                      <div className="tbl__meta">只有自己看得到</div>
                      <p style={{ whiteSpace: 'pre-wrap' }}>{order.internal_note}</p>
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ============================================================
   小件（旧 ui.js / orderbits.js 里那些的 React 版）
   ============================================================ */

function Lamp({ label, tone = 'muted' }) {
  return <span className={`lamp lamp--${tone}`}>{label}</span>
}

function CopyIcon({ text, label }) {
  return (
    <button
      className="btn btn--sm btn--icon"
      type="button"
      title={label}
      onClick={async (event) => {
        event.stopPropagation()
        const ok = await copyText(text)
        toast(ok ? '已复制' : '复制失败，请手动选中', ok ? 'ok' : 'err', 1600)
      }}
    >
      <Copy {...iconProps(15)} />
    </button>
  )
}

/** 订单走的五步轨；售后/取消单独用灯表示 */
function OrderTrack({ status, statusLabel }) {
  if (status === 'cancelled' || status === 'after_sale') {
    return (
      <div className="cluster">
        <Lamp label={statusLabel || status} tone={STATUS_TONE[status] || 'muted'} />
        <span className="dim tiny">已离开主流程</span>
      </div>
    )
  }
  const labels = { pending_confirm: '待确认', pending_pay: '待付款', in_progress: '进行中', pending_accept: '待验收', done: '已完成' }
  const at = STATUS_FLOW.indexOf(status)
  return (
    <div className="track">
      {STATUS_FLOW.map((step, index) => (
        <React.Fragment key={step}>
          {index > 0 ? <span className="track__sep" /> : null}
          <div className={`track__step${index < at ? ' track__step--done' : index === at ? ' track__step--now' : ''}`}>{labels[step]}</div>
        </React.Fragment>
      ))}
    </div>
  )
}

function SectionHead({ title, note, actions = null }) {
  return (
    <div className="sechead">
      <h3>{title}</h3>
      {note ? <span className="sechead__note">{note}</span> : null}
      {actions}
    </div>
  )
}

function Tag({ text, tone = '' }) {
  return <span className={`tag${tone ? ` tag--${tone}` : ''}`}>{text}</span>
}

/** 这一条明细能让客户拿到多少货币（快照里是每个的数量，乘上本条数量）。没配就返回空串 */
function itemGain(item) {
  const gain = item?.snapshot?.gain
  if (!gain || !gain.name) return ''
  const total = Number(gain.amount || 0) * (Number(item.quantity) || 1)
  if (!Number.isFinite(total) || total <= 0) return ''
  return `${gain.name} ${fmtQty(total)}`
}

function gainTotalText(items) {
  const byName = new Map()
  for (const item of items || []) {
    const gain = item?.snapshot?.gain
    if (!gain || !gain.name) continue
    const amount = Number(gain.amount || 0) * (Number(item.quantity) || 1)
    if (!Number.isFinite(amount) || amount <= 0) continue
    byName.set(gain.name, (byName.get(gain.name) || 0) + amount)
  }
  if (!byName.size) return ''
  return [...byName.entries()].map(([name, amount]) => `${name} ${fmtQty(amount)}`).join(' + ')
}

function ItemsList({ items }) {
  return (
    <div className="itemlist">
      {items.map((item) => (
        <div className="item" key={item.id} style={{ cursor: 'default', alignItems: 'flex-start' }}>
          <div className="item__main">
            <div className="item__title">
              {item.name}
              {/* 每天都要做的那种，标出来 —— 标「今日已完成」时一眼看出哪部分是日体 */}
              {item.is_daily ? <Tag text="每天做" tone="jade" /> : null}
              {item.snapshot?.price_overridden ? <Tag text="改过价" tone="cinnabar" /> : null}
              {item.snapshot?.matched_tier ? <Tag text="阶梯价" tone="slate" /> : null}
            </div>
            {item.spec ? <div className="tbl__meta">{item.spec}</div> : null}
            {/* 这一条能让客户拿到多少货币。快照里冻的是「每个」的数量，
                这里乘上本条的数量 —— 跟右边「单价 × 数量 = 金额」一个口径，
                也跟下面「共 N 项」那条合计对得上（×2 就该拿两倍）。 */}
            {itemGain(item) ? (
              <div className="subitems">
                <div className="subitem"><span className="subitem__k">可得</span><span className="strong">{itemGain(item)}</span></div>
              </div>
            ) : null}
            {item.snapshot?.package_items?.length ? (
              <div className="subitems">
                <div className="subitem"><span className="subitem__k">套餐含</span><span>{item.snapshot.package_items.join(' · ')}</span></div>
              </div>
            ) : null}
            {item.snapshot?.addons?.length ? (
              <div className="subitems">
                <div className="subitem">
                  <span className="subitem__k">增项</span>
                  <span>{item.snapshot.addons.map((addon) => `${addon.name}${addon.price_mode === 'percent' ? ` +${addon.price}%` : ` +${fmtMoney(addon.price)}元`}`).join(' · ')}</span>
                </div>
              </div>
            ) : null}
          </div>
          <div className="item__right">
            <div className="item__fig">
              {fmtMoney(item.unit_price)}
              {/* 单位要跟数量隔开：以前写成 `× 1` 直接拼单位，单位是「30天」时
                  就成了「50 × 130天」，看着像 130 天。 */}
              <span className="dim">{`${item.unit_label ? `/${item.unit_label}` : ''} × ${fmtQty(item.quantity)}`}</span>
            </div>
            <div className="tbl__meta">{`= ${fmtMoney(item.amount)} 元`}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** 「今天 / 昨天 / 3 天前 / 更早写日期」 */
function relDay(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''))
  if (!match) return String(dateStr || '')
  const then = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const days = Math.round((today - then) / 86400000)
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days === 2) return '前天'
  if (days > 2 && days < 8) return `${days} 天前`
  if (days === -1) return '明天'
  return `${Number(match[2])}月${Number(match[3])}日`
}

function ProgressTimeline({ list, onEdit, onDelete }) {
  if (!list.length) {
    return (
      <div className="empty">
        <div className="empty__mark"><Plus {...iconProps(20)} /></div>
        <div className="empty__title">还没有进度记录</div>
        <p className="empty__body">每做一段就记一条，客户问起来直接发，自己回头看也清楚。</p>
      </div>
    )
  }
  // 旧的在前、新的在后，和「一条时间线往下走」的直觉一致
  const sorted = [...list].sort((a, b) => String(a.happened_on || '').localeCompare(String(b.happened_on || '')) || (a.id || 0) - (b.id || 0))
  const lastIndex = sorted.length - 1

  return (
    <div className="timeline">
      {sorted.map((progress, index) => {
        // 分段文本（一单多个游戏）按段各算一次，key 上会带游戏名
        const deltas = resourceDeltaList(progress.resources_before, progress.resources_after)
        const media = progress.media || []
        const shots = media.filter((item) => /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(item))
        const links = media.filter((item) => !/\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(item))
        return (
          <div className={`tl${index === lastIndex ? ' tl--now' : ''}`} key={progress.id}>
            <div className="tl__rail"><div className="tl__dot" /></div>
            <div className="tl__body">
              <div className="tl__head">
                <div className="tl__date">
                  <strong>{relDay(progress.happened_on)}</strong>
                  <span className="tl__datefull">{fmtDay(progress.happened_on)}</span>
                </div>
                {index === lastIndex ? <Tag text="最新" tone="slate" /> : null}
                <span className="tl__step">{`第 ${index + 1} 条`}</span>
                <div style={{ flex: '1' }} />
                {onEdit ? <button className="btn btn--sm btn--quiet" type="button" title="编辑" onClick={() => onEdit(progress)}><Pencil {...iconProps(13)} /></button> : null}
                {onDelete ? <button className="btn btn--sm btn--quiet" type="button" title="删除" onClick={() => onDelete(progress)}><Trash2 {...iconProps(13)} /></button> : null}
              </div>
              <div className="tl__content">{progress.content}</div>
              {progress.resources_before || progress.resources_after ? (
                <div className="tl__resrow">
                  <span className="tl__reslabel">资源变化</span>
                  <span className="tl__res">
                    {progress.resources_before ? <span>{progress.resources_before}</span> : <span className="dim">未记录</span>}
                    <span className="tl__arrow">→</span>
                    {progress.resources_after ? <span>{progress.resources_after}</span> : <span className="dim">未记录</span>}
                  </span>
                </div>
              ) : null}
              {deltas.length ? (
                <div className="tl__deltas">
                  <span className="dim tiny">本次消耗</span>
                  {deltas.map((delta) => (
                    <span
                      key={`${delta.game || ''}-${delta.key}`}
                      className={`tl__delta tone-${delta.diff < 0 ? 'oxblood' : delta.diff > 0 ? 'jade' : 'muted'}`}
                    >
                      {`${delta.game ? `${delta.game} ` : ''}${delta.key} ${delta.diff < 0 ? '−' : delta.diff > 0 ? '+' : '±'}${fmtQty(Math.abs(delta.diff))}`}
                    </span>
                  ))}
                </div>
              ) : null}
              {shots.length ? (
                <div className="tl__shots">
                  {shots.map((item) => (
                    <a key={item} href={item} target="_blank" rel="noreferrer noopener"><img className="shot" src={item} alt="进度截图" loading="lazy" /></a>
                  ))}
                </div>
              ) : null}
              {links.length ? (
                <div className="tl__shots">
                  {links.map((item) => (
                    <a className="shot-link" key={item} href={item} target="_blank" rel="noreferrer noopener"><LinkIcon {...iconProps(12)} />录屏 / 链接</a>
                  ))}
                </div>
              ) : null}
              {progress.note ? <div className="tl__note"><span className="tl__note-label">备注</span>{progress.note}</div> : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

/* ============================================================
   拆单 / 分享进度（两个弹层）
   ============================================================ */

/** 拆单：把几个服务项挪到一张新单上，两边各自收款结单 */
function openSplit(order, onDone) {
  return openOverlay(
    (close) => <SplitModal order={order} close={close} onDone={onDone} />,
    `order-split-${order.id}`
  )
}

function SplitModal({ order, close, onDone }) {
  const [picked, setPicked] = useState([])
  const [payMode, setPayMode] = useState('proportional')
  const [progMode, setProgMode] = useState('keep')
  const [busy, setBusy] = useState(false)

  const hasPay = (order.payments || []).length > 0
  const hasProgress = (order.progress || []).length > 0
  const rest = order.items.length - picked.length
  const hint =
    picked.length === 0
      ? '还没勾任何服务项。'
      : rest === 0
        ? '不能全拆走 —— 原单得至少留一个服务项（整张都要挪的话，不如直接改这一张）。'
        : `拆出去 ${picked.length} 项，原单留 ${rest} 项。折扣 / 手续费 / 成本留在原单，新单从 0 开始。`

  async function go() {
    setBusy(true)
    try {
      const result = await api.post(`/api/orders/${order.id}/split`, { item_ids: picked, payments: payMode, progress: progMode })
      close(true)
      const bits = [`已拆出 ${result.moved_count} 项，新单 ${result.created.order_no}`]
      if (result.payments_moved) bits.push(`收款分了 ${result.payments_moved} 笔`)
      if (result.progress_moved) bits.push(`进度跟过去 ${result.progress_moved} 条`)
      toast(bits.join(' · '), 'ok', 4600)
      if (result.original_overpaid > 0.001) {
        setTimeout(
          () => toast(`注意：原单还留着 ¥${fmtMoney(result.original_paid)} 的收款，但金额只剩 ¥${fmtMoney(result.original.total)}，多收了 ¥${fmtMoney(result.original_overpaid)}`, 'err', 9000),
          400
        )
      }
      onDone()
    } catch (err) {
      toastErr(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={`拆单 · ${order.order_no}`}
      wide
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(false)}>取消</button>
          <button className="btn btn--primary" type="button" disabled={busy || picked.length === 0 || rest === 0} onClick={go}>拆成新单</button>
        </>
      }
    >
      <div className="stack">
        <p className="sm">适合「30天日体 + 几个活动」这种单：把活动拆出去单独结算，日体那张继续天天标今日完成。</p>
        <p className="sm dim">勾上要拆出去的 —— 选中的会变成一张新单，没选的留在原单。</p>
        <div className="itemlist">
          {order.items.map((item) => (
            <label className="item" key={item.id} style={{ cursor: 'pointer', alignItems: 'center', gap: '10px' }}>
              <input
                className="chk"
                type="checkbox"
                aria-label={`拆出 ${item.name}`}
                checked={picked.includes(item.id)}
                onChange={(event) => setPicked((current) => (event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)))}
              />
              <div className="item__main">
                <div className="item__title">
                  {item.name}
                  {item.is_daily ? <Tag text="每天做" tone="jade" /> : null}
                </div>
                {item.spec ? <div className="tbl__meta">{item.spec}</div> : null}
              </div>
              <div className="item__right"><div className="item__fig">{`¥${fmtMoney(item.amount)}`}</div></div>
            </label>
          ))}
        </div>
        {/* 已经记过收款/进度才问，没有就不用烦 */}
        {hasPay ? (
          <div className="field">
            <label className="lbl" htmlFor="split-pay">{`收款怎么分（这张单已收 ¥${fmtMoney(order.paid_total)}）`}</label>
            <select id="split-pay" className="sel" aria-label="收款怎么分" value={payMode} onChange={(event) => setPayMode(event.target.value)}>
              <option value="proportional">按金额比例分到两张单（推荐）</option>
              <option value="keep">全部留在原单</option>
            </select>
          </div>
        ) : null}
        {hasProgress ? (
          <div className="field">
            <label className="lbl" htmlFor="split-progress">{`进度时间线（现有 ${order.progress.length} 条）`}</label>
            <select id="split-progress" className="sel" aria-label="进度时间线怎么处理" value={progMode} onChange={(event) => setProgMode(event.target.value)}>
              <option value="keep">留在原单</option>
              <option value="move">跟到新单</option>
            </select>
          </div>
        ) : null}
        <div className="note note--warn">{hint}</div>
      </div>
    </Modal>
  )
}

/* ============================================================
   分享进度：文本发微信 / 图片发微信
   ============================================================ */

function shareProgress(order, ctx) {
  return openOverlay((close) => <ShareModal order={order} ctx={ctx} close={close} />, `order-share-${order.id}`)
}

function ShareModal({ order, ctx, close }) {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState(null)

  useEffect(() => {
    let alive = true
    api
      .get(`/api/orders/${order.id}/progress-report`)
      .then(async (data) => {
        if (!alive) return
        setText(data.text || '')
        setReport(data.report)
        try {
          // renderProgressCard 现在是 async：它要先把截图加载完才能知道图多高
          const canvas = await renderProgressCard(data.report, { scale: 1 })
          if (!alive) return
          setPreview(canvas.toDataURL('image/png'))
        } catch (err) {
          if (!alive) return
          setPreviewError(err?.message || String(err))
        }
      })
      .catch((err) => {
        if (!alive) return
        setPreviewError(err?.message || String(err))
        toastErr(err)
      })
    return () => {
      alive = false
    }
  }, [order.id])

  async function doCopy() {
    const ok = await copyText(text)
    toast(ok ? '进度文字已复制，粘到微信里就能发' : '复制失败，请手动选中', ok ? 'ok' : 'err', 3200)
  }

  async function doImage() {
    setBusy(true)
    try {
      const blob = await canvasToBlob(await renderProgressCard(report, { scale: 2 }))
      if (!blob) {
        toast('这个浏览器不支持生成图片，请换 Chrome / Edge / Safari 试试', 'err', 4200)
        return
      }
      const safe = String(report.orderNo || '订单').replace(/[\\/:*?"<>|]/g, '_')
      downloadBlob(blob, `${report.shopName}-进度-${safe}.png`)
      toast('图片已生成，去下载文件夹看看', 'ok', 3200)
    } catch (err) {
      toastErr(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="分享进度"
      wide
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>关闭</button>
          {/* 两个动作都不关窗，方便复制完文字再存张图 */}
          <button className="btn" type="button" disabled={!text} onClick={doCopy}>复制文字</button>
          <button className="btn btn--primary" type="button" disabled={!report || busy} data-loading={busy ? '1' : undefined} onClick={doImage}>存成图片</button>
        </>
      }
    >
      <div className="stack">
        <p className="muted sm" style={{ margin: '0' }}>发给客户看这次做到哪了。图片发微信最好用，文字想改两句就复制。</p>
        <div className="sechead" style={{ marginBottom: '0' }}>
          <h3>图片</h3>
          <span className="sechead__note">一张竖图，直接发</span>
        </div>
        <div className="report-preview">
          {preview ? <img src={preview} alt="进度汇报预览" /> : previewError ? <div className="hint">{`图片预览画不出来：${previewError}`}</div> : <span className="dim sm">正在画图…</span>}
        </div>
        <div className="sechead" style={{ marginBottom: '0' }}>
          <h3>文字</h3>
          <span className="sechead__note">复制了就能粘</span>
        </div>
        <pre className="report-text">{text}</pre>
        <div className="note">进度、资源变化、截图张数都会带上。截图原图发不进这张图里，图上只会写「附 N 张截图」，图还是自己另发。</div>
      </div>
    </Modal>
  )
}
