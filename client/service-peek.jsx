import React, { useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { api, PRICE_TYPE_LABEL } from './lib/api.js'
import { fmtMoney, fmtQty } from './lib/formatters.js'
import { toast, toastErr } from './app/toast-store.js'
import { confirmDialog } from './app/confirm.jsx'
import CopyButton from './app/copy-button.jsx'
import Drawer from './app/drawer.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { openOptionEditor } from './option-editor.jsx'
import { openServiceForm } from './service-form.jsx'
import { openTierEditor } from './tier-editor.jsx'
import { currencyGain, unitOf } from '../shared/pricing.js'

/* ============================================================
   服务项详情抽屉（React 版）
   ============================================================

   原来是 public/js/views/price.js 里的 servicePeek()。
   价格表里点服务行的「查看服务详情」就开这个，它也是这一页的**中枢**：
   「改价格和说明」「阶梯价」「套餐与增项」三个按钮各自再叠一层抽屉上去
   （所以浮层宿主必须是能叠的，见 app/overlay-host.jsx）。

     openServicePeek(service, ctx, { onChanged })

   **这里的数据是自己的一份 state**：上面那三层改的都是库里的东西，
   抽屉不能一直拿着「打开那一刻」的那份快照 —— 不然改完价格它还显示旧价，
   而「复制价款」是拿这个价直接发给客户的。每次改完都重新拉一遍
   /api/services/:id/full（含阶梯价和增项），顺手让外面的价格表也刷新。
   ============================================================ */

const iconProps = (size = 14) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

function Tag({ text, tone = '' }) {
  return <span className={`tag${tone ? ` tag--${tone}` : ''}`}>{text}</span>
}

export function openServicePeek(service, ctx, { onChanged } = {}) {
  return openOverlay((close) => <ServicePeek service={service} ctx={ctx} onChanged={onChanged} close={close} />, `service-peek-${service.id}`)
}

function ServicePeek({ service, ctx, onChanged, close }) {
  const [current, setCurrent] = useState(service)

  const notify = () => {
    if (onChanged) onChanged()
    if (ctx?.app?.reload) ctx.app.reload()
  }

  /** 重新取这条服务项（带阶梯价和增项），并让外面的价格表跟着刷新 */
  const refresh = async () => {
    try {
      const full = await api.get(`/api/services/${current.id}/full`)
      if (full && full.service) setCurrent({ ...full.service, tiers: full.tiers || [], options: full.options || [] })
    } catch (err) {
      toastErr(err)
    }
    notify()
  }

  const unit = unitOf(current)
  const tiers = [...(current.tiers || [])].sort((a, b) => (Number(a.min_qty) || 0) - (Number(b.min_qty) || 0))
  const options = (current.options || []).filter((option) => option.status !== 'archived')
  const tierLines = tiers.map((tier) => {
    const range =
      tier.max_qty === null || tier.max_qty === undefined || tier.max_qty === ''
        ? `${fmtQty(tier.min_qty || 1)}${unit}+`
        : `${fmtQty(tier.min_qty || 1)}-${fmtQty(tier.max_qty)}${unit}`
    return `${range}：¥${fmtMoney(tier.unit_price)}/${unit}`
  })
  const optionLines = options.map((option) => {
    const price = option.price_mode === 'percent' ? ` +${fmtQty(option.price)}%` : Number(option.price) ? ` +¥${fmtMoney(option.price)}` : ''
    const description = String(option.description || '').trim()
    return `${option.name || '未命名'}${price}${description ? ` · 说明：${description}` : ''}`
  })

  // 能给客户拿到多少货币（货币名字配在游戏上）。
  // 游戏被归档后就不在 meta.games 里了，currencyGain 查不到名字 ——
  // 退回价格表带过来的 game_currency，别让「星声 200」变成光秃秃一个数。
  const gain =
    currencyGain(current, ctx?.meta?.games || [], ctx?.meta?.categories || []) ||
    (Number(current?.currency_amount) > 0 && current?.game_currency ? `${current.game_currency} ${fmtQty(current.currency_amount)}` : '')

  async function toggleStatus() {
    const next = current.status === 'active' ? 'archived' : 'active'
    try {
      await api.patch(`/api/services/${current.id}`, { status: next })
      toast(next === 'archived' ? '已下架，老订单不受影响' : '已重新上架', 'ok')
      // 重新取一次：标签和按钮上的字要跟着变，不能还写着「在架 / 下架」
      await refresh()
    } catch (err) {
      toastErr(err)
    }
  }

  async function remove() {
    try {
      const usage = await api.get(`/api/services/${current.id}/usage`)
      const ok = await confirmDialog({
        title: `真的删掉「${current.name}」？`,
        message: usage.order_items
          ? `已经有 ${usage.order_items} 条订单明细引用过它。删除后老订单的快照还在，但价格表里再也找不回来了。`
          : '这个服务项还没被任何订单用过，可以安全删除。',
        confirmLabel: '删除',
        tone: 'danger',
      })
      if (!ok) return
      // hard=1：这个按钮写的「删除」，下架是下面那个按钮。
      // 不传的话后端只会归档，东西还在「已下架」里躺着。
      await api.del(`/api/services/${current.id}`, { hard: 1 })
      toast('已删除', 'ok')
      // 先关抽屉再刷新：删掉的东西不该还挂在屏幕上
      close(null)
      notify()
    } catch (err) {
      toastErr(err)
    }
  }

  const subitems = (lines) => (
    <div className="subitems">
      {lines.map((line) => (
        <div className="subitem" key={line}>
          <span>·</span>
          <span>{line}</span>
        </div>
      ))}
    </div>
  )

  return (
    <Drawer title={current.name} subtitle={`${PRICE_TYPE_LABEL[current.price_type] || current.price_type} · ${current.category_name || '未分类'}${current.game_name ? ` · ${current.game_name}` : ''}`} onClose={() => close(null)}>
      <div className="stack">
        <div className="cluster" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="pitem__fig">{`¥${fmtMoney(current.base_price)}`}</div>
            <div className="pitem__unit">{current.price_type === 'per_unit' && tiers.length ? `/${unit} 起` : `/${unit}`}</div>
            {current.price_type === 'per_unit' && tiers.length ? <div className="tbl__meta">{`${tiers.length} 档阶梯价`}</div> : null}
          </div>
          <div className="cluster">{current.status === 'active' ? <Tag text="在架" tone="jade" /> : <Tag text="已下架" tone="oxblood" />}</div>
        </div>

        {gain ? (
          <div>
            <span className="tag tag--outline">{`可获得 ${gain}`}</span>
          </div>
        ) : null}

        {current.description ? <p style={{ lineHeight: '1.7' }}>{current.description}</p> : null}

        {current.package_items?.length ? (
          <div>
            <div className="tbl__meta">套餐包含</div>
            {subitems(current.package_items)}
          </div>
        ) : null}

        {tiers.length ? (
          <div>
            <div className="tbl__meta">阶梯价</div>
            {subitems(tierLines)}
          </div>
        ) : null}

        {options.length ? (
          <div>
            <div className="tbl__meta">套餐与增项</div>
            {subitems(optionLines)}
          </div>
        ) : null}

        <hr />

        <div className="cluster">
          <button
            className="btn btn--sm"
            type="button"
            onClick={() => openServiceForm(current, ctx?.meta || {}).then((saved) => (saved ? refresh() : null))}
          >
            <Pencil {...iconProps()} />
            改价格和说明
          </button>
          {/* 这两层改完也要刷新这一层：不然加完阶梯价/增项，详情里还是空的 */}
          <button className="btn btn--sm" type="button" onClick={() => openTierEditor(current).then(() => refresh())}>
            阶梯价
          </button>
          <button className="btn btn--sm" type="button" onClick={() => openOptionEditor(current).then(() => refresh())}>
            套餐与增项
          </button>
          <CopyButton text={`${current.name} ¥${fmtMoney(current.base_price)}/${unit}`} label="复制价款" />
        </div>

        <hr />

        <div className="cluster">
          <button className="btn btn--sm" type="button" onClick={toggleStatus}>
            {current.status === 'active' ? '下架' : '重新上架'}
          </button>
          <div style={{ flex: '1' }} />
          <button className="btn btn--sm btn--danger" type="button" onClick={remove}>
            <Trash2 {...iconProps()} />
            删除
          </button>
        </div>
      </div>
    </Drawer>
  )
}
