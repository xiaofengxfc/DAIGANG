/* ============================================================
   登录凭证保险箱
   落库全是密文；看明文要过独立密码；每一次取用都留痕。
   ============================================================ */

import { api, LOGIN_TYPE_LABEL, AUDIT_ACTION_LABEL } from '../../../client/lib/api.js'
import { h, icon, fmtDateTime, relTime, copyText, fmtDate } from '../dom.js'
import {
  toast,
  toastErr,
  drawer,
  formDrawer,
  modal,
  confirmDelete,
  emptyState,
  tag,
} from '../ui.js'
import { vaultState, refreshVault, promptUnlock, ensureVaultReady, lockVault } from '../vaultgate.js'

/* ---------------- 凭证表单 ---------------- */

function credentialForm(values = {}, { customers = [], games = [], existingSecret = null } = {}) {
  const custOpts = customers.map((c) => ({ value: String(c.id), label: `${c.name}${c.phone ? ` · ${c.phone}` : ''}` }))
  const gameOpts = [{ value: '', label: '未指定' }, ...games.map((g) => ({ value: String(g.id), label: g.name }))]

  return formDrawer({
    title: values.id ? '改登录凭证' : '新登记一条登录凭证',
    subtitle: '内容加密后落库，明文不落盘',
    submitLabel: values.id ? '保存并重新加密' : '加密保存',
    wide: true,
    intro: h(
      'div.note',
      h('span', { style: { flex: 'none' } }, icon('shield', 16)),
      h('span', '优先扫码登录，不要密码就不用存密码。真需要代登时再填密码——它会用 AES-256-GCM 加密后写进数据库，任何时候查看或复制都会记一笔审计。')
    ),
    fields: [
      { type: 'section', title: '这条凭证属于谁' },
      {
        name: 'customer_id',
        label: '客户',
        type: 'select',
        required: true,
        width: 'half',
        default: values.customer_id ? String(values.customer_id) : '',
        options: custOpts,
      },
      { name: 'game_id', label: '游戏', type: 'select', width: 'half', default: values.game_id ? String(values.game_id) : '', options: gameOpts },
      { name: 'label', label: '备注名', type: 'text', width: 'half', default: values.label, placeholder: '例：主号 / 小号一' },
      {
        name: 'login_type',
        label: '登录方式',
        type: 'select',
        width: 'half',
        default: values.login_type || 'qrcode',
        options: [
          { value: 'qrcode', label: '扫码登录（推荐，不用存密码）' },
          { value: 'password', label: '账号密码' },
          { value: 'other', label: '其他方式' },
        ],
      },
      { name: 'server', label: '区服', type: 'text', width: 'half', default: values.server },
      { name: 'role_name', label: '角色名', type: 'text', width: 'half', default: values.role_name },

      { type: 'section', title: '加密内容', note: '这些字段会整块加密' },
      { name: 'account', label: '游戏账号', type: 'text', width: 'half', default: existingSecret?.account, placeholder: '手机号 / 邮箱 / 用户名' },
      { name: 'phone', label: '绑定手机号', type: 'text', width: 'half', default: existingSecret?.phone },
      { name: 'password', label: '密码', type: 'password', default: existingSecret?.password, hint: '不存也能用——留空表示这条只记账号信息' },
      { name: 'bind_phone', label: '密保手机', type: 'text', width: 'half', default: existingSecret?.bind_phone },
      { name: 'security_question', label: '密保问题', type: 'text', width: 'half', default: existingSecret?.security_question },
      { name: 'security_answer', label: '密保答案', type: 'text', width: 'half', default: existingSecret?.security_answer },
      { name: 'note', label: '备注', type: 'textarea', rows: 2, default: existingSecret?.note, placeholder: '例：不要动原石，不要抽卡' },
      {
        type: 'note',
        text: '不要在这里存短信验证码或临时密码——那些一次性用完就该消失。',
      },
    ],
    onSubmit: async (v) => {
      const secret = {
        account: v.account,
        phone: v.phone,
        password: v.password,
        bind_phone: v.bind_phone,
        security_question: v.security_question,
        security_answer: v.security_answer,
        note: v.note,
      }
      const payload = {
        customer_id: Number(v.customer_id),
        game_id: v.game_id ? Number(v.game_id) : null,
        label: v.label,
        login_type: v.login_type,
        server: v.server,
        role_name: v.role_name,
        secret,
      }
      if (!Object.values(secret).some((x) => String(x || '').trim())) throw new Error('加密内容不能全空，至少填一个字段')
      const r = values.id ? await api.patch(`/api/credentials/${values.id}`, payload) : await api.post('/api/credentials', payload)
      toast(values.id ? '已重新加密保存' : '凭证已加密存好', 'ok')
      return r
    },
  })
}

