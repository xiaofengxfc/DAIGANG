/* ============================================================
   总览 —— 第一屏是一个账簿抬头，不是指标卡
   ============================================================ */

import { api, PAY_METHOD_LABEL, PAY_KIND_LABEL } from '../api.js'
import { h, icon, fmtMoney, fmtDay, fmtDayFull, todayStr } from '../dom.js'
import { emptyState, orderLamp, confirmDelete, toast, toastErr } from '../ui.js'
import { orderTable, paymentDrawer } from './orderbits.js'

function ledgerCell({ label, value, tone = '', onClick, hint }) {
  const cls = `button.cell${tone ? '.cell--' + tone : ''}`
  const el = h(
    cls,
    { type: 'button', title: hint || `${label}：${value}` },
    h('span.cell__lbl', label),
    h('span.cell__fig', value)
  )
  if (onClick) el.addEventListener('click', onClick)
  else el.disabled = true
  return el
}

function ledgerMoneyCell({ label, value, tone = '', onClick, hint }) {
  const el = h(
    `button.cell${tone ? '.cell--' + tone : ''}`,
    { type: 'button', title: hint || `${label}：¥${value}` },
    h('span.cell__lbl', label),
    h('span.cell__fig', `¥${value}`)
  )
  if (onClick) el.addEventListener('click', onClick)
  else el.disabled = true
  return el
}

function onboarding(ctx) {
  return h(
    'div.panel',
    h(
      'div.panel__body',
      emptyState({
        iconName: 'price',
        title: '帐桌支好了，先录第一批价格',
        body: '这个后台不预置任何数据——因为你的项目和价格只有你自己知道。按下面顺序走一遍，十分钟就能接手第一单。',
        steps: [
          '在「游戏」里加一个你在代肝的游戏，顺手填上区服。',
          '在「价格表」里建分类（日常 / 周常 / 活动 / 深渊…）。',
          '在分类下加服务项，选计价方式（固定价、按天、按次、按数量、套餐价），填单价。',
          '需要阶梯价或加急之类的增项，就在服务项里继续加。',
          '去「客户」录第一个客户，然后就能开单了。',
        ],
        actionLabel: '先加一个游戏',
        onAction: () => ctx.navigate('/games'),
        secondary: h('button.btn', { type: 'button', onclick: () => ctx.navigate('/price') }, '直接去价格表'),
      })
    )
  )
}

