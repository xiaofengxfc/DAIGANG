/* ============================================================
   游戏管理
   不做物理删除：老订单里冻着游戏名，删了档案就断了。
   ============================================================ */

import { api } from '../api.js'
import { h, icon, fmtDate, fmtMoney } from '../dom.js'
import { table, toast, toastErr, formDrawer, imageField, confirmModal, confirmDelete, emptyState, tag, copyButton } from '../ui.js'

/* 游戏图标：上传后落到 data/uploads，列表里当图片用。
   具体实现挪到了 ui.js 的 imageField（和客户头像共用一份）。 */

/** 公告可能有好几行、也可能很长，列表里只给一个开头 */
function firstLine(text, max = 64) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!lines.length) return ''
  const head = lines[0].length > max ? `${lines[0].slice(0, max)}…` : lines[0]
  return lines.length > 1 ? `${head}（共 ${lines.length} 行）` : head
}

export function gameForm(values = {}) {
  return formDrawer({
    title: values.id ? '改游戏' : '新建游戏',
    submitLabel: '保存',
    wide: true,
    // 必须把 values 交给 formDrawer：
    // 表单是按 f.name in values ? values[f.name] : f.default 取初值的，
    // 不传就全用 default，而下面这些字段没写 default —— 结果就是「改游戏」时
    // 名字、简介、区服、排序全是空的，逼你重填一遍。
    values,
    fields: [
      { name: 'name', label: '游戏名', type: 'text', required: true, placeholder: '例：原神 / 崩坏：星穹铁道', width: 'half' },
      { name: 'short_name', label: '简称', type: 'text', placeholder: '例：YS / 崩铁', width: 'half' },
      imageField({
        name: 'icon',
        label: '图标',
        value: values.icon || '',
        prefix: 'game',
        hint: '选填。会显示在游戏列表和报价单上。',
      }),
      { name: 'servers', label: '区服列表', type: 'tags', hint: '逗号分隔。例：天空岛, 世界树, 亚服。开单时可以直接选。' },
      {
        name: 'notice',
        label: '顶部提示',
        type: 'textarea',
        rows: 3,
        maxlength: 600,
        placeholder: '例：本价格表自 9 月 20 日起执行；包月客户送一次活动代打。',
        hint:
          '只给客户看的一句话。可以做多行，一行一件事。' +
          '导出价格表时，它会显示在图片 / Word 的最上方 —— 抬头下面、第一个大类上面，不带任何标题。' +
          '和「备注」分开：备注是你自己记账用的，不会出现在导出里。',
      },
      {
        name: 'status',
        label: '状态',
        type: 'select',
        width: 'half',
        default: values.status || 'active',
        options: [
          { value: 'active', label: '上架' },
          { value: 'archived', label: '归档（不再出现在新单里）' },
        ],
      },
      { name: 'sort_order', label: '排序', type: 'number', width: 'half', hint: '数字小的排前面' },
      { name: 'note', label: '备注', type: 'textarea', rows: 2 },
    ],
    onSubmit: async (v) => {
      const r = values.id ? await api.patch(`/api/games/${values.id}`, v) : await api.post('/api/games', v)
      toast('游戏已保存', 'ok')
      return r
    },
  })
}

