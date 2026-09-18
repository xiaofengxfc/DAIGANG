/* ============================================================
   设置：店铺信息、密码、备份、安全须知
   ============================================================ */

import { api } from '../api.js'
import { h, icon, fmtDateTime, fmtMoney, fmtDate } from '../dom.js'
import { toast, toastErr, formDrawer, modal, confirmModal, sectionHead, tag, emptyState } from '../ui.js'
import { vaultState, refreshVault, ensureVaultReady, syncVault } from '../vaultgate.js'

function shopForm(settings) {
  return formDrawer({
    title: '店铺信息',
    submitLabel: '保存',
    values: settings,
    fields: [
      { name: 'business_name', label: '店铺 / 招牌名', type: 'text', required: true, hint: '显示在页面标题和报价单抬头' },
      { name: 'admin_name', label: '怎么称呼你', type: 'text', width: 'half', hint: '保险箱审计里的操作人' },
      { name: 'contact', label: '联系方式', type: 'text', width: 'half', placeholder: '例：微信 xiaofeng' },
      { name: 'quote_footer', label: '报价单页脚', type: 'text', placeholder: '例：价格随版本更新，以最新报价为准' },
      { name: 'quote_valid_days', label: '报价默认有效期', type: 'number', width: 'half', suffix: '天', default: settings.quote_valid_days || 7 },
      { name: 'default_note', label: '开单默认备注', type: 'text', width: 'half' },
    ],
    onSubmit: async (v) => {
      await api.patch('/api/settings', v)
      toast('已保存', 'ok')
    },
  })
}

function passwordForm() {
  return formDrawer({
    title: '改登录密码',
    submitLabel: '改密码',
    intro: h('div.note', '改完之后，其他设备上的登录会全部退出。'),
    fields: [
      { name: 'current', label: '当前密码', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'next', label: '新密码', type: 'password', required: true, autocomplete: 'new-password', hint: '至少 6 位' },
      { name: 'confirm', label: '再输一次新密码', type: 'password', required: true, autocomplete: 'new-password' },
    ],
    onSubmit: async (v) => {
      await api.post('/api/auth/password', v)
      toast('登录密码已改', 'ok')
    },
  })
}

function vaultPasswordForm() {
  return formDrawer({
    title: '改保险箱密码',
    submitLabel: '改密码',
    intro: h(
      'div.note.note--warn',
      '改密码会把数据库里所有凭证重新加密一遍。过程中不要关掉启动窗口。如果中途断电，旧密文可能解不开——改之前建议先导出一份备份。'
    ),
    fields: [
      { name: 'current', label: '当前保险箱密码', type: 'password', required: true, autocomplete: 'current-password' },
      { name: 'next', label: '新保险箱密码', type: 'password', required: true, autocomplete: 'new-password', hint: '至少 8 位，不能纯数字' },
    ],
    onSubmit: async (v) => {
      const r = await api.post('/api/vault/password', v)
      toast(`已重新加密 ${r.reencrypted} 条凭证`, 'ok')
      await refreshVault()
    },
  })
}

async function exportBackup() {
  const data = await api.get('/api/backup/export')
  const text = JSON.stringify(data, null, 2)
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const name = `代肝运营台-备份-${stamp}.json`
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = h('a', { href: url, download: name, style: { display: 'none' } })
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 1000)
  const counts = data.counts || {}
  toast(`备份已导出：${counts.orders || 0} 单 / ${counts.customers || 0} 客户 / ${counts.credentials || 0} 凭证`, 'ok', 4200)
}

