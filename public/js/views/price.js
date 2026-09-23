/* ============================================================
   价格表：游戏（一张价格表）→ 大类 → 服务项 → 阶梯价 / 套餐增项
   这一页是"代肝价格查询"的正身。

   结构说明（和用户的心智模型对齐）：
     一个游戏 = 一张价格表
     一张价格表下面挂若干「大类」（日常 / 周常 / 深渊 / 活动…）
     服务项只能挂在大类里，不能直接挂在游戏上
   ============================================================ */

import { api, PRICE_TYPE_LABEL } from '../api.js'
import { h, icon, fmtMoney, fmtQty, debounce, fmtDate, mount, copyText } from '../dom.js'
import { gameForm } from './games.js'
import { renderPriceCard, canvasToBlob, downloadBlob } from '../pricecard.js'
import {
  table,
  toast,
  toastErr,
  drawer,
  formDrawer,
  confirmDelete,
  confirmModal,
  emptyState,
  tag,
  sectionHead,
  copyButton,
  modal,
} from '../ui.js'

const PRICE_TYPES = Object.entries(PRICE_TYPE_LABEL).map(([value, label]) => ({ value, label }))

function unitOf(s) {
  return s.unit_label || { fixed: '单', daily: '天', per_time: '次', per_unit: '个', package: '套' }[s.price_type] || '单'
}

/**
 * 按数量找命中那一档的单价，找不到就退到「起量最大且不超过」那档，再不行用基准价。
 * 规则跟下单台（pricing.mjs）一样 —— 这里算出来多少，开单就是多少。
 */
function tierUnitPrice(s, qty) {
  const tiers = (s.tiers || []).filter(Boolean)
  if (tiers.length) {
    for (const t of tiers) {
      const lo = Number(t.min_qty) || 0
      const hi = t.max_qty === null || t.max_qty === undefined || t.max_qty === '' ? Infinity : Number(t.max_qty)
      if (qty >= lo && qty <= hi) return Number(t.unit_price) || 0
    }
    const sorted = [...tiers].sort((a, b) => (Number(a.min_qty) || 0) - (Number(b.min_qty) || 0))
    let pick = null
    for (const t of sorted) if (qty >= (Number(t.min_qty) || 0)) pick = t
    if (pick) return Number(pick.unit_price) || 0
  }
  return Number(s.base_price) || 0
}

/**
 * 组合报价：把**这一个大类**下勾中的服务项加起来。
 * 客户说「我要这几个」，点几下就知道一共多少钱，不用自己摁计算器。
 * 数量能改，会自动套阶梯价 —— 跟开单时算出来的数一模一样。
 */
export function sumDialog(cat, services) {
  const list = (services || []).filter((s) => s.status !== 'archived')
  const picked = new Set()
  const rows = []
  const totalFig = h('span.sumline__v', '¥0')
  const countNote = h('span.dim.sm', '')
  let m = null

  function paint() {
    let total = 0
    let n = 0
    for (const r of rows) {
      const on = picked.has(r.s.id)
      r.el.classList.toggle('pickrow--on', on)
      r.qty.disabled = !on
      r.unit.style.visibility = on ? 'visible' : 'hidden'
      const q = on ? Math.max(0.01, Number(r.qty.value) || 1) : 1
      const u = tierUnitPrice(r.s, q)
      const amt = on ? u * q : 0
      r.fig.textContent = `¥${fmtMoney(on ? amt : Number(r.s.base_price) || 0)}`
      if (on) {
        total += amt
        n++
      }
      r.hint.textContent = on && (r.s.tiers || []).length ? `按 ${fmtQty(q)} ${unitOf(r.s)} 算，单价 ¥${fmtMoney(u)}` : ''
    }
    totalFig.textContent = `¥${fmtMoney(total)}`
    countNote.textContent = n ? `已选 ${n} 项` : '还没勾'
    if (m && m.setDisabled) m.setDisabled('copy', n === 0)
  }

  const rowFor = (s) => {
    const cb = h('input.chk', { type: 'checkbox', 'aria-label': `选择 ${s.name}` })
    const qty = h('input.inp.inp--fig', { inputmode: 'decimal', style: { width: '64px' }, disabled: true, 'aria-label': `${s.name} 数量` })
    qty.value = String(Number(s.min_qty) || 1)
    const unit = h('span.dim.tiny', unitOf(s))
    const fig = h('span.pickrow__fig', `¥${fmtMoney(Number(s.base_price) || 0)}`)
    const hint = h('div.hint')

    const toggle = () => {
      if (picked.has(s.id)) picked.delete(s.id)
      else picked.add(s.id)
      cb.checked = picked.has(s.id)
      paint()
    }
    cb.addEventListener('change', toggle)
    qty.addEventListener('input', paint)

    const el = h(
      'div.pickrow',
      h(
        'div.pickrow__top',
        cb,
        h(
          'button.pickrow__main',
          { type: 'button', onclick: toggle },
          h('span.pickrow__line', h('span.pickrow__name', s.name), fig),
          h(
            'span.pickrow__meta',
            [PRICE_TYPE_LABEL[s.price_type] || s.price_type, (s.tiers || []).length ? `${s.tiers.length} 档阶梯价` : null, s.description || null]
              .filter(Boolean)
              .join(' · ')
          )
        )
      ),
      h('div.pickrow__ctrl', h('div.cluster', { style: { gap: '6px' } }, qty, unit, hint))
    )
    rows.push({ s, el, cb, qty, fig, unit, hint })
    return el
  }

  /** 全勾上 / 全清掉 —— 客户说「整页都要」的时候省得一个个点 */
  const setAll = (on) => {
    for (const r of rows) {
      if (on) picked.add(r.s.id)
      else picked.delete(r.s.id)
      r.cb.checked = on
    }
    paint()
  }

  m = modal({
    title: `组合报价 · ${cat.name}`,
    wide: true,
    body: h(
      'div.stack',
      h(
        'div.cluster',
        h('span.sm.dim', `勾上客户要的服务项${list.some((s) => (s.tiers || []).length) ? '；数量能改，会自动套阶梯价' : ''}。`),
        h('div', { style: { flex: '1' } }),
        list.length
          ? h('button.btn.btn--sm', { type: 'button', onclick: () => setAll(true) }, '全选')
          : null,
        list.length
          ? h('button.btn.btn--sm', { type: 'button', onclick: () => setAll(false) }, '全不选')
          : null
      ),
      list.length ? h('div.picker', h('div.picker__scroll', ...list.map(rowFor))) : h('div.empty', h('div.empty__body', '这个大类下还没有服务项。')),
      h('div.sumline', h('span.dim', '合计'), countNote, h('div', { style: { flex: '1' } }), totalFig)
    ),
    actions: [
      { label: '关闭' },
      {
        label: '复制报价',
        key: 'copy',
        onClick: async () => {
          const lines = []
          let total = 0
          for (const r of rows) {
            if (!picked.has(r.s.id)) continue
            const q = Math.max(0.01, Number(r.qty.value) || 1)
            const u = tierUnitPrice(r.s, q)
            const amt = u * q
            total += amt
            lines.push(`${r.s.name}  ${fmtQty(q)}${unitOf(r.s)} × ¥${fmtMoney(u)} = ¥${fmtMoney(amt)}`)
          }
          if (!lines.length) return false
          const okCopy = await copyText([`【${cat.name}】`, ...lines, `合计：¥${fmtMoney(total)}`].join('\n'))
          toast(okCopy ? '报价已复制' : '复制失败，手动选一下吧', okCopy ? 'ok' : 'err')
          return false // 复制完不关窗，方便接着调
        },
      },
    ],
  })
  paint()
  return m
}

/* ---------------- 价格区间 ----------------
   大类收起的时候，光看到「7 项」不知道这一节要多少钱。
   把区间写在栏线右边，收着也能扫一遍价位。同一价就不写两遍。 */
function priceRange(list) {
  const vals = (list || []).map((s) => Number(s.base_price)).filter((v) => Number.isFinite(v))
  if (!vals.length) return ''
  const lo = Math.min(...vals)
  const hi = Math.max(...vals)
  return lo === hi ? `¥${fmtMoney(lo)}` : `¥${fmtMoney(lo)} – ¥${fmtMoney(hi)}`
}

/* ---------------- 大类的展开/收起状态 ----------------
   必须放在模块这一层，不能放在 render() 里面：
   存完一个表单会 app.reload() → 重新跑一遍 render()，
   写在 render 里的 Map 每次都是新的，状态照样丢，
   表现就是「填完内容大类自己收起来了」。

   默认**全部收起**：一进价格表先看到的是「这张表里有哪些大类、各有多少项」，
   想看哪个再点开哪个，不用在一屏拉不到底的长列表里翻。
   谁点开过就记住谁（刷新页面也还在，存在 sessionStorage）。
------------------------------------------------------------------ */

const CAT_OPEN_KEY = 'xfc.price.catOpen'
const catOpen = new Map()

