/* ============================================================
   设置：店铺信息、密码、备份、安全须知
   ============================================================ */

import { api } from '../api.js'
import { h, icon, fmtDateTime, fmtMoney, fmtDate, mount } from '../dom.js'
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

/* ============================================================
   屏幕识别：引擎状态 + 图标模板
   引擎是本机程序，装了就用、没装就往下退，探测链写在后端 src/ocr.mjs 里。
   ============================================================ */

const OCR_ENGINE_ORDER = ['umi', 'paddleocr', 'rapidocr', 'tesseract', 'windows']

function engineRow(eng, preferred) {
  const live = eng.id === preferred
  return h(
    'div.item',
    { style: { cursor: 'default', alignItems: 'flex-start' } },
    h(
      'div.item__main',
      h(
        'div.item__title',
        eng.name,
        live ? tag('正在用', 'jade') : eng.available ? tag('可用', 'jade') : tag('未安装', 'muted'),
        eng.license ? h('span.dim.tiny', { style: { marginLeft: '6px' } }, eng.license) : null
      ),
      h('div.tbl__meta', { style: { marginTop: '2px' } }, eng.available ? eng.note || '已就绪' : eng.note || ''),
      !eng.available && eng.install ? h('div.tbl__meta', { style: { marginTop: '2px', opacity: '.75' } }, `怎么装：${eng.install}`) : null
    )
  )
}

function ocrPanel(st, onRefresh, onRefreshDone) {
  const engines = [...(st.engines || [])].sort((a, b) => OCR_ENGINE_ORDER.indexOf(a.id) - OCR_ENGINE_ORDER.indexOf(b.id))
  const tpl = st.templates || { items: [], missing: [] }
  const rows = h('div.itemlist')
  for (const e of engines) rows.appendChild(engineRow(e, st.engine))

  return h(
    'section.panel',
    h(
      'div.panel__body',
      sectionHead(
        '屏幕识别',
        st.available ? `当前引擎：${st.engine_name || st.engine}` : '这台机器上还没有可用的 OCR',
        h(
          'button.btn.btn--sm',
          {
            type: 'button',
            onclick: async (ev) => {
              const btn = ev.currentTarget
              btn.setAttribute('data-loading', '1')
              try {
                const fresh = await api.get('/api/ocr/status', { probe: 1 })
                toast(fresh.available ? `检测完成，现在用 ${fresh.engine_name || fresh.engine}` : '还是没检测到可用的引擎', fresh.available ? 'ok' : 'err', 4200)
                onRefresh(fresh)
              } catch (err) {
                toastErr(err)
              } finally {
                btn.removeAttribute('data-loading')
              }
            },
          },
          icon('refresh', 14),
          '重新检测'
        )
      )
    ),
    rows,
    h(
      'div.panel__body',
      { style: { paddingTop: '0' } },
      h(
        'div.note',
        '识别用到的东西全部在这台电脑上跑，截图不出本机。按顺序试：Umi-OCR（装了并打开 HTTP 服务最好用）→ PaddleOCR-json / RapidOCR-json（解压到 tools\\ocr\\ 或设环境变量）→ Tesseract → Windows 自带。装了哪个用哪个，没装就往下退，不会因为缺一个就用不了。'
      ),
      h(
        'div',
        { style: { marginTop: 'var(--sp-3)' } },
        h('div.tbl__meta', `图标模板（认出「哪个图标是星声/体力/贝币」靠它们）：共 ${tpl.items.length} 个`),
        h(
          'div.cluster',
          { style: { marginTop: '4px', flexWrap: 'wrap' } },
          ...tpl.items.map((it) => tag(`${it.key}${it.from === 'custom' ? ' · 自备' : ''}`, it.from === 'custom' ? 'jade' : 'muted')),
          tpl.missing && tpl.missing.length ? tag(`缺 ${tpl.missing.join('、')}`, 'amber') : null
        ),
        h(
          'div.cluster',
          { style: { marginTop: 'var(--sp-3)' } },
          h(
            'button.btn.btn--sm',
            { type: 'button', onclick: () => iconTemplateForm(st, onRefreshDone) },
            icon('upload', 14),
            '自备一个图标模板'
          ),
          h('span.dim.tiny', '换了游戏版本、图标变了样子时用：给一张顶栏截图 + 图标所在的方框，程序当场抠出来存下。')
        )
      )
    )
  )
}

