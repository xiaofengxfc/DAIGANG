/* ============================================================
   客户管理
   手机号是主标识，方便直接搜。
   ============================================================ */

import { api, PAY_METHOD_LABEL, PAY_KIND_LABEL, LOGIN_TYPE_LABEL, STATUS_TONE } from '../api.js'
import { h, icon, fmtMoney, fmtDate, fmtDay, fmtDateTime, debounce, todayStr } from '../dom.js'
import {
  table,
  toast,
  toastErr,
  drawer,
  formDrawer,
  confirmDelete,
  emptyState,
  tag,
  lamp,
  sectionHead,
  copyButton,
} from '../ui.js'
import { customerForm } from './orders.js'
import { openComposer } from './orders.js'
import { paymentDrawer } from './orderbits.js'

function customerRow(c, ctx) {
  return h(
    'button.item',
    { type: 'button', onclick: () => ctx.navigate(`/customers/${c.id}`) },
    h('div.avatar', (c.name || '?').slice(0, 1)),
    h(
      'div.item__main',
      h(
        'div.item__title',
        c.name,
        c.status === 'archived' ? tag('已归档', 'oxblood') : null,
        ...(c.tags || []).slice(0, 3).map((t) => tag(t))
      ),
      h(
        'div.item__meta',
        c.phone ? h('span.mono', c.phone) : h('span.dim', '没填手机号'),
        c.wechat ? h('span', `微信 ${c.wechat}`) : null,
        c.qq ? h('span', `QQ ${c.qq}`) : null,
        c.source ? h('span', c.source) : null
      )
    ),
    h(
      'div.item__right',
      h('div.item__fig', `${c.order_count} 单`),
      h(
        'div.tbl__meta',
        c.due_total > 0.001 ? h('span.tone-amber', `未收 ¥${fmtMoney(c.due_total)}`) : h('span.dim', `累计 ¥${fmtMoney(c.order_total)}`)
      )
    )
  )
}

/* ---------------- 客户档案 ---------------- */