try {
  const saved = JSON.parse(sessionStorage.getItem(CAT_OPEN_KEY) || '{}')
  for (const [k, v] of Object.entries(saved)) catOpen.set(String(k), !!v)
} catch {
  /* 读不出来就当没有，不影响使用 */
}

function isCatOpen(catId) {
  const k = String(catId)
  return catOpen.has(k) ? catOpen.get(k) : false
}

function setCatOpen(catId, open) {
  catOpen.set(String(catId), !!open)
  try {
    sessionStorage.setItem(CAT_OPEN_KEY, JSON.stringify(Object.fromEntries(catOpen)))
  } catch {
    /* 存不进去也不影响当前这次使用 */
  }
}

/* ---------------- 大类（分类）表单 ---------------- */

export function categoryForm(values = {}, games = [], presetGameId = null) {
  const isEdit = Boolean(values.id)
  // 从某个游戏的价格表里点「新建大类」时，游戏默认就是这个游戏，
  // 不会静悄悄落回「通用」——那正是之前让人以为"没建成"的原因之一。
  const initial = { ...values }
  if (!isEdit && presetGameId && initial.game_id === undefined) initial.game_id = String(presetGameId)

  return formDrawer({
    title: isEdit ? '改大类' : '新建大类',
    submitLabel: '保存',
    values: initial,
    wide: true,
    intro: h(
      'div.hint',
      '价格表的结构是三层：游戏 → 大类 → 服务项。先建大类（日常 / 周常 / 深渊 / 活动 / 材料…），再往大类里加具体的服务项。'
    ),
    fields: [
      { name: 'name', label: '大类名称', type: 'text', required: true, placeholder: '例：日常 / 周常 / 深渊 / 活动' },
      {
        name: 'game_id',
        label: '属于哪个游戏',
        type: 'select',
        hint: '选「通用」就是一个所有游戏都能用的大类',
        options: [{ value: '', label: '通用（不属于某个游戏）' }, ...games.map((g) => ({ value: String(g.id), label: g.name }))],
      },
      {
        name: 'is_daily',
        label: '每天都做',
        type: 'check',
        checkLabel: '每天都做（日常 / 日体 / 包天这种天天要做的）',
        hint: '勾上之后，开单时会标出来，标「今日已完成」时也会提醒你这张单里是不是还夹着别的活',
      },
      { name: 'note', label: '备注', type: 'text', placeholder: '选填' },
    ],
    onSubmit: async (v) => {
      const payload = { ...v, game_id: v.game_id || null }
      const r = isEdit ? await api.patch(`/api/categories/${values.id}`, payload) : await api.post('/api/categories/append', payload)
      toast('大类已保存', 'ok')
      return r
    },
  })
}

/* ---------------- 「游戏 ↔ 分类」联动选择 ----------------
   以前这里是两个互不相干的 select：分类下拉会把所有游戏的分类全列出来，
   于是很容易选出「游戏=崩铁、分类=原神日常」这种自相矛盾的服务项。
   现在两个下拉互相牵制：
     · 改游戏 → 分类列表只留这个游戏的和通用的
     · 改分类 → 如果这个分类属于某个游戏，游戏自动跟着切过去
   当前已经选中的分类永远保留在列表里，绝不因为筛选而把它悄悄丢掉。
------------------------------------------------------------------ */

export function gameCategoryField({ games = [], categories = [], gameId = '', categoryId = '' } = {}) {
  let gameSel = null
  let catSel = null
  const state = { gameId: gameId ? String(gameId) : '', categoryId: categoryId ? String(categoryId) : '' }
  // 只在打开表单时保留"当前这条"的大类（万一它和游戏对不上，也不能悄悄改掉它）。
  // 用户一旦手动换游戏，就不再保留——否则换了游戏还看得到别的游戏的大类，很迷惑。
  let keepCurrent = Boolean(state.categoryId)

  const catOptionsFor = () =>
    categories.filter((c) => {
      if (keepCurrent && state.categoryId && String(c.id) === state.categoryId) return true
      if (c.status === 'archived') return false
      if (!state.gameId) return true
      return !c.game_id || String(c.game_id) === state.gameId
    })

  function paintGames() {
    gameSel.replaceChildren()
    gameSel.appendChild(h('option', { value: '' }, '通用（不属于某个游戏）'))
    for (const g of games) gameSel.appendChild(h('option', { value: String(g.id) }, g.name))
    gameSel.value = state.gameId
  }

  function paintCats() {
    const list = catOptionsFor()
    catSel.replaceChildren()
    catSel.appendChild(h('option', { value: '' }, list.length ? '— 选一个大类 —' : '这个游戏下还没有大类'))
    for (const c of list) {
      const foreign = c.game_id && String(c.game_id) !== state.gameId
      catSel.appendChild(
        h('option', { value: String(c.id) }, `${c.name}${c.game_name ? `（${c.game_name}）` : ''}${foreign ? ' ⚠' : ''}`)
      )
    }
    catSel.value = list.some((c) => String(c.id) === state.categoryId) ? state.categoryId : ''
    state.categoryId = catSel.value
  }

  return {
    type: 'custom',
    width: 'full',
    render: () => {
      gameSel = h('select.sel')
      catSel = h('select.sel')

      gameSel.addEventListener('change', () => {
        state.gameId = gameSel.value
        // 换了游戏，原来选的大类未必属于这个游戏 —— 清掉重选，免得张冠李戴
        state.categoryId = ''
        keepCurrent = false
        paintCats()
      })
      catSel.addEventListener('change', () => {
        state.categoryId = catSel.value
        const c = categories.find((x) => String(x.id) === state.categoryId)
        if (c?.game_id && String(c.game_id) !== state.gameId) {
          state.gameId = String(c.game_id)
          gameSel.value = state.gameId
          paintCats() // 游戏跟着大类走了
        }
      })

      paintGames()
      paintCats()

      return h(
        'div.row-2',
        h(
          'div.field.field--full',
          h('label.lbl', '属于哪个游戏'),
          gameSel,
          h('div.hint', '选「通用」表示这张价格表不绑游戏')
        ),
        h(
          'div.field.field--full',
          h('label.lbl', '放在哪个大类下', h('span.req', '*')),
          catSel,
          h('div.hint', '服务项必须挂在某个大类里。还没有大类就先去「新建分类」。')
        )
      )
    },
    collect: (out) => {
      out.game_id = state.gameId || ''
      out.category_id = state.categoryId || ''
      if (!state.categoryId) return '请先选一个大类。价格表的结构是：游戏 → 大类 → 服务项，服务项不能直接挂到游戏上。'
      return ''
    },
  }
}

/* ---------------- 服务项表单 ---------------- */

export function serviceForm(values = {}, { games = [], categories = [] } = {}) {
  return formDrawer({
    title: values.id ? '改服务项' : '新建服务项',
    submitLabel: '保存',
    values: { min_qty: 1, price_type: 'fixed', ...values },
    wide: true,
    fields: [
      { name: 'name', label: '服务名', type: 'text', required: true, placeholder: '例：每日委托 / 深渊 12 层 / 活动全包' },
      gameCategoryField({ games, categories, gameId: values.game_id, categoryId: values.category_id }),
      {
        name: 'price_type',
        label: '计价方式',
        type: 'select',
        required: true,
        width: 'half',
        hint: '按数量会自动用阶梯价（如果配了的话）',
        options: PRICE_TYPES,
      },
      { name: 'unit_label', label: '单位', type: 'text', width: 'half', placeholder: '天 / 次 / 层 / 个 / 套' },
      { name: 'base_price', label: '基准单价', type: 'money', required: true, width: 'half', suffix: '元' },
      { name: 'min_qty', label: '起订量', type: 'number', width: 'half' },
      { name: 'max_qty', label: '封顶量（留空不限）', type: 'number', width: 'half' },
      { name: 'description', label: '说明', type: 'textarea', rows: 3, placeholder: '客户问的时候你能直接念出来的一段话' },
      {
        name: 'is_daily',
        label: '每天都做',
        type: 'select',
        width: 'half',
        hint: '默认跟着大类走 —— 往「日常」大类里加的服务项自动就算每天做',
        default: values.is_daily === null || values.is_daily === undefined ? '' : String(values.is_daily),
        options: [
          { value: '', label: '跟随大类（推荐）' },
          { value: '1', label: '是，每天都做' },
          { value: '0', label: '否，一次性的' },
        ],
      },
      { name: 'package_items', label: '套餐包含内容', type: 'tags', hint: '套餐价 / 全包类服务用。逗号分隔，报价单上会逐条列出来。' },
      {
        name: 'status',
        label: '状态',
        type: 'select',
        width: 'half',
        default: values.status || 'active',
        options: [
          { value: 'active', label: '在架' },
          { value: 'archived', label: '已下架（老订单不受影响）' },
        ],
      },
      { name: 'note', label: '内部备注', type: 'text', width: 'half' },
    ],
    onSubmit: async (v) => {
      const payload = {
        ...v,
        game_id: v.game_id || null,
        min_qty: Number(v.min_qty) || 1,
        max_qty: v.max_qty === '' || v.max_qty === null ? null : Number(v.max_qty),
      }
      const r = values.id ? await api.patch(`/api/services/${values.id}`, payload) : await api.post('/api/services/append', payload)
      toast('服务项已保存', 'ok')
      return r
    },
  })
}

