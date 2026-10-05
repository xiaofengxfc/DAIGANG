import React, { useState } from 'react'
import { api } from './lib/api.js'
import { toast } from './lib/legacy-ui.js'
import Drawer from './app/drawer.jsx'
import { CheckField, Field, SelectInput, TextArea, TextInput } from './app/fields.jsx'
import { openOverlay } from './app/overlay-host.jsx'

/* ============================================================
   大类（分类）表单（React 版）
   ============================================================

   原来是 public/js/views/price.js 里的 categoryForm()。

     const saved = await openCategoryForm({}, games, presetGameId)   // 取消 → null
     if (saved) reload()

   两个容易踩的点，跟旧版一致：
     · 从某个游戏的价格表里点「新建大类」时，游戏默认就是这个游戏，
       不会静悄悄落回「通用」——那正是以前让人以为"没建成"的原因；
     · 保存时 game_id 空串要转成 null，否则「通用」会变成一个不存在的外键。
   ============================================================ */

const FORM_ID = 'category-form'

export function openCategoryForm(values = {}, games = [], presetGameId = null) {
  return openOverlay((close) => <CategoryForm values={values} games={games} presetGameId={presetGameId} close={close} />, 'category-form')
}

function CategoryForm({ values, games, presetGameId, close }) {
  const isEdit = Boolean(values.id)
  const [form, setForm] = useState(() => {
    const initial = {
      name: values.name || '',
      game_id: values.game_id === null || values.game_id === undefined ? '' : String(values.game_id),
      is_daily: Boolean(values.is_daily),
      note: values.note || '',
      notice: values.notice || '',
    }
    if (!isEdit && presetGameId && !initial.game_id) initial.game_id = String(presetGameId)
    return initial
  })
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    if (!String(form.name).trim()) next.name = '请填写大类名称'
    setErrors(next)
    if (Object.keys(next).length) {
      document.getElementById('category-name')?.focus()
      return
    }

    setBusy(true)
    setServerError('')
    try {
      const payload = { ...form, name: String(form.name).trim(), game_id: form.game_id || null }
      const saved = isEdit ? await api.patch(`/api/categories/${values.id}`, payload) : await api.post('/api/categories/append', payload)
      toast('大类已保存', 'ok')
      close(saved)
    } catch (err) {
      setServerError(err && err.message ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title={isEdit ? '改大类' : '新建大类'}
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
          <div className="hint">价格表的结构是三层：游戏 → 大类 → 服务项。先建大类（日常 / 周常 / 深渊 / 活动 / 材料…），再往大类里加具体的服务项。</div>
          <div className="formgrid">
            <Field label="大类名称" required htmlFor="category-name" error={errors.name}>
              <TextInput id="category-name" name="name" value={form.name} onChange={set('name')} aria-invalid={errors.name ? 'true' : undefined} placeholder="例：日常 / 周常 / 深渊 / 活动" />
            </Field>

            <Field label="属于哪个游戏" htmlFor="category-game" hint="选「通用」就是一个所有游戏都能用的大类">
              <SelectInput
                id="category-game"
                name="game_id"
                value={form.game_id}
                onChange={set('game_id')}
                options={[{ value: '', label: '通用（不属于某个游戏）' }, ...(games || []).map((game) => ({ value: String(game.id), label: game.name }))]}
              />
            </Field>

            <CheckField
              id="category-is-daily"
              checked={form.is_daily}
              onChange={set('is_daily')}
              label="每天都做（日常 / 日体 / 包天这种天天要做的）"
              hint="勾上之后，开单时会标出来，标「今日已完成」时也会提醒你这张单里是不是还夹着别的活"
            />

            <Field label="备注" htmlFor="category-note">
              <TextInput id="category-note" name="note" value={form.note} onChange={set('note')} placeholder="选填" />
            </Field>

            <Field
              label="大类提示"
              htmlFor="category-notice"
              hint="只给客户看的一句话，可以做多行。导出价格表时，它会显示在「这个大类」的名字下面、服务项上面 —— 缩进一格，比游戏那条顶部提示低一级。和「备注」分开：备注是你自己看的，不会出现在导出里。"
            >
              <TextArea
                id="category-notice"
                name="notice"
                rows={2}
                maxLength={400}
                value={form.notice}
                onChange={set('notice')}
                placeholder="例：本大类按层数计价，10 层起接。"
              />
            </Field>
          </div>

          {serverError ? <div className="note note--alert">{serverError}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}