export default {
  title: '游戏',
  async render(ctx) {
    const { items } = await api.get('/api/games', { limit: 200 })

    ctx.setActions(h('button.btn.btn--sm.btn--primary', { type: 'button', onclick: () => gameForm().then(() => ctx.app.reload()) }, icon('plus', 14), '新建游戏'))

    if (!items.length) {
      return h(
        'section.panel',
        h(
          'div.panel__body',
          emptyState({
            iconName: 'games',
            title: '还没有加游戏',
            body: '先加一个你在代肝的游戏。区服也可以一起填上，开单的时候就不用每次手打了。',
            steps: [
              '点右上角「新建游戏」，填游戏名。',
              '把区服列表填进去（逗号分隔）。',
              '需要的话传个图标，报价单上会好看很多。',
            ],
            actionLabel: '加第一个游戏',
            onAction: () => gameForm().then(() => ctx.app.reload()),
          })
        )
      )
    }

    const active = items.filter((g) => g.status === 'active')
    const archived = items.filter((g) => g.status === 'archived')

    const rows = items.map((g) =>
      h(
        'div.item',
        { style: { cursor: 'default' } },
        g.icon
          ? h('img', { src: g.icon, alt: '', style: { width: '34px', height: '34px', borderRadius: '9px', objectFit: 'cover', flex: 'none', border: '1px solid var(--line)' } })
          : h('div.avatar', g.name.slice(0, 1)),
        h(
          'div.item__main',
          h(
            'div.item__title',
            g.name,
            g.short_name ? h('span.dim.sm', g.short_name) : null,
            g.status === 'archived' ? tag('已归档', 'oxblood') : null
          ),
          h(
            'div.item__meta',
            h('span', `${g.service_count} 个在架服务`),
            h('span', `${g.order_count} 张单`),
            g.servers?.length ? h('span', `区服：${g.servers.join(' / ')}`) : h('span.dim', '没填区服'),
            g.created_at ? h('span', `建于 ${fmtDate(g.created_at)}`) : null
          ),
          g.note ? h('div.tbl__meta', g.note) : null,
          // 公告会在导出图片 / Word 的最上方出现，所以列表里给一条预览，
          // 免得改了公告自己都忘了发出去的是哪一版。
          // 用一道朱砂小竖条当记号，不写「公告」两个字。
          g.notice
            ? h(
                'div.tbl__meta',
                { style: { display: 'flex', gap: '7px', alignItems: 'baseline' } },
                h('span.notice-tick'),
                h('span', { style: { whiteSpace: 'pre-wrap' } }, firstLine(g.notice))
              )
            : null
        ),
        h(
          'div.tbl__acts',
          h('button.btn.btn--sm', { type: 'button', onclick: () => gameForm(g).then(() => ctx.app.reload()) }, icon('edit', 14)),
          h(
            'button.btn.btn--sm',
            {
              type: 'button',
              title: g.status === 'active' ? '归档' : '恢复上架',
              onclick: async () => {
                if (g.status === 'active') {
                  const usage = await api.get(`/api/games/${g.id}/usage`)
                  const ok = await confirmModal({
                    title: `归档「${g.name}」？`,
                    message: `归档后它不再出现在新建服务项和开单的选项里，但${usage.orders} 张老订单和 ${usage.credentials} 条登录凭证都完好。这比删除安全得多。`,
                    confirmLabel: '归档',
                  })
                  if (!ok) return
                }
                await api.patch(`/api/games/${g.id}`, { status: g.status === 'active' ? 'archived' : 'active' })
                toast(g.status === 'active' ? '已归档' : '已恢复上架', 'ok')
                ctx.app.reload()
              },
            },
            g.status === 'active' ? icon('down', 14) : icon('refresh', 14)
          ),
          h(
            'button.btn.btn--sm.btn--danger',
            {
              type: 'button',
              title: '彻底删除',
              onclick: async () => {
                const usage = await api.get(`/api/games/${g.id}/usage`)
                const used = usage.services + usage.categories + usage.orders + usage.credentials
                const ok = await confirmDelete({
                  title: `彻底删除「${g.name}」？`,
                  message: used
                    ? `底下还挂着 ${usage.categories} 个分类、${usage.services} 个服务项、${usage.orders} 张订单、${usage.credentials} 条登录凭证。删除会把这些关联都变成"未指定游戏"。如果只是想不再用它，请用「归档」。`
                    : '这个游戏没有关联任何数据，可以安全删除。',
                })
                if (!ok) return
                try {
                  await api.del(`/api/games/${g.id}`)
                  toast('已删除', 'ok')
                  ctx.app.reload()
                } catch (err) {
                  toastErr(err)
                }
              },
            },
            icon('trash', 14)
          )
        )
      )
    )

    return h(
      'div.stack',
      h(
        'div.pagehead',
        h(
          'div.pagehead__txt',
          h('h1', '游戏'),
          h('p.pagehead__sub', `${active.length} 个上架${archived.length ? ` · ${archived.length} 个已归档` : ''}`)
        )
      ),
      h('section.panel', h('div.itemlist', rows)),
      archived.length
        ? h('div.note', `「已归档」的游戏不会被删除，老订单和登录凭证仍然指向它们。想彻底清掉就到上面点删除。`)
        : null
    )
  },
}
