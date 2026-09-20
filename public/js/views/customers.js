/* ============================================================
   客户管理
   手机号是主标识，方便直接搜。
   ============================================================ */

import { api, PAY_METHOD_LABEL, PAY_KIND_LABEL, LOGIN_TYPE_LABEL, STATUS_TONE } from '../api.js'
import { h, icon, fmtMoney, fmtDate, fmtDay, fmtDateTime, debounce, todayStr, remainInfo } from '../dom.js'
import {
  table,
  toast,
  toastErr,
  drawer,
  formDrawer,
  modal,
  emptyState,
  tag,
  lamp,
  sectionHead,
  copyButton,
} from '../ui.js'
import { customerForm } from './orders.js'
import { openComposer } from './orders.js'
import { paymentDrawer } from './orderbits.js'

/** 「归档还是真删」二选一。返回 'archive' | 'delete' | null */
function choiceDialog({ title, message, archiveLabel, archiveHint, deleteLabel, deleteHint }) {
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    const actions = [{ label: '取消', onClick: () => finish(null) }]
    // 注意：这里不能 return false —— 在 modal() 里 false 表示「别关窗」，而这里点完是要关掉的
    if (archiveLabel) actions.push({ label: archiveLabel, onClick: () => finish('archive') })
    actions.push({ label: deleteLabel, tone: 'danger', onClick: () => finish('delete') })
    modal({
      title,
      wide: true,
      body: h(
        'div.stack.stack--tight',
        h('p', { style: { lineHeight: '1.75' } }, message),
        archiveLabel && archiveHint ? h('div.note.note--ok', h('strong', `${archiveLabel}：`), h('span', archiveHint)) : null,
        deleteHint ? h('div.note.note--alert', h('strong', `${deleteLabel}：`), h('span', deleteHint)) : null
      ),
      actions,
      onClose: () => finish(null),
    })
  })
}

/** 处理一位客户：归档，或者彻底删除 */
async function removeCustomer(ctx, c) {
  let p = null
  try {
    p = await api.get(`/api/customers/${c.id}/profile`)
  } catch {
    /* 拿不到档案也照样让他处理 */
  }
  const orders = p?.summary?.order_count ?? 0
  const creds = p?.credentials?.length ?? 0
  const quotes = p?.quotes?.length ?? 0
  const busy = orders + creds + quotes > 0

  const choice = await choiceDialog({
    title: `处理客户「${c.name}」`,
    message: busy
      ? `这位客户名下有 ${orders} 张订单、${creds} 条登录凭证、${quotes} 份报价单。`
      : '这位客户名下还没有订单、凭证和报价单。',
    archiveLabel: busy ? '归档客户' : null,
    archiveHint: '先从这个列表里收起来。订单、凭证、报价单全部原地不动，随时可以用上面的「已归档」找回来。',
    deleteLabel: busy ? '彻底删除（连带凭证）' : '彻底删除',
    deleteHint: creds
      ? `这位客户存着 ${creds} 条登录凭证（游戏账号密码），彻底删除会把这 ${creds} 条一起删掉，删了就找不回来。` +
        (orders ? `另外 ${orders} 张订单会失去客户关联 —— 单号、服务内容、冻结的客户名和收款记录都还在。` : '')
      : orders
        ? `${orders} 张订单会失去客户关联，但单号、服务内容、冻结的客户名和收款记录都还在。`
        : '直接删掉，不影响任何其它数据。',
  })
  if (!choice) return
  try {
    if (choice === 'archive') {
      await api.patch(`/api/customers/${c.id}`, { status: 'archived' })
      toast(`客户「${c.name}」已归档`, 'ok')
      ctx.navigate('/customers')
    } else {
      await api.del(`/api/customers/${c.id}`, { hard: '1' })
      toast(`客户「${c.name}」已彻底删除`, 'ok')
      ctx.navigate('/customers')
    }
  } catch (err) {
    toastErr(err)
  }
}

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