export default {
  title: '总览',
  async render(ctx) {
    const d = await api.get('/api/dashboard')
    const c = d.counts
    const today = todayStr()

    const emptyish = !c.games && !c.customers && !c.open && !c.done

    /* —— 账簿抬头 —— */
    const ledger = h(
      'section.ledger',
      h(
        'div.ledger__head',
        h('span.ledger__title', '今日台面'),
        h('span.ledger__date.mono', fmtDayFull(today)),
        h('div', { style: { flex: '1' } }),
        h(
          'span.ledger__sum',
          `本月已收 ¥${fmtMoney(d.month_money.received)} · 利润 ¥${fmtMoney(d.month_money.profit)}`
        )
      ),
      h(
        'div.ledger__body',
        h(
          'div.ledger__group',
          ledgerCell({ label: '待确认', value: c.pending_confirm, tone: c.pending_confirm ? 'alert' : '', hint: '客户下单了，等你确认', onClick: () => ctx.navigate('/orders?status=pending_confirm') }),
          ledgerCell({ label: '待付款', value: c.pending_pay, tone: c.pending_pay ? 'alert' : '', hint: '还没收到钱', onClick: () => ctx.navigate('/orders?status=pending_pay') }),
          ledgerCell({ label: '进行中', value: c.in_progress, hint: '正在做的单', onClick: () => ctx.navigate('/orders?status=in_progress') }),
          ledgerCell({ label: '待验收', value: c.pending_accept, tone: c.pending_accept ? 'alert' : '', hint: '做完了等客户点头', onClick: () => ctx.navigate('/orders?status=pending_accept') })
        ),
        h(
          'div.ledger__group.ledger__group--sum',
          ledgerMoneyCell({ label: '今日新单', value: fmtMoney(d.today_money.ordered_amount), hint: `${d.today_money.ordered_count} 单` }),
          ledgerMoneyCell({ label: '今日已收', value: fmtMoney(d.today_money.received), onClick: () => ctx.navigate('/finance') }),
          ledgerMoneyCell({
            label: '未收余额',
            value: fmtMoney(d.receivables),
            tone: d.receivables > 0 ? 'due' : '',
            hint: '所有未结清订单的尾款合计',
            onClick: () => ctx.navigate('/orders?due=1'),
          })
        )
      )
    )

    if (emptyish) return h('div.stack', ledger, onboarding(ctx))

    /* —— 调度列表：正在做的单 —— */
    const dispatch =
      d.open_orders.length > 0
        ? h(
            'section.panel',
            h(
              'div.panel__body.panel__body--flush',
              orderTable(d.open_orders, ctx, { showCustomer: true })
            ),
            h(
              'div.panel__foot',
              h('span.sm.dim', `共 ${c.open} 单没结束`),
              h('div', { style: { flex: '1' } }),
              h('button.btn.btn--sm', { type: 'button', onclick: () => ctx.navigate('/orders?status=open') }, '看全部在做的单')
            )
          )
        : h(
            'section.panel',
            h(
              'div.panel__body',
              emptyState({
                iconName: 'orders',
                title: '现在手上没有在做的单',
                body: '开一单试试：选客户、选服务，价格会自动算出来，下单那一刻就把价格快照冻住了，以后改价不影响老单。',
                actionLabel: '开一张新单',
                onAction: () => ctx.navigate('/orders?new=1'),
              })
            )
          )

    const right = []

    if (d.stale_orders.length) {
      right.push(
        h(
          'section.panel',
          h(
            'div',
            { style: { padding: '12px 16px 0' } },
            h('div.sechead', { style: { marginBottom: '8px' } }, h('h3', h('span.tone-amber', '停滞提醒')), h('span.sechead__note', '两天没记进度了'))
          ),
          h(
            'div.itemlist',
            d.stale_orders.map((o) =>
              h(
                'button.item',
                {
                  type: 'button',
                  onclick: () => ctx.navigate(`/orders/${o.id}`),
                },
                h(
                  'div.item__main',
                  h('div.item__title', o.order_no),
                  h('div.item__meta', h('span', o.customer_name || '散客'), h('span', `上次 ${fmtDay(o.last_progress_on)}`))
                ),
                h('div.item__right', h('span.tag.tag--amber', `${o.idle_days} 天`))
              )
            )
          )
        )
      )
    }

    if (d.unpaid_orders.length) {
      right.push(
        h(
          'section.panel',
          h(
            'div',
            { style: { padding: '12px 16px 0' } },
            h('div.sechead', { style: { marginBottom: '0' } }, h('h3', '还没收齐'), h('span.sechead__note', '点一下就能记收款'))
          ),
          h(
            'div.itemlist',
            d.unpaid_orders.map((o) =>
              h(
                'div.item',
                { style: { cursor: 'default' } },
                h(
                  'div.item__main',
                  h('div.item__title', o.order_no, orderLamp(o.status, o.status_label)),
                  h('div.item__meta', h('span', o.customer_name || '散客'), h('span', o.title || ''))
                ),
                h(
                  'div.item__right',
                  h('div.item__fig.tone-amber', `¥${fmtMoney(o.due_total)}`),
                  h(
                    'button.btn.btn--sm',
                    { type: 'button', style: { marginTop: '4px' }, onclick: () => paymentDrawer(o, () => ctx.app.reload()) },
                    '记收款'
                  )
                )
              )
            )
          )
        )
      )
    }

    if (d.recent_payments.length) {
      right.push(
        h(
          'section.panel',
          h(
            'div',
            { style: { padding: '12px 16px 0' } },
            h('div.sechead', { style: { marginBottom: '0' } }, h('h3', '最近收款'))
          ),
          h(
            'div.itemlist',
            d.recent_payments.map((p) =>
              h(
                'div.item',
                { style: { cursor: 'default' } },
                h(
                  'div.item__main',
                  h('div.item__title', p.customer_name || '散客', h('span.tag', PAY_METHOD_LABEL[p.method] || p.method)),
                  h('div.item__meta', h('span', p.order_no || '未挂订单'), h('span', fmtDay(p.paid_at)))
                ),
                h(
                  'div.item__right',
                  h(`div.item__fig${p.kind === 'refund' ? '.tone-oxblood' : '.tone-jade'}`, `${p.kind === 'refund' ? '−' : '+'}¥${fmtMoney(p.amount)}`),
                  h(
                    'button.btn.btn--sm.btn--quiet',
                    {
                      type: 'button',
                      title: '删除这笔收款',
                      onclick: async () => {
                        const ok = await confirmDelete({
                          title: '删掉这笔收款？',
                          message:
                            `${p.customer_name || '散客'} · ${PAY_KIND_LABEL[p.kind] || p.kind} ¥${fmtMoney(p.amount)}（${fmtDay(p.paid_at)}）` +
                            (p.order_no
                              ? `，挂在订单 ${p.order_no} 上。删掉后这张单的「已收 / 待收」会重新算。`
                              : '。这笔没有挂订单。'),
                        })
                        if (!ok) return
                        try {
                          await api.del(`/api/payments/${p.id}`)
                          toast('已删除这笔收款', 'ok')
                          ctx.app.reload()
                        } catch (err) {
                          toastErr(err)
                        }
                      },
                    },
                    icon('trash', 13)
                  )
                )
              )
            )
          )
        )
      )
    }

    return h(
      'div.stack',
      ledger,
      h('div.split', h('div.stack', dispatch), h('div.stack', right))
    )
  },
}
