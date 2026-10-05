import React, { useMemo, useState } from 'react'
import { PRICE_TYPE_LABEL } from './lib/api.js'
import { fmtMoney, fmtQty } from './lib/formatters.js'
import { copyText } from './lib/dom.js'
import { toast } from './app/toast-store.js'
import Modal from './app/modal.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { unitOf, unitPriceOf } from '../shared/pricing.js'

/* ============================================================
   组合报价（React 版）
   ============================================================

   客户说「我要这几个」，勾几下就知道一共多少钱，不用自己摁计算器。
   数量能改，会自动套阶梯价 —— 单价来自 shared/pricing.js，
   和下单台（src/pricing.mjs）是同一份实现，所以这里显示多少、开单就是多少。

     openPriceSum(category, services)
   ============================================================ */

export function openPriceSum(category, services) {
  return openOverlay((close) => <PriceSum category={category} services={services} close={close} />, 'price-sum')
}

function PriceSum({ category, services, close }) {
  const list = useMemo(() => (services || []).filter((service) => service.status !== 'archived'), [services])
  const [picked, setPicked] = useState(() => new Set())
  const [qty, setQty] = useState(() => Object.fromEntries(list.map((service) => [service.id, String(Number(service.min_qty) || 1)])))
  const [copied, setCopied] = useState(false)

  const rows = list.map((service) => {
    const on = picked.has(service.id)
    const q = on ? Math.max(0.01, Number(qty[service.id]) || 1) : 1
    const unit = unitPriceOf(service, q)
    const amount = on ? unit * q : 0
    const hasTiers = (service.tiers || []).length > 0
    return {
      service,
      on,
      q,
      unit,
      amount,
      hasTiers,
      hint: on && hasTiers ? `按 ${fmtQty(q)} ${unitOf(service)} 算，单价 ¥${fmtMoney(unit)}` : '',
      meta: [PRICE_TYPE_LABEL[service.price_type] || service.price_type, hasTiers ? `${service.tiers.length} 档阶梯价` : null, service.description || null].filter(Boolean).join(' · '),
    }
  })
  const total = rows.reduce((sum, row) => sum + row.amount, 0)
  const pickedCount = rows.filter((row) => row.on).length

  const toggle = (id) =>
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const setAll = (on) => setPicked(on ? new Set(list.map((service) => service.id)) : new Set())

  async function copy() {
    const lines = []
    let sum = 0
    for (const row of rows) {
      if (!row.on) continue
      sum += row.amount
      lines.push(`${row.service.name}  ${fmtQty(row.q)}${unitOf(row.service)} × ¥${fmtMoney(row.unit)} = ¥${fmtMoney(row.amount)}`)
    }
    if (!lines.length) return
    const ok = await copyText([`【${category.name}】`, ...lines, `合计：¥${fmtMoney(sum)}`].join('\n'))
    toast(ok ? '报价已复制' : '复制失败，手动选一下吧', ok ? 'ok' : 'err')
    setCopied(ok)
    // 复制完不关窗，方便接着调数量再复制一次
  }

  return (
    <Modal
      title={`组合报价 · ${category.name}`}
      wide
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>
            关闭
          </button>
          <button className="btn btn--primary" type="button" disabled={!pickedCount} onClick={copy}>
            复制报价
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="cluster">
          <span className="sm dim">勾上客户要的服务项{list.some((service) => (service.tiers || []).length) ? '；数量能改，会自动套阶梯价' : ''}。</span>
          <div style={{ flex: 1 }} />
          {list.length ? (
            <button className="btn btn--sm" type="button" onClick={() => setAll(true)}>
              全选
            </button>
          ) : null}
          {list.length ? (
            <button className="btn btn--sm" type="button" onClick={() => setAll(false)}>
              全不选
            </button>
          ) : null}
        </div>

        {list.length ? (
          <div className="picker">
            <div className="picker__scroll">
              {rows.map((row) => (
                <div className={`pickrow${row.on ? ' pickrow--on' : ''}`} key={row.service.id}>
                  <div className="pickrow__top">
                    <input className="chk" type="checkbox" aria-label={`选择 ${row.service.name}`} checked={row.on} onChange={() => toggle(row.service.id)} />
                    <button className="pickrow__main" type="button" onClick={() => toggle(row.service.id)}>
                      <span className="pickrow__line">
                        <span className="pickrow__name">{row.service.name}</span>
                        <span className="pickrow__fig">{`¥${fmtMoney(row.on ? row.amount : Number(row.service.base_price) || 0)}`}</span>
                      </span>
                      <span className="pickrow__meta">{row.meta}</span>
                    </button>
                  </div>
                  <div className="pickrow__ctrl">
                    <div className="cluster" style={{ gap: '6px' }}>
                      <input
                        className="inp inp--fig"
                        inputMode="decimal"
                        style={{ width: '64px' }}
                        disabled={!row.on}
                        aria-label={`${row.service.name} 数量`}
                        value={qty[row.service.id]}
                        onChange={(event) => setQty((current) => ({ ...current, [row.service.id]: event.target.value }))}
                      />
                      <span className="dim tiny">{unitOf(row.service)}</span>
                      <div className="hint">{row.hint}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="empty">
            <div className="empty__body">这个大类下还没有服务项。</div>
          </div>
        )}

        <div className="sumline">
          <span className="dim">合计</span>
          <span className="dim sm">{pickedCount ? `已选 ${pickedCount} 项` : '还没勾'}</span>
          <div style={{ flex: 1 }} />
          <span className="sumline__v">{`¥${fmtMoney(total)}`}</span>
        </div>
        {copied ? <div className="hint">已复制到剪贴板，可以直接粘给客户。</div> : null}
      </div>
    </Modal>
  )
}
