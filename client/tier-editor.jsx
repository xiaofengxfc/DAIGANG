import React, { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { api } from './lib/api.js'
import { fmtMoney, fmtQty } from './lib/formatters.js'
import { toast, toastErr } from './app/toast-store.js'
import { confirmDelete } from './app/confirm.jsx'
import Drawer from './app/drawer.jsx'
import { Field, TextInput } from './app/fields.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { unitOf } from '../shared/pricing.js'

/* ============================================================
   阶梯价编辑器（React 版）
   ============================================================

   原来是 public/js/views/price.js 里的 tierEditor()。

     await openTierEditor(service)

   列表是现拉的（GET /api/services/:id/tiers），加一档 / 改一档都是往上一层
   叠一个小抽屉，存完只刷新这个列表，不关外面的详情抽屉 —— 和旧版一样。
   ============================================================ */

const iconProps = (size = 14) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

export function openTierEditor(service) {
  return openOverlay((close) => <TierEditor service={service} close={close} />, 'tier-editor')
}

function TierEditor({ service, close }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')

  async function load() {
    try {
      const { items: rows } = await api.get(`/api/services/${service.id}/tiers`)
      setItems(rows || [])
      setError('')
    } catch (err) {
      setError(err && err.message ? err.message : '阶梯价拉不出来')
      setItems([])
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const unit = unitOf(service)

  // 「不限」的止量当无穷大比，免得 null 被当成 0 反而算成不重叠
  const maxOf = (tier) => (tier.max_qty === null || tier.max_qty === undefined || tier.max_qty === '' ? Infinity : Number(tier.max_qty))
  const rangeText = (tier) => `${fmtQty(tier.min_qty)} ~ ${maxOf(tier) === Infinity ? '不限' : fmtQty(tier.max_qty)} ${unit}`
  const overlaps = (() => {
    const list = [...(items || [])].sort((a, b) => Number(a.min_qty) - Number(b.min_qty) || maxOf(a) - maxOf(b))
    const hits = []
    for (let i = 1; i < list.length; i++) if (Number(list[i].min_qty) <= maxOf(list[i - 1])) hits.push([list[i - 1], list[i]])
    return hits
  })()

  async function remove(tier) {
    if (!(await confirmDelete({ title: '删掉这一档？', message: `第 ${fmtQty(tier.min_qty)} 档` }))) return
    try {
      await api.del(`/api/tiers/${tier.id}`)
      toast('已删除', 'ok')
      load()
    } catch (err) {
      toastErr(err)
    }
  }

  return (
    <Drawer
      title="阶梯价"
      subtitle={`${service.name} · 按数量越多越便宜`}
      onClose={() => close(null)}
    >
      <div className="stack">
        <div className="note">按「数量」计价的服务项会先来这里找匹配的一档；数量落在两档之间就用下面那档的价，比第一档的起量还小就按第一档算。例：1~5 层 30 元/层，6~12 层 25 元/层。</div>

        {/* 区间叠在一起（1~5 和 3~4）时，数量落在重叠段里只会命中其中一档 ——
            哪一档是按起量排序后在前的那一档。不点破的话，改价时看到的钱
            和实际算出来的钱对不上，所以这里直接列出来让人去改。 */}
        {overlaps.length ? (
          <div className="note note--alert">
            {`有两档的区间叠在一起：${overlaps.map(([a, b]) => `${rangeText(a)} 和 ${rangeText(b)}`).join('；')}。重叠的数量只会按起量小的那一档算，建议把区间改开。`}
          </div>
        ) : null}

        <div className="itemlist">
          {items === null ? (
            <div className="panel__body">
              <p className="dim sm">读取中…</p>
            </div>
          ) : null}
          {items !== null && !items.length ? (
            <div className="panel__body">
              <p className="dim sm">还没有阶梯价。不配的话就一律用基准单价。</p>
            </div>
          ) : null}
          {(items || []).map((tier) => (
            <div className="item" key={tier.id} style={{ cursor: 'default' }}>
              <div className="item__main">
                <div className="item__title">
                  {`${fmtQty(tier.min_qty)} ~ ${tier.max_qty === null || tier.max_qty === '' ? '不限' : fmtQty(tier.max_qty)} ${unit}`}
                </div>
                <div className="item__meta">
                  <span>{`单价 ¥${fmtMoney(tier.unit_price)}/${unit}`}</span>
                </div>
              </div>
              <div className="tbl__acts">
                <button className="btn btn--sm" type="button" title="改这一档" onClick={() => openTierForm(service, tier).then((saved) => saved && load())}>
                  <Pencil {...iconProps()} />
                </button>
                <button className="btn btn--sm" type="button" title="删掉这一档" onClick={() => remove(tier)}>
                  <Trash2 {...iconProps()} />
                </button>
              </div>
            </div>
          ))}
        </div>

        {/* 「加一档」放在正文末尾，和旧版一样（旧抽屉没有页脚，只有标题栏的关闭按钮） */}
        <button className="btn btn--primary" type="button" onClick={() => openTierForm(service).then((saved) => saved && load())}>
          <Plus {...iconProps()} />
          加一档
        </button>

        {error ? <div className="note note--alert">{error}</div> : null}
      </div>
    </Drawer>
  )
}

/** 加一档 / 改一档：叠在阶梯价抽屉上面的小表单 */
function openTierForm(service, tier = null) {
  return openOverlay(
    (close) => <TierForm service={service} tier={tier} close={close} />,
    `tier-form-${tier ? tier.id : 'new'}`
  )
}

function TierForm({ service, tier, close }) {
  const isEdit = Boolean(tier)
  const [form, setForm] = useState(() => ({
    min_qty: tier && tier.min_qty !== null && tier.min_qty !== undefined ? String(tier.min_qty) : '',
    max_qty: tier && tier.max_qty !== null && tier.max_qty !== undefined ? String(tier.max_qty) : '',
    unit_price: tier && tier.unit_price !== null && tier.unit_price !== undefined ? String(tier.unit_price) : '',
  }))
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    // 只敲了空格也算没填（不然 Number(' ') === 0 会存成「0 ~ x」）
    const blank = (value) => value === null || value === undefined || String(value).trim() === ''
    if (blank(form.min_qty)) next.min_qty = '请填写起始数量'
    else if (!Number.isFinite(Number(form.min_qty))) next.min_qty = '请填数字'
    else if (Number(form.min_qty) <= 0) next.min_qty = '起始数量要大于 0'
    if (blank(form.unit_price)) next.unit_price = '请填写这一档的单价'
    else if (!Number.isFinite(Number(form.unit_price))) next.unit_price = '请填数字'
    else if (Number(form.unit_price) < 0) next.unit_price = '单价不能是负数'
    if (!blank(form.max_qty) && !Number.isFinite(Number(form.max_qty))) next.max_qty = '请填数字'
    // 结束比起始还小 = 这一档永远不会被命中（价格会退到起量小的那一档），
    // 列表上还会显示成「10 ~ 5 层」这种看不懂的区间。宁可不给存。
    if (!next.min_qty && !next.max_qty && !blank(form.min_qty) && !blank(form.max_qty) && Number(form.max_qty) < Number(form.min_qty)) {
      next.max_qty = '结束数量不能比起始数量小'
    }
    setErrors(next)
    setAlert('')
    if (Object.keys(next).length) {
      document.getElementById(`tier-${Object.keys(next)[0]}`)?.focus()
      return
    }

    setBusy(true)
    try {
      const payload = {
        min_qty: Number(form.min_qty),
        max_qty: blank(form.max_qty) ? null : Number(form.max_qty),
        unit_price: Number(form.unit_price),
      }
      if (isEdit) await api.patch(`/api/tiers/${tier.id}`, payload)
      else await api.post(`/api/services/${service.id}/tiers`, payload)
      toast(isEdit ? '已更新' : '已加上', 'ok')
      close(true)
    } catch (err) {
      setAlert(err && err.message ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title={isEdit ? '改阶梯价' : '加一档阶梯价'}
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>
            取消
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn--primary" type="submit" form="tier-form" disabled={busy}>
            {busy ? '保存中…' : isEdit ? '保存' : '加上'}
          </button>
        </>
      }
    >
      <form id="tier-form" noValidate onSubmit={submit}>
        <div className="stack">
          <div className="formgrid">
            <Field label="起始数量" required half htmlFor="tier-min_qty" error={errors.min_qty}>
              <TextInput id="tier-min_qty" numeric value={form.min_qty} onChange={set('min_qty')} />
            </Field>
            <Field label="结束数量（留空不限）" half htmlFor="tier-max_qty" error={errors.max_qty}>
              <TextInput id="tier-max_qty" numeric value={form.max_qty} onChange={set('max_qty')} placeholder={isEdit ? undefined : '留空 = 到无限'} />
            </Field>
            <Field label="这一档的单价" required half htmlFor="tier-unit_price" error={errors.unit_price}>
              <TextInput id="tier-unit_price" money value={form.unit_price} onChange={set('unit_price')} />
            </Field>
          </div>
          {alert ? <div className="note note--alert">{alert}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}
