/* ============================================================
   订单共用件：记账进度、记收款、列表与状态轨
   看板和订单页共用同一套，保证两处表现一致。
   ============================================================ */

import { api, PAY_METHOD_LABEL, PAY_KIND_LABEL, STATUS_TONE } from '../api.js'
import { h, icon, fmtMoney, fmtDate, fmtDay, todayStr, fmtQty, remainInfo } from '../dom.js'
import { formDrawer, table, toast, toastErr, lamp, tag, orderTrack, copyButton, confirmDelete, emptyState } from '../ui.js'

/* ---------------- 记进度 ---------------- */

/** 资源对比：两个并排输入，提交时自己塞进结果 */
function resourcesField({ before = '', after = '' } = {}) {
  let read = () => ({ resources_before: '', resources_after: '' })
  return {
    type: 'custom',
    width: 'full',
    render: () => {
      const b = h('input.inp', { placeholder: '原石 12000 / 树脂 160', 'aria-label': '做之前的资源' })
      const a = h('input.inp', { placeholder: '原石 12400 / 树脂 40', 'aria-label': '做之后的资源' })
      b.value = before
      a.value = after
      read = () => ({ resources_before: b.value.trim(), resources_after: a.value.trim() })
      return h(
        'div.row-2',
        h('div.field.field--full', h('label.lbl', '资源对比 · 做之前'), b),
        h('div.field.field--full', h('label.lbl', '资源对比 · 做之后'), a)
      )
    },
    collect: (out) => Object.assign(out, read()),
  }
}

export function progressDrawer(order, onDone) {
  return formDrawer({
    title: '记一条进度',
    subtitle: `${order.order_no} · ${order.title || ''}`,
    submitLabel: '记下',
    intro: h('div.hint', '以后客户问"做到哪了"，直接把这条发给他就行。'),
    fields: [
      { name: 'happened_on', label: '日期', type: 'date', required: true, default: todayStr(), width: 'half' },
      resourcesField(),
      { name: 'content', label: '这次做了什么', type: 'textarea', required: true, rows: 4, placeholder: '例：清完今日委托 + 派遣，深渊打到第 7 层' },
      { name: 'media', label: '截图 / 录屏链接', type: 'tags', hint: '把图床或相册链接粘进来，多个用逗号分隔。也可以先在别处截好图再贴链接。' },
      { name: 'note', label: '备注', type: 'textarea', rows: 2, placeholder: '例：第 7 层差一颗星，明天补' },
    ],
    onSubmit: async (v) => {
      await api.post(`/api/orders/${order.id}/progress`, v)
      toast('进度记下了', 'ok')
      onDone()
    },
  })
}

/* ---------------- 记收款 ---------------- */

export function paymentDrawer(order, onDone, { presetKind } = {}) {
  const due = Number(order.due_total) || 0
  const paid = Number(order.paid_total) || 0
  // 还没收过钱 → 默认「全款」（一次付清最常见）；已经收过一部分 → 默认「尾款」
  const kind = presetKind || (paid > 0.001 ? 'balance' : 'full')
  return formDrawer({
    title: '记一笔收款',
    subtitle: `${order.order_no} · 应收 ${fmtMoney(order.total)} 元，还差 ${fmtMoney(due)} 元`,
    submitLabel: '记下',
    fields: [
      {
        name: 'amount',
        label: '金额',
        type: 'money',
        required: true,
        default: due > 0 ? due : Number(order.total) || 0,
        suffix: '元',
        width: 'half',
      },
      {
        name: 'kind',
        label: '类型',
        type: 'select',
        default: kind,
        width: 'half',
        options: [
          { value: 'deposit', label: '定金' },
          { value: 'full', label: '全款' },
          { value: 'balance', label: '尾款' },
          { value: 'refund', label: '退款' },
        ],
      },
      {
        name: 'method',
        label: '收款方式',
        type: 'select',
        default: 'wechat',
        width: 'half',
        options: Object.entries(PAY_METHOD_LABEL).map(([value, label]) => ({ value, label })),
      },
      { name: 'paid_at', label: '日期', type: 'date', default: todayStr(), width: 'half' },
      { name: 'note', label: '备注', type: 'text', placeholder: '例：微信转账，客户说月底结清' },
    ],
    onSubmit: async (v) => {
      const r = await api.post('/api/payments', { ...v, order_id: order.id })
      if (r.advanced_to) toast('款已收齐，订单自动推进到「进行中」', 'ok', 3200)
      else toast('收款记下了', 'ok')
      onDone()
    },
  })
}

