/* ============================================================
   界面原件：吐司、对话框、抽屉、声明式表单、账簿表格、空态
   每个交互件都有 default / hover / focus / disabled / loading / error
   ============================================================ */

import { h, frag, icon, mount, clear, cls, uid, fmtMoney, fmtQty, copyText } from './dom.js'
import { STATUS_TONE, STATUS_FLOW } from './api.js'

/* ============================================================
   吐司
   ============================================================ */

let toastHost = null

function ensureToastHost() {
  if (!toastHost) {
    toastHost = h('div.toasts', { role: 'status', 'aria-live': 'polite' })
    document.body.appendChild(toastHost)
  }
  return toastHost
}

export function toast(message, tone = 'info', ms = 2600) {
  const host = ensureToastHost()
  const mark = tone === 'err' ? '!' : tone === 'ok' ? '✓' : '·'
  const el = h(
    `div.toast${tone === 'err' ? '.toast--err' : tone === 'ok' ? '.toast--ok' : ''}`,
    h('span.toast__ico', mark),
    h('span', message)
  )
  host.appendChild(el)
  requestAnimationFrame(() => el.setAttribute('data-show', '1'))
  setTimeout(() => {
    el.removeAttribute('data-show')
    setTimeout(() => el.remove(), 240)
  }, ms)
  return el
}

export const toastErr = (e) => {
  const msg = typeof e === 'string' ? e : e && e.message ? e.message : '出错了'
  toast(msg, 'err', 4200)
}

/* ============================================================
   <dialog> 基座
   ============================================================ */

function openDialog({ node, onClose }) {
  if (!node.isConnected) document.body.appendChild(node)
  let closed = false
  const finish = () => {
    if (closed) return
    closed = true
    document.body.classList.remove('is-locked')
    if (node.open) node.close()
    node.remove()
    if (onClose) onClose()
  }
  node.addEventListener('close', finish)
  node.addEventListener('cancel', (e) => {
    e.preventDefault()
    finish()
  })
  node.addEventListener('click', (e) => {
    // 点遮罩关闭：只有落在 dialog 自身（而不是内部内容）时才算
    if (e.target === node) finish()
  })
  document.body.classList.add('is-locked')
  node.showModal()
  return finish
}

/* ============================================================
   对话框
   ============================================================ */

export function modal({ title, body, actions = [], wide = false, onClose }) {
  const foot = h('div.modal__foot')
  const close = () => finish()
  const dlg = h(
    `dialog.modal${wide ? '.modal--wide' : ''}`,
    h('div.modal__body', title ? h('h2.modal__title', title) : null, body),
    actions.length ? foot : null
  )
  const finish = openDialog({ node: dlg, onClose })
  for (const a of actions) {
    foot.appendChild(
      h(
        `button.btn${a.tone === 'primary' ? '.btn--primary' : a.tone === 'danger' ? '.btn--danger' : ''}`,
        {
          type: 'button',
          onclick: async () => {
            if (a.onClick) {
              const r = await a.onClick({ close: finish })
              if (r === false) return
            }
            if (a.keepOpen !== true) finish()
          },
        },
        a.label
      )
    )
  }
  return { close: finish, node: dlg }
}

export function confirmModal({ title, message, confirmLabel = '确定', tone = 'primary', extra = null }) {
  return new Promise((resolve) => {
    let answer = false
    const m = modal({
      title,
      body: h('div.stack.stack--tight', h('p.muted', message), extra),
      actions: [
        { label: '取消', onClick: () => resolve(false) },
        {
          label: confirmLabel,
          tone,
          onClick: () => {
            answer = true
            resolve(true)
          },
        },
      ],
      onClose: () => {
        if (!answer) resolve(false)
      },
    })
    return m
  })
}

/** 删除前问一句，并按用量给出后果说明 */
export function confirmDelete({ title, message, confirmLabel = '删除' }) {
  return confirmModal({ title, message, confirmLabel, tone: 'danger' })
}