function importBackup(onDone) {
  const file = h('input', { type: 'file', accept: 'application/json,.json', style: { display: 'none' } })
  file.addEventListener('change', async () => {
    const f = file.files && file.files[0]
    if (!f) return
    let payload
    try {
      payload = JSON.parse(await f.text())
    } catch {
      toastErr('这个文件不是合法的 JSON')
      return
    }
    const ok = await confirmModal({
      title: '导入备份会覆盖现在的全部数据',
      message: `备份导出于 ${payload.exported_at ? fmtDateTime(payload.exported_at) : '未知时间'}。导入后现有的订单、客户、凭证、价格表全部被替换，而且所有设备都要重新登录。`,
      confirmLabel: '确认覆盖',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const r = await api.post('/api/backup/import', { payload, confirm: 'REPLACE' })
      toast(`导入完成：${r.imported.orders || 0} 单`, 'ok', 4000)
      setTimeout(() => location.reload(), 1200)
    } catch (err) {
      toastErr(err)
    } finally {
      file.value = ''
    }
  })
  return file
}

export default {
  title: '设置',
  async render(ctx) {
    await refreshVault()
    const [settings, counts] = await Promise.all([api.get('/api/settings'), api.get('/api/backup/counts')])
    const me = ctx.app.state.me
    const LAN = location.hostname !== '127.0.0.1' && location.hostname !== 'localhost'

    const importInput = importBackup(() => ctx.app.reload())

    const row = (title, desc, action, extra) =>
      h(
        'div.item',
        { style: { cursor: 'default', alignItems: 'flex-start' } },
        h('div.item__main', h('div.item__title', title, extra), desc ? h('div.tbl__meta', { style: { marginTop: '2px' } }, desc) : null),
        action || null
      )

    return h(
      'div.stack',
      h('div.pagehead', h('div.pagehead__txt', h('h1', '设置'), h('p.pagehead__sub', '店铺信息、密码、备份与安全'))),

      h(
        'section.panel',
        h('div.panel__body', sectionHead('店铺信息')),
        h(
          'div.itemlist',
          row('招牌名 / 称呼', `${settings.business_name || '未设置'} · 操作人 ${settings.admin_name || '未设置'}`, h('button.btn.btn--sm', { type: 'button', onclick: () => shopForm(settings).then(() => ctx.app.reload()) }, icon('edit', 14), '修改')),
          row('联系方式', settings.contact || '未填写'),
          row('报价单默认有效期', `${settings.quote_valid_days || 7} 天`)
        )
      ),

      h(
        'section.panel',
        h('div.panel__body', sectionHead('安全')),
        h(
          'div.itemlist',
          row(
            '登录密码',
            '手机和电脑共用这一个。改完其他设备会退出。',
            h('button.btn.btn--sm', { type: 'button', onclick: () => passwordForm() }, '改密码')
          ),
          row(
            '保险箱密码',
            vaultState.configured
              ? vaultState.unlocked
                ? '当前已解开。改密码会重新加密所有凭证。'
                : '当前已锁定。'
              : '还没设置。设了之后游戏账号密码才能加密入库。',
            h(
              'div.tbl__acts',
              vaultState.configured
                ? h('button.btn.btn--sm', { type: 'button', onclick: () => vaultPasswordForm() }, '改密码')
                : h(
                    'button.btn.btn--sm.btn--primary',
                    {
                      type: 'button',
                      onclick: async () => {
                        const ok = await ensureVaultReady()
                        if (ok) {
                          toast('保险箱已就绪', 'ok')
                          ctx.app.reload()
                        }
                      },
                    },
                    '去设置'
                  )
            ),
            vaultState.configured ? tag(vaultState.unlocked ? '已解开' : '已锁定', vaultState.unlocked ? 'jade' : 'amber') : tag('未设置', 'oxblood')
          ),
          row('保险箱加密', 'AES-256-GCM，密钥由你的保险箱密码用 scrypt 推导，只存在于内存，不写进任何文件。')
        )
      ),

      h(
        'section.panel',
        h('div.panel__body', sectionHead('数据')),
        h(
          'div.itemlist',
          row(
            '当前数据量',
            `${counts.orders || 0} 张订单 · ${counts.customers || 0} 位客户 · ${counts.credentials || 0} 条凭证 · ${counts.services || 0} 个服务项 · ${counts.games || 0} 个游戏`
          ),
          row(
            '导出一份备份',
            '下载一个 JSON 文件，含全部业务数据。凭证在文件里仍然是密文，换台电脑要用同一个保险箱密码才能解开。',
            h('button.btn.btn--sm', { type: 'button', onclick: () => exportBackup().catch(toastErr) }, icon('download', 14), '导出')
          ),
          row(
            '从备份恢复',
            '会用备份内容覆盖现在的全部数据。',
            h('div.tbl__acts', h('button.btn.btn--sm', { type: 'button', onclick: () => importInput.click() }, icon('upload', 14), '导入'), importInput)
          ),
          row(
            '清空业务数据',
            '清掉订单、客户、凭证、价格表和游戏，保留登录密码和保险箱设置。不可撤销。',
            h(
              'button.btn.btn--sm.btn--danger',
              {
                type: 'button',
                onclick: async () => {
                  const ok = await confirmModal({
                    title: '清空全部业务数据？',
                    message: '订单、进度、收款、客户、凭证、价格表、游戏都会被删掉。登录密码和保险箱密码保留。这个操作不可撤销，建议先导出一份备份。',
                    confirmLabel: '清空',
                    tone: 'danger',
                  })
                  if (!ok) return
                  await api.post('/api/system/reset', { confirm: 'CLEAR' })
                  toast('已清空', 'ok')
                  ctx.app.reload()
                },
              },
              '清空'
            )
          )
        )
      ),

      h(
        'section.panel',
        h('div.panel__body', sectionHead('安全须知', '值得花一分钟读完')),
        h(
          'div.panel__body',
          { style: { paddingTop: '0' } },
          h(
            'ul.empty__steps',
            { style: { maxWidth: '70ch' } },
            h('li', h('span.n', '1'), h('span', '数据全部存在这台电脑的 data/ 目录里，不会上传到任何地方。把整个文件夹拷走就是完整备份。')),
            h('li', h('span.n', '2'), h('span', '用手机通过局域网访问时走的是普通 HTTP，同一 WiFi 下的其他人理论上能抓包看到你输入的密码。建议只在自家/可信 WiFi 下用手机访问，或者启动时加 --local 只允许本机。')),
            h('li', h('span.n', '3'), h('span', '游戏登录凭证是加密的，但保险箱密码一旦忘记就真的解不开——没有后门。请记在密码管理器里。')),
            h('li', h('span.n', '4'), h('span', '优先让客户扫码登录。能不存密码，就不存密码。')),
            h('li', h('span.n', '5'), h('span', '定期导出备份。硬盘坏了、系统重装了，SQLite 文件不会自己回来。'))
          ),
          LAN
            ? h('div.note.note--warn', { style: { marginTop: 'var(--sp-4)' } }, '你现在是透过局域网访问的（' + location.host + '）。请确认这个 WiFi 是你信得过的。')
            : null
        )
      ),

      h(
        'section.panel',
        h('div.panel__body', sectionHead('关于')),
        h(
          'div.panel__body',
          { style: { paddingTop: '0' } },
          h(
            'div.kv',
            h('dt', '程序'),
            h('dd', '代肝价格查询 · 私用运营台'),
            h('dt', '版本'),
            h('dd', 'v1.0.0'),
            h('dt', '运行方式'),
            h('dd', 'Node.js 内置 http + SQLite，零第三方依赖'),
            h('dt', '存储'),
            h('dd', h('span.mono.sm', 'data/console.db')),
            h('dt', '本次登录'),
            h('dd', me?.actor || '—')
          )
        )
      )
    )
  },
}