/* ---------------- 阶梯价编辑 ---------------- */

function tierEditor(service, onDone) {
  const body = h('div.stack')
  const listBox = h('div.itemlist')

  async function load() {
    const { items } = await api.get(`/api/services/${service.id}/tiers`)
    listBox.replaceChildren()
    if (!items.length) {
      listBox.appendChild(h('div.panel__body', h('p.dim.sm', '还没有阶梯价。不配的话就一律用基准单价。')))
    }
    for (const t of items) {
      listBox.appendChild(
        h(
          'div.item',
          { style: { cursor: 'default' } },
          h(
            'div.item__main',
            h('div.item__title', `${fmtQty(t.min_qty)} ~ ${t.max_qty === null || t.max_qty === '' ? '不限' : fmtQty(t.max_qty)} ${unitOf(service)}`),
            h('div.item__meta', h('span', `单价 ¥${fmtMoney(t.unit_price)}/${unitOf(service)}`))
          ),
          h(
            'div.tbl__acts',
            h(
              'button.btn.btn--sm',
              {
                type: 'button',
                onclick: () =>
                  formDrawer({
                    title: '改阶梯价',
                    submitLabel: '保存',
                    values: t,
                    fields: [
                      { name: 'min_qty', label: '起始数量', type: 'number', required: true, width: 'half' },
                      { name: 'max_qty', label: '结束数量（留空不限）', type: 'number', width: 'half' },
                      { name: 'unit_price', label: '这一档的单价', type: 'money', required: true, width: 'half', suffix: '元' },
                    ],
                    onSubmit: async (v) => {
                      await api.patch(`/api/tiers/${t.id}`, {
                        ...v,
                        max_qty: v.max_qty === '' ? null : Number(v.max_qty),
                        min_qty: Number(v.min_qty),
                      })
                      toast('已更新', 'ok')
                      load()
                    },
                  }),
                },
                icon('edit', 14)
              ),
              h(
                'button.btn.btn--sm',
                {
                  type: 'button',
                  onclick: async () => {
                    const ok = await confirmDelete({ title: '删掉这一档？', message: `第 ${fmtQty(t.min_qty)} 档` })
                    if (!ok) return
                    await api.del(`/api/tiers/${t.id}`)
                    toast('已删除', 'ok')
                    load()
                  },
                },
                icon('trash', 14)
              )
            )
          )
        )
    }
  }

  const d = drawer({
    title: '阶梯价',
    subtitle: `${service.name} · 按数量越多越便宜`,
    body: h(
      'div.stack',
      h('div.note', '按「数量」计价的服务项会先来这里找匹配的一档；找不到就用基准单价。例：1~5 层 30 元/层，6~12 层 25 元/层。'),
      listBox,
      h(
        'button.btn.btn--primary',
        {
          type: 'button',
          onclick: () =>
            formDrawer({
              title: '加一档阶梯价',
              submitLabel: '加上',
              fields: [
                { name: 'min_qty', label: '起始数量', type: 'number', required: true, width: 'half' },
                { name: 'max_qty', label: '结束数量（留空不限）', type: 'number', width: 'half', placeholder: '留空 = 到无限' },
                { name: 'unit_price', label: '这一档的单价', type: 'money', required: true, width: 'half', suffix: '元' },
              ],
              onSubmit: async (v) => {
                await api.post(`/api/services/${service.id}/tiers`, {
                  ...v,
                  min_qty: Number(v.min_qty),
                  max_qty: v.max_qty === '' ? null : Number(v.max_qty),
                })
                toast('已加上', 'ok')
                load()
              },
            }),
        },
        icon('plus', 14),
        '加一档'
      )
    ),
  })
  load().then(() => onDone && onDone())
  return d
}

/* ---------------- 增项 / 套餐编辑 ---------------- */

function optionEditor(service) {
  const listBox = h('div.itemlist')

  async function load() {
    const [mine, all] = await Promise.all([
      api.get('/api/options', { service_id: service.id, limit: 200 }),
      api.get('/api/options', { limit: 400 }),
    ])
    const globals = (all.items || []).filter((o) => !o.service_id && o.status !== 'archived')
    listBox.replaceChildren()

    const section = (title, rows, note) => {
      listBox.appendChild(h('div.search__grouplbl', { style: { padding: '10px 0 4px' } }, title))
      if (note) listBox.appendChild(h('div.hint', { style: { paddingBottom: '6px' } }, note))
      if (!rows.length) {
        listBox.appendChild(h('div', { style: { padding: '0 0 8px' } }, h('span.dim.sm', '（空）')))
        return
      }
      for (const o of rows) {
        listBox.appendChild(
          h(
            'div.item',
            { style: { cursor: 'default', alignItems: 'flex-start' } },
            h(
              'div.item__main',
              h(
                'div.item__title',
                o.name,
                tag(o.kind === 'package' ? '套餐' : '增项', o.kind === 'package' ? 'slate' : ''),
                o.default_selected ? tag('默认选中', 'jade') : null,
                o.status === 'archived' ? tag('已下架', 'oxblood') : null
              ),
              h(
                'div.item__meta',
                h('span', o.price_mode === 'percent' ? `加价 ${o.price}%` : o.price ? `加 ¥${fmtMoney(o.price)}` : '不加价'),
                o.description ? h('span', o.description) : null
              )
            ),
            o.service_id
              ? h(
                  'div.tbl__acts',
                  h(
                    'button.btn.btn--sm',
                    {
                      type: 'button',
                      onclick: () =>
                        formDrawer({
                          title: '改增项',
                          submitLabel: '保存',
                          values: o,
                          fields: [
                            { name: 'name', label: '名称', type: 'text', required: true },
                            {
                              name: 'kind',
                              label: '类型',
                              type: 'select',
                              width: 'half',
                              options: [
                                { value: 'addon', label: '增项（加钱）' },
                                { value: 'package', label: '套餐（组合内容）' },
                              ],
                            },
                            {
                              name: 'price_mode',
                              label: '加价方式',
                              type: 'select',
                              width: 'half',
                              options: [
                                { value: 'fixed', label: '固定加价（元）' },
                                { value: 'percent', label: '按比例加价（%）' },
                              ],
                            },
                            { name: 'price', label: '数值', type: 'number', width: 'half' },
                            { name: 'default_selected', label: '下单时默认勾上', type: 'check', checkLabel: '默认勾上' },
                            { name: 'description', label: '说明', type: 'text' },
                          ],
                          onSubmit: async (v) => {
                            await api.patch(`/api/options/${o.id}`, v)
                            toast('已更新', 'ok')
                            load()
                          },
                        }),
                      },
                      icon('edit', 14)
                    ),
                    h(
                      'button.btn.btn--sm',
                      {
                        type: 'button',
                        onclick: async () => {
                          const ok = await confirmDelete({ title: '删掉这个增项？', message: o.name })
                          if (!ok) return
                          await api.del(`/api/options/${o.id}`)
                          toast('已删除', 'ok')
                          load()
                        },
                      },
                      icon('trash', 14)
                    )
                  )
              : h('span.tag.tag--outline', '通用')
          )
        )
      }
    }

    section('这个服务项专属', mine.items || [])
    section('全局通用增项', globals, '建在所有服务项上都可用，比如「不动原石」「全程录屏」。在「新建增项」里把绑定服务留空即可。')
  }

  return drawer({
    title: '套餐与增项',
    subtitle: service.name,
    body: h(
      'div.stack',
      h('div.note', '增项会作为可勾选项出现在下单台里，选了就自动加进金额，并且一起冻进订单快照。'),
      listBox,
      h(
        'div.cluster',
        h(
          'button.btn.btn--primary',
          {
            type: 'button',
            onclick: () =>
              formDrawer({
                title: '给这个服务项加增项',
                submitLabel: '加上',
                fields: [
                  { name: 'name', label: '名称', type: 'text', required: true, placeholder: '例：加急 / 指定角色 / 不动原石' },
                  {
                    name: 'kind',
                    label: '类型',
                    type: 'select',
                    width: 'half',
                    default: 'addon',
                    options: [
                      { value: 'addon', label: '增项（加钱）' },
                      { value: 'package', label: '套餐（组合内容）' },
                    ],
                  },
                  {
                    name: 'price_mode',
                    label: '加价方式',
                    type: 'select',
                    width: 'half',
                    default: 'fixed',
                    options: [
                      { value: 'fixed', label: '固定加价（元）' },
                      { value: 'percent', label: '按比例加价（%）' },
                    ],
                  },
                  { name: 'price', label: '数值', type: 'number', width: 'half', default: 0 },
                  { name: 'default_selected', label: '默认勾上', type: 'check', checkLabel: '下单时默认勾上' },
                  { name: 'description', label: '说明', type: 'text' },
                ],
                onSubmit: async (v) => {
                  await api.post('/api/options/append', { ...v, service_id: service.id })
                  toast('已加上', 'ok')
                  load()
                },
              }),
            },
            icon('plus', 14),
            '加增项'
          ),
          h(
            'button.btn',
            {
              type: 'button',
              onclick: () =>
                formDrawer({
                  title: '新建全局通用增项',
                  submitLabel: '加上',
                  intro: h('div.hint', '不绑定任何服务项，所有服务都能勾。'),
                  fields: [
                    { name: 'name', label: '名称', type: 'text', required: true },
                    {
                      name: 'price_mode',
                      label: '加价方式',
                      type: 'select',
                      width: 'half',
                      default: 'fixed',
                      options: [
                        { value: 'fixed', label: '固定加价（元）' },
                        { value: 'percent', label: '按比例加价（%）' },
                      ],
                    },
                    { name: 'price', label: '数值', type: 'number', width: 'half', default: 0 },
                    { name: 'description', label: '说明', type: 'text' },
                  ],
                  onSubmit: async (v) => {
                    await api.post('/api/options/append', { ...v, service_id: null, kind: 'addon' })
                    toast('已加上', 'ok')
                    load()
                  },
                }),
              },
              '通用增项'
            )
          )
    ),
  })
}