/* ============================================================
   抽屉
   ============================================================ */

export function drawer({ title, subtitle, body, footer, wide = false, onClose }) {
  const bodyEl = h('div.drawer__body')
  mount(bodyEl, body)
  const dlg = h(
    `dialog.drawer${wide ? '.drawer--wide' : ''}`,
    h(
      'div.drawer__head',
      h(
        'div',
        { style: { minWidth: '0', flex: '1' } },
        h('div.drawer__title', title || ''),
        subtitle ? h('div.sm.dim', subtitle) : null
      ),
      h('button.btn.btn--icon.btn--quiet', { type: 'button', 'aria-label': '关闭', onclick: () => finish() }, icon('close'))
    ),
    bodyEl,
    footer ? h('div.drawer__foot', footer) : null
  )
  const finish = openDialog({ node: dlg, onClose })
  return { close: finish, body: bodyEl, node: dlg }
}

/* ============================================================
   声明式表单
   ============================================================ */

function fieldShell(f, control) {
  const errEl = h('div.err', { hidden: true })
  const el = h(
    `div.field${f.width === 'half' ? '' : '.field--full'}`,
    f.label
      ? h(
          'label.lbl',
          { for: control.id },
          f.label,
          f.required ? h('span.req', '*') : null,
          f.suffix ? h('span.dim.tiny', `（${f.suffix}）`) : null
        )
      : null,
    control,
    f.hint ? h('div.hint', f.hint) : null,
    errEl
  )
  return { el, errEl }
}

