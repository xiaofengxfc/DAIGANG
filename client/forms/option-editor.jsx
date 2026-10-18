import React, { useEffect, useState } from 'react'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import { api } from '../lib/api.js'
import { fmtMoney } from '../lib/formatters.js'
import { toast, toastErr } from '../app/toast-store.js'
import { confirmDelete } from '../app/confirm.jsx'
import Drawer from '../app/drawer.jsx'
import { CheckField, Field, SelectInput, TextInput } from '../app/fields.jsx'
import { openOverlay } from '../app/overlay-host.jsx'

/* ============================================================
   套餐 / 增项编辑器（React 版）
   ============================================================

   原来是 public/js/views/price.js 里的 optionEditor()。

     await openOptionEditor(service)

   两段列表：这个服务项专属的、和全局通用的（service_id 为空的）。
   只有专属的那些能改能删；通用的在这里只读，免得在一个服务项里
   把别的服务项也在用的东西改掉。

   注意 load() 一定要跑（旧版这里漏过一次，抽屉打开永远是空的，
   已有的增项根本看不见，只能一直往里加新的）。失败也要说出来，
   别出现「打开是空的，但不知道为什么」。
   ============================================================ */

const iconProps = (size = 14) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

const KIND_OPTIONS = [
  { value: 'addon', label: '增项（加钱）' },
  { value: 'package', label: '套餐（组合内容）' },
]
const MODE_OPTIONS = [
  { value: 'fixed', label: '固定加价（元）' },
  { value: 'percent', label: '按比例加价（%）' },
]

function Tag({ text, tone = '' }) {
  return <span className={`tag${tone ? ` tag--${tone}` : ''}`}>{text}</span>
}

export function openOptionEditor(service) {
  return openOverlay((close) => <OptionEditor service={service} close={close} />, 'option-editor')
}