/* ---------------- 服务项详情抽屉 ---------------- */

export function servicePeek(service, ctx, { onChanged } = {}) {
  const reload = () => {
    if (onChanged) onChanged()
    ctx.app.reload()
  }

  const priceLine =
    service.price_type === 'per_unit' && service.tiers?.length
      ? h(
          'div',
          h('div.pitem__fig', `¥${fmtMoney(service.base_price)}`),
          h('div.pitem__unit', `/${unitOf(service)} 起`),
          h('div.tbl__meta', `${service.tiers.length} 档阶梯价`)
        )
      : h('div', h('div.pitem__fig', `¥${fmtMoney(service.base_price)}`), h('div.pitem__unit', `/${unitOf(service)}`))

  return drawer({
    title: service.name,
    subtitle: `${PRICE_TYPE_LABEL[service.price_type] || service.price_type} · ${service.category_name || '未分类'}${service.game_name ? ` · ${service.game_name}` : ''}`,
    body: h(
      'div.stack',
      h(
        'div.cluster',
        { style: { justifyContent: 'space-between', alignItems: 'flex-start' } },
        h('div', priceLine),
        h(
          'div.cluster',
          service.status === 'active' ? tag('在架', 'jade') : tag('已下架', 'oxblood')
        )
      ),
      service.description ? h('p', { style: { lineHeight: '1.7' } }, service.description) : null,
      service.package_items?.length
        ? h(
            'div',
            h('div.tbl__meta', '套餐包含'),
            h('div.subitems', ...service.package_items.map((p) => h('div.subitem', h('span', '·'), h('span', p))))
          )
        : null,
      h('hr'),
      h(
        'div.cluster',
        h(
          'button.btn.btn--sm',
          { type: 'button', onclick: () => serviceForm(service, ctx.meta).then(reload) },
          icon('edit', 14),
          '改价格和说明'
        ),
        h('button.btn.btn--sm', { type: 'button', onclick: () => tierEditor(service) }, '阶梯价'),
        h('button.btn.btn--sm', { type: 'button', onclick: () => optionEditor(service) }, '套餐与增项'),
        copyButton(`${service.name} ¥${fmtMoney(service.base_price)}/${unitOf(service)}`, '复制价款')
      ),
      h('hr'),
      h(
        'div.cluster',
        h(
          'button.btn.btn--sm',
          {
            type: 'button',
            onclick: async () => {
              const next = service.status === 'active' ? 'archived' : 'active'
              await api.patch(`/api/services/${service.id}`, { status: next })
              toast(next === 'archived' ? '已下架，老订单不受影响' : '已重新上架', 'ok')
              reload()
            },
          },
          service.status === 'active' ? '下架' : '重新上架'
        ),
        h('div', { style: { flex: '1' } }),
        h(
          'button.btn.btn--sm.btn--danger',
          {
            type: 'button',
            onclick: async () => {
              const usage = await api.get(`/api/services/${service.id}/usage`)
              const ok = await confirmModal({
                title: `真的删掉「${service.name}」？`,
                message: usage.order_items
                  ? `已经有 ${usage.order_items} 条订单明细引用过它。删除后老订单的快照还在，但价格表里再也找不回来了。`
                  : '这个服务项还没被任何订单用过，可以安全删除。',
                confirmLabel: '删除',
                tone: 'danger',
              })
              if (!ok) return
              await api.del(`/api/services/${service.id}`)
              toast('已删除', 'ok')
              reload()
            },
          },
          icon('trash', 14),
          '删除'
        )
      )
    ),
  })
}

/* ---------------- 导出：图片 / Word 文档 ----------------
   图片和文档都从服务端同一个「导出模型」生成，内容保证一致。
   导出会自动裁掉多余内容（空大类、超出条数的服务项），
   发微信和打印都好看。
------------------------------------------------------------------ */