function iconTemplateForm(st, onDone) {
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', style: { display: 'none' } })
  const preview = h('img', { alt: '截图预览', style: { maxWidth: '100%', borderRadius: '8px', marginTop: '6px' } })
  const keySel = h(
    'select.sel',
    ...(st.resources || []).map((k) => h('option', { value: k }, k))
  )
  const box = { x: 0, y: 0, w: 200, h: 80 }
  const num = (k, d) =>
    h('input.inp.inp--fig', {
      inputmode: 'numeric',
      value: String(d),
      style: { width: '76px' },
      oninput: (ev) => {
        box[k] = Number(ev.currentTarget.value) || 0
      },
      'aria-label': k,
    })
  let dataUrl = ''
  file.addEventListener('change', () => {
    const f = file.files && file.files[0]
    if (!f) return
    const fr = new FileReader()
    fr.onload = () => {
      dataUrl = String(fr.result)
      preview.src = dataUrl
      const im = new Image()
      im.onload = () => {
        // 默认框按画面比例给一个（顶栏那条带里偏左一点），用户自己挪
        box.x = Math.round(im.naturalWidth * 0.25)
        box.y = Math.round(im.naturalHeight * 0.02)
        box.w = Math.round(im.naturalWidth * 0.06)
        box.h = Math.round(im.naturalHeight * 0.05)
        for (const [k, v] of Object.entries(box)) if (inputs[k]) inputs[k].value = String(v)
      }
      im.src = dataUrl
    }
    fr.readAsDataURL(f)
  })
  const inputs = { x: num('x', box.x), y: num('y', box.y), w: num('w', box.w), h: num('h', box.h) }

  const d = formDrawer({
    title: '自备图标模板',
    subtitle: '游戏版本更新、图标改了样子，就自己抠一个',
    submitLabel: '抠出来存下',
    fields: [
      { name: '__key', label: '图标类型', type: 'custom', render: () => keySel },
      {
        name: '__img',
        label: '游戏截图（顶栏那张）',
        type: 'custom',
        render: () =>
          h(
            'div.stack.stack--tight',
            h('button.btn.btn--sm', { type: 'button', onclick: () => file.click() }, icon('upload', 14), '选一张图'),
            file,
            preview,
            h('div.tbl__meta', '选完图之后程序会给一个默认的方框；把下面四个数改成图标本体所在的位置。')
          ),
      },
      {
        name: '__box',
        label: '图标所在的方框（像素）',
        type: 'custom',
        render: () =>
          h(
            'div.cluster',
            { style: { gap: '8px', flexWrap: 'wrap' } },
            h('label.inline', h('span.dim.tiny', 'x'), inputs.x),
            h('label.inline', h('span.dim.tiny', 'y'), inputs.y),
            h('label.inline', h('span.dim.tiny', '宽'), inputs.w),
            h('label.inline', h('span.dim.tiny', '高'), inputs.h)
          ),
      },
    ],
    onSubmit: async () => {
      if (!dataUrl) throw new Error('先选一张截图')
      const r = await api.post('/api/ocr/icons', { key: keySel.value, data_url: dataUrl, box })
      toast(`${r.key} 的模板已存下（${r.size[0]}×${r.size[1]}）`, 'ok', 4200)
      onDone()
    },
  })
  return d
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
    const [settings, counts, ocr] = await Promise.all([api.get('/api/settings'), api.get('/api/backup/counts'), api.get('/api/ocr/status').catch(() => null)])
    const me = ctx.app.state.me
    const LAN = location.hostname !== '127.0.0.1' && location.hostname !== 'localhost'
    let ocrState = ocr

    const importInput = importBackup(() => ctx.app.reload())

    const row = (title, desc, action, extra) =>
      h(
        'div.item',
        { style: { cursor: 'default', alignItems: 'flex-start' } },
        h('div.item__main', h('div.item__title', title, extra), desc ? h('div.tbl__meta', { style: { marginTop: '2px' } }, desc) : null),
        action || null
      )

    const ocrBox = h('div.stack.stack--tight')
    const paintOcr = () => {
      mount(
        ocrBox,
        ocrState ? ocrPanel(ocrState, (fresh) => {
          ocrState = fresh
          paintOcr()
        }, async () => {
          ocrState = await api.get('/api/ocr/status').catch(() => ocrState)
          paintOcr()
        }) : h('section.panel', h('div.panel__body', sectionHead('屏幕识别'), h('div.note', '拿不到识别状态（后端可能还没重启到新版）。')))
      )
    }
    paintOcr()

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

      ocrBox,

      h(
        'section.panel',
        h('div.panel__body', sectionHead('数据')),        h(
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