function OptionEditor({ service, close }) {
  const [mine, setMine] = useState(null)
  const [globals, setGlobals] = useState([])
  const [error, setError] = useState('')

  async function load() {
    try {
      const [own, all] = await Promise.all([
        api.get('/api/options', { service_id: service.id, limit: 200 }),
        // 通用增项（service_id 为空）在服务端过滤：service_id=__none__ 就是 IS NULL。
        // 以前是「拉 400 条再在前端筛」，通用增项一多就会被截断，列表里凭空少几条。
        api.get('/api/options', { service_id: '__none__', status: 'active', limit: 400 }),
      ])
      setMine(own.items || [])
      setGlobals((all.items || []).filter((option) => !option.service_id && option.status !== 'archived'))
      setError('')
    } catch (err) {
      setError(err && err.message ? err.message : '增项拉不出来')
      setMine([])
      setGlobals([])
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function remove(option) {
    if (!(await confirmDelete({ title: '删掉这个增项？', message: option.name }))) return
    try {
      // hard=1：这个按钮写的是「删掉」。不传的话后端只把它归档，
      // 而下面这个列表是照 service_id 拉的、不看状态，删完它还挂在原地。
      await api.del(`/api/options/${option.id}`, { hard: 1 })
      toast('已删除', 'ok')
      load()
    } catch (err) {
      toastErr(err)
    }
  }

  const row = (option) => (
    <div className="item" key={option.id} style={{ cursor: 'default', alignItems: 'flex-start' }}>
      <div className="item__main">
        <div className="item__title">
          {option.name}
          <Tag text={option.kind === 'package' ? '套餐' : '增项'} tone={option.kind === 'package' ? 'slate' : ''} />
          {option.default_selected ? <Tag text="默认选中" tone="jade" /> : null}
          {option.status === 'archived' ? <Tag text="已下架" tone="oxblood" /> : null}
        </div>
        <div className="item__meta">
          <span>{option.price_mode === 'percent' ? `加价 ${option.price}%` : option.price ? `加 ¥${fmtMoney(option.price)}` : '不加价'}</span>
          {option.description ? <span>{option.description}</span> : null}
        </div>
      </div>
      {option.service_id ? (
        <div className="tbl__acts">
          <button className="btn btn--sm" type="button" title="改增项" onClick={() => openOptionForm({ option }).then((saved) => saved && load())}>
            <Pencil {...iconProps()} />
          </button>
          <button className="btn btn--sm" type="button" title="删掉这个增项" onClick={() => remove(option)}>
            <Trash2 {...iconProps()} />
          </button>
        </div>
      ) : (
        <span className="tag tag--outline">通用</span>
      )}
    </div>
  )

  const section = (title, rows, note) => (
    <React.Fragment key={title}>
      <div className="search__grouplbl" style={{ padding: '10px 0 4px' }}>
        {title}
      </div>
      {note ? (
        <div className="hint" style={{ paddingBottom: '6px' }}>
          {note}
        </div>
      ) : null}
      {rows.length ? (
        rows.map(row)
      ) : (
        <div style={{ padding: '0 0 8px' }}>
          <span className="dim sm">（空）</span>
        </div>
      )}
    </React.Fragment>
  )

  return (
    <Drawer title="套餐与增项" subtitle={service.name} onClose={() => close(null)}>
      <div className="stack">
        <div className="note">增项会作为可勾选项出现在下单台里，选了就自动加进金额，并且一起冻进订单快照。</div>

        <div className="itemlist">
          {mine === null ? (
            <div className="panel__body">
              <p className="dim sm">读取中…</p>
            </div>
          ) : (
            <>
              {section('这个服务项专属', mine)}
              {section('全局通用增项', globals, '建在所有服务项上都可用，比如「不动原石」「全程录屏」。在「新建增项」里把绑定服务留空即可。')}
            </>
          )}
        </div>

        <div className="cluster">
          <button className="btn btn--primary" type="button" onClick={() => openOptionForm({ service }).then((saved) => saved && load())}>
            <Plus {...iconProps()} />
            加增项
          </button>
          <button className="btn" type="button" onClick={() => openOptionForm({ global: true }).then((saved) => saved && load())}>
            通用增项
          </button>
        </div>

        {error ? <div className="note note--alert">{error}</div> : null}
      </div>
    </Drawer>
  )
}

/** 改增项 / 给这个服务项加增项 / 新建全局通用增项 —— 三种形态共用一个表单 */
function openOptionForm({ option = null, service = null, global = false }) {
  const key = option ? `option-form-${option.id}` : global ? 'option-form-global' : `option-form-${service ? service.id : 'new'}`
  return openOverlay((close) => <OptionForm option={option} service={service} global={global} close={close} />, key)
}

function OptionForm({ option, service, global, close }) {
  const isEdit = Boolean(option)
  const [form, setForm] = useState(() => ({
    name: option ? option.name || '' : '',
    kind: option ? option.kind || 'addon' : 'addon',
    price_mode: option ? option.price_mode || 'fixed' : 'fixed',
    // 「加增项」「通用增项」两个表单的数值默认 0，改增项时用原值（可能是空的）
    price: option ? (option.price === null || option.price === undefined ? '' : String(option.price)) : '0',
    default_selected: option ? Boolean(option.default_selected) : false,
    description: option ? option.description || '' : '',
  }))
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    if (!String(form.name).trim()) next.name = '请填写名称'
    if (String(form.price).trim() !== '' && !Number.isFinite(Number(form.price))) next.price = '请填数字'
    setErrors(next)
    setAlert('')
    if (Object.keys(next).length) {
      document.getElementById(`option-${Object.keys(next)[0]}`)?.focus()
      return
    }

    setBusy(true)
    try {
      const payload = { ...form, name: String(form.name).trim(), price: form.price === '' ? 0 : Number(form.price) }
      if (isEdit) {
        await api.patch(`/api/options/${option.id}`, payload)
        toast('已更新', 'ok')
      } else if (global) {
        await api.post('/api/options/append', { ...payload, service_id: null, kind: 'addon' })
        toast('已加上', 'ok')
      } else {
        await api.post('/api/options/append', { ...payload, service_id: service.id })
        toast('已加上', 'ok')
      }
      close(true)
    } catch (err) {
      setAlert(err && err.message ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title={isEdit ? '改增项' : global ? '新建全局通用增项' : '给这个服务项加增项'}
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>
            取消
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn--primary" type="submit" form="option-form" disabled={busy}>
            {busy ? '保存中…' : isEdit ? '保存' : '加上'}
          </button>
        </>
      }
    >
      <form id="option-form" noValidate onSubmit={submit}>
        <div className="stack">
          {global ? <div className="hint">不绑定任何服务项，所有服务都能勾。</div> : null}
          <div className="formgrid">
            <Field label="名称" required htmlFor="option-name" error={errors.name}>
              <TextInput
                id="option-name"
                value={form.name}
                onChange={set('name')}
                aria-invalid={errors.name ? 'true' : undefined}
                placeholder={isEdit || global ? undefined : '例：加急 / 指定角色 / 不动原石'}
              />
            </Field>

            {/* 全局通用增项固定是「增项」，表单里不给选类型 —— 和旧版一致 */}
            {global ? null : (
              <Field label="类型" half htmlFor="option-kind">
                <SelectInput id="option-kind" value={form.kind} onChange={set('kind')} options={KIND_OPTIONS} />
              </Field>
            )}

            <Field label="加价方式" half htmlFor="option-price-mode">
              <SelectInput id="option-price-mode" value={form.price_mode} onChange={set('price_mode')} options={MODE_OPTIONS} />
            </Field>

            <Field label="数值" half htmlFor="option-price" error={errors.price}>
              <TextInput id="option-price" numeric value={form.price} onChange={set('price')} />
            </Field>

            {global ? null : (
              <CheckField
                id="option-default-selected"
                checked={form.default_selected}
                onChange={set('default_selected')}
                label={isEdit ? '默认勾上' : '下单时默认勾上'}
              />
            )}

            <Field label="说明" htmlFor="option-description">
              <TextInput id="option-description" value={form.description} onChange={set('description')} />
            </Field>
          </div>
          {alert ? <div className="note note--alert">{alert}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}
