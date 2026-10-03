/* ============================================================
   报价单：从价格表勾选 → 算钱 → 生成一段能直接发微信的文字
   这是"代肝价格查询"对外的另一半。
   ============================================================ */

import { api, PRICE_TYPE_LABEL } from '../../../client/lib/api.js'
import { h, icon, fmtMoney, fmtQty, fmtDate, copyText, todayStr, debounce, mount } from '../dom.js'
import { drawer, toast, toastErr, confirmDelete, emptyState, table, tag, sectionHead, copyButton, modal } from '../ui.js'

const defaultUnit = (s) =>
  s.unit_label || { fixed: '单', daily: '天', per_time: '次', per_unit: '个', package: '套' }[s.price_type] || '单'

function unitPriceFor(service, tiers, qty) {
  const list = (tiers || []).filter(Boolean)
  for (const t of list) {
    const lo = Number(t.min_qty) || 0
    const hi = t.max_qty === null || t.max_qty === undefined || t.max_qty === '' ? Infinity : Number(t.max_qty)
    if (qty >= lo && qty <= hi) return Number(t.unit_price) || 0
  }
  let pick = null
  for (const t of [...list].sort((a, b) => Number(a.min_qty) - Number(b.min_qty))) if (qty >= (Number(t.min_qty) || 0)) pick = t
  return pick ? Number(pick.unit_price) || 0 : Number(service.base_price) || 0
}

/* ---------------- 报价单生成台 ---------------- */

