import React, { useState } from 'react'
import { api } from './lib/api.js'
import { toast } from './lib/legacy-ui.js'
import Drawer from './app/drawer.jsx'
import { Field, ImageField, SelectInput, TagsInput, TextArea, TextInput } from './app/fields.jsx'
import { openOverlay } from './app/overlay-host.jsx'

/* ============================================================
   游戏表单（第一个全 React 的表单）
   ============================================================

   原来是 public/js/views/games.js 里的 gameForm()，靠 ui.js 的声明式字段数组
   建 DOM。这里改成受控组件，字段、校验、错误显示都在 React 里。

   对外调用方式没变：

     const saved = await openGameForm(game)   // 取消 → null
     if (saved) reload()

   旧的那份 gameForm 先留着：public/js/views/price.js（旧价格表页面）还在用它，
   等价格表也迁过来再删。两套并存期间，两边都能开、互不影响。
   ============================================================ */

const FORM_ID = 'game-form'

export function openGameForm(values = {}) {
  return openOverlay((close) => <GameForm values={values} close={close} />)
}

function GameForm({ values, close }) {
  const [form, setForm] = useState(() => ({
    name: values.name || '',
    short_name: values.short_name || '',
    icon: values.icon || '',
    servers: Array.isArray(values.servers) ? values.servers : [],
    currency: values.currency || '',
    notice: values.notice || '',
    status: values.status || 'active',
    sort_order: values.sort_order === null || values.sort_order === undefined ? '' : String(values.sort_order),
    note: values.note || '',
  }))
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    if (!String(form.name).trim()) next.name = '请填写游戏名'
    if (form.sort_order !== '' && !Number.isFinite(Number(form.sort_order))) next.sort_order = '请填数字'
    setErrors(next)
    if (Object.keys(next).length) {
      document.getElementById(`game-${Object.keys(next)[0]}`)?.focus()
      return
    }

    setBusy(true)
    setServerError('')
    try {
      // sort_order 空着就照旧传空串，交给后端按默认值处理（和旧表单一致）
      const payload = { ...form, name: String(form.name).trim() }
      const saved = values.id ? await api.patch(`/api/games/${values.id}`, payload) : await api.post('/api/games', payload)
      toast('游戏已保存', 'ok')
      close(saved)
    } catch (err) {
      setServerError(err && err.message ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title={values.id ? '改游戏' : '新建游戏'}
      wide
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
            <Field label="游戏名" required half htmlFor="game-name" error={errors.name}>
              <TextInput id="game-name" name="name" value={form.name} onChange={set('name')} aria-invalid={errors.name ? 'true' : undefined} placeholder="例：原神 / 崩坏：星穹铁道" />
            </Field>

            <Field label="简称" half htmlFor="game-short-name">
              <TextInput id="game-short-name" name="short_name" value={form.short_name} onChange={set('short_name')} placeholder="例：YS / 崩铁" />
            </Field>

            <ImageField
              label="图标"
              value={form.icon}
              onChange={set('icon')}
              prefix="game"
              hint="选填。会显示在游戏列表和报价单上。"
            />

            <Field label="区服列表" htmlFor="game-servers" hint="逗号分隔。例：天空岛, 世界树, 亚服。开单时可以直接选。">
              <TagsInput id="game-servers" name="servers" value={form.servers} onChange={set('servers')} />
            </Field>

            <Field
              label="货币名称"
              half
              htmlFor="game-currency"
              hint="这个游戏里客户最认的那种货币叫什么。填了之后，服务项上就能写「这个套餐给多少」。"
            >
              <TextInput id="game-currency" name="currency" value={form.currency} onChange={set('currency')} placeholder="例：原石 / 星声 / 纠缠之缘" />
            </Field>

            <Field
              label="顶部提示"
              htmlFor="game-notice"
              hint="只给客户看的一句话。可以做多行，一行一件事。导出价格表时，它会显示在图片 / Word 的最上方 —— 抬头下面、第一个大类上面，不带任何标题。和「备注」分开：备注是你自己记账用的，不会出现在导出里。"
            >
              <TextArea
                id="game-notice"
                name="notice"
                rows={3}
                maxLength={600}
                value={form.notice}
                onChange={set('notice')}
                placeholder="例：本价格表自 9 月 20 日起执行；包月客户送一次活动代打。"
              />
            </Field>

            <Field label="状态" half htmlFor="game-status">
              <SelectInput
                id="game-status"
                name="status"
                value={form.status}
                onChange={set('status')}
                options={[
                  { value: 'active', label: '上架' },
                  { value: 'archived', label: '归档（不再出现在新单里）' },
                ]}
              />
            </Field>

            <Field label="排序" half htmlFor="game-sort-order" error={errors.sort_order} hint="数字小的排前面">
              <TextInput id="game-sort-order" name="sort_order" numeric value={form.sort_order} onChange={set('sort_order')} aria-invalid={errors.sort_order ? 'true' : undefined} />
            </Field>

            <Field label="备注" htmlFor="game-note">
              <TextArea id="game-note" name="note" rows={2} value={form.note} onChange={set('note')} />
            </Field>
          </div>

          {serverError ? <div className="note note--alert">{serverError}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}