async function openExporter(ctx, { games = [] } = {}) {
  const state = {
    // 默认「每个游戏各出一份」：发给客户时只发他那款游戏，
    // 不要把几个游戏的价目混在同一张图/同一个文档里。
    scope: 'per-game',
    perCategory: '6',
    maxCategories: '8',
    withDesc: true,
    contact: null, // null = 还没动过，用服务端默认值
    footer: null,
  }
  let allModel = null // 不筛游戏的完整模型，用来知道有哪些游戏、各多少项

  const scopeSel = h(
    'select.sel',
    h('option', { value: 'per-game' }, '每个游戏各出一份（推荐 · 分开的文件）'),
    h('option', { value: 'merged' }, '全部游戏合并成一份'),
    ...games.map((g) => h('option', { value: `game:${g.id}` }, `只要「${g.name}」这一份`))
  )
  scopeSel.value = state.scope

  const perSel = h(
    'select.sel',
    ...[
      { v: '4', l: '4 项' },
      { v: '6', l: '6 项' },
      { v: '8', l: '8 项' },
      { v: '12', l: '12 项' },
      { v: '99', l: '不限' },
    ].map((o) => h('option', { value: o.v }, o.l))
  )
  perSel.value = state.perCategory

  const catSel = h(
    'select.sel',
    ...[
      { v: '6', l: '6 个' },
      { v: '8', l: '8 个' },
      { v: '12', l: '12 个' },
      { v: '99', l: '不限' },
    ].map((o) => h('option', { value: o.v }, o.l))
  )
  catSel.value = state.maxCategories

  const descChk = h('input.chk', { type: 'checkbox' })
  descChk.checked = true

  const contactInp = h('input.inp', { placeholder: '例：微信 xiaofeng' })
  const footerInp = h('input.inp', { placeholder: '例：价格随版本更新，以最新报价为准' })

  const previewBox = h('div.exporter__preview')
  const summary = h('div.hint', '正在生成预览…')
  const imgBtn = h('button.btn.btn--primary', { type: 'button' }, icon('download', 14), '生成图片')
  const docBtn = h('button.btn', { type: 'button' }, icon('quotes', 14), '生成 Word 文档')

  let refreshing = 0
  let previewModel = null

  /** 公共查询参数（不含 game_id） */
  function baseQuery() {
    const q = {
      per_category: state.perCategory,
      max_categories: state.maxCategories,
      with_desc: state.withDesc ? '1' : '0',
    }
    if (state.contact !== null) q.contact = state.contact
    if (state.footer !== null) q.footer = state.footer
    return q
  }

  /** 这次导出会产出哪几份 */
  function targets(m) {
    if (!m) return []
    if (state.scope === 'merged') return [{ key: '', name: '', count: m.itemCount }]
    if (state.scope.startsWith('game:')) {
      const id = state.scope.slice(5)
      const one = m.gameOptions.find((g) => g.key === id)
      return one ? [one] : []
    }
    return m.gameOptions.slice()
  }

  async function refresh() {
    const token = ++refreshing
    let all
    try {
      all = await api.get('/api/pricebook/export-model', baseQuery())
    } catch (err) {
      summary.textContent = '预览生成失败：' + (err.message || '')
      return
    }
    if (token !== refreshing) return
    allModel = all

    // 用户没改过的话，把服务端给的默认值回填进输入框
    if (state.contact === null && document.activeElement !== contactInp) contactInp.value = all.contact || ''
    if (state.footer === null && document.activeElement !== footerInp) footerInp.value = all.footer || ''

    // 预览哪一份：合并就看全部；拆分就看第一份（一般就是第一个游戏）
    const list = targets(all)
    let preview = all
    let previewName = ''
    if (state.scope !== 'merged' && list.length) {
      const first = list[0]
      previewName = first.name
      if (first.key) {
        try {
          preview = await api.get('/api/pricebook/export-model', { ...baseQuery(), game_id: first.key })
        } catch {
          preview = all
        }
      }
    }
    if (token !== refreshing) return
    previewModel = preview

    let canvas
    try {
      canvas = renderPriceCard(preview, { scale: 1 })
    } catch (err) {
      summary.textContent = '预览画不出来：' + (err.message || '')
      return
    }
    mount(previewBox, h('img', { src: canvas.toDataURL('image/png'), alt: '价格表预览' }))

    const hidden = preview.hiddenServices + preview.hiddenCategories
    const parts = []
    if (state.scope === 'per-game') {
      parts.push(list.length > 1 ? `会生成 ${list.length} 份，每个游戏一份（不混在一起）` : '会生成 1 份')
    } else if (state.scope === 'merged') {
      parts.push('会生成 1 份，所有游戏合在一起')
    } else {
      parts.push(`只导出「${previewName || preview.subtitle}」1 份`)
    }
    parts.push(
      `本份预览：${preview.itemCount} 个服务项、${preview.groups.length} 个大类` +
        (hidden ? `，另有 ${hidden} 项没展开` : '')
    )
    summary.textContent = parts.join(' · ')
    imgBtn.disabled = docBtn.disabled = !list.length
  }

  const rerender = debounce(() => refresh(), 220)

  scopeSel.addEventListener('change', () => {
    state.scope = scopeSel.value
    refresh()
  })
  perSel.addEventListener('change', () => {
    state.perCategory = perSel.value
    refresh()
  })
  catSel.addEventListener('change', () => {
    state.maxCategories = catSel.value
    refresh()
  })
  descChk.addEventListener('change', () => {
    state.withDesc = descChk.checked
    refresh()
  })
  contactInp.addEventListener('input', () => {
    state.contact = contactInp.value
    rerender()
  })
  footerInp.addEventListener('input', () => {
    state.footer = footerInp.value
    rerender()
  })

  const d = drawer({
    wide: true,
    title: '导出价格表',
    subtitle: '生成能直接发微信的图片，或者能打印、能编辑的 Word 文档',
    body: h(
      'div.stack',
      h(
        'div.formgrid',
        h(
          'div.field.field--full',
          h('label.lbl', '导出范围'),
          scopeSel,
          h('div.hint', '默认每个游戏单独出一份，发给客户时只发他那款游戏，不会把几个游戏混在一张图上。')
        ),
        h('div.field.field--full', h('label.lbl', '每个大类最多列几项'), perSel, h('div.hint', '列不下的会折成「还有 N 项」')),
        h('div.field.field--full', h('label.lbl', '最多列几个大类'), catSel),
        h('div.field.field--full', h('label.lbl', '带说明文字'), h('label.inline', { style: { cursor: 'pointer' } }, descChk, h('span.sm', '展示服务项的说明和套餐内容'))),
        h('div.field.field--full', h('label.lbl', '联系方式'), contactInp),
        h('div.field.field--full', h('label.lbl', '页脚说明'), footerInp)
      ),
      h('div.sechead', { style: { marginBottom: '0' } }, h('h3', '预览'), h('span.sechead__note', '这就是生成出来的图片')),
      previewBox,
      summary,
      h(
        'div.note',
        '导出会自动裁掉多余内容：空的大类不导出，超出条数的服务项折成「还有 N 项」，说明太长会截断。' +
          '目的是一张图发出去好看、一眼能看完，而不是把整张价格表塞进去。'
      )
    ),
    footer: [
      h('button.btn', { type: 'button', onclick: () => d.close() }, '关闭'),
      h('div', { style: { flex: '1' } }),
      docBtn,
      imgBtn,
    ],
  })

  const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)

  /** 逐个游戏取模型；合并模式就取一次 */
  async function eachModel() {
    const list = targets(allModel)
    const out = []
    for (const t of list) {
      if (state.scope === 'merged') {
        out.push({ target: t, model: allModel })
      } else {
        const m = t.key
          ? await api.get('/api/pricebook/export-model', { ...baseQuery(), game_id: t.key })
          : allModel
        out.push({ target: t, model: m })
      }
    }
    return out
  }

  function fileName(model, target, ext) {
    const game = state.scope === 'merged' ? '' : target?.name || ''
    return `${safeName(model.shopName)}-${safeName(game || '价目表')}-${model.date}.${ext}`
  }

  imgBtn.addEventListener('click', async () => {
    if (!allModel) return
    imgBtn.setAttribute('data-loading', '1')
    try {
      const jobs = await eachModel()
      if (!jobs.length) return
      let n = 0
      for (const { target, model } of jobs) {
        const blob = await canvasToBlob(renderPriceCard(model, { scale: 2 }))
        if (!blob) {
          toast('这个浏览器不支持生成图片，请换 Chrome / Edge / Safari 试试', 'err', 4200)
          return
        }
        downloadBlob(blob, fileName(model, target, 'png'))
        n++
        // 连着下多个文件，给它一点间隔，免得被浏览器拦掉
        if (n < jobs.length) await new Promise((r) => setTimeout(r, 400))
      }
      toast(n > 1 ? `已生成 ${n} 张图片，每个游戏一张` : '图片已生成，去下载文件夹看看', 'ok', 3600)
    } catch (err) {
      toastErr(err)
    } finally {
      imgBtn.removeAttribute('data-loading')
    }
  })

  docBtn.addEventListener('click', async () => {
    if (!allModel) return
    docBtn.setAttribute('data-loading', '1')
    try {
      const jobs = await eachModel()
      if (!jobs.length) return
      let n = 0
      for (const { target, model } of jobs) {
        const q = new URLSearchParams(baseQuery())
        if (state.scope !== 'merged' && target.key) q.set('game_id', target.key)
        const res = await fetch(`/api/pricebook/export.docx?${q.toString()}`, { credentials: 'same-origin' })
        if (!res.ok) {
          let msg = '生成文档失败'
          try {
            const j = await res.json()
            if (j?.error) msg = j.error
          } catch {
            /* 保持默认提示 */
          }
          toast(msg, 'err', 4200)
          return
        }
        downloadBlob(await res.blob(), fileName(model, target, 'docx'))
        n++
        if (n < jobs.length) await new Promise((r) => setTimeout(r, 400))
      }
      toast(n > 1 ? `已生成 ${n} 份 Word 文档，每个游戏一份` : 'Word 文档已生成，可以用 Word / WPS 打开和修改', 'ok', 3600)
    } catch (err) {
      toastErr(err)
    } finally {
      docBtn.removeAttribute('data-loading')
    }
  })

  refresh()
  return d
}

/* ---------------- 页面 ---------------- */

