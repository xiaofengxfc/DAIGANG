import React, { useState } from 'react'
import { ORDER_STATUS_LABEL, api } from '../lib/api.js'
import { toast } from '../app/toast-store.js'
import Drawer from '../app/drawer.jsx'
import { Field, SelectInput, TextInput } from '../app/fields.jsx'
import { openOverlay } from '../app/overlay-host.jsx'

/* ============================================================
   推进订单状态（React 版）
   ============================================================

   原来是 public/js/views/orderbits.js 里的 statusDrawer()。
   能推进到哪几个状态由服务端算好放在 order.next_statuses 里，
   这里只负责让用户挑一个；一个都没有时不弹抽屉，直接提示。
   ============================================================ */

const FORM_ID = 'status-form'

export function openStatusForm(order, onDone) {
  const nexts = order.next_statuses || []
  if (!nexts.length) {
    toast('这个状态没有下一步了', 'err')
    return Promise.resolve(null)
  }
  return openOverlay((close) => <StatusForm order={order} nexts={nexts} onDone={onDone} close={close} />, `status-form-${order.id}`)
}

function StatusForm({ order, nexts, onDone, close }) {
  const [form, setForm] = useState({ status: '', note: '' })
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    if (!form.status) next.status = '请填写改成'
    setErrors(next)
    if (Object.keys(next).length) {
      document.getElementById('status-status')?.focus()
      return
    }

    setBusy(true)
    setServerError('')
    try {
      const saved = await api.post(`/api/orders/${order.id}/status`, form)
      toast('状态已更新', 'ok')
      close(saved)
      if (onDone) onDone(saved)
    } catch (err) {
      setServerError(err && err.message ? err.message : '推不动这个状态')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title="推进状态"
      subtitle={`${order.order_no} · 现在是「${order.status_label}」`}
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>
            取消
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn--primary" type="submit" form={FORM_ID} disabled={busy}>
            {busy ? '推进中…' : '推进'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} noValidate onSubmit={submit}>
        <div className="stack">
          <div className="formgrid">
            <Field label="改成" required htmlFor="status-status" error={errors.status}>
              <SelectInput
                id="status-status"
                name="status"
                value={form.status}
                onChange={set('status')}
                aria-invalid={errors.status ? 'true' : undefined}
                options={nexts.map((status) => ({ value: status, label: ORDER_STATUS_LABEL[status] || status }))}
              />
            </Field>

            <Field label="顺便记一句（会写进进度时间线）" htmlFor="status-note">
              <TextInput id="status-note" name="note" value={form.note} onChange={set('note')} placeholder="例：做完了，等客户验收" />
            </Field>
          </div>

          {serverError ? <div className="note note--alert">{serverError}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}
