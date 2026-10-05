import React from 'react'
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
   ============================================================ */

const iconProps = (size = 14) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

function Tag({ text, tone = '' }) {
  return <span className={`tag${tone ? ` tag--${tone}` : ''}`}>{text}</span>
}

export function openServicePeek(service, ctx, { onChanged } = {}) {
  return openOverlay((close) => <ServicePeek service={service} ctx={ctx} onChanged={onChanged} close={close} />, `service-peek-${service.id}`)
}

function ServicePeek({ service, ctx, onChanged, close }) {
  const reload = () => {
    if (onChanged) onChanged()
    if (ctx?.app?.reload) ctx.app.reload()
  }

  const unit = unitOf(service)
  const tiers = [...(service.tiers || [])].sort((a, b) => (Number(a.min_qty) || 0) - (Number(b.min_qty) || 0))
  const options = (service.options || []).filter((option) => option.status !== 'archived')
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

  // 能给客户拿到多少货币（货币名字配在游戏上）
  const gain = currencyGain(service, ctx?.meta?.games || [], ctx?.meta?.categories || [])

  async function toggleStatus() {
    const next = service.status === 'active' ? 'archived' : 'active'
    try {
      await api.patch(`/api/services/${service.id}`, { status: next })
      toast(next === 'archived' ? '已下架，老订单不受影响' : '已重新上架', 'ok')
      reload()
    } catch (err) {
      toastErr(err)
    }
  }

  async function remove() {
    try {
      const usage = await api.get(`/api/services/${service.id}/usage`)
      const ok = await confirmDialog({
        title: `真的删掉「${service.name}」？`,
        message: usage.order_items
          ? `已经有 ${usage.order_items} 条订单明细引用过它。删除后老订单的快照还在，但价格表里再也找不回来了。`
          : '这个服务项还没被任何订单用过，可以安全删除。',
        confirmLabel: '删除',
        tone: 'danger',
      })
      if (!ok) return
      // hard=1：这个按钮写的「删除」，下架是下面那个按钮。
      // 不传的话后端只会归档，东西还在「已下架」里躺着。
      await api.del(`/api/services/${service.id}`, { hard: 1 })
      toast('已删除', 'ok')
      // 先关抽屉再刷新：删掉的东西不该还挂在屏幕上
      close(null)
      reload()
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
    <Drawer title={service.name} subtitle={`${PRICE_TYPE_LABEL[service.price_type] || service.price_type} · ${service.category_name || '未分类'}${service.game_name ? ` · ${service.game_name}` : ''}`} onClose={() => close(null)}>
      <div className="stack">
        <div className="cluster" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div className="pitem__fig">{`¥${fmtMoney(service.base_price)}`}</div>
            <div className="pitem__unit">{service.price_type === 'per_unit' && tiers.length ? `/${unit} 起` : `/${unit}`}</div>
            {service.price_type === 'per_unit' && tiers.length ? <div className="tbl__meta">{`${tiers.length} 档阶梯价`}</div> : null}
          </div>
          <div className="cluster">{service.status === 'active' ? <Tag text="在架" tone="jade" /> : <Tag text="已下架" tone="oxblood" />}</div>
        </div>

        {gain ? (
          <div>
            <span className="tag tag--outline">{`可获得 ${gain}`}</span>
          </div>
        ) : null}

        {service.description ? <p style={{ lineHeight: '1.7' }}>{service.description}</p> : null}

        {service.package_items?.length ? (
          <div>
            <div className="tbl__meta">套餐包含</div>
            {subitems(service.package_items)}
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
            onClick={() => openServiceForm(service, ctx?.meta || {}).then((saved) => (saved ? reload() : null))}
          >
            <Pencil {...iconProps()} />
            改价格和说明
          </button>
          <button className="btn btn--sm" type="button" onClick={() => openTierEditor(service)}>
            阶梯价
          </button>
          <button className="btn btn--sm" type="button" onClick={() => openOptionEditor(service)}>
            套餐与增项
          </button>
          <CopyButton text={`${service.name} ¥${fmtMoney(service.base_price)}/${unit}`} label="复制价款" />
        </div>

        <hr />

        <div className="cluster">
          <button className="btn btn--sm" type="button" onClick={toggleStatus}>
            {service.status === 'active' ? '下架' : '重新上架'}
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