/** 在做 / 已结束 的一张订单行 */
function orderLine(ctx, o) {
  const done = ['done', 'cancelled'].includes(o.status)
  const info = done ? { kind: 'ok', text: '' } : remainInfo(o.ordered_at, o.due_at)
  const due = Number(o.due_total) || 0
  return h(
    'button.item',
    { type: 'button', onclick: () => ctx.navigate(`/orders/${o.id}`) },
    h(
      'div.item__main',
      h(
        'div.item__title',
        o.order_no,
        lamp(o.status_label, STATUS_TONE[o.status] || 'muted'),
        !done && info.text ? h(`span.duepill.duepill--${info.kind}`, info.text) : null
      ),
      h(
        'div.item__meta',
        h('span', o.title || '没写标题'),
        h('span', fmtDay(o.ordered_at)),
        o.due_at ? h('span', `交付 ${fmtDay(o.due_at)}`) : null
      )
    ),
    h(
      'div.item__right',
      h('div.item__fig', `¥${fmtMoney(o.total)}`),
      h('div.tbl__meta', due > 0.001 ? h('span.tone-amber', `未收 ¥${fmtMoney(due)}`) : h('span.dim', '已结清'))
    )
  )
}

/**
 * 客户名下的订单。
 * 客户会反复下单，单多了不能一股脑铺开 —— 先列在做的，已结束的收在后面，
 * 各自封顶，剩下的给个「还有 N 张」。
 */
function customerOrders(ctx, c, orders) {
  const active = orders.filter((o) => !['done', 'cancelled'].includes(o.status))
  const closed = orders.filter((o) => ['done', 'cancelled'].includes(o.status))
  const ACTIVE_MAX = 6
  const CLOSED_MAX = 3
  const unpaid = active.filter((o) => Number(o.due_total) > 0.001).length

  const head = h(
    'div.custorder__sum',
    h('span', `在做 ${active.length}`),
    closed.length ? h('span.dim', `· 已结束 ${closed.length}`) : null,
    unpaid ? h('span.tone-amber', `· ${unpaid} 张没收齐`) : null
  )

  const body = h('div.itemlist')
  for (const o of active.slice(0, ACTIVE_MAX)) body.appendChild(orderLine(ctx, o))
  if (active.length > ACTIVE_MAX) {
    body.appendChild(
      h(
        'button.item.item--more',
        { type: 'button', onclick: () => ctx.navigate(`/orders?customer_id=${c.id}&status=open`) },
        h('span.sm', `还有 ${active.length - ACTIVE_MAX} 张在做的单`),
        icon('right', 13)
      )
    )
  }

  if (closed.length) {
    body.appendChild(h('div.custorder__sep', h('span.sm.dim', '已结束')))
    for (const o of closed.slice(0, CLOSED_MAX)) body.appendChild(orderLine(ctx, o))
    if (closed.length > CLOSED_MAX) {
      body.appendChild(
        h(
          'button.item.item--more',
          { type: 'button', onclick: () => ctx.navigate(`/orders?customer_id=${c.id}&status=`) },
          h('span.sm', `还有 ${closed.length - CLOSED_MAX} 张已结束的单`),
          icon('right', 13)
        )
      )
    }
  }

  return h('div', head, body)
}

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
    // 归档过的客户给一条恢复的路，否则归档就成了单向操作
    c.status === 'archived'
      ? h('button.btn.btn--sm', { type: 'button', onclick: async () => {
          try {
            await api.patch(`/api/customers/${c.id}`, { status: 'active' })
            toast(`客户「${c.name}」已恢复`, 'ok')
            ctx.app.reload()
          } catch (err) {
            toastErr(err)
          }
        } }, icon('refresh', 14), '恢复')
      : null,
    h('button.btn.btn--sm.btn--quiet', { type: 'button', title: '归档或彻底删除这位客户', onclick: () => removeCustomer(ctx, c) }, icon('trash', 14)),
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
          h(
            'div.panel__body',
            sectionHead(
              '订单',
              `${p.orders.length} 张`,
              p.orders.length
                ? h('button.btn.btn--sm', { type: 'button', onclick: () => ctx.navigate(`/orders?customer_id=${c.id}&status=`) }, '看全部')
                : null
            )
          ),
          p.orders.length
            ? customerOrders(ctx, c, p.orders)
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
    // 归档的客户默认收起来，不然「归档」看起来跟没删一样
    const archivedCount = items.filter((c) => c.status === 'archived').length
    if (only === 'archived') filtered = filtered.filter((c) => c.status === 'archived')
    else filtered = filtered.filter((c) => c.status !== 'archived')
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
        // 只有真的归档过客户，才把这个入口露出来
        ...(archivedCount ? [{ key: 'archived', label: `已归档 ${archivedCount}` }] : []),
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
