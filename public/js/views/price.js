/* ============================================================
   价格表：分类 → 服务项 → 阶梯价 / 套餐增项
   这一页是"代肝价格查询"的正身。
   ============================================================ */

import { api, PRICE_TYPE_LABEL } from '../api.js'
import { h, icon, fmtMoney, fmtQty, debounce, fmtDate } from '../dom.js'
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

/* ---------------- 分类表单 ---------------- */

export function categoryForm(values = {}, games = []) {
  return formDrawer({
    title: values.id ? '改分类' : '新建分类',
    submitLabel: '保存',
    values,
    intro: h('div.hint', '分类是价格表的第一层，像「日常 / 周常 / 活动 / 深渊 / 材料 / 成就」。'),
    fields: [
      { name: 'name', label: '分类名', type: 'text', required: true, placeholder: '例：日常' },
      {
        name: 'game_id',
        label: '只属于某个游戏（留空 = 所有游戏通用）',
        type: 'select',
        options: [{ value: '', label: '通用（所有游戏）' }, ...games.map((g) => ({ value: String(g.id), label: g.name }))],
      },
      { name: 'note', label: '备注', type: 'text' },
    ],
    onSubmit: async (v) => {
      const payload = { ...v, game_id: v.game_id || null }
      const r = values.id ? await api.patch(`/api/categories/${values.id}`, payload) : await api.post('/api/categories/append', payload)
      toast('分类已保存', 'ok')
      return r
    },
  })
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
      {
        name: 'category_id',
        label: '分类',
        type: 'select',
        required: true,
        width: 'half',
        options: categories.map((c) => ({ value: String(c.id), label: c.game_name ? `${c.name}（${c.game_name}）` : c.name })),
      },
      {
        name: 'game_id',
        label: '游戏（留空 = 通用）',
        type: 'select',
        width: 'half',
        options: [{ value: '', label: '通用' }, ...games.map((g) => ({ value: String(g.id), label: g.name }))],
      },
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

/* ---------------- 页面 ---------------- */

export default {
  title: '价格表',
  async render(ctx) {
    const [gameRes, catRes, svcRes, optRes] = await Promise.all([
      api.get('/api/games', { status: 'active' }),
      api.get('/api/categories', { limit: 300 }),
      api.get('/api/services', { limit: 600 }),
      api.get('/api/options', { limit: 500 }),
    ])
    const games = gameRes.items || []
    const categories = catRes.items || []
    const services = svcRes.items || []
    const options = optRes.items || []

    ctx.meta = { games, categories }

    ctx.setActions(
      h('button.btn.btn--sm', { type: 'button', onclick: () => categoryForm({}, games).then(() => ctx.app.reload()) }, icon('plus', 14), '分类'),
      h('button.btn.btn--sm.btn--primary', { type: 'button', onclick: () => newService() }, icon('plus', 14), '服务项')
    )

    if (!services.length && !categories.length) {
      return h(
        'section.panel',
        h(
          'div.panel__body',
          emptyState({
            iconName: 'price',
            title: '价格表还是空的',
            body: '这里的结构是三层：分类 → 服务项 → 套餐/增项。价格改一次，从今往后的单子都按新价，已经开出去的老单不动。',
            steps: [
              '先建分类，比如「日常」「周常」「深渊」「活动」。',
              '在分类下加服务项：每日委托、清体力、深渊 12 层……',
              '每个服务项选一种计价方式：固定价 / 按天 / 按次 / 按数量 / 套餐价。',
              '数量大的（比如深渊层数）可以加阶梯价，层数越多单价越低。',
              '加急、指定角色、不动原石这类，做成增项。',
            ],
            actionLabel: '先建一个分类',
            onAction: () => categoryForm({}, games).then(() => ctx.app.reload()),
            secondary: categories.length
              ? h('button.btn', { type: 'button', onclick: () => newService() }, '直接加服务项')
              : null,
          })
        )
      )
    }

    function newService(presetCatId = null) {
      if (!categories.length) {
        toast('先建一个分类', 'err')
        return categoryForm({}, games).then(() => ctx.app.reload())
      }
      const values = presetCatId ? { category_id: presetCatId } : {}
      return serviceForm(values, { games, categories }).then(() => ctx.app.reload())
    }

    /* 过滤 */
    let filterGame = ctx.query.get('game') || ''
    let filterStatus = ctx.query.get('status') || 'active'
    let filterQ = ''

    const listBox = h('div.pricelist')

    function optsFor(sid) {
      return options.filter((o) => o.service_id === sid || (!o.service_id && o.status === 'active'))
    }

    function paint() {
      const q = filterQ.trim().toLowerCase()
      const visibleCats = categories.filter((c) => (filterStatus === 'all' ? true : c.status === filterStatus || c.status !== 'archived'))
      listBox.replaceChildren()

      const matches = (s) => {
        if (filterGame && String(s.game_id || '') !== filterGame) return false
        if (filterStatus === 'active' && s.status === 'archived') return false
        if (filterStatus === 'archived' && s.status !== 'archived') return false
        if (q && !`${s.name} ${s.description} ${s.note} ${s.category_name} ${s.game_name}`.toLowerCase().includes(q)) return false
        return true
      }

      let shown = 0
      const groups = categories.map((c) => ({ cat: c, list: services.filter((s) => s.category_id === c.id && matches(s)) }))
      const loose = services.filter((s) => matches(s) && (!s.category_id || !categories.some((c) => c.id === s.category_id)))
      if (loose.length) groups.push({ cat: { id: 0, name: '未分类' }, list: loose })

      for (const { cat, list } of groups) {
        if (!list.length && (q || filterGame || filterStatus !== 'active')) continue
        shown += list.length
        const head = h(
          'button.pgroup__head',
          { type: 'button' },
          h('span.pgroup__name', cat.name),
          cat.game_name ? tag(cat.game_name, 'slate') : null,
          cat.status === 'archived' ? tag('分类已归档', 'oxblood') : null,
          h('span.pgroup__grow'),
          h('span.pgroup__n', `${list.length} 项`),
          h('button.btn.btn--sm.btn--quiet', {
            type: 'button',
            title: '在这个分类下加服务项',
            onclick: (e) => {
              e.stopPropagation()
              newService(cat.id)
            },
          }, icon('plus', 14)),
          h('button.btn.btn--sm.btn--quiet', {
            type: 'button',
            title: '改分类',
            onclick: (e) => {
              e.stopPropagation()
              if (!cat.id) return
              categoryForm(cat, games).then(() => ctx.app.reload())
            },
          }, icon('edit', 14))
        )

        const items = h('div', { style: { display: 'none' } })
        for (const s of list) {
          const related = optsFor(s.id)
          items.appendChild(
            h(
              'div.pitem',
              h(
                'div',
                h(
                  'div.pitem__name',
                  s.name,
                  s.game_name ? tag(s.game_name, 'slate') : null,
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
                  h('button.btn.btn--sm', { type: 'button', onclick: () => serviceForm(s, { games, categories }).then(() => ctx.app.reload()) }, icon('edit', 14))
                )
              )
            )
          )
        }

        const group = h('div.pgroup', head, items)
        const toggle = () => {
          const open = items.style.display === 'none'
          items.style.display = open ? 'block' : 'none'
        }
        head.addEventListener('click', toggle)
        if (list.length && list.length <= 8) items.style.display = 'block'
        listBox.appendChild(group)
      }

      if (!shown) {
        listBox.appendChild(
          h(
            'div',
            emptyState({
              iconName: 'search',
              title: q ? '没有匹配的服务项' : '这个筛选下没有服务项',
              body: q ? '换个关键词，或者清空搜索。' : '试着切换上面的筛选，或者新建一个服务项。',
              actionLabel: '新建服务项',
              onAction: () => newService(),
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

    const gameSel = h('select.sel', { style: { width: 'auto', minWidth: '120px' } })
    gameSel.appendChild(h('option', { value: '' }, '全部游戏'))
    for (const g of games) gameSel.appendChild(h('option', { value: String(g.id) }, g.name))
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
          h('p.pagehead__sub', `${services.filter((s) => s.status === 'active').length} 个在架服务项 · 改价只影响之后开的单`)
        )
      ),
      h('div.toolbar', statusSeg, gameSel, h('div.toolbar__grow'), searchInput),
      h('section.panel', listBox)
    )
  },
}