/* ---------------- 明文取用 ---------------- */

async function revealSecret(cred, { action = 'view' } = {}) {
  const ready = await promptUnlock({ reason: `查看「${cred.customer_name || ''} · ${cred.label || cred.masked_hint}」的登录信息，需要先解开保险箱。` })
  if (!ready) return
  let data
  try {
    data = await api.post(`/api/credentials/${cred.id}/reveal`, { action })
  } catch (err) {
    toastErr(err)
    return
  }
  const s = data.secret || {}
  const rows = [
    ['游戏账号', s.account],
    ['密码', s.password],
    ['绑定手机号', s.phone],
    ['密保手机', s.bind_phone],
    ['密保问题', s.security_question],
    ['密保答案', s.security_answer],
    ['备注', s.note],
  ].filter(([, v]) => String(v || '').trim())

  const grid = h('div.secretgrid')
  for (const [k, v] of rows) {
    grid.appendChild(h('div.secretgrid__k', k))
    grid.appendChild(
      h(
        'div.secretgrid__v',
        h('code', String(v)),
        h(
          'button.btn.btn--sm.btn--icon.btn--quiet',
          {
            type: 'button',
            title: '复制',
            onclick: async () => {
              const ok = await copyText(v)
              toast(ok ? '已复制（已记入审计）' : '复制失败', ok ? 'ok' : 'err')
              if (ok) {
                // 复制也算一次取用，单独留痕
                api.post(`/api/credentials/${cred.id}/reveal`, { action: 'copy', field: k }).catch(() => {})
              }
            },
          },
          icon('copy', 14)
        )
      )
    )
  }

  const allText = rows.map(([k, v]) => `${k}：${v}`).join('\n')

  modal({
    title: `${cred.customer_name || ''} · ${cred.label || '登录凭证'}`,
    wide: true,
    body: h(
      'div.stack',
      h(
        'div.cluster.sm.dim',
        h('span', data.game_name || '未指定游戏'),
        data.server ? h('span', `· ${data.server}`) : null,
        data.role_name ? h('span', `· ${data.role_name}`) : null,
        h('span', '·'),
        h('span', LOGIN_TYPE_LABEL[data.login_type] || data.login_type)
      ),
      h('div', { class: 'veil-clear' }, grid),
      h('div.note.note--warn', `本次取用于 ${fmtDateTime(data.revealed_at)} 记入审计日志。关闭后请勿口头转述或转发截图。`),
      h(
        'div.cluster',
        h(
          'button.btn.btn--sm',
          {
            type: 'button',
            onclick: async () => {
              const ok = await copyText(allText)
              toast(ok ? '整条已复制（已记入审计）' : '复制失败', ok ? 'ok' : 'err')
              if (ok) api.post(`/api/credentials/${cred.id}/reveal`, { action: 'copy', field: '整条' }).catch(() => {})
            },
          },
          icon('copy', 14),
          '复制整条'
        ),
        h('span.dim.tiny', '仅在客户明确要求代登时使用')
      )
    ),
    actions: [{ label: '看完了，关掉', tone: 'primary' }],
  })
}

/* ---------------- 解锁条 ---------------- */