/* ---------------- 改状态 ---------------- */

export function statusDrawer(order, onDone) {
  const nexts = order.next_statuses || []
  if (!nexts.length) {
    toast('这个状态没有下一步了', 'err')
    return Promise.resolve()
  }
  const LABEL = {
    pending_confirm: '待确认',
    pending_pay: '待付款',
    in_progress: '进行中',
    pending_accept: '待验收',
    done: '已完成',
    after_sale: '售后',
    cancelled: '已取消',
  }
  return formDrawer({
    title: '推进状态',
    subtitle: `${order.order_no} · 现在是「${order.status_label}」`,
    submitLabel: '推进',
    fields: [
      {
        name: 'status',
        label: '改成',
        type: 'select',
        required: true,
        options: nexts.map((s) => ({ value: s, label: LABEL[s] || s })),
      },
      { name: 'note', label: '顺便记一句（会写进进度时间线）', type: 'text', placeholder: '例：做完了，等客户验收' },
    ],
    onSubmit: async (v) => {
      await api.post(`/api/orders/${order.id}/status`, v)
      toast('状态已更新', 'ok')
      onDone()
    },
  })
}

/* ---------------- 列表 ---------------- */

export function orderColumns({ showCustomer = true, ctx } = {}) {
  const cols = [
    {
      key: 'order_no',
      label: '订单',
      main: true,
      render: (o) =>
        h(
          'div',
          h(
            'div.tbl__primary',
            o.order_no,
            o.stale ? h('span.tag.tag--amber', { style: { marginLeft: '6px' } }, `${o.idle_days} 天没动`) : null
          ),
          h('div.tbl__meta', o.title || '（没写标题）')
        ),
    },
  ]
  if (showCustomer) {
    cols.push({
      key: 'customer_name',
      label: '客户',
      render: (o) => (o.customer_id ? h('span', o.customer_name || '—') : h('span.dim', '散客')),
    })
  }
  cols.push(
    { key: 'game_name', label: '游戏', cls: 'col-opt', render: (o) => h('span.sm', { style: { whiteSpace: 'nowrap' } }, o.game_name || '—') },
    {
      key: 'progress_count',
      label: '进度',
      cls: 'col-opt',
      render: (o) =>
        o.progress_count
          ? h('span.sm', `${o.progress_count} 条`, h('span.dim.tiny', ` · 到 ${fmtDay(o.last_progress_on)}`))
          : h('span.dim.sm', '还没记'),
    },
    { key: 'status', label: '状态', render: (o) => lamp(o.status_label, STATUS_TONE[o.status] || 'muted') },
    {
      key: 'due_at',
      label: '交付',
      cls: 'col-opt',
      render: (o) => {
        if (!o.due_at) return h('span.dim.sm', '—')
        // 已经做完/取消的单不用再催了，只显示日期
        const info = ['done', 'cancelled'].includes(o.status) ? { kind: 'ok', text: '' } : remainInfo(o.ordered_at, o.due_at)
        return h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' } },
          h('span.sm', fmtDay(o.due_at)),
          info.kind === 'invalid'
            ? h('span.duepill.duepill--bad', '填错了')
            : info.text
              ? h(`span.duepill.duepill--${info.kind}`, info.text)
              : null
        )
      },
    },
    { key: 'total', label: '总额', num: true, render: (o) => `¥${fmtMoney(o.total)}` },
    {
      key: 'due_total',
      label: '尾款',
      num: true,
      render: (o) =>
        o.due_total > 0.001 ? h('span.tone-amber', `¥${fmtMoney(o.due_total)}`) : h('span.dim', '已结清'),
    },
    {
      key: 'acts',
      label: '操作',
      cls: 'td-acts',
      render: (o) =>
        h(
          'div.tbl__acts',
          h(
            'button.btn.btn--sm',
            {
              type: 'button',
              title: '记进度',
              onclick: (e) => {
                e.stopPropagation()
                progressDrawer(o, () => ctx.app.reload())
              },
            },
            icon('edit', 14)
          ),
          o.due_total > 0.001
            ? h(
                'button.btn.btn--sm',
                {
                  type: 'button',
                  title: '记收款',
                  onclick: (e) => {
                    e.stopPropagation()
                    paymentDrawer(o, () => ctx.app.reload())
                  },
                },
                icon('wallet', 14)
              )
            : null,
          h(
            'button.btn.btn--sm',
            {
              type: 'button',
              title: '看详情',
              onclick: (e) => {
                e.stopPropagation()
                ctx.navigate(`/orders/${o.id}`)
              },
            },
            icon('right', 14)
          )
        ),
    }
  )
  return cols
}

