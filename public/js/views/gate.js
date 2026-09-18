/* ============================================================
   门口：首次初始化 + 登录
   ============================================================ */

import { api } from '../api.js'
import { h, icon } from '../dom.js'
import { makeField, toastErr } from '../ui.js'

function gateForm({ title, subtitle, note, fields, submitLabel, onSubmit, foot }) {
  const errBox = h('div.note.note--alert', { hidden: true })
  const built = fields.map((f) => ({ f, ...makeField(f, f.default) }))
  const btn = h('button.btn.btn--primary.btn--block', { type: 'submit' }, submitLabel)
  const form = h('form', { class: 'stack', novalidate: true, onsubmit: handle }, ...built.map((b) => b.el), errBox, btn)

  async function handle(e) {
    e.preventDefault()
    let bad = null
    const out = {}
    for (const b of built) {
      b.errEl.hidden = true
      if (b.control && b.control.removeAttribute) b.control.removeAttribute('aria-invalid')
      const v = b.read()
      if (b.f.required && (v === '' || v === null || v === undefined)) {
        b.errEl.textContent = `请填写${b.f.label || '这一项'}`
        b.errEl.hidden = false
        if (b.control && b.control.setAttribute) b.control.setAttribute('aria-invalid', 'true')
        if (!bad) bad = b
        continue
      }
      out[b.f.name] = v
    }
    if (bad) {
      if (bad.focus) bad.focus()
      return
    }
    errBox.hidden = true
    btn.setAttribute('data-loading', '1')
    btn.disabled = true
    try {
      await onSubmit(out)
    } catch (err) {
      errBox.textContent = err.message || '没能完成'
      errBox.hidden = false
    } finally {
      btn.removeAttribute('data-loading')
      btn.disabled = false
    }
  }

  setTimeout(() => built[0] && built[0].focus && built[0].focus(), 60)

  return h(
    'div.gate',
    h(
      'div.gate__card',
      h('div.cluster', h('div.gate__mark', '代'), h('span.dim.sm', '本机私有 · 数据不出这台电脑')),
      h('div', h('h1', title), subtitle ? h('p.muted', { style: { marginTop: '4px' } }, subtitle) : null),
      note || null,
      form,
      foot || null
    )
  )
}

/* ---------------- 登录 ---------------- */

export function renderGate({ onDone }) {
  return gateForm({
    title: '进帐桌',
    subtitle: '输入登录密码开始对账。',
    fields: [
      { name: 'password', label: '登录密码', type: 'password', required: true, autocomplete: 'current-password' },
    ],
    submitLabel: '进去',
    onSubmit: async (v) => {
      await api.post('/api/auth/login', { password: v.password })
      onDone()
    },
    foot: h('div.hint', '忘了密码的话：关掉启动窗口，删掉 data/console.db 里的 admin_hash 两行设置即可重设——但那会一并清掉保险箱配置。'),
  })
}

/* ---------------- 首次初始化 ---------------- */

export async function renderSetup({ onDone }) {
  const days = h('input.inp.inp--fig', { type: 'text', inputmode: 'numeric', value: '7' })
  void days

  return gateForm({
    title: '先把帐桌支起来',
    subtitle: '三步，一分钟之内能开始录价格。',
    note: h(
      'div.note',
      h('span', { style: { flex: 'none' } }, icon('shield', 16)),
      h(
        'span',
        '这个后台没有客户注册、没有商城。只有你一个人用，所有数据存在这台电脑的 data/ 目录里，随时可以整个备份走。'
      )
    ),
    fields: [
      { name: 'business_name', label: '店铺 / 招牌名', type: 'text', default: '我的代肝小铺', required: true, hint: '会出现在报价单和页面标题上' },
      { name: 'admin_name', label: '怎么称呼你', type: 'text', default: '老板', required: true, hint: '保险箱审计里记录的"操作人"就是你' },
      { name: 'password', label: '登录密码', type: 'password', required: true, autocomplete: 'new-password', hint: '至少 6 位。手机和电脑共用这一个。' },
      { name: 'confirm', label: '确认登录密码', type: 'password', required: true, autocomplete: 'new-password' },
      {
        name: 'vault_password',
        label: '保险箱密码（可以留空，之后再设）',
        type: 'password',
        autocomplete: 'new-password',
        hint: '专门用来加密游戏账号密码，和登录密码分开。忘了就解不开了，请记在密码管理器里。',
      },
    ],
    submitLabel: '建好，开始用',
    onSubmit: async (v) => {
      if (v.password !== v.confirm) throw new Error('两次输入的登录密码不一致')
      await api.post('/api/setup', {
        password: v.password,
        confirm: v.confirm,
        business_name: v.business_name,
        admin_name: v.admin_name,
        vault_password: v.vault_password,
      })
      onDone()
    },
    foot: h(
      'div.hint',
      '接下来建议的顺序：游戏 → 分类 → 服务项和价格 → 客户 → 开单。'
    ),
  })
}