export async function openQuoteComposer(ctx, { existing = null } = {}) {
  const [book, custRes, gameRes] = await Promise.all([
    api.get('/api/pricebook'),
    api.get('/api/customers', { status: 'active', limit: 500 }),
    api.get('/api/games', { status: 'active' }),
  ])
  const customers = custRes.items || []
  const games = gameRes.items || []
  const allServices = []
  for (const cat of book.categories) for (const s of cat.services) allServices.push({ ...s, _cat: cat.name, _catId: cat.id })
  for (const s of book.loose) allServices.push({ ...s, _cat: '未分类', _catId: 0 })

  const picked = new Map()
  /** 每行自己的重画函数，筛选后重画时用得上 */
  const rowPainters = []
  let title = existing?.title || '代肝报价单'
  let note = existing?.note || ''
  let validUntil = existing?.valid_until || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)

  const custSel = h('select.sel')
  custSel.appendChild(h('option', { value: '' }, '— 不指定客户（先给路人报价）—'))
  for (const c of customers) {
    const o = h('option', { value: String(c.id) }, `${c.name}${c.phone ? ` · ${c.phone}` : ''}`)
    if (existing?.customer_id === c.id) o.selected = true
    custSel.appendChild(o)
  }

  const gameSel = h('select.sel')
  gameSel.appendChild(h('option', { value: '' }, '— 不指定游戏 —'))
  for (const g of games) {
    const o = h('option', { value: String(g.id) }, g.name)
    if (existing?.game_id === g.id) o.selected = true
    gameSel.appendChild(o)
  }

  const titleInp = h('input.inp', { value: title })
  const noteInp = h('textarea.ta', { rows: 2, placeholder: '例：包月更划算；三个号同时做可再谈' })
  noteInp.value = note
  const validInp = h('input.inp', { type: 'date', value: validUntil })
  const searchInput = h('input.inp', { type: 'search', placeholder: '搜服务名…' })

  const svcList = h('div.picker__scroll')
  const pickerFoot = h('div.picker__foot')
  const sheetBox = h('div.stack.stack--tight')
  const textBox = h('pre.plaintext', { style: { display: 'none' } })
  const toggleTextBtn = h('button.btn.btn--sm', { type: 'button' }, icon('quotes', 14), '看文字版')
  let showText = false

  function paintSheet() {
    const lines = []
    let total = 0
    for (const [id, sel] of picked) {
      const s = allServices.find((x) => x.id === id)
      if (!s) continue
      const qty = Number(sel.quantity) || 1
      const unit = sel.unitPrice === '' ? unitPriceFor(s, s.tiers, qty) : Number(sel.unitPrice)
      let amount = unit * qty
      const addons = []
      for (const o of s.options || []) {
        if (!sel.optionIds.has(o.id)) continue
        const add = o.price_mode === 'percent' ? (amount * Number(o.price)) / 100 : Number(o.price)
        amount += add
        addons.push(`${o.name}${o.price_mode === 'percent' ? ` +${o.price}%` : o.price ? ` +${fmtMoney(o.price)}元` : ''}`)
      }
      total += amount
      lines.push({ s, qty, unit, amount, addons })
    }

    sheetBox.replaceChildren(
      lines.length
        ? h(
            'div.quote-sheet',
            h(
              'div.quote-sheet__head',
              h('strong', titleInp.value || '代肝报价单'),
              h('div', { style: { flex: '1' } }),
              h('span.dim.sm', `有效期至 ${validInp.value || '—'}`)
            ),
            h(
              'div.quote-sheet__lines',
              lines.map((l) =>
                h(
                  'div.qline',
                  h(
                    'div',
                    h('div', l.s.name),
                    h('div.tbl__meta', `${fmtMoney(l.unit)} 元/${defaultUnit(l.s)} × ${fmtQty(l.qty)} = ${fmtMoney(l.amount)} 元`),
                    l.addons.length ? h('div.tbl__meta', `含 ${l.addons.join(' · ')}`) : null
                  ),
                  h('div.qline__amt', `¥${fmtMoney(l.amount)}`)
                )
              )
            ),
            h('div.quote-sheet__total', h('span', '合计'), h('span.quote-sheet__totalfig', `¥${fmtMoney(total)}`))
          )
        : h('div.empty', h('div.empty__mark', icon('price', 20)), h('div.empty__title', '右边勾几个服务项'), h('p.empty__body', '报价单会实时长出来，右边这段文字可以直接复制发微信。'))
    )

    if (showText) {
      textBox.textContent = buildText(lines, total)
      textBox.style.display = ''
    }
    // 挑服务框底部那条「已选 N 项」跟着一起刷新
    paintFoot()
  }

  function buildText(lines, total) {
    const out = []
    out.push(`【${titleInp.value || '代肝报价单'}】`)
    const c = customers.find((x) => String(x.id) === custSel.value)
    const g = games.find((x) => String(x.id) === gameSel.value)
    if (c) out.push(`客户：${c.name}`)
    if (g) out.push(`游戏：${g.name}`)
    out.push('————————————')
    lines.forEach((l, i) => {
      out.push(`${i + 1}. ${l.s.name}`)
      out.push(`   ${fmtMoney(l.unit)} 元/${defaultUnit(l.s)} × ${fmtQty(l.qty)} = ${fmtMoney(l.amount)} 元`)
      if (l.addons.length) out.push(`   含：${l.addons.join('、')}`)
      if (l.s.description) out.push(`   说明：${l.s.description}`)
    })
    out.push('————————————')
    out.push(`合计：${fmtMoney(total)} 元`)
    if (noteInp.value) out.push(`备注：${noteInp.value}`)
    if (validInp.value) out.push(`有效期至：${validInp.value}`)
    return out.join('\n')
  }

  /* 按大类筛。**大类列表完全由上面选的游戏决定** ——
     选了某个游戏就只列这个游戏的大类，选了「不指定游戏」才列全部。
     唯一的例外：这个游戏一个大类都没有（服务项全挂在「通用」大类下）时，
     把通用大类带上，否则筛选框空着没法用。 */
  let catFilter = ''
  const catFilterSel = h('select.sel', { style: { width: 'auto', minWidth: '130px' }, 'aria-label': '按大类筛选' })

  function paintCatFilter() {
    const gameId = gameSel.value
    const withSvc = book.categories.filter((c) => c.services && c.services.length)
    let list = withSvc
    if (gameId) {
      const own = withSvc.filter((c) => String(c.game_id || '') === gameId)
      list = own.length ? own : withSvc.filter((c) => !c.game_id)
    }
    // 换游戏后，原来选的大类要是已经不在列表里就退掉
    if (catFilter && !list.some((c) => String(c.id) === catFilter)) catFilter = ''
    catFilterSel.replaceChildren(
      h('option', { value: '' }, '全部大类'),
      ...list.map((c) => h('option', { value: String(c.id) }, c.name))
    )
    catFilterSel.value = catFilter
  }
  catFilterSel.addEventListener('change', () => {
    catFilter = catFilterSel.value
    renderServices()
  })

  /** 「已选 N 项 + 清空」，固定在挑服务框底部 */
  function paintFoot() {
    const n = picked.size
    // 用 mount：replaceChildren(null) 会把 null 变成文字「null」挂上去
    mount(
      pickerFoot,
      n ? h('span.cluster', { style: { gap: '6px' } }, h('span.pickcount', String(n)), h('span', '已选')) : h('span.dim', '还没勾服务项'),
      h('div', { style: { flex: '1' } }),
      n
        ? h(
            'button.btn.btn--sm.btn--quiet',
            {
              type: 'button',
              onclick: () => {
                picked.clear()
                for (const p of rowPainters) if (p) p()
                paintSheet()
                paintFoot()
              },
            },
            '清空'
          )
        : null
    )
  }

  function renderServices() {
    const q = searchInput.value.trim().toLowerCase()
    rowPainters.length = 0
    const cats = new Map()
    for (const s of allServices) {
      if (catFilter && String(s._catId || '') !== catFilter) continue
      if (q && !`${s.name} ${s.description} ${s._cat}`.toLowerCase().includes(q)) continue
      if (!cats.has(s._cat)) cats.set(s._cat, [])
      cats.get(s._cat).push(s)
    }
    svcList.replaceChildren()
    if (!allServices.length) {
      svcList.appendChild(
        h('div.empty', h('div.empty__body', '价格表还是空的。'), h('button.btn.btn--sm', { type: 'button', onclick: () => ctx.navigate('/price') }, '先去建价格表'))
      )
      paintFoot()
      return
    }
    if (!cats.size) {
      svcList.appendChild(
        h('div.empty', h('div.empty__body', '没有匹配的服务项。'), h('button.btn.btn--sm', { type: 'button', onclick: () => ctx.navigate('/price') }, '去价格表看看'))
      )
      paintFoot()
      return
    }
    for (const [catName, list] of cats) {
      const group = h(
        'div.pickgroup',
        h('div.pickgroup__head', h('span.pickgroup__name', catName), h('span.pickgroup__n', `${list.length} 项`))
      )
      for (const s of list) {
        const sel = picked.get(s.id)
        const cb = h('input.chk', { type: 'checkbox', 'aria-label': `选择 ${s.name}` })
        cb.checked = Boolean(sel)
        const qty = h('input.inp.inp--fig', { inputmode: 'decimal', style: { width: '70px' }, 'aria-label': `${s.name} 数量` })
        const price = h('input.inp.inp--fig', { inputmode: 'decimal', style: { width: '82px' }, placeholder: '改价', 'aria-label': `${s.name} 单价` })
        const ctrl = h('div.pickrow__ctrl')
        ctrl.append(h('div.cluster', { style: { gap: '6px' } }, qty, h('span.dim.tiny', defaultUnit(s)), price, h('span.dim.tiny', '元')))

        const optWrap = h('div.cluster', { style: { gap: '10px' } })
        const detail = h('div.pickrow__detail', optWrap)
        const row = h('div.pickrow')

        const paint = () => {
          const cur = picked.get(s.id)
          row.classList.toggle('pickrow--on', Boolean(cur))
          cb.checked = Boolean(cur)
          ctrl.style.display = cur ? '' : 'none'
          detail.style.display = cur ? '' : 'none'
          if (cur) {
            if (document.activeElement !== qty) qty.value = String(cur.quantity)
            if (document.activeElement !== price) price.value = cur.unitPrice === '' ? '' : String(cur.unitPrice)
          }
        }
        const toggle = () => {
          if (picked.has(s.id)) picked.delete(s.id)
          // 价格表里勾了「默认选中」的增项直接带上，跟开单台一个规矩
          else
            picked.set(s.id, {
              quantity: Number(s.min_qty) || 1,
              unitPrice: '',
              optionIds: new Set((s.options || []).filter((o) => o.default_selected).map((o) => o.id)),
            })
          buildOpts()
          paint()
          paintSheet()
        }
        cb.addEventListener('change', toggle)
        qty.addEventListener('input', () => {
          const cur = picked.get(s.id)
          if (cur) cur.quantity = Number(qty.value) || 0
          paintSheet()
        })
        price.addEventListener('input', () => {
          const cur = picked.get(s.id)
          if (cur) cur.unitPrice = price.value === '' ? '' : Number(price.value)
          paintSheet()
        })

        function buildOpts() {
          optWrap.replaceChildren()
          const cur = picked.get(s.id)
          if (!cur) return
          for (const o of s.options || []) {
            const oc = h('input.chk', { type: 'checkbox' })
            oc.checked = cur.optionIds.has(o.id)
            oc.addEventListener('change', () => {
              if (oc.checked) cur.optionIds.add(o.id)
              else cur.optionIds.delete(o.id)
              paintSheet()
            })
            optWrap.appendChild(h('label.inline', { style: { cursor: 'pointer', gap: '5px' } }, oc, h('span.sm', o.name)))
          }
        }

        row.append(
          h(
            'div.pickrow__top',
            cb,
            h(
              'button.pickrow__main',
              { type: 'button', onclick: toggle },
              h(
                'span.pickrow__line',
                h('span.pickrow__name', s.name),
                h('span.pickrow__fig', `¥${fmtMoney(s.base_price)}`, h('em', `/${defaultUnit(s)}`))
              ),
              h(
                'span.pickrow__meta',
                [PRICE_TYPE_LABEL[s.price_type] || s.price_type, s.description || null].filter(Boolean).join(' · ')
              )
            )
          ),
          ctrl,
          detail
        )
        rowPainters.push(paint)
        buildOpts()
        paint()
        group.appendChild(row)
      }
      svcList.appendChild(group)
    }
    paintFoot()
  }

  searchInput.addEventListener('input', debounce(renderServices, 140))
  titleInp.addEventListener('input', paintSheet)
  noteInp.addEventListener('input', paintSheet)
  validInp.addEventListener('change', paintSheet)
  custSel.addEventListener('change', paintSheet)
  // 换了游戏，大类列表要跟着换（筛着的那个大类如果不属于新游戏会自动退掉）
  gameSel.addEventListener('change', () => {
    paintCatFilter()
    renderServices()
    paintSheet()
  })
  toggleTextBtn.addEventListener('click', () => {
    showText = !showText
    toggleTextBtn.replaceChildren(icon('quotes', 14), showText ? '收起文字版' : '看文字版')
    paintSheet()
  })

  paintCatFilter()
  renderServices()
  paintSheet()

  const saveBtn = h('button.btn.btn--primary', { type: 'button' }, existing ? '保存改动' : '存成报价单')
  const copyBtn = h('button.btn', { type: 'button' }, icon('copy', 14), '复制文字')

  const d = drawer({
    wide: true,
    title: existing ? `改报价单 · ${existing.quote_no}` : '做一张报价单',
    subtitle: '勾服务 → 算钱 → 复制文字发微信',
    body: h(
      'div.stack',
      h(
        'div.formgrid',
        h('div.field.field--full', h('label.lbl', '抬头'), titleInp),
        h('div.field.field--full', h('label.lbl', '客户'), custSel),
        h('div.field.field--full', h('label.lbl', '游戏'), gameSel),
        h('div.field.field--full', h('label.lbl', '有效期至'), validInp)
      ),
      h(
        'div.split',
        h(
          'div.stack.stack--tight',
          h('div.sechead', h('h3', '挑服务'), h('span.sechead__note', '勾上就进单')),
          h('div.cluster', { style: { gap: '6px' } }, searchInput, catFilterSel),
          h('div.picker', svcList, pickerFoot)
        ),
        h(
          'div.stack.stack--tight',
          h('div.sechead', h('h3', '报价单'), h('div', { style: { flex: '1' } }), toggleTextBtn),
          sheetBox,
          textBox,
          h('div.field.field--full', h('label.lbl', '备注'), noteInp)
        )
      )
    ),
    footer: [
      h('div', { style: { flex: '1' } }),
      h('button.btn', { type: 'button', onclick: () => d.close() }, '关闭'),
      copyBtn,
      saveBtn,
    ],
  })

  copyBtn.addEventListener('click', async () => {
    const lines = []
    let total = 0
    for (const [id, sel] of picked) {
      const s = allServices.find((x) => x.id === id)
      if (!s) continue
      const qty = Number(sel.quantity) || 1
      const unit = sel.unitPrice === '' ? unitPriceFor(s, s.tiers, qty) : Number(sel.unitPrice)
      let amount = unit * qty
      const addons = []
      for (const o of s.options || []) {
        if (!sel.optionIds.has(o.id)) continue
        const add = o.price_mode === 'percent' ? (amount * Number(o.price)) / 100 : Number(o.price)
        amount += add
        addons.push(`${o.name}${o.price_mode === 'percent' ? ` +${o.price}%` : o.price ? ` +${fmtMoney(o.price)}元` : ''}`)
      }
      total += amount
      lines.push({ s, qty, unit, amount, addons })
    }
    if (!lines.length) {
      toast('还没勾服务项', 'err')
      return
    }
    const ok = await copyText(buildText(lines, total))
    toast(ok ? '报价单文字已复制，去微信粘吧' : '复制失败，可以手动框选文字版', ok ? 'ok' : 'err', 2600)
  })

  saveBtn.addEventListener('click', async () => {
    if (!picked.size) {
      toast('至少勾一个服务项', 'err')
      return
    }
    const items = [...picked.entries()].map(([id, sel]) => ({
      service_id: id,
      quantity: Number(sel.quantity) || 1,
      option_ids: [...sel.optionIds],
      unit_price: sel.unitPrice === '' ? undefined : Number(sel.unitPrice),
    }))
    const payload = {
      customer_id: custSel.value ? Number(custSel.value) : null,
      game_id: gameSel.value ? Number(gameSel.value) : null,
      title: titleInp.value,
      items,
      note: noteInp.value,
      valid_until: validInp.value || null,
    }
    saveBtn.setAttribute('data-loading', '1')
    saveBtn.disabled = true
    try {
      await (existing ? api.patch(`/api/quotes/${existing.id}`, payload) : api.post('/api/quotes', payload))
      toast('报价单已保存', 'ok')
      d.close()
      ctx.app.reload()
    } catch (err) {
      toastErr(err)
    } finally {
      saveBtn.removeAttribute('data-loading')
      saveBtn.disabled = false
    }
  })

  return d
}

