import React, { useState } from 'react'
import { api, PAY_METHOD_LABEL } from './lib/api.js'
import { fmtMoney, todayStr } from './lib/formatters.js'
import { toast } from './app/toast-store.js'
import Drawer from './app/drawer.jsx'
import { Field, SelectInput, TextInput } from './app/fields.jsx'
import { openOverlay } from './app/overlay-host.jsx'

/* ============================================================
   记一笔收款（React 版）
   ============================================================

   原来是 public/js/views/orderbits.js 里的 paymentDrawer()。
   订单页和看板都调它，调用方式保持原样：

     paymentDrawer(order, onReload)                 // 记完刷新列表
     paymentDrawer(order, onReload, { presetKind: 'deposit' })

   还没收过钱默认「全款」（一次付清最常见），已经收过一部分默认「尾款」。
   ============================================================ */

const FORM_ID = 'payment-form'

export function openPaymentForm(order, onDone, { presetKind } = {}) {
  return openOverlay((close) => <PaymentForm order={order} onDone={onDone} presetKind={presetKind} close={close} />, `payment-form-${order.id}`)
}

function PaymentForm({ order, onDone, presetKind, close }) {
  const due = Number(order.due_total) || 0
  const paid = Number(order.paid_total) || 0
  const [form, setForm] = useState(() => ({
    amount: String(due > 0 ? due : Number(order.total) || 0),
    kind: presetKind || (paid > 0.001 ? 'balance' : 'full'),
    method: 'wechat',
    paid_at: todayStr(),
    note: '',
  }))
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    // 旧引擎里 money 空着会读成 0，于是「必填的金额」空着也能提交，记下一笔 ¥0。
    // 那是它的一个洞，这里故意堵上：空着就报错，明确填 0 才按 0 记。
    const raw = String(form.amount).trim()
    if (raw === '') next.amount = '请填写金额'
    else if (!Number.isFinite(Number(raw))) next.amount = '请填数字'
    setErrors(next)
    if (Object.keys(next).length) {
      document.getElementById(`payment-${Object.keys(next)[0]}`)?.focus()
      return
    }

    setBusy(true)
    setServerError('')
    try {
      const saved = await api.post('/api/payments', { ...form, amount: Number(form.amount), order_id: order.id })
      if (saved.advanced_to) toast('款已收齐，订单自动推进到「进行中」', 'ok', 3200)
      else toast('收款记下了', 'ok')
      close(saved)
      if (onDone) onDone(saved)
    } catch (err) {
      setServerError(err && err.message ? err.message : '记不下这笔收款')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title="记一笔收款"
      subtitle={`${order.order_no} · 应收 ${fmtMoney(order.total)} 元，还差 ${fmtMoney(due)} 元`}
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>
            取消
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn--primary" type="submit" form={FORM_ID} disabled={busy}>
            {busy ? '记账中…' : '记下'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} noValidate onSubmit={submit}>
        <div className="stack">
          <div className="formgrid">
            <Field label="金额" required half suffix="元" htmlFor="payment-amount" error={errors.amount}>
              <TextInput id="payment-amount" name="amount" money value={form.amount} onChange={set('amount')} aria-invalid={errors.amount ? 'true' : undefined} />
            </Field>

            <Field label="类型" half htmlFor="payment-kind">
              <SelectInput
                id="payment-kind"
                name="kind"
                value={form.kind}
                onChange={set('kind')}
                options={[
                  { value: 'deposit', label: '定金' },
                  { value: 'full', label: '全款' },
                  { value: 'balance', label: '尾款' },
                  { value: 'refund', label: '退款' },
                ]}
              />
            </Field>

            <Field label="收款方式" half htmlFor="payment-method">
              <SelectInput
                id="payment-method"
                name="method"
                value={form.method}
                onChange={set('method')}
                options={Object.entries(PAY_METHOD_LABEL).map(([value, label]) => ({ value, label }))}
              />
            </Field>

            <Field label="日期" half htmlFor="payment-paid-at">
              <input id="payment-paid-at" name="paid_at" className="inp" type="date" value={form.paid_at} onChange={(event) => set('paid_at')(event.target.value)} />
            </Field>

            <Field label="备注" htmlFor="payment-note">
              <TextInput id="payment-note" name="note" value={form.note} onChange={set('note')} placeholder="例：微信转账，客户说月底结清" />
            </Field>
          </div>

          {serverError ? <div className="note note--alert">{serverError}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}
