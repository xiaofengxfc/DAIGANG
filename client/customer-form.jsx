import React, { useState } from 'react'
import { api } from './lib/api.js'
import Drawer from './app/drawer.jsx'
import { Field, ImageField, SelectInput, TagsInput, TextArea, TextInput } from './app/fields.jsx'
import { openOverlay } from './app/overlay-host.jsx'

/* ============================================================
   客户表单（React 版）
   ============================================================

   原来是 public/js/views/orders.js 里的 customerForm()（客户表单住在订单模块里，
   客户页再 import 回去）。字段和提示一字未改，只是改成受控组件。

     const saved = await openCustomerForm(customer)   // 取消 → null
     if (saved) reload()

   旧的那份先留着：客户档案详情页（/customers/:id）、旧订单开单器、旧客户页
   都还在用它，等那些页面也迁完再删。
   ============================================================ */

const SOURCES = ['微信', 'QQ群', '朋友介绍', '闲鱼', '贴吧', '回头客', '其他']
const FORM_ID = 'customer-form'

export function openCustomerForm(values = {}, { title } = {}) {
  return openOverlay((close) => <CustomerForm values={values} title={title || (values.id ? '改客户资料' : '新客户')} close={close} />)
}

function CustomerForm({ values, title, close }) {
  const [form, setForm] = useState(() => ({
    avatar: values.avatar || '',
    name: values.name || '',
    phone: values.phone || '',
    wechat: values.wechat || '',
    qq: values.qq || '',
    source: values.source || '微信',
    tags: Array.isArray(values.tags) ? values.tags : [],
    note: values.note || '',
  }))
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    if (!String(form.name).trim()) next.name = '请填写昵称'
    setErrors(next)
    if (Object.keys(next).length) {
      document.getElementById('customer-name')?.focus()
      return
    }

    setBusy(true)
    setServerError('')
    try {
      const payload = { ...form, name: String(form.name).trim() }
      const saved = values.id ? await api.patch(`/api/customers/${values.id}`, payload) : await api.post('/api/customers', payload)
      close(saved)
    } catch (err) {
      setServerError(err && err.message ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title={title}
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>
            取消
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn--primary" type="submit" form={FORM_ID} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} noValidate onSubmit={submit}>
        <div className="stack">
          <div className="formgrid">
            <ImageField
              label="头像"
              value={form.avatar}
              onChange={set('avatar')}
              prefix="customer"
              shape="circle"
              size={60}
              hint="选填。会显示在客户列表和订单列表上，客户多了好认。"
            />

            <Field label="昵称" required htmlFor="customer-name" error={errors.name}>
              <TextInput id="customer-name" name="name" value={form.name} onChange={set('name')} aria-invalid={errors.name ? 'true' : undefined} placeholder="客户怎么称呼" />
            </Field>

            <Field label="手机号" half htmlFor="customer-phone" hint="用作客户标识，方便搜索">
              <TextInput id="customer-phone" name="phone" value={form.phone} onChange={set('phone')} />
            </Field>

            <Field label="微信" half htmlFor="customer-wechat">
              <TextInput id="customer-wechat" name="wechat" value={form.wechat} onChange={set('wechat')} />
            </Field>

            <Field label="QQ" half htmlFor="customer-qq">
              <TextInput id="customer-qq" name="qq" value={form.qq} onChange={set('qq')} />
            </Field>

            <Field label="来源" half htmlFor="customer-source">
              <SelectInput
                id="customer-source"
                name="source"
                value={form.source}
                onChange={set('source')}
                options={SOURCES.map((value) => ({ value, label: value }))}
              />
            </Field>

            <Field label="标签" htmlFor="customer-tags" hint="例如：爽快、老客户、要发票">
              <TagsInput id="customer-tags" name="tags" value={form.tags} onChange={set('tags')} />
            </Field>

            <Field label="备注" htmlFor="customer-note">
              <TextArea id="customer-note" name="note" rows={3} value={form.note} onChange={set('note')} placeholder="作息、沟通习惯、忌讳…" />
            </Field>
          </div>

          {serverError ? <div className="note note--alert">{serverError}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}
