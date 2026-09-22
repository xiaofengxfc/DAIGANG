/* ============================================================
   订单共用件：记账进度、记收款、列表与状态轨
   看板和订单页共用同一套，保证两处表现一致。
   ============================================================ */

import { api, PAY_METHOD_LABEL, PAY_KIND_LABEL, STATUS_TONE } from '../api.js'
import { h, icon, fmtMoney, fmtDate, fmtDay, todayStr, fmtQty, remainInfo } from '../dom.js'
import { formDrawer, table, toast, toastErr, lamp, tag, orderTrack, copyButton, confirmDelete, emptyState } from '../ui.js'

/* ---------------- 记进度 ---------------- */

/** 要盯的三个资源。名字跟 src/ocr.mjs 里的 RESOURCE_ALIASES 对应 */
export const RES_KEYS = ['星声', '体力', '贝币']

/**
 * 把「星声 105 体力 86」这种文本拆成三个标准资源 + 其他。
 * 老记录（甚至「原石 12000 / 树脂 160」这种）都读得回来，
 * 认不出的标签原样留在「其他」里，一个字都不丢。
 */
export function parseResources(text) {
  const raw = String(text || '').trim()
  const out = { 星声: '', 体力: '', 贝币: '', other: '' }
  if (!raw) return out
  const re = /([^\s\d,，./·、]+)\s*([\d][\d,，]*(?:\.\d+)?)/g
  const found = []
  let m
  while ((m = re.exec(raw))) found.push([m[1], m[2].replace(/[,，]/g, '')])
  if (!found.length) {
    out.other = raw
    return out
  }
  const leftovers = []
  for (const [k, v] of found) {
    if (RES_KEYS.includes(k)) out[k] = v
    else leftovers.push(`${k} ${v}`)
  }
  out.other = leftovers.join(' · ')
  return out
}

/** 反过来拼回一行文本（还是人一眼能读的样子） */
export function buildResources(vals, other) {
  const parts = []
  for (const k of RES_KEYS) {
    const v = String((vals && vals[k]) ?? '').trim()
    if (v) parts.push(`${k} ${v}`)
  }
  const o = String(other || '').trim()
  if (o) parts.push(o)
  return parts.join(' ')
}

/** 前后差值，给「本次消耗」那行用 */
export function resourceDelta(beforeText, afterText) {
  const a = parseResources(beforeText)
  const b = parseResources(afterText)
  const out = []
  for (const k of RES_KEYS) {
    const x = Number(a[k])
    const y = Number(b[k])
    if (!a[k] || !b[k] || !Number.isFinite(x) || !Number.isFinite(y)) continue
    out.push({ key: k, diff: y - x })
  }
  return out
}

/**
 * 上一条进度里「做之后」的资源。
 * 连着记的时候，这一次的「做之前」就是上一次的「做之后」——
 * 直接带出来，省得每回都重抄一遍。
 */
export function lastResourcesAfter(order) {
  const list = (order && order.progress) || []
  const sorted = [...list].sort(
    (a, b) => String(a.happened_on || '').localeCompare(String(b.happened_on || '')) || (a.id || 0) - (b.id || 0)
  )
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].resources_after) return sorted[i].resources_after
  }
  return ''
}

/**
 * 资源对比：星声 / 体力 / 贝币 各一个框，外加一个「其他」兜底。
 * 两边都能点「识别画面」看屏幕，或点「识别截图」选一张图。
 * beforeFrom 有值时说明「做之前」是带上一条来的，给个提示讲清来历。
 */