function buildControl(f, initial) {
  const id = uid('f')
  const common = {
    id,
    name: f.name,
    placeholder: f.placeholder || '',
    disabled: Boolean(f.disabled),
    autocomplete: f.autocomplete || 'off',
  }

  if (f.type === 'textarea') {
    const ta = h('textarea.ta', { ...common, rows: f.rows || 3, maxlength: f.maxlength || 4000 })
    ta.value = initial ?? ''
    return { control: ta, read: () => ta.value, focus: () => ta.focus() }
  }

  if (f.type === 'select') {
    const sel = h('select.sel', common)
    const wanted = initial === null || initial === undefined ? '' : String(initial)
    let matched = false
    for (const opt of f.options || []) {
      const o = h('option', { value: opt.value }, opt.label)
      if (String(opt.value) === wanted) {
        o.selected = true
        matched = true
      }
      sel.appendChild(o)
    }
    // 原值不在选项里（分类被删了、游戏归档了……）时补一个占位项并选中它。
    // 不补的话浏览器默认选中第一项，一保存就把这条记录的外键悄悄改掉了。
    if (!matched) {
      sel.insertBefore(h('option', { value: wanted }, wanted ? `（原值：${wanted}）` : '（未指定）'), sel.firstChild)
      sel.value = wanted
    }
    return { control: sel, read: () => sel.value, focus: () => sel.focus() }
  }

  if (f.type === 'check') {
    const cb = h('input.chk', { ...common, type: 'checkbox' })
    cb.checked = Boolean(initial)
    const wrap = h('label.inline', { for: id, style: { cursor: 'pointer' } }, cb, h('span', f.checkLabel || f.label || ''))
    return { control: wrap, read: () => cb.checked, focus: () => cb.focus(), bare: true }
  }

  if (f.type === 'tags') {
    const inp = h('input.inp', { ...common, placeholder: f.placeholder || '用逗号分隔，例如：爽快, 老客户' })
    inp.value = Array.isArray(initial) ? initial.join(', ') : initial || ''
    return {
      control: inp,
      read: () =>
        String(inp.value)
          .split(/[,，\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      focus: () => inp.focus(),
    }
  }

  const types = { number: 'text', money: 'text', date: 'date', password: 'password', text: 'text' }
  const inp = h('input.inp', {
    ...common,
    type: types[f.type] || 'text',
    inputmode: f.type === 'money' || f.type === 'number' ? 'decimal' : f.inputmode || undefined,
    maxlength: f.maxlength || 300,
  })
  if (f.type === 'money' || f.type === 'number') inp.classList.add('inp--fig')
  inp.value = initial === null || initial === undefined ? '' : String(initial)
  if (f.type === 'money') inp.addEventListener('blur', () => { if (inp.value !== '') inp.value = String(Math.round((Number(inp.value) || 0) * 100) / 100) })
  return {
    control: inp,
    read: () => {
      if (f.type === 'money' || f.type === 'number') {
        if (inp.value.trim() === '') return f.type === 'money' ? 0 : ''
        return Number(inp.value)
      }
      return inp.value
    },
    focus: () => inp.focus(),
  }
}

/** 拼出一个完整字段：壳 + 控件 + 错误位。抽屉和整页表单共用。 */
export function makeField(f, initial) {
  const { control, read, focus, bare } = buildControl(f, initial)
  if (bare) {
    return { el: h('div.field.field--full', control), read, focus, control, errEl: h('div.err', { hidden: true }) }
  }
  const { el, errEl } = fieldShell(f, control)
  if (f.width !== 'half') el.classList.add('field--full')
  return { el, read, focus, control, errEl }
}

/**
 * 抽屉里的表单。返回 Promise：
 * 提交成功 resolve(值)，取消 resolve(null)，服务端报错就留在原地把错误显示出来。
 */
export function formDrawer({
  title,
  subtitle,
  fields,
  values = {},
  submitLabel = '保存',
  intro = null,
  footerNote = null,
  wide = false,
  onSubmit,
}) {
  return new Promise((resolve) => {
    let settled = false
    const built = []

    const grid = h('div.formgrid')
    for (const f of fields) {
      if (f.type === 'section') {
        grid.appendChild(
          h(
            'div.formsec.field--full',
            h('div.sechead', { style: { marginBottom: '0' } }, h('h3', f.title), f.note ? h('span.sechead__note', f.note) : null)
          )
        )
        continue
      }
      if (f.type === 'note') {
        grid.appendChild(h(`div.note${f.tone ? `.note--${f.tone}` : ''}.field--full`, f.text))
        continue
      }
      if (f.type === 'custom') {
        const node = f.render(values)
        if (f.width !== 'half') node.classList.add('field--full')
        grid.appendChild(node)
        // 自定义块可以自己往提交结果里塞值（比如并排的两个输入框）
        if (f.collect) built.push({ f, custom: true, collect: f.collect })
        continue
      }
      const initial = f.name in values ? values[f.name] : f.default
      const built1 = makeField(f, initial)
      grid.appendChild(built1.el)
      built.push({ f, read: built1.read, el: built1.el, errEl: built1.errEl, focus: built1.focus, control: built1.control })
    }

    const errBox = h('div.note.note--alert', { hidden: true })
    const bodyWrap = h('div.stack', intro, grid, footerNote ? h('div.hint', footerNote) : null, errBox)

    const formId = uid('form')
    const form = h('form', { id: formId, novalidate: true, onsubmit: handleSubmit }, bodyWrap)

    // 提交按钮在抽屉的粘性页脚里，靠 form 属性挂回上面的表单，走原生 submit
    const submitBtn = h('button.btn.btn--primary', { type: 'submit', form: formId }, submitLabel)

    const d = drawer({
      title,
      subtitle,
      body: form,
      footer: [h('button.btn', { type: 'button', onclick: () => finish(null) }, '取消'), h('div', { style: { flex: '1' } }), submitBtn],
      wide,
      onClose: () => finish(null),
    })

    function finish(value) {
      if (settled) return
      settled = true
      d.close()
      resolve(value)
    }

    async function handleSubmit(e) {
      e.preventDefault()
      let firstBad = null
      const out = {}
      let customErr = ''
      for (const b of built) {
        if (b.custom) {
          // 自定义块可以返回一句错误来拦住提交（比如「还没选分类」）
          const msg = b.collect(out)
          if (typeof msg === 'string' && msg && !customErr) customErr = msg
          continue
        }
        b.el.classList.remove('is-bad')
        b.errEl.hidden = true
        if (b.control && b.control.removeAttribute) b.control.removeAttribute('aria-invalid')
        const v = b.read()
        if (b.f.required) {
          const empty = v === '' || v === null || v === undefined || (Array.isArray(v) && !v.length)
          if (empty) {
            b.errEl.textContent = `请填写${b.f.label || '这一项'}`
            b.errEl.hidden = false
            if (b.control && b.control.setAttribute) b.control.setAttribute('aria-invalid', 'true')
            if (!firstBad) firstBad = b
            continue
          }
        }
        if ((b.f.type === 'number' || b.f.type === 'money') && v !== '' && !Number.isFinite(Number(v))) {
          b.errEl.textContent = '请填数字'
          b.errEl.hidden = false
          if (!firstBad) firstBad = b
          continue
        }
        out[b.f.name] = v
      }
      // 自定义块报的错（比如「还没选大类」）优先于服务端错误显示
      if (customErr) {
        errBox.textContent = customErr
        errBox.hidden = false
        errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        return
      }
      if (firstBad) {
        if (firstBad.focus) firstBad.focus()
        return
      }

      errBox.hidden = true
      submitBtn.setAttribute('data-loading', '1')
      submitBtn.disabled = true
      try {
        const result = await onSubmit(out)
        finish(result === undefined ? out : result)
      } catch (err) {
        errBox.textContent = err && err.message ? err.message : '保存失败'
        errBox.hidden = false
        errBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      } finally {
        submitBtn.removeAttribute('data-loading')
        submitBtn.disabled = false
      }
    }

    setTimeout(() => {
      const first = built.find((b) => !b.f.disabled && b.f.type !== 'check' && b.focus)
      if (first) first.focus()
    }, 60)
  })
}

/* ============================================================
   空态
   ============================================================ */

export function emptyState({ iconName = 'plus', title, body, steps, actionLabel, onAction, secondary }) {
  return h(
    'div.empty',
    h('div.empty__mark', icon(iconName, 20)),
    h('div.empty__title', title),
    body ? h('p.empty__body', body) : null,
    steps && steps.length
      ? h(
          'ul.empty__steps',
          steps.map((s, i) => h('li', h('span.n', String(i + 1)), h('span', s)))
        )
      : null,
    actionLabel || secondary
      ? h(
          'div.cluster',
          actionLabel ? h('button.btn.btn--primary', { type: 'button', onclick: onAction }, actionLabel) : null,
          secondary || null
        )
      : null
  )
}

export function skeletonRows(n = 5) {
  return h(
    'div',
    Array.from({ length: n }, () => h('div.skel.skel--row'))
  )
}

/* ============================================================
   账簿表格
   ============================================================ */

/**
 * columns: [{ key, label, num, main, width, render(row), cls }]
 * 手机上每一行折成一张卡片，td 用 data-label 显示列名。
 */
export function table({ columns, rows, onRowClick, stack = true, footer = null, compact = false }) {
  const thead = h(
    'thead',
    h(
      'tr',
      columns.map((c) => h(`th${c.num ? '.num' : ''}`, { style: c.width ? { width: c.width } : null }, c.label))
    )
  )

  const tbody = h('tbody')
  rows.forEach((row, idx) => {
    const tr = h('tr', {
      'data-clickable': onRowClick ? '1' : null,
      tabindex: onRowClick ? '0' : null,
      onclick: onRowClick ? (e) => { if (!e.target.closest('button,a')) onRowClick(row) } : null,
      onkeydown: onRowClick
        ? (e) => {
            if (e.key === 'Enter' && !e.target.closest('button,a')) onRowClick(row)
          }
        : null,
    })
    columns.forEach((c, ci) => {
      const content = c.render ? c.render(row, idx) : row[c.key]
      const isMain = c.main || ci === 0
      tr.appendChild(
        h(
          `td${c.num ? '.num' : ''}${isMain ? '.td-main' : ''}${c.cls ? '.' + c.cls : ''}`,
          { 'data-label': c.num ? c.label : isMain ? '' : c.label },
          content
        )
      )
    })
    tbody.appendChild(tr)
  })

  return h(
    `div.tblwrap${stack ? '.tblwrap--stack' : ''}`,
    h(`table.tbl${stack ? '.tbl--stack' : ''}${compact ? '.tbl--compact' : ''}`, thead, tbody, footer)
  )
}

/* ============================================================
   状态灯与状态轨
   ============================================================ */

export function lamp(label, tone = 'muted') {
  return h(`span.lamp.lamp--${tone}`, label)
}

export function orderLamp(status, label) {
  return lamp(label || status, STATUS_TONE[status] || 'muted')
}

export function tag(text, tone = '') {
  return h(`span.tag${tone ? `.tag--${tone}` : ''}`, text)
}

/** 订单走的五步轨；售后/取消单独用灯表示 */
export function orderTrack(status, statusLabel) {
  if (status === 'cancelled' || status === 'after_sale') {
    return h('div.cluster', orderLamp(status, statusLabel), h('span.dim.tiny', '已离开主流程'))
  }
  const at = STATUS_FLOW.indexOf(status)
  const labels = { pending_confirm: '待确认', pending_pay: '待付款', in_progress: '进行中', pending_accept: '待验收', done: '已完成' }
  const out = []
  STATUS_FLOW.forEach((s, i) => {
    if (i > 0) out.push(h('span.track__sep'))
    const state = i < at ? '--done' : i === at ? '--now' : ''
    out.push(h(`div.track__step${state ? '.track__step' + state : ''}`, labels[s]))
  })
  return h('div.track', out)
}

/* ============================================================
   小件
   ============================================================ */

export function kv(pairs) {
  const dl = h('dl.kv')
  for (const [k, v] of pairs) {
    if (v === null || v === undefined || v === '') continue
    dl.appendChild(h('dt', k))
    dl.appendChild(h('dd', v))
  }
  return dl
}

export function sectionHead(title, note, actions) {
  return h('div.sechead', h('h3', title), note ? h('span.sechead__note', note) : null, actions || null)
}

export function copyButton(text, label = '复制', { size = 'sm', onCopied } = {}) {
  return h(
    `button.btn.btn--sm${size === 'icon' ? '.btn--icon' : ''}`,
    {
      type: 'button',
      title: label,
      onclick: async (e) => {
        e.stopPropagation()
        const ok = await copyText(text)
        toast(ok ? '已复制' : '复制失败，请手动选中', ok ? 'ok' : 'err', 1600)
        if (ok && onCopied) onCopied()
      },
    },
    size === 'icon' ? icon('copy', 15) : icon('copy', 15),
    size === 'icon' ? null : label
  )
}

/** 金额显示：正数是墨色，负数（退款）走丹色 */
export function moneyEl(n, { strong = false, tone = null } = {}) {
  const v = Number(n) || 0
  const t = tone || (v < 0 ? 'oxblood' : null)
  return h(
    `span.num${strong ? '.strong' : ''}${t ? '.tone-' + t : ''}`,
    `${v < 0 ? '−' : ''}${fmtMoney(Math.abs(v))}`
  )
}

export function qtyText(qty, unit) {
  return `${fmtQty(qty)}${unit ? ' ' + unit : ''}`
}

/** 一行"标签 + 值"，给详情页用 */
export function defRow(label, value) {
  return h('div.cluster', { style: { gap: '6px' } }, h('span.dim.sm', label), value)
}