function vaultBar(onChanged) {
  const wrap = h('div')
  const paint = () => {
    const configured = vaultState.configured
    const open = vaultState.unlocked
    wrap.replaceChildren(
      h(
        `div.vaultbar${open ? '.vaultbar--open' : ''}`,
        h('div.seal-mark', open ? '开' : '封'),
        h(
          'div.vaultbar__txt',
          h('div.strong', !configured ? '保险箱还没设密码' : open ? '保险箱已解开' : '保险箱已锁定'),
          h(
            'div.sm.dim',
            !configured
              ? '设一个独立密码，游戏账号密码才能开始加密入库。'
              : open
                ? `钥匙只在内存里，闲置 20 分钟或退出登录会自动落锁。${vaultState.expires_in_ms ? `还有约 ${Math.max(1, Math.round(vaultState.expires_in_ms / 60000))} 分钟。` : ''}`
                : '要看账号密码，先解开保险箱。每次查看和复制都会留痕。'
          )
        ),
        !configured
          ? h(
              'button.btn.btn--primary',
              {
                type: 'button',
                onclick: async () => {
                  const ok = await ensureVaultReady()
                  if (ok) {
                    toast('保险箱已就绪', 'ok')
                    onChanged()
                  }
                  paint()
                },
              },
              '设置密码'
            )
          : open
            ? h(
                'button.btn',
                {
                  type: 'button',
                  onclick: async () => {
                    await lockVault()
                    toast('已落锁', 'ok')
                    onChanged()
                    paint()
                  },
                },
                icon('vault', 15),
                '落锁'
              )
            : h(
                'button.btn.btn--primary',
                {
                  type: 'button',
                  onclick: async () => {
                    await promptUnlock({ reason: '解开后可以查看客户游戏账号密码。' })
                    onChanged()
                    paint()
                  },
                },
                icon('shield', 15),
                '解开保险箱'
              )
      )
    )
  }
  paint()
  return { node: wrap, paint }
}

/* ---------------- 审计日志 ---------------- */

async function auditDrawer() {
  const { items } = await api.get('/api/vault/audit', { limit: 300 })
  const d = drawer({
    wide: true,
    title: '取用记录',
    subtitle: '谁、什么时候、看了哪条',
    body: h(
      'div.stack',
      h('div.note', '这个列表只记不删。如果发现不是你本人的操作，请立刻改保险箱密码并检查这台电脑。'),
      items.length
        ? h(
            'div.itemlist',
            items.map((a) =>
              h(
                'div.item',
                { style: { cursor: 'default', alignItems: 'flex-start' } },
                h(
                  'div.item__main',
                  h(
                    'div.item__title',
                    AUDIT_ACTION_LABEL[a.action] || a.action,
                    a.action.includes('failed') ? tag('失败', 'oxblood') : null
                  ),
                  h('div.item__meta', h('span', a.customer_name || ''), h('span', a.target || ''), h('span.mono', a.ip || '')),
                  h('div.tbl__meta', `${fmtDateTime(a.created_at)} · ${relTime(a.created_at)} · 操作人 ${a.actor || '—'}`)
                )
              )
            )
          )
        : h('p.dim.sm', '还没有任何取用记录。')
    ),
  })
  return d
}

/* ---------------- 页面 ---------------- */

