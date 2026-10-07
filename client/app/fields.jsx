import React, { useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { api } from '../lib/api.js'
import { toast } from './toast-store.js'

/* ============================================================
   表单字段（React 版）
   ============================================================

   和 drawer.jsx 一样，类名沿用旧 ui.js 那套（.field / .lbl / .inp / .ta /
   .sel / .hint / .err / .field--full），样式直接从 app.css 继承。

   旧引擎是「声明式字段数组 + 自己读 DOM」，这里是真受控组件：
   值在 React state 里，校验在提交时做，错误显示在同一个位置（.err）。
   ============================================================ */

/** 字段外壳：标签 + 控件 + 提示 + 错误位，和旧 fieldShell 结构一致 */
export function Field({ label, hint, error, required = false, half = false, suffix = '', htmlFor, children }) {
  return (
    <div className={`field${half ? '' : ' field--full'}${error ? ' is-bad' : ''}`}>
      {label ? (
        <label className="lbl" htmlFor={htmlFor}>
          {label}
          {required ? <span className="req">*</span> : null}
          {/* 单位跟在标签后面（基准单价（元）），旧引擎就是放在 .lbl 里的 */}
          {suffix ? <span className="dim tiny">{`（${suffix}）`}</span> : null}
        </label>
      ) : null}
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
      <div className="err" hidden={!error}>
        {error || ''}
      </div>
    </div>
  )
}

export function TextInput({ value, onChange, numeric = false, money = false, maxLength = 300, onBlur, ...rest }) {
  const fig = numeric || money
  return (
    <input
      {...rest}
      className={`inp${fig ? ' inp--fig' : ''}`}
      type="text"
      inputMode={fig ? 'decimal' : undefined}
      autoComplete="off"
      maxLength={maxLength}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
      // 金额框失焦时收成两位小数，和旧引擎的 money 字段一样。
      // 但只有真是数字才收：以前输入「100元」这种会被 Number() 判成 NaN，
      // 然后 || 0 把它整个改成 0 —— 看着像自己变 0，存下去的也是 0。
      // 留着原文，交给提交时的「请填数字」去拦。
      onBlur={(event) => {
        const raw = event.target.value
        // 只敲了空格也算「没填」：Number(' ') === 0，收成两位小数会把它写成 0，
        // 于是「请填写基准单价」再也拦不住，一个 ¥0 的服务项就悄悄存下去了。
        if (money && raw.trim() !== '' && Number.isFinite(Number(raw))) onChange(String(Math.round(Number(raw) * 100) / 100))
        if (onBlur) onBlur(event)
      }}
    />
  )
}

export function TextArea({ value, onChange, rows = 3, maxLength = 4000, ...rest }) {
  return (
    <textarea
      {...rest}
      className="ta"
      rows={rows}
      maxLength={maxLength}
      autoComplete="off"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function SelectInput({ value, onChange, options = [], ...rest }) {
  const raw = value === null || value === undefined ? '' : String(value)
  // 后端把 bool 列原样传成 true / false，而选项里写的是 '1' / '0'。
  // 直接 String() 对不上，就会冒出一个「（原值：false）」。
  // 所以先按选项集试一次别名换算（只在选项里真有 '1' / '0' 时才换）—— 和旧引擎一致。
  const alias = raw === 'true' ? '1' : raw === 'false' ? '0' : raw
  const wanted = alias !== raw && options.some((option) => String(option.value) === alias) ? alias : raw
  const known = options.some((option) => String(option.value) === wanted)
  return (
    <select {...rest} className="sel" value={wanted} onChange={(event) => onChange(event.target.value)}>
      {/* 原值不在选项里（记录被归档、分类被删）时补一个占位项并选中它。
          不补的话浏览器会默认选第一项，一保存就把这条记录的外键悄悄改掉了。 */}
      {known ? null : <option value={wanted}>{wanted ? `（原值：${wanted}）` : '（未指定）'}</option>}
      {options.map((option) => (
        <option key={String(option.value)} value={String(option.value)}>
          {option.label}
        </option>
      ))}
    </select>
  )
}

const splitTags = (text) =>
  String(text)
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter(Boolean)

/** 逗号分隔的多个值（区服、标签…）。对外是数组，对内保留用户正在敲的原文 */
export function TagsInput({ value, onChange, placeholder = '用逗号分隔，例如：爽快, 老客户', ...rest }) {
  const [text, setText] = useState(() => (Array.isArray(value) ? value.join(', ') : value || ''))
  return (
    <input
      {...rest}
      className="inp"
      type="text"
      autoComplete="off"
      placeholder={placeholder}
      value={text}
      onChange={(event) => {
        setText(event.target.value)
        onChange(splitTags(event.target.value))
      }}
    />
  )
}

/**
 * 勾选框。
 *
 * 注意这里**不渲染 .hint**：旧引擎对 check 字段走的是 bare 分支
 * （makeField 里 `if (bare) return h('div.field.field--full', control)`），
 * 提示文字会被直接丢掉。迁移时保持一致，免得顺手改了样子；
 * 但作者写的说明不该消失，所以挂到 label 的 title 上——鼠标停一下能看到，
 * 又不占版面、不影响和新旧表单的几何对比。
 */
export function CheckField({ label, hint, checked, onChange, id }) {
  return (
    <div className="field field--full">
      <label className="inline" htmlFor={id} style={{ cursor: 'pointer' }} title={hint || undefined}>
        <input id={id} className="chk" type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} />
        <span>{label}</span>
      </label>
    </div>
  )
}

/** 图片上传：读成 data URL 传给 /api/uploads，拿回来的地址直接当 img src */
export function ImageField({ label = '图片', value, onChange, prefix = 'img', hint = '', size = 56, shape = 'square', placeholder = '无' }) {
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)

  async function pick(event) {
    const file = event.target.files && event.target.files[0]
    if (!file) return
    if (file.size > 1.5 * 1024 * 1024) {
      toast('图片请压到 1.5MB 以内', 'err', 3600)
      return
    }
    setBusy(true)
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('读不了这个文件'))
        reader.readAsDataURL(file)
      })
      const result = await api.post('/api/uploads', { data_url: dataUrl, prefix })
      onChange(result.url)
      toast('图片已上传', 'ok')
    } catch (err) {
      toast(err && err.message ? err.message : '上传失败', 'err', 4200)
    } finally {
      setBusy(false)
      event.target.value = ''
    }
  }

  return (
    <div className="field field--full">
      {label ? <label className="lbl">{label}</label> : null}
      <div className="cluster">
        <div
          style={{
            width: `${size}px`,
            height: `${size}px`,
            borderRadius: shape === 'circle' ? '50%' : '12px',
            border: '1px solid var(--line-strong)',
            background: 'var(--surface-inset)',
            overflow: 'hidden',
            display: 'grid',
            placeContent: 'center',
            flex: 'none',
          }}
        >
          {value ? (
            <img src={value} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <span className="dim tiny">{placeholder}</span>
          )}
        </div>
        <div className="stack stack--tight">
          <div className="cluster">
            <button
              className="btn btn--sm"
              type="button"
              data-loading={busy ? '1' : undefined}
              onClick={() => fileRef.current && fileRef.current.click()}
            >
              <Upload size={14} strokeWidth={1.8} aria-hidden="true" />
              选一张图
            </button>
            {value ? (
              <button className="btn btn--sm btn--quiet" type="button" onClick={() => onChange('')}>
                去掉
              </button>
            ) : null}
          </div>
          {hint ? <div className="hint">{hint}</div> : null}
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
        style={{ display: 'none' }}
        onChange={pick}
      />
    </div>
  )
}