function resourcesField({ before = '', after = '', beforeFrom = '' } = {}) {
  let read = () => ({ resources_before: '', resources_after: '' })
  let ocrOk = null
  const sides = []

  const buildSide = (label, initial, isFirst = false) => {
    const parsed = parseResources(initial)
    const inputs = {}
    for (const k of RES_KEYS) {
      const inp = h('input.inp.inp--fig', { inputmode: 'numeric', style: { width: '92px' }, 'aria-label': `${label} ${k}` })
      inp.value = parsed[k]
      inputs[k] = inp
    }
    const other = h('input.inp', { placeholder: '其他（可选）', 'aria-label': `${label} 其他资源` })
    other.value = parsed.other

    const deltaLine = h('div.hint')
    const note = h('div.note.note--ok', { hidden: true })
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' } })
    const shotBtn = h('button.btn.btn--sm', { type: 'button', title: '选一张游戏截图，自动认星声 / 体力 / 贝币' }, icon('eye', 14), '识别截图')
    const watchBtn = h('button.btn.btn--sm.btn--primary', { type: 'button', title: '切到游戏，程序会一直看着屏幕，三个都认到就自动停' }, icon('refresh', 14), '识别画面')

    const box = h(
      'div.field.field--full',
      h('div.cluster', h('label.lbl', label), h('div', { style: { flex: '1' } }), watchBtn, shotBtn),
      h('div.cluster', { style: { gap: '6px', flexWrap: 'wrap' } }, ...RES_KEYS.map((k) => h('label.inline', { style: { gap: '4px' } }, h('span.dim.tiny', k), inputs[k]))),
      other,
      // 「做之前」是带上一条来的时候，说清来历，免得以为填错了
      isFirst && beforeFrom ? h('div.hint', `「做之前」带的是${beforeFrom}，不对就直接改。`) : null,
      deltaLine,
      note,
      file
    )
    const rec = { inputs, other, deltaLine, note }
    sides.push(rec)

    shotBtn.addEventListener('click', () => {
      if (ocrOk === false) return toast('这台机器上没法识别（只支持 Windows）', 'err', 3600)
      file.click()
    })

    /**
     * 识别画面：切到游戏，程序每 1.5 秒截一次屏，
     * 三个资源都认到就自动停 —— 不用截图、不用来回切。
     */
    let watching = false
    watchBtn.addEventListener('click', async () => {
      if (watching) return
      if (ocrOk === false) return toast('这台机器上用不了屏幕识别（只支持 Windows）', 'err', 3600)
      watching = true
      watchBtn.setAttribute('data-loading', '1')
      const got = {}
      const deadline = Date.now() + 90000
      const paintProgress = () => {
        const have = RES_KEYS.filter((k) => got[k] !== undefined)
        note.hidden = false
        note.replaceChildren(
          h('strong', `正在看屏幕… 已认到 ${have.length}/3${have.length ? '（' + have.join('、') + '）' : ''}`),
          h('div.tiny', { style: { marginTop: '4px', opacity: '.85' } }, '切到游戏，走到有这几个资源的界面；三个都认到就自动停。')
        )
      }
      paintProgress()
      try {
        while (Date.now() < deadline && RES_KEYS.some((k) => got[k] === undefined)) {
          let r = null
          try {
            r = await api.post('/api/ocr/screen', {})
          } catch (err) {
            // 单次失败（比如切窗口时截到黑屏）不算结束，接着看
            await new Promise((res) => setTimeout(res, 1200))
            continue
          }
          for (const k of RES_KEYS) {
            if (got[k] === undefined && r.resources && r.resources[k] !== undefined) got[k] = r.resources[k]
          }
          for (const k of RES_KEYS) if (got[k] !== undefined) inputs[k].value = String(got[k])
          paintProgress()
          paint()
          if (RES_KEYS.every((k) => got[k] !== undefined)) break
          await new Promise((res) => setTimeout(res, 1500))
        }
        const n = RES_KEYS.filter((k) => got[k] !== undefined).length
        note.replaceChildren(
          h('strong', n === RES_KEYS.length ? '三个都认到了，核对一下再保存' : `只认到 ${n} 个，剩下的自己填一下`),
          h('div.tiny', { style: { marginTop: '4px', opacity: '.85' } }, '认出来的都是「图标 + 数字」对上的，认不准的宁可不填。')
        )
        toast(n === RES_KEYS.length ? '三个都认到了' : `认到 ${n} 个`, n ? 'ok' : 'err', 3600)
      } finally {
        watching = false
        watchBtn.removeAttribute('data-loading')
        paint()
      }
    })
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0]
      if (!f) return
      if (f.size > 1.5 * 1024 * 1024) {
        file.value = ''
        return toast('截图请压到 1.5MB 以内', 'err', 3600)
      }
      shotBtn.setAttribute('data-loading', '1')
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader()
          fr.onload = () => resolve(fr.result)
          fr.onerror = () => reject(new Error('读不了这个文件'))
          fr.readAsDataURL(f)
        })
        const r = await api.post('/api/ocr', { data_url: dataUrl })
        const got = r.resources || {}
        let n = 0
        for (const k of RES_KEYS) {
          if (got[k] === undefined || got[k] === null) continue
          inputs[k].value = String(got[k])
          n++
        }
        // 认出来的原文也摊开给用户核对 —— 认错的时候一眼能看出来
        const lines = (r.lines || []).filter((l) => l.trim()).slice(0, 8)
        note.replaceChildren(
          h('strong', n ? `认出 ${n} 项，请核对一下再保存` : '这三个资源一个都没认出来，可以手动填'),
          lines.length ? h('div.tiny', { style: { marginTop: '4px', opacity: '.85' } }, `识别到的原文：${lines.join(' ｜ ')}`) : null
        )
        note.hidden = false
        paint()
        toast(n ? `认出 ${n} 项，核对后再保存` : '这张图里没认出资源数字', n ? 'ok' : 'err', 3600)
      } catch (err) {
        toastErr(err)
      } finally {
        shotBtn.removeAttribute('data-loading')
        file.value = ''
      }
    })
    return box
  }

  function vals(p) {
    const o = {}
    for (const k of RES_KEYS) o[k] = p.inputs[k].value
    return buildResources(o, p.other.value)
  }

  function paint() {
    if (sides.length < 2) return
    const deltas = resourceDelta(vals(sides[0]), vals(sides[1]))
    sides[1].deltaLine.textContent = deltas.length
      ? '本次消耗：' +
        deltas
          .map((d) => {
            const sign = d.diff < 0 ? '−' : d.diff > 0 ? '+' : '±'
            return `${d.key} ${sign}${fmtQty(Math.abs(d.diff))}`
          })
          .join(' · ')
      : ''
  }

  return {
    type: 'custom',
    width: 'full',
    render: () => {
      const box = h('div.stack.stack--tight', buildSide('资源对比 · 做之前', before, true), buildSide('资源对比 · 做之后', after))
      read = () => ({ resources_before: vals(sides[0]), resources_after: vals(sides[1]) })
      for (const p of sides) {
        for (const k of RES_KEYS) p.inputs[k].addEventListener('input', paint)
        p.other.addEventListener('input', paint)
      }
      paint()
      if (ocrOk === null) {
        ocrOk = true
        api
          .get('/api/ocr/status')
          .then((s) => {
            ocrOk = Boolean(s && s.available)
          })
          .catch(() => {
            ocrOk = false
          })
      }
      return box
    },
    collect: (out) => Object.assign(out, read()),
  }
}