export default {
  title: '保险箱',
  async render(ctx) {
    await refreshVault()
    const [credRes, custRes, gameRes] = await Promise.all([
      api.get('/api/credentials', { limit: 500 }),
      api.get('/api/customers', { status: 'active', limit: 500 }),
      api.get('/api/games', { limit: 200 }),
    ])
    let creds = credRes.items || []
    const customers = custRes.items || []
    const games = gameRes.items || []

    const focusCustomer = ctx.query.get('customer')
    if (focusCustomer) creds = creds.filter((c) => String(c.customer_id) === String(focusCustomer))

    const bar = vaultBar(() => ctx.app.reload())

    ctx.setActions(
      h('button.btn.btn--sm', { type: 'button', onclick: () => auditDrawer() }, icon('clock', 14), '取用记录'),
      h('button.btn.btn--sm.btn--primary', {
        type: 'button',
        onclick: async () => {
          const ok = await ensureVaultReady()
          if (!ok) return
          const saved = await credentialForm({ customer_id: focusCustomer || '' }, { customers, games })
          if (saved) {
            toast('已加密保存', 'ok')
            ctx.app.reload()
          }
        },
      }, icon('plus', 14), '登记凭证')
    )

    const body = creds.length
      ? h(
          'div.itemlist',
          creds.map((c) => {
            const locked = !vaultState.unlocked
            return h(
              'div.item',
              { style: { cursor: 'default', alignItems: 'flex-start' } },
              h(
                'div.item__main',
                h(
                  'div.item__title',
                  c.label || '未命名凭证',
                  tag(LOGIN_TYPE_LABEL[c.login_type] || c.login_type, c.login_type === 'qrcode' ? 'jade' : ''),
                  c.status === 'archived' ? tag('已归档', 'oxblood') : null
                ),
                h(
                  'div.item__meta',
                  h('span', c.customer_name || '—'),
                  h('span', c.game_name || '未指定游戏'),
                  c.server ? h('span', c.server) : null,
                  c.role_name ? h('span', c.role_name) : null,
                  h('span', `建于 ${fmtDate(c.created_at)}`)
                ),
                h(
                  'div',
                  { style: { marginTop: '6px' } },
                  locked
                    ? h('span.sealed', h('span.seal-mark', '封'), '内容已加密封存 · 解开保险箱后可查看')
                    : h('span.mono.sm', c.masked_hint || '（没记账号）')
                )
              ),
              h(
                'div.tbl__acts',
                h(
                  'button.btn.btn--sm',
                  {
                    type: 'button',
                    onclick: () => revealSecret(c),
                  },
                  icon(locked ? 'vault' : 'eye', 14),
                  locked ? '解开查看' : '查看'
                ),
                h(
                  'button.btn.btn--sm',
                  {
                    type: 'button',
                    onclick: async () => {
                      const ok = await promptUnlock({ reason: '改凭证内容也要先解开保险箱。' })
                      if (!ok) return
                      let secret = null
                      try {
                        secret = (await api.post(`/api/credentials/${c.id}/reveal`, { action: 'view' })).secret
                      } catch (err) {
                        toastErr(err)
                        return
                      }
                      const saved = await credentialForm(c, { customers, games, existingSecret: secret })
                      if (saved) ctx.app.reload()
                    },
                  },
                  icon('edit', 14)
                ),
                h(
                  'button.btn.btn--sm.btn--danger',
                  {
                    type: 'button',
                    onclick: async () => {
                      const ok = await confirmDelete({
                        title: '删掉这条凭证？',
                        message: `${c.customer_name || ''} · ${c.label || c.masked_hint}。删除会记入审计，且无法恢复。`,
                      })
                      if (!ok) return
                      try {
                        await api.del(`/api/credentials/${c.id}`)
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
          })
        )
      : emptyState({
          iconName: 'vault',
          title: focusCustomer ? '这位客户还没有凭证' : '保险箱是空的',
          body: vaultState.configured
            ? '登记客户的游戏登录方式。优先扫码登录——那样一个密码都不用存。'
            : '先给保险箱设一个独立密码，然后才能开始加密保存凭证。',
          steps: vaultState.configured
            ? [
                '点右上角「登记凭证」，选客户和游戏。',
                '登录方式优先选「扫码登录」，不需要存密码。',
                '真需要代登时再填账号密码，会加密落库。',
                '之后每次查看或复制，都会自动记一笔审计。',
              ]
            : null,
          actionLabel: vaultState.configured ? '登记第一条凭证' : '给保险箱设密码',
          onAction: async () => {
            const ok = await ensureVaultReady()
            if (!ok) return
            if (!vaultState.configured) return ctx.app.reload()
            const saved = await credentialForm({ customer_id: focusCustomer || '' }, { customers, games })
            if (saved) ctx.app.reload()
          },
        })

    const focusedId = ctx.query.get('c')
    if (focusedId) {
      const c = creds.find((x) => String(x.id) === String(focusedId)) || (credRes.items || []).find((x) => String(x.id) === String(focusedId))
      if (c && vaultState.unlocked) setTimeout(() => revealSecret(c), 150)
    }

    return h(
      'div.stack',
      h(
        'div.pagehead',
        h(
          'div.pagehead__txt',
          h('h1', '登录凭证保险箱'),
          h(
            'p.pagehead__sub',
            `${creds.length} 条凭证 · 用 AES-256-GCM 加密存储，明文不落盘`
          )
        )
      ),
      bar.node,
      creds.length && !vaultState.unlocked
        ? h('div.note.note--warn', '保险箱已锁定：下面的内容全被封着。这是故意的——万一这台电脑被别人打开，第一眼看不到任何账号。')
        : null,
      h('section.panel', h('div.panel__body.panel__body--flush', body))
    )
  },
}
