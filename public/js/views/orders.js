/* ============================================================
   订单：列表、下单台、详情
   下单那一刻把价格、套餐内容、增项全部冻成快照，以后改价不影响老单。
   ============================================================ */

import { api, PRICE_TYPE_LABEL, PAY_METHOD_LABEL, PAY_KIND_LABEL, STATUS_TONE } from '../api.js'
import { h, icon, fmtMoney, fmtQty, fmtDate, fmtDay, fmtDateTime, todayStr, debounce, remainInfo, mount } from '../dom.js'
import {
  toast,
  toastErr,
  drawer,
  modal,
  confirmModal,
  confirmDelete,
  formDrawer,
  imageField,
  emptyState,
  lamp,
  tag,
  orderTrack,
  sectionHead,
  copyButton,
} from '../ui.js'
import { orderTable, progressDrawer, paymentDrawer, statusDrawer, orderItemsList, progressTimeline, editProgressDrawer } from './orderbits.js'
import { renderProgressCard } from '../progresscard.js'
import { canvasToBlob, downloadBlob } from '../pricecard.js'

/* ============================================================
   分享进度：文本发微信 / 图片发微信
   ============================================================ */

async function shareProgress(order, ctx) {
  let data
  try {
    data = await api.get(`/api/orders/${order.id}/progress-report`)
  } catch (err) {
    toastErr(err)
    return
  }
  const { text, report } = data

  const pre = h('pre.report-text')
  pre.textContent = text

  const imgBox = h('div.report-preview')
  try {
    imgBox.appendChild(h('img', { src: renderProgressCard(report, { scale: 1 }).toDataURL('image/png'), alt: '进度汇报预览' }))
  } catch (err) {
    imgBox.appendChild(h('div.hint', `图片预览画不出来：${err.message || ''}`))
  }

  async function doCopy() {
    try {
      await navigator.clipboard.writeText(text)
      toast('进度文字已复制，粘到微信里就能发', 'ok', 3200)
    } catch {
      // 没有剪贴板权限就退回手动选中
      const r = document.createRange()
      r.selectNodeContents(pre)
      const sel = window.getSelection()
      sel.removeAllRanges()
      sel.addRange(r)
      toast('已选中文字，按 Ctrl+C 复制', 'ok', 3600)
    }
  }

  async function doImage() {
    try {
      const blob = await canvasToBlob(renderProgressCard(report, { scale: 2 }))
      if (!blob) {
        toast('这个浏览器不支持生成图片，请换 Chrome / Edge / Safari 试试', 'err', 4200)
        return
      }
      const safe = String(report.orderNo || '订单').replace(/[\\/:*?"<>|]/g, '_')
      downloadBlob(blob, `${report.shopName}-进度-${safe}.png`)
      toast('图片已生成，去下载文件夹看看', 'ok', 3200)
    } catch (err) {
      toastErr(err)
    }
  }

  const m = modal({
    title: '分享进度',
    wide: true,
    body: h(
      'div.stack',
      h('p.muted.sm', { style: { margin: '0' } }, '发给客户看这次做到哪了。图片发微信最好用，文字想改两句就复制。'),
      h('div.sechead', { style: { marginBottom: '0' } }, h('h3', '图片'), h('span.sechead__note', '一张竖图，直接发')),
      imgBox,
      h('div.sechead', { style: { marginBottom: '0' } }, h('h3', '文字'), h('span.sechead__note', '复制了就能粘')),
      pre,
      h('div.note', '进度、资源变化、截图张数都会带上。截图原图发不进这张图里，图上只会写「附 N 张截图」，图还是自己另发。')
    ),
    actions: [
      { label: '关闭', onClick: () => m.close() },
      // 两个动作都不关窗，方便复制完文字再存张图
      { label: '复制文字', onClick: () => { doCopy(); return false } },
      { label: '存成图片', tone: 'primary', onClick: () => { doImage(); return false } },
    ],
  })
  void ctx
}

/* ============================================================
   客户端试算（和服务器同一套口径，仅用于即时预览）
   ============================================================ */

function unitPriceFor(service, tiers, qty) {
  const list = (tiers || []).filter(Boolean)
  for (const t of list) {
    const lo = Number(t.min_qty) || 0
    const hi = t.max_qty === null || t.max_qty === undefined || t.max_qty === '' ? Infinity : Number(t.max_qty)
    if (qty >= lo && qty <= hi) return Number(t.unit_price) || 0
  }
  let pick = null
  for (const t of [...list].sort((a, b) => Number(a.min_qty) - Number(b.min_qty))) {
    if (qty >= (Number(t.min_qty) || 0)) pick = t
  }
  if (pick) return Number(pick.unit_price) || 0
  return Number(service.base_price) || 0
}

const defaultUnit = (s) =>
  s.unit_label || { fixed: '单', daily: '天', per_time: '次', per_unit: '个', package: '套' }[s.price_type] || '单'

/**
 * 这个服务项大概要做多少天。按信息量从大到小推：
 *   1. 单位写成「30天」这种 → 取那个数 × 数量（你库里日体/精托/全托都是这种）
 *   2. 单位就是「天 / 日」→ 数量
 *   3. 按天计价但没写单位 → 数量
 *   4. 其它（单 / 次 / 层 / 个 / 套）→ 推不出来，返回 0（那就不自动填交付日期）
 */
function serviceDays(svc, qty) {
  const n = Number(qty) || 0
  if (n <= 0) return 0
  const unit = String(svc.unit_label || '').trim()
  const m = /^(\d+(?:\.\d+)?)\s*[天日]$/.exec(unit)
  if (m) return Number(m[1]) * n
  if (unit === '天' || unit === '日') return n
  if (!unit && svc.price_type === 'daily') return n
  return 0
}

/** 'YYYY-MM-DD' 往后推 n 天 */
function addDays(iso, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  if (!m) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  d.setDate(d.getDate() + Number(n))
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 大类/服务项两级的「每天都做」：服务项自己设了就听它的，没设（null）跟着大类走 */
const svcIsDaily = (s) => (s.is_daily === null || s.is_daily === undefined ? Boolean(s._catDaily) : Boolean(s.is_daily))

function calcPicked(picked, servicesById) {
  let subtotal = 0
  let addons = 0
  const lines = []
  for (const [id, sel] of picked) {
    const svc = servicesById.get(id)
    if (!svc) continue
    const qty = Number(sel.quantity) || 1
    const auto = unitPriceFor(svc, sel.tiers, qty)
    const unit = sel.unitPrice === '' || sel.unitPrice === null || sel.unitPrice === undefined ? auto : Number(sel.unitPrice)
    const base = unit * qty
    let add = 0
    for (const o of sel.options || []) {
      if (!sel.optionIds.has(o.id)) continue
      add += o.price_mode === 'percent' ? (base * Number(o.price)) / 100 : Number(o.price)
    }
    subtotal += base
    addons += add
    lines.push({ svc, qty, unit, base, add, amount: base + add })
  }
  return { lines, subtotal, addons }
}

/* ============================================================
   下单台
   ============================================================ */

export async function openComposer(ctx, { existing = null, presetCustomer = null } = {}) {
  const [book, custRes, gameRes] = await Promise.all([
    api.get('/api/pricebook'),
    api.get('/api/customers', { status: 'active', limit: 500 }),
    api.get('/api/games', { status: 'active' }),
  ])

  const customers = custRes.items || []
  const games = gameRes.items || []
  const allServices = []
  for (const cat of book.categories) {
    // _catDaily 带上大类的「每天都做」，服务项自己没设时要用它兜底
    for (const s of cat.services) allServices.push({ ...s, _catName: cat.name, _catId: cat.id, _catDaily: cat.is_daily })
  }
  for (const s of book.loose) allServices.push({ ...s, _catName: '未分类', _catId: 0, _catDaily: false })
  const servicesById = new Map(allServices.map((s) => [s.id, s]))

  const picked = new Map()
  const unmappable = [] // 明细指向的服务项已经不在价格表里（比如报价单转来的单），改不了
  if (existing) {
    for (const it of existing.items || []) {
      const svc = servicesById.get(it.ref_id)
      const optionIds = new Set((it.snapshot?.addons || []).map((a) => a.id))
      if (svc) {
        picked.set(svc.id, {
          quantity: it.quantity,
          unitPrice: it.snapshot?.price_overridden ? it.unit_price : '',
          optionIds,
          tiers: svc.tiers || [],
          options: svc.options || [],
        })
      } else {
        unmappable.push(it)
      }
    }
  }

  /* —— 顶部：客户 / 游戏 / 日期 —— */
  const custSel = h('select.sel')
  custSel.appendChild(h('option', { value: '' }, '— 选客户 —'))
  for (const c of customers) {
    const o = h('option', { value: String(c.id) }, `${c.name}${c.phone ? ` · ${c.phone}` : ''}`)
    if (existing ? existing.customer_id === c.id : presetCustomer === c.id) o.selected = true
    custSel.appendChild(o)
  }

  const gameSel = h('select.sel')
  gameSel.appendChild(h('option', { value: '' }, '— 选游戏 —'))
  for (const g of games) {
    const o = h('option', { value: String(g.id) }, g.name)
    if (existing && existing.game_id === g.id) o.selected = true
    gameSel.appendChild(o)
  }

  const dateInp = h('input.inp', { type: 'date', value: existing ? fmtDate(existing.ordered_at) : todayStr() })
  const titleInp = h('input.inp', { placeholder: '不填就用服务名拼一个', value: existing?.title || '' })
  const dueInp = h('input.inp', { type: 'date', value: existing?.due_at ? fmtDate(existing.due_at) : '' })

  /* 交付日期：单子里有「每天都做」的服务项时，按它要做的天数自动填
     （日体套餐 30 天 → 交付 = 下单 + 30）。
     用户自己改过就撒手不管；把日期清空 = 交回给自动。 */
  let dueTouched = Boolean(existing?.due_at)
  let dueAuto = { days: 0, name: '' }

  /* 下单日期和交付日期之间：还剩几天。
     「剩余」按今天算（这才是你真正关心的），另外把「下单到交付一共几天」也带上。 */
  const remainBox = h('div.remain')
  function paintRemain() {
    remainBox.replaceChildren()
    remainBox.className = 'remain'
    const info = remainInfo(dateInp.value, dueInp.value)
    if (info.kind === 'none') {
      // 还没填交付日期：别用一个大色块占着位置，留一行浅提示就行
      remainBox.classList.add('remain--none')
      if (!dueInp.value) remainBox.appendChild(h('span.dim.sm', '填了交付日期，这里会算还剩几天'))
      return
    }
    if (info.kind === 'invalid') {
      remainBox.classList.add('remain--bad')
      remainBox.appendChild(h('span.remain__big', '交付日期比下单日期还早'))
      remainBox.appendChild(h('span.dim.sm', `下单到交付 ${info.span} 天，检查一下`))
      return
    }
    remainBox.classList.add(`remain--${info.kind}`)
    remainBox.appendChild(h('span.remain__big', info.text))
    // 写「下单到交付 30 天」而不是「一共 31 天」：自动填的交付日期就是按服务项
    // 的天数推出来的，这里再用「算头算尾」的 31 天，跟上面「30 天」自相矛盾。
    if (info.span !== null) remainBox.appendChild(h('span.dim.sm', `下单到交付 ${info.span} 天`))
    // 说清楚这个日期是怎么来的，免得以为是手滑填错了
    if (dueAuto.days > 0) {
      remainBox.appendChild(
        h('span.dim.sm', `${dueAuto.name ? `按「${dueAuto.name}」` : ''}${dueAuto.days} 天自动填的，可以直接改`)
      )
    }
  }
  dateInp.addEventListener('input', paintRemain)
  dateInp.addEventListener('change', paintRemain)
  dateInp.addEventListener('input', () => {
    if (!dueTouched) paintSummary() // 下单日期改了，自动填的交付日期跟着挪
  })
  dueInp.addEventListener('input', () => {
    // 用户动过就以他填的为准；清空则回到自动。
    // 不管填没填，只要人动过，这个日期就不再是「自动填的」，提示必须撤掉。
    dueTouched = dueInp.value !== ''
    dueAuto = { days: 0, name: '' }
    paintRemain()
  })
  dueInp.addEventListener('change', paintRemain)

  const noteInp = h('textarea.ta', { rows: 2, placeholder: '给客户看的备注' })
  noteInp.value = existing?.note || ''
  const innerInp = h('textarea.ta', { rows: 2, placeholder: '只有自己看得到的备注' })
  innerInp.value = existing?.internal_note || ''

  const discountInp = h('input.inp.inp--fig', { inputmode: 'decimal', value: String(existing?.discount ?? 0) })
  const feeInp = h('input.inp.inp--fig', { inputmode: 'decimal', value: String(existing?.platform_fee ?? 0) })
  const costInp = h('input.inp.inp--fig', { inputmode: 'decimal', value: String(existing?.cost ?? 0) })

  /* —— 服务挑选区 —— */
  const svcSearch = h('input.inp', { type: 'search', placeholder: '搜服务名…' })
  const svcList = h('div.picker__scroll')
  const pickerFoot = h('div.picker__foot')
  const summaryBox = h('div.stack.stack--tight')
  const totalFig = h('span.quote-sheet__totalfig')
  let gameFilter = ''

  function renderServices() {
    const q = svcSearch.value.trim().toLowerCase()
    recordPainters.length = 0
    const cats = new Map()
    for (const s of allServices) {
      if (!s.name) continue
      if (gameFilter && String(s.game_id || '') !== gameFilter && s.game_id) continue
      // 大类筛：跟搜索、游戏筛是「都要满足」的关系
      if (catFilter && String(s._catId || '') !== catFilter) continue
      if (q && !(`${s.name} ${s.description} ${s._catName}`.toLowerCase().includes(q))) continue
      const key = s._catName || '未分类'
      if (!cats.has(key)) cats.set(key, [])
      cats.get(key).push(s)
    }
    svcList.replaceChildren()
    if (!cats.size) {
      svcList.appendChild(
        h(
          'div.empty',
          h('div.empty__body', '没有匹配的服务项。'),
          h('button.btn.btn--sm', { type: 'button', onclick: () => ctx.navigate('/price') }, '去价格表加一个')
        )
      )
      return
    }
    for (const [catName, list] of cats) {
      const group = h(
        'div.pickgroup',
        h(
          'div.pickgroup__head',
          h('span.pickgroup__name', catName),
          h('span.pickgroup__n', `${list.length} 项`)
        )
      )
      for (const s of list) {
        group.appendChild(serviceRow(s))
      }
      svcList.appendChild(group)
    }
    paintPickerFoot()
  }

  /** 「已选 N 项 + 共多少钱」，顺带一个清空 */
  function paintPickerFoot() {
    const n = picked.size
    // 用 mount 而不是 replaceChildren：replaceChildren(null) 会把 null
    // 变成文字「null」挂在界面上（这里以前就会显示「还没勾服务项 null」）。
    mount(
      pickerFoot,
      n
        ? h('span.cluster', { style: { gap: '6px' } }, h('span.pickcount', String(n)), h('span', '已选'))
        : h('span.dim', '还没勾服务项'),
      h('div', { style: { flex: '1' } }),
      n
        ? h(
            'button.btn.btn--sm.btn--quiet',
            {
              type: 'button',
              onclick: () => {
                picked.clear()
                for (const p of recordPainters) if (p) p()
                paintSummary()
                paintPickerFoot()
              },
            },
            '清空'
          )
        : null
    )
  }

  function serviceRow(s) {
    const cb = h('input.chk', { type: 'checkbox', 'aria-label': `选择 ${s.name}` })
    cb.checked = picked.has(s.id)

    const qty = h('input.inp.inp--fig', { inputmode: 'decimal', style: { width: '76px' }, 'aria-label': `${s.name} 数量` })
    const price = h('input.inp.inp--fig', { inputmode: 'decimal', style: { width: '86px' }, placeholder: '改价', 'aria-label': `${s.name} 单价` })
    const optWrap = h('div.cluster', { style: { gap: '10px' } })
    const tierHint = h('span.dim.tiny')
    const qtyBox = h('div.cluster', { style: { gap: '6px' } }, qty, h('span.dim.tiny', defaultUnit(s)), price, h('span.dim.tiny', '元'))
    const ctrl = h('div.pickrow__ctrl', qtyBox)
    const detail = h('div.pickrow__detail')
    const row = h('div.pickrow')

    /** 只重画选中/未选中的外观，不重建输入框（否则打字会掉焦点） */
    function paintRow() {
      const cur = picked.get(s.id)
      row.classList.toggle('pickrow--on', Boolean(cur))
      cb.checked = Boolean(cur)
      ctrl.style.display = cur ? '' : 'none'
      detail.style.display = cur ? '' : 'none'
      if (!cur) return
      if (document.activeElement !== qty) qty.value = String(cur.quantity)
      if (document.activeElement !== price) price.value = cur.unitPrice === '' ? '' : String(cur.unitPrice)
      const auto = unitPriceFor(s, s.tiers, Number(cur.quantity) || 1)
      tierHint.textContent =
        Number(cur.quantity) >= 1
          ? `按 ${fmtQty(cur.quantity)} ${defaultUnit(s)} 算，基准单价 ¥${fmtMoney(auto)}`
          : ''
    }

    /** 增项只在勾选状态变化时重建 */
    function buildOptions() {
      const cur = picked.get(s.id)
      optWrap.replaceChildren()
      if (!cur) return
      for (const o of cur.options || []) {
        const oc = h('input.chk', { type: 'checkbox' })
        oc.checked = cur.optionIds.has(o.id)
        oc.addEventListener('change', () => {
          if (oc.checked) cur.optionIds.add(o.id)
          else cur.optionIds.delete(o.id)
          paintSummary()
        })
        optWrap.appendChild(
          h(
            'label.inline',
            { style: { cursor: 'pointer', gap: '5px' } },
            oc,
            h('span.sm', o.name),
            h('span.dim.tiny', o.price_mode === 'percent' ? `+${o.price}%` : o.price ? `+${fmtMoney(o.price)}元` : '不加价')
          )
        )
      }
      if (!optWrap.childElementCount) optWrap.appendChild(h('span.dim.tiny', '这个服务项没有增项'))
    }

    row.append(
      h(
        'div.pickrow__top',
        cb,
        h(
          'button.pickrow__main',
          { type: 'button', onclick: () => toggle() },
          h(
            'span.pickrow__line',
            h('span.pickrow__name', s.name),
            // 价格常驻：不勾选也知道多少钱
            h('span.pickrow__fig', `¥${fmtMoney(s.base_price)}`, h('em', `/${defaultUnit(s)}`))
          ),
          h(
            'span.pickrow__meta',
            [
              PRICE_TYPE_LABEL[s.price_type] || s.price_type,
              s.tiers?.length ? `${s.tiers.length} 档阶梯价` : null,
              s.description || null,
            ]
              .filter(Boolean)
              .join(' · ')
          )
        )
      ),
      ctrl,
      detail
    )
    detail.append(optWrap, tierHint)

    function toggle() {
      if (picked.has(s.id)) picked.delete(s.id)
      else
        picked.set(s.id, {
          quantity: Number(s.min_qty) || 1,
          unitPrice: '',
          // 价格表里勾了「默认选中」的增项，开单时直接带上 ——
          // 不然每次都要手动补勾一遍，等于白设。
          optionIds: new Set((s.options || []).filter((o) => o.default_selected).map((o) => o.id)),
          tiers: s.tiers || [],
          options: s.options || [],
        })
      buildOptions()
      paintRow()
      paintSummary()
    }
    cb.addEventListener('change', toggle)

    qty.addEventListener('input', () => {
      const cur = picked.get(s.id)
      if (!cur) return
      const raw = qty.value.trim()
      const v = Number(raw)
      const bad = raw !== '' && !Number.isFinite(v)
      // 空着当 1（金额那边也是 || 1）；填了非数字就标红，并且按 0 存 ——
      // 绝不能让 NaN 流进金额，那会把整单算成 ¥0 还存下去。
      qty.classList.toggle('is-bad', bad)
      cur.quantity = raw === '' || bad ? 0 : v
      paintRow()
      paintSummary()
    })
    price.addEventListener('input', () => {
      const cur = picked.get(s.id)
      if (!cur) return
      const raw = price.value.trim()
      const v = Number(raw)
      const bad = raw !== '' && !Number.isFinite(v)
      // 填了非数字：标红，并且这一行退回「按基准单价算」。
      // 以前是直接 Number() → NaN，合计会静默变成 ¥0，保存还真的把单价写成 0。
      price.classList.toggle('is-bad', bad)
      cur.unitPrice = raw === '' || bad ? '' : v
      paintSummary()
    })

    recordPainters.push(paintRow)
    if (picked.has(s.id)) buildOptions() // 改单时这个服务项已经选中，增项勾选框也得建出来
    paintRow()
    return row
  }

  const recordPainters = []

  /** 勾着的「每天都做」服务项里，要做最久的那条要多少天（顺带记下名字好写提示） */
  function dailyPlan() {
    let days = 0
    let name = ''
    for (const [id, sel] of picked) {
      const svc = servicesById.get(id)
      if (!svc || !svcIsDaily(svc)) continue
      const d = serviceDays(svc, sel.quantity)
      if (d > days) {
        days = d
        name = svc.name
      }
    }
    return { days, name }
  }

  /* —— 汇总 —— */
  function paintSummary() {
    const { lines, subtotal, addons } = calcPicked(picked, servicesById)
    const discount = Math.max(0, Number(discountInp.value) || 0)
    const fee = Math.max(0, Number(feeInp.value) || 0)
    const cost = Math.max(0, Number(costInp.value) || 0)
    const total = Math.max(0, subtotal + addons - discount)
    totalFig.textContent = `¥${fmtMoney(total)}`

    // 单子里有每天都做的服务项 → 交付日期按天数自动填。
    // 用户自己动过交付日期就不碰了；清空则回到自动。
    if (!dueTouched) {
      const plan = dailyPlan()
      const next = plan.days > 0 ? addDays(dateInp.value, plan.days) : ''
      if (dueInp.value !== next) {
        dueInp.value = next
        dueAuto = plan.days > 0 ? plan : { days: 0, name: '' }
        paintRemain()
      } else {
        dueAuto = plan.days > 0 ? plan : { days: 0, name: '' }
      }
    }
    summaryBox.replaceChildren(
      h(
        'div',
        { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px', fontSize: 'var(--fs-sm)' } },
        h('span.dim', `服务小计（${lines.length} 项）`),
        h('span.num', `¥${fmtMoney(subtotal)}`),
        h('span.dim', '增项合计'),
        h('span.num', `¥${fmtMoney(addons)}`),
        h('span.dim', '折扣'),
        h('span.num.tone-oxblood', `−¥${fmtMoney(discount)}`),
        h('span.dim', '利润预估'),
        h('span.num', `¥${fmtMoney(total - fee - cost)}`)
      )
    )
    // 服务行的背景跟着选中状态走
    for (const p of recordPainters) if (p) p()
    // 已选数量也一起刷新
    paintPickerFoot()
  }

  svcSearch.addEventListener('input', debounce(renderServices, 140))
  for (const inp of [discountInp, feeInp, costInp]) inp.addEventListener('input', paintSummary)

  const gameFilterSel = h('select.sel', { style: { width: 'auto', minWidth: '130px' }, 'aria-label': '按游戏筛选' })
  gameFilterSel.appendChild(h('option', { value: '' }, '全部游戏'))
  for (const g of games) gameFilterSel.appendChild(h('option', { value: String(g.id) }, g.name))

  /* 按大类筛。**大类列表完全由上面选的游戏决定** ——
     选了某个游戏就只列这个游戏的大类，选了「全部游戏」才列全部。
     唯一的例外：这个游戏一个大类都没有（服务项全挂在「通用」大类下）时，
     把通用大类带上，否则筛选框空着没法用。 */
  let catFilter = ''
  const catFilterSel = h('select.sel', { style: { width: 'auto', minWidth: '130px' }, 'aria-label': '按大类筛选' })

  const pickableCats = () => {
    const withSvc = book.categories.filter((c) => c.services && c.services.length)
    if (!gameFilter) return withSvc
    const own = withSvc.filter((c) => String(c.game_id || '') === gameFilter)
    return own.length ? own : withSvc.filter((c) => !c.game_id)
  }

  function paintCatFilter() {
    const list = pickableCats()
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

  gameFilterSel.addEventListener('change', () => {
    gameFilter = gameFilterSel.value
    paintCatFilter()
    renderServices()
  })

  paintCatFilter()
  renderServices()
  paintSummary()
  paintRemain()

  /* —— 抽屉 —— */
  // 两列排：日期成对、金额成对。以前每一栏都写 field--full，
  // 760 宽的抽屉里一路全宽控件排到天边，找个「成本」要滚半天。
  const body = h(
    'div.stack',
    h(
      'div.formgrid',
      h(
        'div.field',
        h('label.lbl', '客户 *'),
        // nowrap + 让 select 自己缩：不然 select 的 width:100% 会把「新客户」挤到下一行
        h(
          'div.cluster',
          { style: { gap: '6px', flexWrap: 'nowrap' } },
          h('div', { style: { flex: '1 1 auto', minWidth: '0' } }, custSel),
          addCustomerBtn()
        )
      ),
      h('div.field', h('label.lbl', '游戏'), gameSel),
      h('div.field', h('label.lbl', '下单日期'), dateInp),
      h('div.field', h('label.lbl', '交付日期'), dueInp),
      // 两个日期下面：还剩几天
      h('div.field.field--full', remainBox),
      h('div.field.field--full', h('label.lbl', '订单标题'), titleInp)
    ),
    h('div', h('div.sechead', h('h3', '挑服务'), h('span.sechead__note', '勾上就进单子，数量可以改'))),
    h('div.cluster', { style: { marginBottom: '6px' } }, svcSearch, gameFilterSel, catFilterSel),
    h('div.picker', svcList, pickerFoot),
    h('div', h('div.sechead', h('h3', '金额'))),
    h(
      'div.formgrid',
      h('div.field', h('label.lbl', '折扣（元）'), discountInp),
      h('div.field', h('label.lbl', '平台手续费（元）'), feeInp),
      h('div.field', h('label.lbl', '成本（元）'), costInp)
    ),
    summaryBox,
    unmappable.length
      ? h(
          'div.note.note--warn',
          `这张单有 ${unmappable.length} 条明细（${unmappable
            .map((i) => i.name)
            .join('、')}）在价格表里已经找不到对应的服务项，多半是从报价单转过来的。` +
            '这几条在这里改不了，保存时会原样保留（不会被删掉，也不会被重算）。其它明细的改动照常保存。'
        )
      : null,
    h('div', h('div.sechead', h('h3', '备注'))),
    h('div.field.field--full', h('label.lbl', '给客户看的备注'), noteInp),
    h('div.field.field--full', h('label.lbl', '只有自己看得到的备注'), innerInp),
    h('div.note', '提交后，服务名、单价、数量、套餐内容、增项会一起冻进这张单的快照里。之后你在价格表里怎么改价，这张单都不受影响。')
  )

  function addCustomerBtn() {
    return h(
      'button.btn.btn--sm',
      {
        type: 'button',
        onclick: async () => {
          const created = await customerForm()
          if (!created) return
          const o = h('option', { value: String(created.id) }, `${created.name}${created.phone ? ` · ${created.phone}` : ''}`)
          custSel.appendChild(o)
          custSel.value = String(created.id)
        },
      },
      icon('plus', 14),
      '新客户'
    )
  }

  const submitBtn = h('button.btn.btn--primary', { type: 'button' }, existing ? '保存改动' : '开单')
  const d = drawer({
    title: existing ? `改单 · ${existing.order_no}` : '开一张新单',
    subtitle: existing ? '改完会重算金额并替换明细快照' : '选客户、挑服务，价格自动算',
    wide: true,
    body,
    footer: [
      h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flex: '1' } }, h('span.sm.dim', '合计'), totalFig),
      h('button.btn', { type: 'button', onclick: () => d.close() }, '取消'),
      submitBtn,
    ],
  })

  submitBtn.addEventListener('click', async () => {
    if (!custSel.value && !gameSel.value && !picked.size) {
      toast('至少选一个客户和一个服务项', 'err')
      return
    }
    if (!picked.size) {
      toast('还没挑服务项', 'err')
      return
    }
    if (!custSel.value) {
      toast('先选客户，或者点「新客户」建一个', 'err')
      custSel.focus()
      return
    }
    const editableById = new Map(
      [...picked.entries()].map(([id, sel]) => [
        id,
        {
          service_id: id,
          quantity: Number(sel.quantity) || 1,
          option_ids: [...sel.optionIds],
          unit_price: sel.unitPrice === '' ? undefined : Number(sel.unitPrice),
        },
      ])
    )

    // 拼出这次要保存的明细，顺序尽量跟原来一致：
    //   · 原来就有、现在还能改的 → 用新填的值
    //   · 原来就有、服务项已经没了的 → 带 keep_id 原样保留（服务端从库里读，不重算）
    //   · 原来有但现在被取消勾选的 → 不带，等于删掉
    //   · 这次新挑的 → 追加到最后
    const items = []
    const usedIds = new Set()
    if (existing) {
      const unmappableIds = new Set(unmappable.map((it) => it.id))
      for (const it of existing.items || []) {
        if (unmappableIds.has(it.id)) {
          items.push({ keep_id: it.id })
          continue
        }
        const editable = editableById.get(it.ref_id)
        if (editable) {
          items.push(editable)
          usedIds.add(it.ref_id)
        }
      }
    }
    for (const [id, payloadItem] of editableById) {
      if (!usedIds.has(id)) items.push(payloadItem)
    }

    const payload = {
      customer_id: Number(custSel.value),
      game_id: gameSel.value ? Number(gameSel.value) : null,
      title: titleInp.value,
      discount: Number(discountInp.value) || 0,
      platform_fee: Number(feeInp.value) || 0,
      cost: Number(costInp.value) || 0,
      ordered_at: dateInp.value,
      due_at: dueInp.value || null,
      note: noteInp.value,
      internal_note: innerInp.value,
      // 明细一律发出去 —— 改不了的用 keep_id 让服务端原样保留，
      // 这样其它明细的改动才存得下来。
      items,
    }
    submitBtn.setAttribute('data-loading', '1')
    submitBtn.disabled = true
    try {
      const saved = existing ? await api.patch(`/api/orders/${existing.id}`, payload) : await api.post('/api/orders', payload)
      if (existing && unmappable.length) toast('单据已更新（那几条改不了的明细原样保留）', 'ok', 3400)
      else toast(existing ? '单据已更新' : `开单成功 · ${saved.order_no}`, 'ok')
      d.close()
      if (!existing) ctx.navigate(`/orders/${saved.id}`)
      else ctx.app.reload()
    } catch (err) {
      toastErr(err)
    } finally {
      submitBtn.removeAttribute('data-loading')
      submitBtn.disabled = false
    }
  })

  return d
}

/* ============================================================
   客户表单（下单台内联用）
   ============================================================ */

export function customerForm(values = {}, { title = '新客户' } = {}) {
  return formDrawer({
    title,
    submitLabel: '保存',
    values,
    fields: [
      imageField({
        name: 'avatar',
        label: '头像',
        value: values.avatar || '',
        prefix: 'customer',
        shape: 'circle',
        size: 60,
        hint: '选填。会显示在客户列表和订单列表上，客户多了好认。',
      }),
      { name: 'name', label: '昵称', type: 'text', required: true, placeholder: '客户怎么称呼' },
      { name: 'phone', label: '手机号', type: 'text', width: 'half', hint: '用作客户标识，方便搜索' },
      { name: 'wechat', label: '微信', type: 'text', width: 'half' },
      { name: 'qq', label: 'QQ', type: 'text', width: 'half' },
      {
        name: 'source',
        label: '来源',
        type: 'select',
        width: 'half',
        default: values.source || '微信',
        options: ['微信', 'QQ群', '朋友介绍', '闲鱼', '贴吧', '回头客', '其他'].map((v) => ({ value: v, label: v })),
      },
      { name: 'tags', label: '标签', type: 'tags', hint: '例如：爽快、老客户、要发票' },
      { name: 'note', label: '备注', type: 'textarea', rows: 3, placeholder: '作息、沟通习惯、忌讳…' },
    ],
    onSubmit: async (v) => (values.id ? api.patch(`/api/customers/${values.id}`, v) : api.post('/api/customers', v)),
  })
}

/* ============================================================
   订单详情
   ============================================================ */

async function renderDetail(ctx, id) {
  const o = await api.get(`/api/orders/${id}`)
  const closed = ['done', 'cancelled'].includes(o.status)

  /** 今日已完成：日体、包天那种天天要做的单，今天做完了先挪出「在做」，明天自己回来 */
  const dailyDone = async (done) => {
    // 撤销不用问。标记时如果这张单里还夹着「一次性的活」（比如 30天日体 + 两个活动），
    // 得先提醒一句 —— 标完整张单都会从「在做」里消失，别把没做的活动一起藏了。
    if (done && (o.other_items || []).length) {
      const ok = await confirmModal({
        title: '这张单里还有别的活',
        message: `标成「今日已完成」之后，整张单这个「今天」都会从「在做」里消失，过了凌晨 4 点才回来。这张单里除了每天要做的，还有：${o.other_items.join('、')}。这些今天也做完了吗？`,
        confirmLabel: '都做完了，标吧',
      })
      if (!ok) return
    }
    try {
      await api.post(`/api/orders/${o.id}/daily-done`, { done })
      toast(done ? '标成今日完成，过了凌晨 4 点自动回到「在做的」' : '已撤销，回到「在做的」', 'ok', 3400)
      ctx.app.reload()
    } catch (err) {
      toastErr(err)
    }
  }

  /** 直接推进到已完成（状态机允许才能走，比如还没付钱的单会被拦下） */
  const finishNow = async () => {
    const ok = await confirmModal({
      title: `把 ${o.order_no} 标成已完成？`,
      message: '整张单就结束了，不再出现在「在做的」里。如果这是每天都要做的日体单，应该用「今日已完成」。',
      confirmLabel: '标成已完成',
    })
    if (!ok) return
    try {
      await api.post(`/api/orders/${o.id}/status`, { status: 'done' })
      toast('订单已完成', 'ok')
      ctx.app.reload()
    } catch (err) {
      toastErr(err)
    }
  }

  /** 拆单：把几个服务项挪到一张新单上，两边各自收款结单 */
  const splitOrder = () => {
    const pickedIds = new Set()
    const list = h('div.itemlist')
    for (const it of o.items) {
      const cb = h('input.chk', { type: 'checkbox', 'aria-label': `拆出 ${it.name}` })
      cb.addEventListener('change', () => {
        if (cb.checked) pickedIds.add(it.id)
        else pickedIds.delete(it.id)
        paintFoot()
      })
      list.appendChild(
        h(
          'label.item',
          { style: { cursor: 'pointer', alignItems: 'center', gap: '10px' } },
          cb,
          h(
            'div.item__main',
            h('div.item__title', it.name, it.is_daily ? tag('每天做', 'jade') : null),
            it.spec ? h('div.tbl__meta', it.spec) : null
          ),
          h('div.item__right', h('div.item__fig', `¥${fmtMoney(it.amount)}`))
        )
      )
    }
    const foot = h('div.note.note--warn')

    // 收款 / 进度怎么跟着走
    const paySel = h(
      'select.sel',
      { 'aria-label': '收款怎么分' },
      h('option', { value: 'proportional' }, '按金额比例分到两张单（推荐）'),
      h('option', { value: 'keep' }, '全部留在原单')
    )
    const progSel = h(
      'select.sel',
      { 'aria-label': '进度时间线怎么处理' },
      h('option', { value: 'keep' }, '留在原单'),
      h('option', { value: 'move' }, '跟到新单')
    )
    const hasPay = (o.payments || []).length > 0
    const hasProg = (o.progress || []).length > 0

    const m = modal({
      title: `拆单 · ${o.order_no}`,
      wide: true,
      body: h(
        'div.stack',
        h('p.sm', '适合「30天日体 + 几个活动」这种单：把活动拆出去单独结算，日体那张继续天天标今日完成。'),
        h('p.sm.dim', '勾上要拆出去的 —— 选中的会变成一张新单，没选的留在原单。'),
        list,
        // 已经记过收款/进度才问，没有就不用烦
        hasPay
          ? h('div.field', h('label.lbl', `收款怎么分（这张单已收 ¥${fmtMoney(o.paid_total)}）`), paySel)
          : null,
        hasProg ? h('div.field', h('label.lbl', `进度时间线（现有 ${o.progress.length} 条）`), progSel) : null,
        foot
      ),
      actions: [
        { label: '取消' },
        {
          label: '拆成新单',
          tone: 'primary',
          key: 'go',
          onClick: async ({ close }) => {
            try {
              const r = await api.post(`/api/orders/${o.id}/split`, {
                item_ids: [...pickedIds],
                payments: paySel.value,
                progress: progSel.value,
              })
              close()
              const bits = [`已拆出 ${r.moved_count} 项，新单 ${r.created.order_no}`]
              if (r.payments_moved) bits.push(`收款分了 ${r.payments_moved} 笔`)
              if (r.progress_moved) bits.push(`进度跟过去 ${r.progress_moved} 条`)
              toast(bits.join(' · '), 'ok', 4600)
              if (r.original_overpaid > 0.001) {
                setTimeout(
                  () =>
                    toast(
                      `注意：原单还留着 ¥${fmtMoney(r.original_paid)} 的收款，但金额只剩 ¥${fmtMoney(r.original.total)}，多收了 ¥${fmtMoney(r.original_overpaid)}`,
                      'err',
                      9000
                    ),
                  400
                )
              }
              ctx.app.reload()
            } catch (err) {
              toastErr(err)
              return false
            }
          },
        },
      ],
    })
    function paintFoot() {
      const n = pickedIds.size
      const rest = o.items.length - n
      foot.replaceChildren(
        h(
          'span',
          n === 0
            ? '还没勾任何服务项。'
            : rest === 0
              ? '不能全拆走 —— 原单得至少留一个服务项（整张都要挪的话，不如直接改这一张）。'
              : `拆出去 ${n} 项，原单留 ${rest} 项。折扣 / 手续费 / 成本留在原单，新单从 0 开始。`
        )
      )
      if (m.setDisabled) m.setDisabled('go', n === 0 || rest === 0)
    }
    paintFoot()
  }

  ctx.setActions(
    h('button.btn.btn--sm', { type: 'button', onclick: () => progressDrawer(o, () => ctx.app.reload()) }, icon('edit', 14), '记进度'),
    o.due_total > 0.001
      ? h('button.btn.btn--sm', { type: 'button', onclick: () => paymentDrawer(o, () => ctx.app.reload()) }, icon('wallet', 14), '记收款')
      : null,
    // 每天要做的单：今天做完了先标掉，明天自己回来
    !closed
      ? h(
          'button.btn.btn--sm',
          {
            type: 'button',
            title: o.daily_done_today ? '撤销今日完成，重新回到「在做」' : '今天这份做完了，先挪出「在做」，明天自动回来',
            onclick: () => dailyDone(!o.daily_done_today),
          },
          icon(o.daily_done_today ? 'refresh' : 'check', 14),
          o.daily_done_today ? '撤销今日完成' : '今日已完成'
        )
      : null,
    // 状态机允许的话，一步标成整单完成
    !closed && (o.next_statuses || []).includes('done')
      ? h('button.btn.btn--sm.btn--primary', { type: 'button', title: '整张单结束', onclick: finishNow }, icon('check', 14), '标记完成')
      : null,
    h(
      'button.btn.btn--sm',
      { type: 'button', onclick: () => statusDrawer(o, () => ctx.app.reload()) },
      '推进状态'
    ),
    h('button.btn.btn--sm', { type: 'button', onclick: () => openComposer(ctx, { existing: o }) }, icon('price', 14), '改明细'),
    // 混着日常和一次性的单：把一次性的拆出去，两边各自结算
    o.items.length > 1
      ? h('button.btn.btn--sm', { type: 'button', title: '把其中几个服务项拆成一张新单', onclick: splitOrder }, icon('copy', 14), '拆单')
      : null,
    h(
      'button.btn.btn--sm.btn--icon',
      {
        type: 'button',
        title: '删除订单',
        onclick: async () => {
          const ok = await confirmDelete({
            title: '删除这张单？',
            message: `订单 ${o.order_no} 及其进度、收款记录会一并消失，不能撤销。如果只是不做了，建议改成「已取消」。`,
          })
          if (!ok) return
          try {
            await api.del(`/api/orders/${o.id}`)
            toast('订单已删除', 'ok')
            ctx.navigate('/orders')
          } catch (err) {
            toastErr(err)
          }
        },
      },
      icon('trash', 14)
    )
  )

  /* —— 金额栏 —— */
  const moneyRows = [
    ['服务小计', `¥${fmtMoney(o.items_subtotal)}`],
    ['增项合计', `¥${fmtMoney(o.addon_total)}`],
    ['折扣', `−¥${fmtMoney(o.discount)}`],
    ['平台手续费', `¥${fmtMoney(o.platform_fee)}`],
    ['成本', `¥${fmtMoney(o.cost)}`],
  ]

  return h(
    'div.stack',
    /* 抬头 */
    h(
      'section.panel',
      h(
        'div.panel__body',
        h(
          'div.cluster',
          { style: { justifyContent: 'space-between', alignItems: 'flex-start' } },
          h(
            'div',
            { style: { minWidth: '0' } },
            h('div.cluster', h('span.mono.strong', o.order_no), lamp(o.status_label, STATUS_TONE[o.status] || 'muted'), copyButton(o.order_no, '复单号', { size: 'icon' })),
            h('h1', { style: { marginTop: '4px' } }, o.title || '（没写标题）'),
            h(
              'div.cluster.sm.dim',
              { style: { marginTop: '4px' } },
              h('span', o.customer_name || '散客'),
              h('span', '·'),
              h('span', o.game_name || '未指定游戏'),
              h('span', '·'),
              h('span', `下单 ${fmtDateTime(o.ordered_at)}`),
              o.due_at ? h('span', `· 交付 ${fmtDay(o.due_at)}`) : null,
              // 交付日期还剩几天 —— 做完的单就不用提醒了
              (() => {
                if (['done', 'cancelled'].includes(o.status)) return null
                const info = remainInfo(o.ordered_at, o.due_at)
                if (info.kind === 'none') return null
                if (info.kind === 'invalid') return h('span.duepill.duepill--bad', '交付日期填错了')
                return h(`span.duepill.duepill--${info.kind}`, info.text)
              })()
            )
          ),
          h(
            'div',
            { style: { textAlign: 'right' } },
            h('div.cell__lbl', '订单总额'),
            h('div', { style: { fontFamily: 'var(--font-fig)', fontSize: 'var(--fs-2xl)', fontWeight: '600', letterSpacing: '-0.02em' } }, `¥${fmtMoney(o.total)}`),
            h(
              'div.sm',
              o.due_total > 0.001 ? h('span.tone-amber', `还差 ¥${fmtMoney(o.due_total)}`) : h('span.tone-jade', '已结清')
            )
          )
        ),
        h('div', { style: { marginTop: 'var(--sp-4)' } }, orderTrack(o.status, o.status_label)),
        o.customer_id
          ? h(
              'div.cluster',
              { style: { marginTop: 'var(--sp-3)' } },
              h('button.btn.btn--sm', { type: 'button', onclick: () => ctx.navigate(`/customers/${o.customer_id}`) }, '看客户档案'),
              o.credentials?.length
                ? h(
                    'button.btn.btn--sm',
                    { type: 'button', onclick: () => ctx.navigate(`/vault?customer=${o.customer_id}`) },
                    icon('vault', 14),
                    `这个客户有 ${o.credentials.length} 条登录凭证`
                  )
                : null
            )
          : null
      )
    ),

    h(
      'div.split',
      /* 左：明细 + 进度 */
      h(
        'div.stack',
        h(
          'section.panel',
          h('div.panel__body', sectionHead('服务明细（下单时的快照）', '改价格表不影响这里')),
          h('div.panel__body.panel__body--flush', orderItemsList(o.items)),
          h(
            'div.panel__foot',
            h('span.sm.dim', `共 ${o.items.length} 项`),
            h('div', { style: { flex: '1' } }),
            h('span.sm.dim', '合计'),
            h('span.strong', `¥${fmtMoney(o.total)}`)
          )
        ),
        h(
          'section.panel',
          h(
            'div.panel__body',
            sectionHead(
              '进度时间线',
              `${o.progress.length} 条`,
              h('button.btn.btn--sm', { type: 'button', onclick: () => shareProgress(o, ctx) }, icon('quotes', 14), '分享进度'),
              h('button.btn.btn--sm.btn--primary', { type: 'button', onclick: () => progressDrawer(o, () => ctx.app.reload()) }, icon('plus', 14), '记一条')
            )
          ),
          h(
            'div.panel__body',
            { style: { paddingTop: '0' } },
            progressTimeline(o.progress, {
              onEdit: (p) => editProgressDrawer(p, () => ctx.app.reload()),
              onDelete: async (p) => {
                const ok = await confirmDelete({ title: '删掉这条进度？', message: `${fmtDay(p.happened_on)}：${p.content.slice(0, 40)}` })
                if (!ok) return
                try {
                  await api.del(`/api/progress/${p.id}`)
                  toast('已删除', 'ok')
                  ctx.app.reload()
                } catch (err) {
                  toastErr(err)
                }
              },
            })
          )
        )
      ),

      /* 右：钱、收款、备注 */
      h(
        'div.stack',
        h(
          'section.panel',
          h('div.panel__body', sectionHead('钱')),
          h(
            'div.panel__body',
            { style: { paddingTop: '0' } },
            h(
              'div',
              { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '6px 12px', fontSize: 'var(--fs-base)' } },
              ...moneyRows.flatMap(([k, v]) => [h('span.dim', k), h('span.num', v)]),
              h('span.strong', { style: { borderTop: '1px solid var(--line)', paddingTop: '6px', marginTop: '4px' } }, '合计'),
              h('span.num.strong', { style: { borderTop: '1px solid var(--line)', paddingTop: '6px', marginTop: '4px' } }, `¥${fmtMoney(o.total)}`),
              h('span.dim.tone-jade', '已收'),
              h('span.num.tone-jade', `¥${fmtMoney(o.paid_total)}`),
              h('span.dim', o.due_total > 0.001 ? '还差' : '尾款'),
              h('span.num', o.due_total > 0.001 ? `¥${fmtMoney(o.due_total)}` : '0'),
              h('span.dim', '利润'),
              h('span.num', `¥${fmtMoney(o.profit)}`)
            )
          ),
          h(
            'div.panel__body',
            { style: { paddingTop: '0' } },
            h(
              'div.cluster',
              h('button.btn.btn--sm.btn--block', { type: 'button', onclick: () => paymentDrawer(o, () => ctx.app.reload()) }, icon('plus', 14), '记一笔收款')
            )
          )
        ),

        h(
          'section.panel',
          h('div.panel__body', sectionHead('收款记录', `${o.payments.length} 笔`)),
          o.payments.length
            ? h(
                'div.itemlist',
                o.payments.map((p) =>
                  h(
                    'div.item',
                    { style: { cursor: 'default' } },
                    h(
                      'div.item__main',
                      h('div.item__title', PAY_KIND_LABEL[p.kind] || p.kind, tag(PAY_METHOD_LABEL[p.method] || p.method)),
                      h('div.item__meta', h('span', fmtDay(p.paid_at)), p.note ? h('span', p.note) : null)
                    ),
                    h(
                      'div.item__right',
                      h(`div.item__fig${p.kind === 'refund' ? '.tone-oxblood' : '.tone-jade'}`, `${p.kind === 'refund' ? '−' : '+'}¥${fmtMoney(p.amount)}`),
                      h(
                        'button.btn.btn--sm.btn--quiet',
                        {
                          type: 'button',
                          title: '删除这笔',
                          onclick: async () => {
                            const ok = await confirmDelete({ title: '删掉这笔记录？', message: `${PAY_KIND_LABEL[p.kind]} ¥${fmtMoney(p.amount)}（${p.paid_at}）` })
                            if (!ok) return
                            try {
                              await api.del(`/api/payments/${p.id}`)
                              toast('已删除', 'ok')
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
            : h('div.panel__body', h('p.dim.sm', '还没有收款记录。'))
        ),

        o.note || o.internal_note
          ? h(
              'section.panel',
              h('div.panel__body', sectionHead('备注')),
              h(
                'div.panel__body',
                { style: { paddingTop: '0' } },
                o.note ? h('div', h('div.tbl__meta', '给客户看的'), h('p', { style: { whiteSpace: 'pre-wrap' } }, o.note)) : null,
                o.internal_note
                  ? h('div', { style: { marginTop: '10px' } }, h('div.tbl__meta', '只有自己看得到'), h('p', { style: { whiteSpace: 'pre-wrap' } }, o.internal_note))
                  : null
              )
            )
          : null
      )
    )
  )
}

/* ============================================================
   列表页
   ============================================================ */

const FILTERS = [
  { key: 'open', label: '在做的' },
  { key: 'daily_done', label: '今日已完成' },
  { key: 'pending_confirm', label: '待确认' },
  { key: 'pending_pay', label: '待付款' },
  { key: 'in_progress', label: '进行中' },
  { key: 'pending_accept', label: '待验收' },
  { key: 'due', label: '没收齐' },
  { key: 'done', label: '已完成' },
  { key: '', label: '全部' },
]

export default {
  title: '订单',
  async render(ctx) {
    if (ctx.sub === 'new') {
      ctx.setActions()
      const node = await renderList(ctx, '')
      setTimeout(() => openComposer(ctx), 80)
      return node
    }
    if (ctx.sub) return renderDetail(ctx, ctx.sub)
    return renderList(ctx, ctx.query.get('status') ?? 'open')
  },
}

async function renderList(ctx, status) {
  {
    const q = ctx.query.get('q') || ''
    const custId = ctx.query.get('customer_id') || ''
    const sort = ctx.query.get('sort') || ''

    ctx.setActions(
      h('button.btn.btn--sm.btn--primary', { type: 'button', onclick: () => openComposer(ctx) }, icon('plus', 14), '开新单')
    )

    const params = { limit: 300 }
    if (status === 'due') params.due = '1'
    else if (status) params.status = status
    if (q) params.q = q
    // 从客户档案点「看这个客户的全部单」进来时，只筛这一个客户
    if (custId) params.customer_id = custId
    if (sort) params.sort = sort

    const { items } = await api.get('/api/orders', params)

    let cust = null
    if (custId) {
      try {
        cust = await api.get(`/api/customers/${custId}`)
      } catch {
        cust = null
      }
    }

    /** 拼查询串时把当前的筛选都带上，切 tab / 搜索不会把客户筛选弄丢 */
    const href = (over = {}) => {
      const st = 'status' in over ? over.status : status
      const qq = 'q' in over ? over.q : q
      const cc = 'customer_id' in over ? over.customer_id : custId
      const so = 'sort' in over ? over.sort : sort
      const p = new URLSearchParams()
      // status 必须显式带上，哪怕是空串：
      //   ?status=   → 全部
      //   完全没有 status → 落在默认的「在做」上
      // 少了这个，「全部」点下去会被当成默认值，等于点不动。
      p.set('status', st || '')
      if (qq) p.set('q', qq)
      if (cc) p.set('customer_id', cc)
      if (so) p.set('sort', so)
      return `/orders?${p.toString()}`
    }

    const seg = h(
      'div.seg',
      FILTERS.map((f) =>
        h(
          'button.seg__btn',
          {
            type: 'button',
            'aria-pressed': String(f.key === status),
            onclick: () => ctx.navigate(href({ status: f.key })),
          },
          f.label
        )
      )
    )

    const sortSel = h(
      'select.sel',
      { style: { width: 'auto' }, 'aria-label': '排序方式' },
      ...[
        { v: '', l: '最新在前' },
        { v: 'oldest', l: '最早在前' },
        { v: 'customer', l: '按客户排' },
        { v: 'amount', l: '按金额排' },
      ].map((o) => h('option', { value: o.v }, o.l))
    )
    sortSel.value = sort
    sortSel.addEventListener('change', () => ctx.navigate(href({ sort: sortSel.value })))

    const searchInput = h('input.inp', { type: 'search', placeholder: '搜单号 / 标题 / 客户名', value: q, style: { maxWidth: '260px' } })
    searchInput.addEventListener(
      'input',
      debounce(() => {
        ctx.navigate(href({ q: searchInput.value.trim() }), { replace: true })
      }, 300)
    )

    const total = items.reduce(
      (s, o) => {
        s.amount += Number(o.total) || 0
        s.due += Number(o.due_total) || 0
        return s
      },
      { amount: 0, due: 0 }
    )
    // 涉及多少位客户 —— 客户多的时候这个数比单数更有信息量
    const custCount = new Set(items.filter((o) => o.customer_id).map((o) => o.customer_id)).size
    const walkIn = items.filter((o) => !o.customer_id).length

    return h(
      'div.stack',
      h(
        'div.pagehead',
        h(
          'div.pagehead__txt',
          h(
            'h1',
            custId
              ? `${cust?.name || '这个客户'}的单`
              : status === 'open'
                ? '在做的单'
                : status === 'daily_done'
                  ? '今日已完成'
                  : '订单'
          ),
          h(
            'p.pagehead__sub',
            items.length
              ? `${items.length} 张单 · ${custCount} 位客户${walkIn ? ` + ${walkIn} 张散客` : ''} · 合计 ¥${fmtMoney(total.amount)} · 未收 ¥${fmtMoney(total.due)}`
              : ''
          )
        )
      ),
      h(
        'div.toolbar',
        seg,
        // 只看某个客户时给个明显的标签，点 × 就取消筛选
        custId
          ? h(
              'button.filterchip',
              { type: 'button', title: '取消「只看这个客户」', onclick: () => ctx.navigate(href({ customer_id: '' })) },
              `只看「${cust?.name || '这个客户'}」`,
              icon('close', 12)
            )
          : null,
        h('div.toolbar__grow'),
        sortSel,
        searchInput
      ),
      // 今日已完成这一档要解释一下，不然会以为单子丢了
      status === 'daily_done'
        ? h(
            'div.note.note--ok',
            h('span', { style: { flex: 'none' } }, icon('check', 15)),
            h(
              'span',
              '这些是这个「今天」标了「今日已完成」的单 —— 今天不用再管，过了凌晨 4 点它们会自动回到「在做的」。点单号进去可以撤销。'
            )
          )
        : null,
      h(
        'section.panel',
        h(
          'div.panel__body.panel__body--flush',
          items.length
            ? orderTable(items, ctx)
            : emptyState({
                iconName: 'orders',
                title: q ? '没搜到符合条件的单' : status === 'open' ? '手上没有在做的单' : '这个状态下没有单',
                body: q ? '换个单号或者客户名试试。' : '开一张新单：选客户、挑服务，价格会自动算出来。',
                actionLabel: '开新单',
                onAction: () => openComposer(ctx),
              })
        )
      )
    )
  }
}