export async function renderCustomerDetail(ctx, id) {
  const p = await api.get(`/api/customers/${id}/profile`)
  const c = p.customer
  const s = p.summary

  ctx.setActions(
    h('button.btn.btn--sm.btn--primary', { type: 'button', onclick: () => openComposer(ctx, { presetCustomer: c.id }) }, icon('plus', 14), '给 TA 开单'),
    h('button.btn.btn--sm', { type: 'button', onclick: async () => {
      const saved = await customerForm(c, { title: '改客户资料' })
      if (saved) ctx.app.reload()
    } }, icon('edit', 14), '改资料'),
    h('button.btn.btn--sm.btn--quiet', { type: 'button', onclick: () => ctx.navigate('/customers') }, '返回列表')
  )

  const contact = h(
    'div.stack.stack--tight',
    h(
      'div.kv',
      ...[
        ['手机号', c.phone ? h('span.cluster', h('span.mono', c.phone), copyButton(c.phone, '复制', { size: 'icon' })) : h('span.dim', '没填')],
        ['微信', c.wechat ? h('span.cluster', h('span.mono', c.wechat), copyButton(c.wechat, '复制', { size: 'icon' })) : h('span.dim', '没填')],
        ['QQ', c.qq ? h('span.mono', c.qq) : h('span.dim', '没填')],
        ['来源', c.source || '—'],
        ['建档', fmtDate(c.created_at)],
      ].flatMap(([k, v]) => [h('dt', k), h('dd', v)])
    ),
    c.tags?.length ? h('div.cluster', c.tags.map((t) => tag(t))) : null,
    c.note ? h('div.note', c.note) : null
  )

  const money = h(
    'div',
    { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px' } },
    h('span.dim', '累计订单额'),
    h('span.num', `¥${fmtMoney(s.order_total)}`),
    h('span.dim.tone-jade', '已收'),
    h('span.num.tone-jade', `¥${fmtMoney(s.paid_total)}`),
    h('span.dim', s.due_total > 0.001 ? '还欠' : '尾款'),
    h('span.num', s.due_total > 0.001 ? h('span.tone-amber', `¥${fmtMoney(s.due_total)}`) : '0'),
    h('span.dim', '在做的单'),
    h('span.num', String(s.active_orders))
  )

  /* 凭证区：只露脱敏提示，明细要去保险箱 */
  const credBlock = p.credentials.length
    ? h(
        'div.itemlist',
        p.credentials.map((cred) =>
          h(
            'div.item',
            { style: { cursor: 'default' } },
            h('div.item__main', h('div.item__title', cred.label || '未命名', h('span.tag', LOGIN_TYPE_LABEL[cred.login_type] || cred.login_type)), h('div.item__meta', h('span', cred.game_name || '未指定'), h('span', cred.server || ''), h('span.mono', cred.masked_hint))),
            h('button.btn.btn--sm', { type: 'button', onclick: () => ctx.navigate(`/vault?customer=${c.id}&c=${cred.id}`) }, '去保险箱')
          )
        )
      )
    : h('p.dim.sm', '这个客户还没有登记游戏登录凭证。')

  return h(
    'div.stack',
    h(
      'div.pagehead',
      h(
        'div.pagehead__txt',
        h('h1', c.name),
        h(
          'p.pagehead__sub',
          `${s.order_count} 张单 · 累计 ¥${fmtMoney(s.order_total)}${s.due_total > 0.001 ? ` · 还欠 ¥${fmtMoney(s.due_total)}` : ' · 已结清'}`
        )
      )
    ),
    h(
      'div.split',
      h(
        'div.stack',
        h(
          'section.panel',
          h('div.panel__body', sectionHead('订单', `${p.orders.length} 张`)),
          p.orders.length
            ? h(
                'div.itemlist',
                p.orders.map((o) =>
                  h(
                    'button.item',
                    { type: 'button', onclick: () => ctx.navigate(`/orders/${o.id}`) },
                    h(
                      'div.item__main',
                      h('div.item__title', o.order_no, lamp(o.status_label, STATUS_TONE[o.status] || 'muted')),
                      h('div.item__meta', h('span', o.title || ''), h('span', fmtDay(o.ordered_at)))
                    ),
                    h('div.item__right', h('div.item__fig', `¥${fmtMoney(o.total)}`))
                  )
                )
              )
            : h('div.panel__body', emptyState({ iconName: 'orders', title: '还没有单', body: '给这个客户开第一张单。', actionLabel: '开单', onAction: () => openComposer(ctx, { presetCustomer: c.id }) }))
        ),
        h(
          'section.panel',
          h('div.panel__body', sectionHead('收款流水', `${p.payments.length} 笔`)),
          p.payments.length
            ? h(
                'div.itemlist',
                p.payments.map((pay) =>
                  h(
                    'div.item',
                    { style: { cursor: 'default' } },
                    h(
                      'div.item__main',
                      h('div.item__title', PAY_KIND_LABEL[pay.kind] || pay.kind, tag(PAY_METHOD_LABEL[pay.method] || pay.method)),
                      h('div.item__meta', h('span', fmtDay(pay.paid_at)), h('span', pay.order_no || ''), pay.note ? h('span', pay.note) : null)
                    ),
                    h('div.item__right', h(`div.item__fig${pay.kind === 'refund' ? '.tone-oxblood' : '.tone-jade'}`, `${pay.kind === 'refund' ? '−' : '+'}¥${fmtMoney(pay.amount)}`))
                  )
                )
              )
            : h('div.panel__body', h('p.dim.sm', '还没有收款记录。'))
        )
      ),
      h(
        'div.stack',
        h('section.panel', h('div.panel__body', sectionHead('联系方式')), h('div.panel__body', { style: { paddingTop: '0' } }, contact)),
        h('section.panel', h('div.panel__body', sectionHead('账目')), h('div.panel__body', { style: { paddingTop: '0' } }, money)),
        h(
          'section.panel',
          h(
            'div.panel__body',
            sectionHead(
              '登录凭证',
              `${p.credentials.length} 条`,
              h('button.btn.btn--sm', { type: 'button', onclick: () => ctx.navigate(`/vault?customer=${c.id}`) }, '去保险箱')
            )
          ),
          h('div.panel__body', { style: { paddingTop: '0' } }, credBlock)
        )
      )
    )
  )
}

/* ---------------- 列表 ---------------- */

export default {
  title: '客户',
  async render(ctx) {
    if (ctx.sub) return renderCustomerDetail(ctx, ctx.sub)

    const q = ctx.query.get('q') || ''
    const only = ctx.query.get('only') || ''
    const { items } = await api.get('/api/customers', { limit: 500 })

    ctx.setActions(
      h('button.btn.btn--sm.btn--primary', { type: 'button', onclick: async () => {
        const saved = await customerForm()
        if (saved) {
          toast(`客户「${saved.name}」已建档`, 'ok')
          ctx.app.reload()
        }
      } }, icon('plus', 14), '新建客户')
    )

    if (!items.length) {
      return h(
        'section.panel',
        h(
          'div.panel__body',
          emptyState({
            iconName: 'customers',
            title: '还没有客户',
            body: '手机号作为客户标识，以后直接搜手机号就能找到人和他所有的单。',
            steps: ['点右上角「新建客户」，填昵称和手机号。', '微信号、QQ、来源都填上，以后找人不费劲。', '标签随手打：爽快、老客户、要发票……'],
            actionLabel: '建第一个客户',
            onAction: async () => {
              const saved = await customerForm()
              if (saved) ctx.app.reload()
            },
          })
        )
      )
    }

    let filtered = items
    if (q.trim()) {
      const t = q.trim().toLowerCase()
      filtered = filtered.filter((c) => `${c.name} ${c.phone} ${c.wechat} ${c.qq} ${c.note} ${c.source}`.toLowerCase().includes(t))
    }
    if (only === 'due') filtered = filtered.filter((c) => c.due_total > 0.001)
    if (only === 'repeat') filtered = filtered.filter((c) => c.order_count >= 2)

    const searchInput = h('input.inp', { type: 'search', placeholder: '搜昵称 / 手机号 / 微信 / QQ', value: q, style: { maxWidth: '280px' } })
    searchInput.addEventListener(
      'input',
      debounce(() => {
        const v = searchInput.value.trim()
        const p = new URLSearchParams()
        if (v) p.set('q', v)
        if (only) p.set('only', only)
        ctx.navigate(`/customers${p.toString() ? '?' + p.toString() : ''}`, { replace: true })
      }, 300)
    )

    const seg = h(
      'div.seg',
      [
        { key: '', label: '全部' },
        { key: 'due', label: '有欠款' },
        { key: 'repeat', label: '回头客' },
      ].map((f) =>
        h(
          'button.seg__btn',
          {
            type: 'button',
            'aria-pressed': String(f.key === only),
            onclick: () => {
              const p = new URLSearchParams()
              if (q) p.set('q', q)
              if (f.key) p.set('only', f.key)
              ctx.navigate(`/customers${p.toString() ? '?' + p.toString() : ''}`)
            },
          },
          f.label
        )
      )
    )

    return h(
      'div.stack',
      h(
        'div.pagehead',
        h(
          'div.pagehead__txt',
          h('h1', '客户'),
          h('p.pagehead__sub', `${filtered.length} 位${filtered.length !== items.length ? `（共 ${items.length} 位）` : ''}`)
        )
      ),
      h('div.toolbar', seg, h('div.toolbar__grow'), searchInput),
      h(
        'section.panel',
        filtered.length
          ? h('div.itemlist', filtered.map((c) => customerRow(c, ctx)))
          : h('div.panel__body', emptyState({ iconName: 'search', title: '没找到', body: '换个关键词试试，或者清空搜索。' }))
      )
    )
  },
}