export function progressDrawer(order, onDone) {
  // 连着记的时候，「做之前」直接带上一条的「做之后」—— 不用重抄
  const carried = lastResourcesAfter(order)
  return formDrawer({
    title: '记一条进度',
    subtitle: `${order.order_no} · ${order.title || ''}`,
    submitLabel: '记下',
    intro: h('div.hint', '以后客户问"做到哪了"，直接把这条发给他就行。'),
    fields: [
      { name: 'happened_on', label: '日期', type: 'date', required: true, default: todayStr(), width: 'half' },
      resourcesField({ before: carried, beforeFrom: carried ? '上一条的「做之后」' : '' }),
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
            o.stale ? h('span.tag.tag--amber', { style: { marginLeft: '6px' } }, `${o.idle_days} 天没动`) : null,
            // 今天已经交付过的日体单，第二天自己会回到「在做」
            o.daily_done_today ? h('span.tag.tag--jade', { style: { marginLeft: '6px' } }, '今日已完成') : null
          ),
          h('div.tbl__meta', o.title || '（没写标题）')
        ),
    },
  ]
  if (showCustomer) {
    cols.push({
      key: 'customer_name',
      label: '客户',
      render: (o) => {
        // 散客（没挂客户）没什么可点的
        if (!o.customer_id) return h('span.dim', '散客')
        const n = Number(o.customer_order_count) || 0
        return h(
          'button.custcell',
          {
            type: 'button',
            title: `看 ${o.customer_name || '这个客户'} 的档案（名下共 ${n} 张单）${o.customer_phone ? ` · ${o.customer_phone}` : ''}`,
            onclick: (e) => {
              // 别让点客户变成打开这一单
              e.stopPropagation()
              ctx.navigate(`/customers/${o.customer_id}`)
            },
          },
          o.customer_avatar
            ? h('img.avatar.avatar--xs', { src: o.customer_avatar, alt: '', loading: 'lazy' })
            : h('span.avatar.avatar--xs', (o.customer_name || '?').slice(0, 1)),
          h(
            'span.custcell__txt',
            h('span.custcell__name', o.customer_name || '没填名字'),
            h(
              'span.custcell__n',
              // 手机号直接列出来，要联系客户不用点进档案
              o.customer_phone ? h('span.mono', o.customer_phone) : null,
              o.customer_phone && n > 1 ? h('span', ' · ') : null,
              // 一个客户反复下单时给个提示，头一单就不用标了
              n > 1 ? h('span', `第 ${n} 单`) : null
            )
          )
        )
      },
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
            // 每天都要做的那种，标出来 —— 标「今日已完成」时一眼看出哪部分是日体
            it.is_daily ? tag('每天做', 'jade') : null,
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
