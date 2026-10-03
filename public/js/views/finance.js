/* ============================================================
   财务：应收、已收、退款、尾款、手续费、成本、利润
   简单直白：一张区间账单 + 每日柱 + 按方式/游戏分组 + 未结清清单
   ============================================================ */

import { api, PAY_METHOD_LABEL, STATUS_TONE } from '../../../client/lib/api.js'
import { h, icon, fmtMoney, fmtDay, todayStr, monthStart, fmtDate } from '../dom.js'
import { table, toast, toastErr, emptyState, lamp, tag, sectionHead } from '../ui.js'
import { paymentDrawer } from './orderbits.js'

function presetRange(key) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  if (key === 'thisMonth') return { from: `${y}-${String(m + 1).padStart(2, '0')}-01`, to: todayStr(), label: '本月' }
  if (key === 'lastMonth') {
    const d = new Date(y, m - 1, 1)
    const last = new Date(y, m, 0)
    return {
      from: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`,
      to: `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(last.getDate()).padStart(2, '0')}`,
      label: '上月',
    }
  }
  if (key === 'thisYear') return { from: `${y}-01-01`, to: todayStr(), label: '今年' }
  if (key === 'last30') {
    const d = new Date()
    d.setDate(d.getDate() - 29)
    return { from: fmtDate(d.toISOString()), to: todayStr(), label: '近 30 天' }
  }
  return { from: monthStart(), to: todayStr(), label: '本月' }
}

function bars(daily) {
  const list = daily.slice(-31)
  const max = Math.max(1, ...list.map((d) => Math.max(d.ordered || 0, d.received || 0)))
  return h(
    'div',
    h(
      'div.bars',
      list.map((d) =>
        h(
          'div.bar',
          {
            style: { height: `${Math.max(2, ((d.ordered || 0) / max) * 100)}%`, background: d.ordered ? 'var(--cinnabar)' : 'var(--line-strong)' },
          },
          h('div.bar__tip', `${fmtDay(d.date)}：开单 ¥${fmtMoney(d.ordered)} · 收款 ¥${fmtMoney(d.received)}`)
        )
      )
    ),
    h(
      'div.legend',
      h('span.legend__k', h('span.legend__sw', { style: { background: 'var(--cinnabar)' } }), '当日开单额'),
      h('span.legend__k', h('span', `峰值 ¥${fmtMoney(max)}`)),
      h('span.legend__k', h('span', `${list[0] ? fmtDay(list[0].date) : ''} → ${list.length ? fmtDay(list[list.length - 1].date) : ''}`))
    )
  )
}

export default {
  title: '财务',
  async render(ctx) {
    const preset = ctx.query.get('range') || 'thisMonth'
    const range = preset === 'custom'
      ? { from: ctx.query.get('from') || monthStart(), to: ctx.query.get('to') || todayStr(), label: '自定义' }
      : presetRange(preset)

    const [fin, payRes] = await Promise.all([
      api.get('/api/finance/summary', { from: range.from, to: range.to }),
      api.get('/api/payments', { from: range.from, to: range.to, limit: 400 }),
    ])
    const t = fin.totals

    const fromInp = h('input.inp', { type: 'date', value: range.from, style: { width: 'auto' } })
    const toInp = h('input.inp', { type: 'date', value: range.to, style: { width: 'auto' } })
    const goCustom = () => ctx.navigate(`/finance?range=custom&from=${fromInp.value}&to=${toInp.value}`)

    const seg = h(
      'div.seg',
      ['thisMonth', 'lastMonth', 'last30', 'thisYear', 'custom'].map((k) =>
        h(
          'button.seg__btn',
          { type: 'button', 'aria-pressed': String(k === preset), onclick: () => ctx.navigate(`/finance?range=${k}`) },
          k === 'custom' ? '自定义' : presetRange(k).label
        )
      )
    )

    return h(
      'div.stack',
      h(
        'div.pagehead',
        h(
          'div.pagehead__txt',
          h('h1', '财务'),
          h('p.pagehead__sub', `${range.from} → ${range.to} · 共 ${t.order_count} 张单`)
        ),
        h('div.pagehead__acts', preset === 'custom' ? h('div.cluster', fromInp, h('span.dim', '→'), toInp, h('button.btn.btn--sm.btn--primary', { type: 'button', onclick: goCustom }, '看这段')) : null)
      ),
      h('div.toolbar', seg, h('div.toolbar__grow')),

      /* 区间账单 */
      h(
        'section.ledger',
        h(
          'div.ledger__head',
          h('span.ledger__title', '区间账单'),
          h('div', { style: { flex: '1' } }),
          h('span.ledger__date', `${range.label}`)
        ),
        h(
          'div.ledger__body',
          h(
            'div.ledger__group',
            h('div.cell', h('span.cell__lbl', '订单额'), h('span.cell__fig', `¥${fmtMoney(t.order_total)}`)),
            h('div.cell', h('span.cell__lbl', '总收款'), h('span.cell__fig', `¥${fmtMoney(t.received)}`)),
            h('div.cell', h('span.cell__lbl', '退款'), h('span.cell__fig', `¥${fmtMoney(t.refunded)}`)),
            h('div.cell', h('span.cell__lbl', '净收'), h('span.cell__fig.tone-jade', { style: { color: 'var(--jade-ink)' } }, `¥${fmtMoney(t.net_received)}`))
          ),
          h(
            'div.ledger__group.ledger__group--sum',
            h('div.cell', h('span.cell__lbl', '应收余额'), h('span.cell__fig', { style: { color: t.due_total > 0 ? 'var(--cinnabar)' : '' } }, `¥${fmtMoney(t.due_total)}`)),
            h('div.cell', h('span.cell__lbl', '手续费'), h('span.cell__fig.cell__fig--sm', `¥${fmtMoney(t.platform_fee)}`)),
            h('div.cell', h('span.cell__lbl', '成本'), h('span.cell__fig.cell__fig--sm', `¥${fmtMoney(t.cost)}`)),
            h('div.cell', h('span.cell__lbl', '利润'), h('span.cell__fig', `¥${fmtMoney(t.profit)}`))
          )
        )
      ),

      h(
        'div.split',
        h(
          'div.stack',
          h(
            'section.panel',
            h('div.panel__body', sectionHead('每天开了多少', '按开单日统计')),
            h('div.panel__body', { style: { paddingTop: '0' } }, bars(fin.daily))
          ),
          h(
            'section.panel',
            h('div.panel__body', sectionHead('还没结清的单', `${fin.receivables.length} 张 · 合计 ¥${fmtMoney(fin.receivables.reduce((s, r) => s + r.due_total, 0))}`)),
            fin.receivables.length
              ? table({
                  columns: [
                    { key: 'order_no', label: '订单', main: true, render: (o) => h('div', h('div.tbl__primary', o.order_no), h('div.tbl__meta', o.title || '')) },
                    { key: 'customer_name', label: '客户' },
                    { key: 'status', label: '状态', render: (o) => lamp(o.status_label, STATUS_TONE[o.status] || 'muted') },
                    { key: 'ordered_at', label: '下单', render: (o) => h('span.sm.dim', fmtDay(o.ordered_at)) },
                    { key: 'total', label: '总额', num: true, render: (o) => fmtMoney(o.total) },
                    { key: 'due_total', label: '还差', num: true, render: (o) => h('span.tone-amber', fmtMoney(o.due_total)) },
                  ],
                  rows: fin.receivables,
                  onRowClick: (o) => ctx.navigate(`/orders/${o.id}`),
                })
              : h('div.panel__body', h('p.dim.sm', '都收齐了。'))
          ),
          h(
            'section.panel',
            h('div.panel__body', sectionHead('收款流水', `${payRes.items.length} 笔`)),
            payRes.items.length
              ? table({
                  columns: [
                    { key: 'paid_at', label: '日期', main: true, render: (p) => h('div', h('div.tbl__primary', fmtDay(p.paid_at)), h('div.tbl__meta', p.order_no || '未挂订单')) },
                    { key: 'customer_name', label: '客户' },
                    { key: 'method', label: '方式', render: (p) => tag(PAY_METHOD_LABEL[p.method] || p.method) },
                    { key: 'note', label: '备注', render: (p) => h('span.sm.dim', p.note || '') },
                    {
                      key: 'amount',
                      label: '金额',
                      num: true,
                      render: (p) => h(`span${p.kind === 'refund' ? '.tone-oxblood' : '.tone-jade'}`, `${p.kind === 'refund' ? '−' : '+'}${fmtMoney(p.amount)}`),
                    },
                  ],
                  rows: payRes.items,
                })
              : h('div.panel__body', h('p.dim.sm', '这段时间没有收款记录。'))
          )
        ),
        h(
          'div.stack',
          h(
            'section.panel',
            h('div.panel__body', sectionHead('按收款方式')),
            fin.by_method.length
              ? h(
                  'div.itemlist',
                  fin.by_method.map((m) =>
                    h(
                      'div.item',
                      { style: { cursor: 'default' } },
                      h('div.item__main', h('div.item__title', PAY_METHOD_LABEL[m.method] || m.method), h('div.item__meta', h('span', `${m.count} 笔`))),
                      h('div.item__right', h('div.item__fig', `¥${fmtMoney(m.amount)}`))
                    )
                  )
                )
              : h('div.panel__body', h('p.dim.sm', '暂无。'))
          ),
          h(
            'section.panel',
            h('div.panel__body', sectionHead('按游戏')),
            fin.by_game.length
              ? h(
                  'div.itemlist',
                  fin.by_game.map((g) =>
                    h(
                      'div.item',
                      { style: { cursor: 'default' } },
                      h('div.item__main', h('div.item__title', g.game_name), h('div.item__meta', h('span', `${g.order_count} 单`), h('span', `利润 ¥${fmtMoney(g.profit)}`))),
                      h('div.item__right', h('div.item__fig', `¥${fmtMoney(g.order_total)}`))
                    )
                  )
                )
              : h('div.panel__body', h('p.dim.sm', '暂无。'))
          ),
          h(
            'section.panel',
            h('div.panel__body', sectionHead('口径说明')),
            h(
              'div.panel__body',
              { style: { paddingTop: '0' } },
              h(
                'ul.empty__steps',
                h('li', h('span.n', '·'), h('span', '订单额按「下单日」归集；收款按「到账日」归集，两者不必同月。')),
                h('li', h('span.n', '·'), h('span', '净收 = 总收款 − 退款。')),
                h('li', h('span.n', '·'), h('span', '利润 = 订单额 − 平台手续费 − 成本，不含你自己的人工。')),
                h('li', h('span.n', '·'), h('span', '已取消的单不计入订单额。'))
              )
            )
          )
        )
      )
    )
  },
}
