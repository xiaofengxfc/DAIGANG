/* ============================================================
   价格表：游戏（一张价格表）→ 大类 → 服务项 → 阶梯价 / 套餐增项
   这一页是"代肝价格查询"的正身。

   结构说明（和用户的心智模型对齐）：
     一个游戏 = 一张价格表
     一张价格表下面挂若干「大类」（日常 / 周常 / 深渊 / 活动…）
     服务项只能挂在大类里，不能直接挂在游戏上
   ============================================================ */

import { api, PRICE_TYPE_LABEL } from '../api.js'
import { h, icon, fmtMoney, fmtQty, debounce, fmtDate, mount } from '../dom.js'
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
} from '../ui.js'

const PRICE_TYPES = Object.entries(PRICE_TYPE_LABEL).map(([value, label]) => ({ value, label }))

function unitOf(s) {
  return s.unit_label || { fixed: '单', daily: '天', per_time: '次', per_unit: '个', package: '套' }[s.price_type] || '单'
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

    /* 一行服务项 */
    function serviceRow(s) {
      const related = optsFor(s.id)
      return h(
        'div.pitem',
        h(
          'div',
          h(
            'div.pitem__name',
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
          h('div.pitem__fig', `¥${fmtMoney(s.base_price)}`),
          h('div.pitem__unit', `/${unitOf(s)}`),
          h(
            'div.pitem__acts',
            h('button.btn.btn--sm', { type: 'button', onclick: () => servicePeek(s, ctx, { onChanged: () => ctx.app.reload() }) }, '详情'),
            h(
              'button.btn.btn--sm',
              { type: 'button', onclick: () => serviceForm(s, { games: allGames, categories }).then(() => ctx.app.reload()) },
              icon('edit', 14)
            )
          )
        )
      )
    }

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

          const catHead = h(
            'div.pcat__head',
            h('span.pcat__name', b.cat.name),
            b.cat.status === 'archived' ? tag('大类已归档', 'oxblood') : null,
            b.cat.note ? h('span.dim.tiny', b.cat.note) : null,
            h('span.pgroup__grow'),
            h(
              'span.pgroup__n',
              q && b.list.length !== b.all.length ? `${b.all.length} 个服务项（命中 ${b.list.length}）` : `${b.all.length} 个服务项`
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

          // 空的默认展开（要看得见「加服务项」），服务项多的默认收起
          catBody.style.display = b.all.length > 8 ? 'none' : ''
          catHead.addEventListener('click', () => {
            catBody.style.display = catBody.style.display === 'none' ? '' : 'none'
          })
          groupBody.appendChild(h('div.pcat', catHead, catBody))
        }

        if (loose.length) {
          const looseBody = h('div.pcat__body')
          for (const s of loose) looseBody.appendChild(serviceRow(s))
          groupBody.appendChild(
            h(
              'div.pcat',
              h(
                'div.pcat__head',
                h('span.pcat__name', '未分类'),
                tag('这些服务项还没归到大类', 'amber'),
                h('span.pgroup__grow'),
                h('span.pgroup__n', `${loose.length} 个`)
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

        listBox.appendChild(h('div.pgroup', groupHead, groupBody))
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
      h('div.toolbar', statusSeg, gameSel, h('div.toolbar__grow'), searchInput),
      h('section.panel', listBox),
      h(
        'div.note',
        '结构是「游戏（一张价格表）→ 大类 → 服务项」。服务项必须挂在大类里。改价格表只影响之后开的单，已经开出去的老单，价格冻在下单那一刻。'
      )
    )
  },
}