/* ---------------- 页面 ---------------- */

export default {
  title: '报价单',
  async render(ctx) {
    const { items } = await api.get('/api/quotes', { limit: 200 })

    ctx.setActions(
      h('button.btn.btn--sm.btn--primary', { type: 'button', onclick: () => openQuoteComposer(ctx) }, icon('plus', 14), '做报价单')
    )

    if (!items.length) {
      return h(
        'section.panel',
        h(
          'div.panel__body',
          emptyState({
            iconName: 'quotes',
            title: '还没做过报价单',
            body: '客户问"多少钱"，不用再翻价格表手打——勾几个服务项，报价单自动出来，还能一键复制成文字发微信。',
            steps: [
              '先确保价格表里有服务项。',
              '点「做报价单」，勾上这次要报的项目。',
              '数量、增项、改价都能现场调。',
              '点「复制文字」，粘到微信里发出去。',
              '客户点头了，可以直接把报价单转成订单。',
            ],
            actionLabel: '做第一张报价单',
            onAction: () => openQuoteComposer(ctx),
          })
        )
      )
    }

    const showText = async (q) => {
      const { text } = await api.get(`/api/quotes/${q.id}/text`)
      const pre = h('pre.plaintext', text)
      modal({
        title: `报价单文字 · ${q.quote_no}`,
        wide: true,
        body: h('div.stack.stack--tight', pre, h('div.hint', '这段字可以直接粘到微信里。')),
        actions: [
          { label: '复制', tone: 'primary', keepOpen: true, onClick: async () => {
            const ok = await copyText(text)
            toast(ok ? '已复制' : '复制失败，请手动选中', ok ? 'ok' : 'err')
            return false
          } },
          { label: '关闭' },
        ],
      })
    }

    return h(
      'div.stack',
      h(
        'div.pagehead',
        h('div.pagehead__txt', h('h1', '报价单'), h('p.pagehead__sub', `${items.length} 张 · 客户点头后可以一键转成订单`))
      ),
      h(
        'section.panel',
        table({
          columns: [
            {
              key: 'quote_no',
              label: '报价单',
              main: true,
              render: (q) => h('div', h('div.tbl__primary', q.quote_no), h('div.tbl__meta', `${q.title || ''}${q.customer_name ? ` · ${q.customer_name}` : ''}`)),
            },
            { key: 'item_count', label: '项目数', num: true, render: (q) => String(q.item_count) },
            { key: 'game_name', label: '游戏', render: (q) => h('span.sm', q.game_name || '通用') },
            { key: 'valid_until', label: '有效期至', render: (q) => h('span.sm.dim', q.valid_until || '—') },
            { key: 'total', label: '合计', num: true, render: (q) => h('span.strong', `¥${fmtMoney(q.total)}`) },
            {
              key: 'acts',
              label: '操作',
              cls: 'td-acts',
              render: (q) =>
                h(
                  'div.tbl__acts',
                  h('button.btn.btn--sm', { type: 'button', onclick: (e) => { e.stopPropagation(); showText(q) } }, '文字'),
                  h(
                    'button.btn.btn--sm',
                    {
                      type: 'button',
                      title: '转成订单',
                      onclick: async (e) => {
                        e.stopPropagation()
                        try {
                          const r = await api.post(`/api/quotes/${q.id}/convert`)
                          toast(`已生成订单 ${r.order_no}`, 'ok')
                          ctx.navigate(`/orders/${r.order_id}`)
                        } catch (err) {
                          toastErr(err)
                        }
                      },
                    },
                    '转订单'
                  ),
                  h(
                    'button.btn.btn--sm',
                    { type: 'button', title: '删除', onclick: async (e) => {
                      e.stopPropagation()
                      const ok = await confirmDelete({ title: '删掉这张报价单？', message: `${q.quote_no} · ¥${fmtMoney(q.total)}` })
                      if (!ok) return
                      await api.del(`/api/quotes/${q.id}`)
                      toast('已删除', 'ok')
                      ctx.app.reload()
                    } },
                    icon('trash', 14)
                  )
                ),
            },
          ],
          rows: items,
          // 点一行就看这张报价单的文字版（原来跳到 ?open= 但没人处理，点了等于没反应）
          onRowClick: (q) => showText(q),
        })
      ),
      h('div.note', '报价单里的价格是下单那一刻从价格表读出来的。以后你改价格表的价，这些老报价单上的数字不变。')
    )
  },
}