export function orderTable(rows, ctx, opts = {}) {
  return table({
    columns: orderColumns({ ...opts, ctx }),
    rows,
    onRowClick: (o) => ctx.navigate(`/orders/${o.id}`),
  })
}

/* ---------------- 详情里的一段 ---------------- */

export function orderItemsList(items) {
  return h(
    'div.itemlist',
    items.map((it) =>
      h(
        'div.item',
        { style: { cursor: 'default', alignItems: 'flex-start' } },
        h(
          'div.item__main',
          h(
            'div.item__title',
            it.name,
            it.snapshot?.price_overridden ? tag('改过价', 'cinnabar') : null,
            it.snapshot?.matched_tier ? tag('阶梯价', 'slate') : null
          ),
          it.spec ? h('div.tbl__meta', it.spec) : null,
          it.snapshot?.package_items?.length
            ? h(
                'div.subitems',
                h('div.subitem', h('span.subitem__k', '套餐含'), h('span', it.snapshot.package_items.join(' · ')))
              )
            : null,
          it.snapshot?.addons?.length
            ? h(
                'div.subitems',
                h(
                  'div.subitem',
                  h('span.subitem__k', '增项'),
                  h(
                    'span',
                    it.snapshot.addons
                      .map((a) => `${a.name}${a.price_mode === 'percent' ? ` +${a.price}%` : ` +${fmtMoney(a.price)}元`}`)
                      .join(' · ')
                  )
                )
              )
            : null
        ),
        h(
          'div.item__right',
          h(
            'div.item__fig',
            `${fmtMoney(it.unit_price)}`,
            h('span.dim', ` × ${fmtQty(it.quantity)}${it.unit_label || ''}`)
          ),
          h('div.tbl__meta', `= ${fmtMoney(it.amount)} 元`)
        )
      )
    )
  )
}

export function progressTimeline(list, { onEdit, onDelete } = {}) {
  if (!list.length) {
    return h('div.empty', h('div.empty__mark', icon('clock', 20)), h('div.empty__title', '还没有进度记录'), h('p.empty__body', '每做一段就记一条，客户问起来直接发，自己回头看也清楚。'))
  }
  return h(
    'div.timeline',
    list.map((p) =>
      h(
        'div.tl',
        h('div.tl__rail', h('div.tl__dot')),
        h(
          'div.tl__body',
          h(
            'div.tl__head',
            h('span.tl__date', fmtDay(p.happened_on)),
            p.resources_before || p.resources_after
              ? h(
                  'span.tl__res',
                  p.resources_before ? h('span', p.resources_before) : null,
                  h('span.dim', '→'),
                  p.resources_after ? h('span', p.resources_after) : null
                )
              : null,
            h('div', { style: { flex: '1' } }),
            onEdit
              ? h('button.btn.btn--sm.btn--quiet', { type: 'button', title: '编辑', onclick: () => onEdit(p) }, icon('edit', 13))
              : null,
            onDelete
              ? h('button.btn.btn--sm.btn--quiet', { type: 'button', title: '删除', onclick: () => onDelete(p) }, icon('trash', 13))
              : null
          ),
          h('div.tl__content', p.content),
          p.media && p.media.length
            ? h(
                'div.tl__shots',
                p.media.map((m) =>
                  /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(m)
                    ? h('a', { href: m, target: '_blank', rel: 'noreferrer noopener' }, h('img.shot', { src: m, alt: '进度截图', loading: 'lazy' }))
                    : h('a.shot-link', { href: m, target: '_blank', rel: 'noreferrer noopener' }, icon('link', 12), '截图')
                )
              )
            : null,
          p.note ? h('div.tbl__meta', p.note) : null
        )
      )
    )
  )
}

export function editProgressDrawer(p, onDone) {
  return formDrawer({
    title: '改这条进度',
    submitLabel: '保存',
    fields: [
      { name: 'happened_on', label: '日期', type: 'date', required: true, width: 'half', default: p.happened_on },
      resourcesField({ before: p.resources_before, after: p.resources_after }),
      { name: 'content', label: '这次做了什么', type: 'textarea', required: true, rows: 4, default: p.content },
      { name: 'media', label: '截图链接', type: 'tags', default: p.media || [] },
      { name: 'note', label: '备注', type: 'textarea', rows: 2, default: p.note },
    ],
    onSubmit: async (v) => {
      await api.patch(`/api/progress/${p.id}`, v)
      toast('已更新', 'ok')
      onDone()
    },
  })
}