export default {
  title: '价格表',
  async render(ctx) {
    // 归档的游戏也要取回来——它的分类和服务项仍然要显示（老单不能断）
    const [gameRes, catRes, svcRes, optRes] = await Promise.all([
      api.get('/api/games', { limit: 200 }),
      api.get('/api/categories', { limit: 300 }),
      api.get('/api/services', { limit: 600 }),
      api.get('/api/options', { limit: 500 }),
    ])
    const allGames = gameRes.items || []
    const games = allGames.filter((g) => g.status === 'active') // 下拉框里只给在架的
    const categories = catRes.items || []
    const services = svcRes.items || []
    const options = optRes.items || []

    ctx.meta = { games, categories }

    /* ---------- 三个动作：建价格表 / 建大类 / 加服务项 ---------- */
    const newPriceTable = () => gameForm().then(() => ctx.app.reload())
    const newCategory = (presetGameId = null) => categoryForm({}, games, presetGameId).then(() => ctx.app.reload())
    const editCategory = (cat) => categoryForm(cat, games).then(() => ctx.app.reload())
    const newService = (categoryId) => {
      // 服务项必须落在大类里。没有大类就先引导去建大类，而不是弹一个孤立的服务项表单。
      if (!categoryId) {
        toast('先建一个大类，服务项要挂在大类下面', 'err', 3200)
        return newCategory()
      }
      // 往收起的大类里加东西，先把它展开 —— 不然存完看不见自己刚加的那条
      setCatOpen(categoryId, true)
      const cat = categories.find((c) => String(c.id) === String(categoryId))
      return serviceForm(
        { category_id: categoryId, game_id: cat?.game_id || '' },
        { games: allGames.filter((g) => g.status === 'active' || String(g.id) === String(cat?.game_id)), categories }
      ).then(() => ctx.app.reload())
    }

    ctx.setActions(
      h('button.btn.btn--sm', { type: 'button', onclick: () => newPriceTable() }, icon('plus', 14), '新建价格表'),
      h('button.btn.btn--sm.btn--primary', { type: 'button', onclick: () => newCategory() }, icon('plus', 14), '新建大类'),
      h('button.btn.btn--sm', { type: 'button', onclick: () => openExporter(ctx, { games: allGames }) }, icon('download', 14), '导出图片/文档')
    )

    if (!allGames.length && !categories.length && !services.length) {
      return h(
        'section.panel',
        h(
          'div.panel__body',
          emptyState({
            iconName: 'price',
            title: '还没有价格表',
            body: '一张价格表 = 一个游戏。先建价格表，再在里面建大类（日常 / 周常 / 深渊 / 活动），最后往大类里加具体的服务项。价格改一次，从今往后的单子都按新价，已经开出去的老单不动。',
            steps: [
              '① 建价格表：就是加一个游戏（可以顺手填区服、传图标）。',
              '② 在价格表里建大类：日常、周常、深渊、活动……',
              '③ 在大类里加服务项：每日委托、清体力、深渊 12 层……',
              '④ 每个服务项选一种计价方式，填单价和说明。',
              '⑤ 数量大的（比如深渊层数）加阶梯价，加急之类做成增项。',
            ],
            actionLabel: '新建第一张价格表',
            onAction: () => newPriceTable(),
            secondary: h('button.btn', { type: 'button', onclick: () => newCategory() }, '不绑游戏，建个通用大类'),
          })
        )
      )
    }

    /* ---------- 分组：游戏 → 大类 → 服务项 ---------- */
    const gameById = new Map(allGames.map((g) => [String(g.id), g]))
    const catIds = new Set(categories.map((c) => String(c.id)))
    const groupOrder = []
    const groupMap = new Map()
    const GENERIC = '通用（不属于某个游戏）'

    function groupFor(key, name, game) {
      if (!groupMap.has(key)) {
        const grp = { key, name, game, cats: [], loose: [] }
        groupMap.set(key, grp)
        groupOrder.push(grp)
      }
      return groupMap.get(key)
    }

    for (const g of allGames) groupFor(String(g.id), g.name, g)
    for (const c of categories) {
      const key = c.game_id ? String(c.game_id) : ''
      groupFor(key, key ? gameById.get(key)?.name || c.game_name || '未知游戏' : GENERIC, gameById.get(key) || null).cats.push(c)
    }

    // 服务项按它所属的大类归组；没有大类的（含大类已被删的）按自己的 game_id 落到「未分类」
    const servicesByCat = new Map()
    for (const s of services) {
      const cid = s.category_id && catIds.has(String(s.category_id)) ? String(s.category_id) : ''
      if (cid) {
        if (!servicesByCat.has(cid)) servicesByCat.set(cid, [])
        servicesByCat.get(cid).push(s)
      } else {
        const key = s.game_id ? String(s.game_id) : ''
        groupFor(key, key ? gameById.get(key)?.name || s.game_name || '未知游戏' : GENERIC, gameById.get(key) || null).loose.push(s)
      }
    }

    // 展示顺序：游戏（按 sort_order）→ 通用 → 其它兜底组
    const orderedGroups = []
    for (const g of allGames) orderedGroups.push(groupMap.get(String(g.id)))
    if (groupMap.has('')) orderedGroups.push(groupMap.get(''))
    for (const g of groupOrder) if (!orderedGroups.includes(g)) orderedGroups.push(g)

    /* 过滤 */
    let filterGame = ctx.query.get('game') || ''
    let filterStatus = ctx.query.get('status') || 'active'
    let filterQ = ''

    const listBox = h('div.pricelist')

    function optsFor(sid) {
      return options.filter((o) => o.service_id === sid || (!o.service_id && o.status === 'active'))
    }

    /* ---------------- 拖拽排序 ----------------
       顺序存在 services.sort_order 上。拖完把「整份显示顺序」发给后端，
       sort_order 就和页面看到的顺序对齐，不会跟别的项错位。
       排序永远基于完整数据（services），所以开着搜索/筛选拖也不会漏掉东西。
    -------------------------------------------------- */
    let draggingId = null

    const clearMarks = () => {
      for (const el of listBox.querySelectorAll('.is-drop-before,.is-drop-after')) {
        el.classList.remove('is-drop-before', 'is-drop-after')
      }
      for (const el of listBox.querySelectorAll('.is-drop-empty')) el.classList.remove('is-drop-empty')
    }

    /** 落点在哪一行之前；null = 放到最后 */
    function rowAfterPoint(container, y) {
      const rows = [...container.querySelectorAll('.pitem')].filter((r) => r.dataset.svcId !== String(draggingId))
      for (const r of rows) {
        const box = r.getBoundingClientRect()
        if (y < box.top + box.height / 2) return r
      }
      return null
    }

    /** 按这次拖动，算出「所有服务项」的新顺序 */
    function orderAfterMove(movedId, targetCat, beforeId) {
      const key = String(targetCat.id)
      const list = (servicesByCat.get(key) || []).map((s) => s.id).filter((id) => id !== movedId)
      let at = beforeId ? list.indexOf(beforeId) : list.length
      if (at < 0) at = list.length
      list.splice(at, 0, movedId)

      const ids = []
      const seen = new Set()
      const push = (id) => {
        if (id == null || seen.has(id)) return
        seen.add(id)
        ids.push(id)
      }
      for (const grp of orderedGroups) {
        for (const c of grp.cats) {
          const k = String(c.id)
          ;(k === key ? list : (servicesByCat.get(k) || []).map((s) => s.id)).forEach(push)
        }
        grp.loose.forEach((s) => push(s.id))
      }
      services.forEach((s) => push(s.id)) // 兜底：一条都不能漏
      return ids
    }

    async function applyMove(movedId, targetCat, beforeId) {
      const moved = services.find((s) => s.id === movedId)
      if (!moved) return
      const changedCat = String(moved.category_id || '') !== String(targetCat.id)
      const ids = orderAfterMove(movedId, targetCat, beforeId)
      try {
        // 拖到别的大类里 = 顺便改归属，服务项的游戏跟着大类走
        if (changedCat) {
          await api.patch(`/api/services/${movedId}`, {
            category_id: targetCat.id,
            game_id: targetCat.game_id || '',
          })
        }
        await api.post('/api/reorder/services', { ids })
        toast(changedCat ? `已挪到「${targetCat.name}」` : '顺序已保存', 'ok')
        ctx.app.reload()
      } catch (err) {
        toastErr(err)
      }
    }

    function wireRow(row, s) {
      row.draggable = true
      row.dataset.svcId = String(s.id)
      row.addEventListener('dragstart', (e) => {
        draggingId = s.id
        row.classList.add('is-dragging')
        try {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', String(s.id))
        } catch {
          /* 有些浏览器不给设置，忽略 */
        }
      })
      row.addEventListener('dragend', () => {
        draggingId = null
        row.classList.remove('is-dragging')
        clearMarks()
      })
    }

    function wireCatBody(catBody, cat) {
      catBody.addEventListener('dragover', (e) => {
        if (!draggingId) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        clearMarks()
        const after = rowAfterPoint(catBody, e.clientY)
        if (after) {
          after.classList.add('is-drop-before')
        } else {
          const rows = [...catBody.querySelectorAll('.pitem')]
          if (rows.length) rows[rows.length - 1].classList.add('is-drop-after')
          else catBody.classList.add('is-drop-empty')
        }
      })
      catBody.addEventListener('dragleave', (e) => {
        if (!catBody.contains(e.relatedTarget)) clearMarks()
      })
      catBody.addEventListener('drop', (e) => {
        e.preventDefault()
        if (!draggingId) return
        const after = rowAfterPoint(catBody, e.clientY)
        const beforeId = after ? Number(after.dataset.svcId) : null
        const movedId = draggingId
        draggingId = null
        clearMarks()
        applyMove(movedId, cat, beforeId)
      })
    }

    /* ---------------- 拖拽排序：大类 ----------------
       和大类里的服务项是两套独立的状态，互不干扰：
       · 抓着服务项拖 → 调服务项顺序（甚至换大类）
       · 抓着大类标题拖 → 调大类顺序（甚至换游戏）
       顺序同样存 sort_order，拖完把整份显示顺序发回去。
    -------------------------------------------------- */
    let draggingCat = null

    /** 落点在哪一个大类之前；null = 放到这个组的最后 */
    function catAfterPoint(groupBody, y) {
      const cats = [...groupBody.querySelectorAll('.pcat')].filter(
        (el) => el.dataset.catId && el.dataset.catId !== String(draggingCat)
      )
      for (const el of cats) {
        const box = el.getBoundingClientRect()
        if (y < box.top + box.height / 2) return el
      }
      return null
    }

    /** 按这次拖动，算出「所有大类」的新顺序（按页面显示顺序摊平） */
    function catsOrderAfterMove(movedId, targetKey, beforeId) {
      const byGroup = new Map()
      for (const grp of orderedGroups) {
        byGroup.set(grp.key, grp.cats.map((c) => c.id).filter((id) => id !== movedId))
      }
      if (!byGroup.has(targetKey)) byGroup.set(targetKey, [])
      const target = byGroup.get(targetKey)
      let at = beforeId ? target.indexOf(beforeId) : target.length
      if (at < 0) at = target.length
      target.splice(at, 0, movedId)

      const ids = []
      const seen = new Set()
      const push = (id) => {
        if (id == null || seen.has(id)) return
        seen.add(id)
        ids.push(id)
      }
      for (const grp of orderedGroups) for (const id of byGroup.get(grp.key) || []) push(id)
      categories.forEach((c) => push(c.id)) // 兜底：一条都不能漏
      return ids
    }

    async function applyCatMove(movedId, grp, beforeId) {
      const cat = categories.find((c) => c.id === movedId)
      if (!cat) return
      const targetGameId = grp.key ? Number(grp.key) : null
      const changedGame = String(cat.game_id || '') !== String(grp.key)
      const ids = catsOrderAfterMove(movedId, grp.key, beforeId)
      try {
        // 拖到别的游戏那一组里 = 顺便换游戏
        if (changedGame) await api.patch(`/api/categories/${movedId}`, { game_id: targetGameId })
        await api.post('/api/reorder/categories', { ids })
        toast(changedGame ? `「${cat.name}」已挪到 ${grp.name}` : '大类的顺序已保存', 'ok')
        ctx.app.reload()
      } catch (err) {
        toastErr(err)
      }
    }

    function wireCatHead(catHead, pcat, cat) {
      catHead.draggable = true
      pcat.dataset.catId = String(cat.id)
      catHead.addEventListener('dragstart', (e) => {
        // 抓着标题里的按钮时别触发拖动
        if (e.target && e.target.closest && e.target.closest('.btn')) {
          e.preventDefault()
          return
        }
        draggingCat = cat.id
        pcat.classList.add('is-dragging')
        try {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData('text/plain', `cat:${cat.id}`)
        } catch {
          /* 有的浏览器不给设置，忽略 */
        }
      })
      catHead.addEventListener('dragend', () => {
        draggingCat = null
        pcat.classList.remove('is-dragging')
        clearMarks()
      })
    }

    function wireGroupBody(groupBody, grp) {
      groupBody.addEventListener('dragover', (e) => {
        if (!draggingCat) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
        clearMarks()
        const after = catAfterPoint(groupBody, e.clientY)
        if (after) {
          after.classList.add('is-drop-before')
        } else {
          const cats = [...groupBody.querySelectorAll('.pcat')].filter((el) => el.dataset.catId)
          if (cats.length) cats[cats.length - 1].classList.add('is-drop-after')
        }
      })
      groupBody.addEventListener('dragleave', (e) => {
        if (!groupBody.contains(e.relatedTarget)) clearMarks()
      })
      groupBody.addEventListener('drop', (e) => {
        e.preventDefault()
        if (!draggingCat) return
        const after = catAfterPoint(groupBody, e.clientY)
        const beforeId = after && after.dataset.catId ? Number(after.dataset.catId) : null
        const movedId = draggingCat
        draggingCat = null
        clearMarks()
        applyCatMove(movedId, grp, beforeId)
      })
    }

    /* 一行服务项。
       没填备注、没填套餐内容、没挂增项、没有阶梯价的 —— 排成一行：
       名字 …… ¥价格/单位，不留一片空白。
       填了东西的才铺开成多行。规则只看服务项自己，不看它属于哪个大类。 */
    function serviceRow(s) {
      const related = optsFor(s.id)
      const bare =
        !s.description && !(s.package_items?.length) && !related.length && !(s.tier_count > 0) && s.status !== 'archived'

      const acts = h(
        'div.pitem__acts',
        h(
          'button.btn.btn--sm.btn--quiet',
          {
            type: 'button',
            title: '详情',
            draggable: 'false',
            onclick: (e) => {
              e.stopPropagation()
              servicePeek(s, ctx, { onChanged: () => ctx.app.reload() })
            },
          },
          '详情'
        ),
        h(
          'button.btn.btn--sm.btn--quiet',
          {
            type: 'button',
            title: '改这个服务项',
            draggable: 'false',
            onclick: (e) => {
              e.stopPropagation()
              serviceForm(s, { games: allGames, categories }).then(() => ctx.app.reload())
            },
          },
          icon('edit', 14)
        )
      )

      const row = bare
        ? h(
            'div.pitem.pitem--slim',
            { title: '拖动可以调整顺序' },
            h('span.pitem__grip', icon('drag', 14)),
            h('span.pitem__name', s.name),
            h('span.pitem__leader'),
            h(
              'span.pitem__amount',
              h('span.pitem__fig', `¥${fmtMoney(s.base_price)}`),
              h('em.pitem__unit', `/${unitOf(s)}`)
            ),
            acts
          )
        : h(
            'div.pitem',
            { title: '拖动可以调整顺序' },
            h(
              'div',
              h(
                'div.pitem__name',
                h('span.pitem__grip', icon('drag', 14)),
                s.name,
                s.tier_count > 0 ? tag(`${s.tier_count} 档阶梯价`, 'cinnabar') : null,
                s.status === 'archived' ? tag('已下架', 'oxblood') : null
              ),
              s.description ? h('div.pitem__desc', s.description) : null,
              s.package_items?.length
                ? h('div.subitems', h('div.subitem', h('span.subitem__k', '含'), h('span', s.package_items.join(' · '))))
                : null,
              related.length
                ? h(
                    'div.subitems',
                    h(
                      'div.subitem',
                      h('span.subitem__k', '增项'),
                      h(
                        'span',
                        related
                          .slice(0, 6)
                          .map((o) => `${o.name}${o.price_mode === 'percent' ? ` +${o.price}%` : o.price ? ` +${fmtMoney(o.price)}元` : ''}`)
                          .join(' · ')
                      )
                    )
                  )
                : null
            ),
            h(
              'div.pitem__price',
              h('span.pitem__amount', h('span.pitem__fig', `¥${fmtMoney(s.base_price)}`), h('em.pitem__unit', `/${unitOf(s)}`)),
              acts
            )
          )

      wireRow(row, s)
      return row
    }

    // 「全部展开 / 全部收起」这个按钮在 paint 之后才建出来，
    // 但 paint 里要顺手把它的文案刷新一下（手动折叠一个之后文案就该变），
    // 所以先占个位，按钮建好再换成真的。
    let syncExpandNow = () => {}

    function paint() {
      const q = filterQ.trim().toLowerCase()
      listBox.replaceChildren()

      const statusOk = (s) =>
        filterStatus === 'all' ? true : filterStatus === 'active' ? s.status !== 'archived' : s.status === 'archived'
      const catNameHit = (c) => !!q && `${c.name} ${c.note || ''}`.toLowerCase().includes(q)
      const svcHit = (s, catMatched) =>
        statusOk(s) && (!q || catMatched || `${s.name} ${s.description || ''} ${s.note || ''}`.toLowerCase().includes(q))

      let shownGroups = 0

      for (const grp of orderedGroups) {
        if (filterGame && grp.key !== filterGame) continue

        let blocks = grp.cats.map((cat) => {
          const all = servicesByCat.get(String(cat.id)) || []
          const nameHit = catNameHit(cat)
          return { cat, nameHit, all, list: all.filter((s) => svcHit(s, nameHit)) }
        })
        const loose = grp.loose.filter((s) => svcHit(s, false))

        if (q) {
          blocks = blocks.filter((b) => b.list.length || b.nameHit)
          if (!blocks.length && !loose.length) continue
        }

        const svcCount = blocks.reduce((n, b) => n + b.list.length, 0) + loose.length
        shownGroups++

        const groupBody = h('div.pgroup__body')

        for (const b of blocks) {
          const catBody = h('div.pcat__body')
          if (!b.list.length) {
            catBody.appendChild(
              h(
                'div',
                { style: { padding: '2px 16px 14px' } },
                h('span.dim.sm', b.all.length ? '这个筛选下没有服务项。' : '这个大类下还没有服务项 —— 点右边「加服务项」开始录。')
              )
            )
          } else {
            for (const s of b.list) catBody.appendChild(serviceRow(s))
          }
          // 整个大类都是放置区：可以排在任意位置，也可以从别的大类拖过来
          wireCatBody(catBody, b.cat)

          const catHead = h(
            'div.pcat__head',
            { title: '按住可以调整大类顺序，拖到别的游戏/通用组里就是换归属' },
            h('span.pcat__name', b.cat.name),
            // 每天都要做的大类，在价格表里也标一下。
            // 用中性描边而不是绿色：这一页的强调色只留朱砂一个。
            b.cat.is_daily ? tag('每天做', 'outline') : null,
            b.cat.status === 'archived' ? tag('大类已归档', 'oxblood') : null,
            b.cat.note ? h('span.pcat__note', b.cat.note) : null,
            // 名字和数字之间拉一条栏线：大类看起来才像账簿里的一节
            h('span.pcat__rule'),
            // 收着也能看出这一节大概多少钱
            priceRange(b.list) ? h('span.pcat__range', priceRange(b.list)) : null,
            h(
              'span.pcat__n',
              q && b.list.length !== b.all.length ? `${b.all.length} 项（命中 ${b.list.length}）` : `${b.all.length} 项`
            ),
            // 管理操作收在一组里，鼠标进这一行才出现 —— 正文要像一张能直接读的价目表
            h(
              'span.pcat__acts',
              // 组合报价：勾几个服务项加一下，客户问「这几个一共多少」的时候用
              h(
                'button.btn.btn--sm',
                {
                  type: 'button',
                  title: '勾几个服务项，算这一组一共多少钱',
                  onclick: (e) => {
                    e.stopPropagation()
                    sumDialog(b.cat, b.all)
                  },
                },
                icon('price', 14),
                '组合报价'
              ),
              h(
                'button.btn.btn--sm.btn--primary',
                {
                  type: 'button',
                  title: '在这个大类下加服务项',
                  onclick: (e) => {
                    e.stopPropagation()
                    newService(b.cat.id)
                  },
                },
                icon('plus', 14),
                '加服务项'
              ),
              h(
                'button.btn.btn--sm.btn--quiet',
                {
                  type: 'button',
                  title: '改大类',
                  onclick: (e) => {
                    e.stopPropagation()
                    editCategory(b.cat)
                  },
                },
                icon('edit', 14)
              )
            )
          )

          // 展开/收起状态记在 catOpen 里，刷新不会丢。
          // 默认全部收起（见 isCatOpen 上面的说明）；右侧那条价格区间
          // 就是为了让收起状态也能看出这一节大概多少钱。
          const open = isCatOpen(b.cat.id)
          catBody.style.display = open ? '' : 'none'
          catHead.setAttribute('aria-expanded', open ? 'true' : 'false')
          catHead.addEventListener('click', () => {
            const next = catBody.style.display === 'none'
            catBody.style.display = next ? '' : 'none'
            catHead.setAttribute('aria-expanded', next ? 'true' : 'false')
            setCatOpen(b.cat.id, next)
            // 手动折叠一个之后，「全部展开」的文案要跟着变
            syncExpandNow()
          })
          const pcatEl = h('div.pcat', catHead, catBody)
          wireCatHead(catHead, pcatEl, b.cat)
          groupBody.appendChild(pcatEl)
        }
        // 这一组本身就是大类的放置区：组内调顺序，或者从别的游戏组拖过来
        wireGroupBody(groupBody, grp)

        if (loose.length) {
          const looseBody = h('div.pcat__body')
          for (const s of loose) looseBody.appendChild(serviceRow(s))
          // 「未分类」不接拖放（它没有真正的大类 id，排进去会算错位置）。
          // 但这里的行仍然可以往外拖，拖到某个大类里就等于重新归类。
          groupBody.appendChild(
            h(
              'div.pcat',
              h(
                'div.pcat__head',
                h('span.pcat__name', '未分类'),
                tag('这些服务项还没归到大类', 'amber'),
                h('span.pcat__rule'),
                priceRange(loose) ? h('span.pcat__range', priceRange(loose)) : null,
                h('span.pcat__n', `${loose.length} 项`)
              ),
              looseBody
            )
          )
        }

        if (!blocks.length && !loose.length) {
          groupBody.appendChild(
            h(
              'div',
              { style: { padding: '2px 16px 14px' } },
              h('span.dim.sm', '这张价格表还没有大类 —— 先点右边「新建大类」，再往里加服务项。')
            )
          )
        }

        const groupHead = h(
          'div.pgroup__head',
          h('span.pgroup__name', grp.name),
          grp.game?.status === 'archived' ? tag('游戏已归档', 'oxblood') : null,
          grp.game?.servers?.length ? h('span.dim.tiny', grp.game.servers.join(' / ')) : null,
          h('span.pgroup__grow'),
          h('span.pgroup__n', `${blocks.length} 个大类 · ${svcCount} 个服务项`),
          h(
            'button.btn.btn--sm',
            {
              type: 'button',
              title: '在这张价格表下新建大类',
              onclick: (e) => {
                e.stopPropagation()
                newCategory(grp.key || null)
              },
            },
            icon('plus', 14),
            '新建大类'
          )
        )

        // 这个游戏的公告：和导出图片 / Word 最上方那条是同一份内容。
        // 在价格表里也露一下，改完能立刻看到发给客户的是什么。
        const gameNotice = String(grp.game?.notice || '').trim()

        listBox.appendChild(
          h(
            'div.pgroup',
            groupHead,
            gameNotice
              ? h(
                  'div.pgroup__notice',
                  h('span.pgroup__notice-k', '公告'),
                  h('span', gameNotice)
                )
              : null,
            groupBody
          )
        )
      }

      if (!shownGroups) {
        listBox.appendChild(
          h(
            'div',
            emptyState({
              iconName: 'search',
              title: q ? '没有匹配的服务项' : '这个筛选下没有内容',
              body: q ? '换个关键词，或者清空搜索。' : '换个筛选条件，或者新建一个大类。',
              actionLabel: q ? null : '新建大类',
              onAction: q ? null : () => newCategory(filterGame || null),
            })
          )
        )
      }

      syncExpandNow()
    }

    const searchInput = h('input.inp', { type: 'search', placeholder: '搜服务名 / 说明', style: { maxWidth: '240px' } })
    searchInput.addEventListener(
      'input',
      debounce(() => {
        filterQ = searchInput.value
        paint()
      }, 160)
    )

    const gameSel = h('select.sel', { style: { width: 'auto', minWidth: '140px' } })
    gameSel.appendChild(h('option', { value: '' }, '全部价格表'))
    for (const g of allGames) {
      gameSel.appendChild(h('option', { value: String(g.id) }, g.status === 'archived' ? `${g.name}（已归档）` : g.name))
    }
    if (filterGame) gameSel.value = filterGame
    gameSel.addEventListener('change', () => {
      filterGame = gameSel.value
      paint()
    })

    const statusSeg = h(
      'div.seg',
      [
        { key: 'active', label: '在架' },
        { key: 'archived', label: '已下架' },
        { key: 'all', label: '全部' },
      ].map((f) =>
        h(
          'button.seg__btn',
          {
            type: 'button',
            'aria-pressed': String(f.key === filterStatus),
            onclick: (e) => {
              filterStatus = f.key
              e.currentTarget.parentElement.querySelectorAll('.seg__btn').forEach((b) => b.setAttribute('aria-pressed', 'false'))
              e.currentTarget.setAttribute('aria-pressed', 'true')
              paint()
            },
          },
          f.label
        )
      )
    )

    paint()

    // 十来个大类一个个点开太费事，给一个总开关
    const expandIco = icon('down', 14)
    const expandTxt = h('span', '全部展开')
    const allExpanded = () => categories.length > 0 && categories.every((c) => isCatOpen(c.id))
    const syncExpand = () => {
      const on = allExpanded()
      expandIco.style.transform = on ? 'rotate(180deg)' : ''
      expandTxt.textContent = on ? '全部收起' : '全部展开'
    }
    const expandBtn = h(
      'button.btn.btn--sm',
      {
        type: 'button',
        title: '把所有大类一次展开或收起',
        onclick: () => {
          const on = !allExpanded()
          for (const c of categories) setCatOpen(c.id, on)
          paint()
          syncExpand()
        },
      },
      expandIco,
      expandTxt
    )
    syncExpandNow = syncExpand
    syncExpand()

    const focused = ctx.query.get('s')
    if (focused) {
      const s = services.find((x) => String(x.id) === String(focused))
      if (s) setTimeout(() => servicePeek(s, ctx, { onChanged: () => ctx.app.reload() }), 120)
    }

    return h(
      'div.stack',
      h(
        'div.pagehead',
        h(
          'div.pagehead__txt',
          h('h1', '价格表'),
          h(
            'p.pagehead__sub',
            `${allGames.length} 张价格表 · ${categories.length} 个大类 · ${services.filter((s) => s.status === 'active').length} 个在架服务项 · 改价只影响之后开的单`
          )
        )
      ),
      h('div.toolbar', statusSeg, gameSel, expandBtn, h('div.toolbar__grow'), searchInput),
      h('section.sheet', listBox),
      h(
        'div.note',
        '结构是「游戏（一张价格表）→ 大类 → 服务项」。服务项必须挂在大类里。' +
          '按住服务项可以拖动排序，拖到别的大类里就顺手换归属；大类的标题也能拖，用来调整大类顺序，拖到别的游戏组里就是换游戏。' +
          '改价格表只影响之后开的单，已经开出去的老单，价格冻在下单那一刻。'
      )
    )
  },
}
