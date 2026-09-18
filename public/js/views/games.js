/* ============================================================
   游戏管理
   不做物理删除：老订单里冻着游戏名，删了档案就断了。
   ============================================================ */

import { api } from '../api.js'
import { h, icon, fmtDate, fmtMoney } from '../dom.js'
import { table, toast, toastErr, formDrawer, confirmModal, confirmDelete, emptyState, tag, copyButton } from '../ui.js'

/* 游戏图标：上传后落到 data/uploads，列表里当图片用 */
function iconField(initialUrl = '') {
  let url = initialUrl
  let preview
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml', style: { display: 'none' } })
  const btn = h('button.btn.btn--sm', { type: 'button' }, icon('upload', 14), '选一张图')
  const clearBtn = h('button.btn.btn--sm.btn--quiet', { type: 'button' }, '去掉')

  function paint() {
    if (!preview) return
    preview.replaceChildren(
      url
        ? h('img', { src: url, alt: '游戏图标', style: { width: '100%', height: '100%', objectFit: 'cover' } })
        : h('span.dim.tiny', '无图标')
    )
    clearBtn.style.display = url ? '' : 'none'
  }

  btn.addEventListener('click', () => file.click())
  clearBtn.addEventListener('click', () => {
    url = ''
    paint()
  })
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0]
    if (!f) return
    if (f.size > 1.5 * 1024 * 1024) {
      toastErr('图片请压到 1.5MB 以内')
      return
    }
    btn.setAttribute('data-loading', '1')
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(fr.result)
        fr.onerror = () => reject(new Error('读不了这个文件'))
        fr.readAsDataURL(f)
      })
      const r = await api.post('/api/uploads', { data_url: dataUrl, prefix: 'game' })
      url = r.url
      paint()
      toast('图标已上传', 'ok')
    } catch (err) {
      toastErr(err)
    } finally {
      btn.removeAttribute('data-loading')
      file.value = ''
    }
  })

  return {
    type: 'custom',
    width: 'full',
    render: () => {
      preview = h('div', {
        style: {
          width: '56px',
          height: '56px',
          borderRadius: '12px',
          border: '1px solid var(--line-strong)',
          background: 'var(--surface-inset)',
          overflow: 'hidden',
          display: 'grid',
          placeContent: 'center',
          flex: 'none',
        },
      })
      paint()
      return h(
        'div.field.field--full',
        h('label.lbl', '图标'),
        h('div.cluster', preview, h('div.stack.stack--tight', h('div.cluster', btn, clearBtn), h('div.hint', '选填。会显示在游戏列表和报价单上。'))),
        file
      )
    },
    collect: (out) => {
      out.icon = url
    },
  }
}

export function gameForm(values = {}) {
  return formDrawer({
    title: values.id ? '改游戏' : '新建游戏',
    submitLabel: '保存',
    wide: true,
    fields: [
      { name: 'name', label: '游戏名', type: 'text', required: true, placeholder: '例：原神 / 崩坏：星穹铁道', width: 'half' },
      { name: 'short_name', label: '简称', type: 'text', placeholder: '例：YS / 崩铁', width: 'half' },
      iconField(values.icon || ''),
      { name: 'servers', label: '区服列表', type: 'tags', hint: '逗号分隔。例：天空岛, 世界树, 亚服。开单时可以直接选。' },
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
          g.note ? h('div.tbl__meta', g.note) : null
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
