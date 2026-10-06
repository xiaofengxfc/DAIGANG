import React, { useCallback, useEffect, useState } from 'react'
import { ClipboardCopy, Clock, Edit3, Eye, LockKeyhole, Plus, ShieldCheck, Trash2, Unlock } from 'lucide-react'
import { AUDIT_ACTION_LABEL, LOGIN_TYPE_LABEL, api } from './lib/api.js'
import { fmtDate, fmtDateTime, relTime } from './lib/formatters.js'
import { copyText } from './lib/dom.js'
import { toast, toastErr } from './app/toast-store.js'
import { confirmDelete } from './app/confirm.jsx'
import Modal from './app/modal.jsx'
import Drawer from './app/drawer.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { Field, SelectInput, TextArea, TextInput } from './app/fields.jsx'
import { ensureVaultReady, promptUnlock, useVaultState } from './vault-gate.jsx'
import { lockVault, refreshVault } from '../public/js/vaultgate.js'

/* ============================================================
   登录凭证保险箱（React 版）
   ============================================================

   原来是 public/js/views/vault.js：一条条凭证列在那儿，明文要看先过独立密码，
   每次查看/复制都留一笔审计。加密、解密、审计全在服务端，这边只管门禁和呈现。

   门禁状态（configured / unlocked）还是 public/js/vaultgate.js 里那一份，
   弹窗换成 React 的（client/vault-gate.jsx）。
   ============================================================ */

const iconProps = (size) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

export default function VaultPage({ route, navigate, onReload, reloadKey }) {
  const vault = useVaultState()
  const [creds, setCreds] = useState(null)
  const [customers, setCustomers] = useState([])
  const [games, setGames] = useState([])
  const [error, setError] = useState('')

  const focusCustomer = route.query.get('customer') || ''
  const focusedId = route.query.get('c') || ''

  const load = useCallback(async () => {
    try {
      await refreshVault()
      const [credRes, custRes, gameRes] = await Promise.all([
        api.get('/api/credentials', { limit: 500 }),
        api.get('/api/customers', { status: 'active', limit: 500 }),
        api.get('/api/games', { limit: 200 }),
      ])
      setCreds(credRes.items || [])
      setCustomers(custRes.items || [])
      setGames(gameRes.items || [])
      setError('')
    } catch (err) {
      setError(err?.message || String(err))
      setCreds([])
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  const reload = useCallback(() => {
    load()
    if (onReload) onReload()
  }, [load, onReload])

  // 从搜索结果 / 客户档案点「这条凭证」进来：解开之后直接把明文弹出来
  useEffect(() => {
    if (!focusedId || !vault.unlocked || !creds) return
    const cred = creds.find((item) => String(item.id) === String(focusedId))
    if (!cred) return
    const timer = setTimeout(() => revealSecret(cred), 150)
    return () => window.clearTimeout(timer)
  }, [focusedId, vault.unlocked, creds, reload])

  const shown = focusCustomer ? (creds || []).filter((cred) => String(cred.customer_id) === String(focusCustomer)) : creds || []
  const locked = !vault.unlocked

  async function register() {
    const ready = await ensureVaultReady()
    if (!ready) return
    const saved = await openCredentialForm({ customer_id: focusCustomer || '' }, { customers, games })
    if (saved) {
      toast('已加密保存', 'ok')
      reload()
    }
  }

  async function edit(cred) {
    const ready = await promptUnlock({ reason: '改凭证内容也要先解开保险箱。' })
    if (!ready) return
    let secret = null
    try {
      secret = (await api.post(`/api/credentials/${cred.id}/reveal`, { action: 'view' })).secret
    } catch (err) {
      toastErr(err)
      return
    }
    const saved = await openCredentialForm(cred, { customers, games, existingSecret: secret })
    if (saved) reload()
  }

  async function remove(cred) {
    const yes = await confirmDelete({
      title: '删掉这条凭证？',
      message: `${cred.customer_name || ''} · ${cred.label || cred.masked_hint}。删除会记入审计，且无法恢复。`,
    })
    if (!yes) return
    try {
      await api.del(`/api/credentials/${cred.id}`)
      toast('已删除', 'ok')
      reload()
    } catch (err) {
      toastErr(err)
    }
  }

  return (
    <div className="vault-page">
      <header className="vault-page__head">
        <div>
          <h2>登录凭证保险箱</h2>
          <p>{`${shown.length} 条凭证 · 用 AES-256-GCM 加密存储，明文不落盘`}</p>
        </div>
        <div className="vault-page__actions">
          <button className="refactor-button" type="button" onClick={() => openAudit()}><Clock {...iconProps(14)} />取用记录</button>
          <button className="refactor-button refactor-button--primary" type="button" onClick={register}><Plus {...iconProps(14)} />登记凭证</button>
        </div>
      </header>

      {error ? <div className="refactor-alert" role="alert">{error}</div> : null}

      <VaultBar vault={vault} onChanged={reload} />

      {shown.length && locked ? (
        <div className="note note--warn">保险箱已锁定：下面的内容全被封着。这是故意的——万一这台电脑被别人打开，第一眼看不到任何账号。</div>
      ) : null}

      <section className="panel">
        <div className="panel__body panel__body--flush">
          {creds === null ? (
            <div className="refactor-loading"><span /><span /><span /></div>
          ) : shown.length ? (
            <div className="itemlist">
              {shown.map((cred) => (
                <div className="item" key={cred.id} style={{ cursor: 'default', alignItems: 'flex-start' }}>
                  <div className="item__main">
                    <div className="item__title">
                      {cred.label || '未命名凭证'}
                      <span className={`tag${cred.login_type === 'qrcode' ? ' tag--jade' : ''}`}>{LOGIN_TYPE_LABEL[cred.login_type] || cred.login_type}</span>
                      {cred.status === 'archived' ? <span className="tag tag--oxblood">已归档</span> : null}
                    </div>
                    <div className="item__meta">
                      <span>{cred.customer_name || '—'}</span>
                      <span>{cred.game_name || '未指定游戏'}</span>
                      {cred.server ? <span>{cred.server}</span> : null}
                      {cred.role_name ? <span>{cred.role_name}</span> : null}
                      <span>{`建于 ${fmtDate(cred.created_at)}`}</span>
                    </div>
                    <div style={{ marginTop: '6px' }}>
                      {locked ? (
                        <span className="sealed"><span className="seal-mark">封</span>内容已加密封存 · 解开保险箱后可查看</span>
                      ) : (
                        <span className="mono sm">{cred.masked_hint || '（没记账号）'}</span>
                      )}
                    </div>
                  </div>
                  <div className="tbl__acts">
                    <button className="btn btn--sm" type="button" onClick={() => revealSecret(cred)}>
                      {locked ? <LockKeyhole {...iconProps(14)} /> : <Eye {...iconProps(14)} />}
                      {locked ? '解开查看' : '查看'}
                    </button>
                    <button className="btn btn--sm" type="button" title="改凭证" onClick={() => edit(cred)}><Edit3 {...iconProps(14)} /></button>
                    <button className="btn btn--sm btn--danger" type="button" title="删除凭证" onClick={() => remove(cred)}><Trash2 {...iconProps(14)} /></button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="panel__body">
              <div className="empty">
                <div className="empty__mark"><ShieldCheck {...iconProps(20)} /></div>
                <div className="empty__title">{focusCustomer ? '这位客户还没有凭证' : '保险箱是空的'}</div>
                <p className="empty__body">
                  {vault.configured ? '登记客户的游戏登录方式。优先扫码登录——那样一个密码都不用存。' : '先给保险箱设一个独立密码，然后才能开始加密保存凭证。'}
                </p>
                {vault.configured ? (
                  <ul className="empty__steps">
                    <li><span className="n">·</span><span>点右上角「登记凭证」，选客户和游戏。</span></li>
                    <li><span className="n">·</span><span>登录方式优先选「扫码登录」，不需要存密码。</span></li>
                    <li><span className="n">·</span><span>真需要代登时再填账号密码，会加密落库。</span></li>
                    <li><span className="n">·</span><span>之后每次查看或复制，都会自动记一笔审计。</span></li>
                  </ul>
                ) : null}
                <button className="refactor-button refactor-button--primary" type="button" onClick={register}>
                  {vault.configured ? '登记第一条凭证' : '给保险箱设密码'}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  )
}

/* ---------------- 解锁条 ---------------- */

function VaultBar({ vault, onChanged }) {
  const open = vault.unlocked
  const configured = vault.configured
  const minutes = vault.expires_in_ms ? Math.max(1, Math.round(vault.expires_in_ms / 60000)) : 0

  return (
    <div className={`vaultbar${open ? ' vaultbar--open' : ''}`}>
      <div className="seal-mark">{open ? '开' : '封'}</div>
      <div className="vaultbar__txt">
        <div className="strong">{!configured ? '保险箱还没设密码' : open ? '保险箱已解开' : '保险箱已锁定'}</div>
        <div className="sm dim">
          {!configured
            ? '设一个独立密码，游戏账号密码才能开始加密入库。'
            : open
              ? `钥匙只在内存里，闲置 20 分钟或退出登录会自动落锁。${minutes ? `还有约 ${minutes} 分钟。` : ''}`
              : '要看账号密码，先解开保险箱。每次查看和复制都会留痕。'}
        </div>
      </div>
      {!configured ? (
        <button
          className="btn btn--primary"
          type="button"
          onClick={async () => {
            const ready = await ensureVaultReady()
            if (ready) {
              toast('保险箱已就绪', 'ok')
              onChanged()
            }
          }}
        >
          设置密码
        </button>
      ) : open ? (
        <button
          className="btn"
          type="button"
          onClick={async () => {
            try {
              await lockVault()
              toast('已落锁', 'ok')
              onChanged()
            } catch (err) {
              toastErr(err)
            }
          }}
        >
          <LockKeyhole {...iconProps(15)} />落锁
        </button>
      ) : (
        <button
          className="btn btn--primary"
          type="button"
          onClick={async () => {
            await promptUnlock({ reason: '解开后可以查看客户游戏账号密码。' })
            onChanged()
          }}
        >
          <Unlock {...iconProps(15)} />解开保险箱
        </button>
      )}
    </div>
  )
}

/* ---------------- 凭证表单 ---------------- */

function openCredentialForm(values = {}, { customers = [], games = [], existingSecret = null } = {}) {
  const editing = Boolean(values.id)
  return openOverlay(
    (close) => <CredentialForm values={values} customers={customers} games={games} existingSecret={existingSecret} close={close} />,
    editing ? `credential-form-${values.id}` : 'credential-form'
  )
}

function CredentialForm({ values, customers, games, existingSecret, close }) {
  const editing = Boolean(values.id)
  const [form, setForm] = useState(() => ({
    customer_id: values.customer_id ? String(values.customer_id) : '',
    game_id: values.game_id ? String(values.game_id) : '',
    label: values.label || '',
    login_type: values.login_type || 'qrcode',
    server: values.server || '',
    role_name: values.role_name || '',
    account: existingSecret?.account || '',
    phone: existingSecret?.phone || '',
    password: existingSecret?.password || '',
    bind_phone: existingSecret?.bind_phone || '',
    security_question: existingSecret?.security_question || '',
    security_answer: existingSecret?.security_answer || '',
    note: existingSecret?.note || '',
  }))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit() {
    if (!form.customer_id) {
      setError('请选择客户')
      return
    }
    const secret = {
      account: form.account,
      phone: form.phone,
      password: form.password,
      bind_phone: form.bind_phone,
      security_question: form.security_question,
      security_answer: form.security_answer,
      note: form.note,
    }
    if (!Object.values(secret).some((value) => String(value || '').trim())) {
      setError('加密内容不能全空，至少填一个字段')
      return
    }
    const payload = {
      customer_id: Number(form.customer_id),
      game_id: form.game_id ? Number(form.game_id) : null,
      label: form.label,
      login_type: form.login_type,
      server: form.server,
      role_name: form.role_name,
      secret,
    }
    setBusy(true)
    setError('')
    try {
      const saved = editing ? await api.patch(`/api/credentials/${values.id}`, payload) : await api.post('/api/credentials', payload)
      toast(editing ? '已重新加密保存' : '凭证已加密存好', 'ok')
      close(saved)
    } catch (err) {
      setError(err?.message || '保存失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      wide
      title={editing ? '改登录凭证' : '新登记一条登录凭证'}
      subtitle="内容加密后落库，明文不落盘"
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>取消</button>
          <button className="btn btn--primary" type="submit" form="credential-form" disabled={busy} data-loading={busy ? '1' : undefined}>
            {editing ? '保存并重新加密' : '加密保存'}
          </button>
        </>
      }
    >
      <form
        id="credential-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="stack">
          <div className="note">
            <span style={{ flex: 'none' }}><ShieldCheck {...iconProps(16)} /></span>
            <span>优先扫码登录，不要密码就不用存密码。真需要代登时再填密码——它会用 AES-256-GCM 加密后写进数据库，任何时候查看或复制都会记一笔审计。</span>
          </div>

          <div className="sechead"><h3>这条凭证属于谁</h3></div>
          <div className="formgrid">
            <Field label="客户" required half htmlFor="credential-customer" error={error && !form.customer_id ? error : ''}>
              <SelectInput
                id="credential-customer"
                value={form.customer_id}
                onChange={set('customer_id')}
                options={[{ value: '', label: '— 选客户 —' }, ...customers.map((customer) => ({ value: String(customer.id), label: `${customer.name}${customer.phone ? ` · ${customer.phone}` : ''}` }))]}
              />
            </Field>
            <Field label="游戏" half htmlFor="credential-game">
              <SelectInput id="credential-game" value={form.game_id} onChange={set('game_id')} options={[{ value: '', label: '未指定' }, ...games.map((game) => ({ value: String(game.id), label: game.name }))]} />
            </Field>
            <Field label="备注名" half htmlFor="credential-label">
              <TextInput id="credential-label" value={form.label} onChange={set('label')} placeholder="例：主号 / 小号一" />
            </Field>
            <Field label="登录方式" half htmlFor="credential-login-type">
              <SelectInput
                id="credential-login-type"
                value={form.login_type}
                onChange={set('login_type')}
                options={[
                  { value: 'qrcode', label: '扫码登录（推荐，不用存密码）' },
                  { value: 'password', label: '账号密码' },
                  { value: 'other', label: '其他方式' },
                ]}
              />
            </Field>
            <Field label="区服" half htmlFor="credential-server">
              <TextInput id="credential-server" value={form.server} onChange={set('server')} />
            </Field>
            <Field label="角色名" half htmlFor="credential-role">
              <TextInput id="credential-role" value={form.role_name} onChange={set('role_name')} />
            </Field>
          </div>

          <div className="sechead">
            <h3>加密内容</h3>
            <span className="sechead__note">这些字段会整块加密</span>
          </div>
          <div className="formgrid">
            <Field label="游戏账号" half htmlFor="credential-account">
              <TextInput id="credential-account" value={form.account} onChange={set('account')} placeholder="手机号 / 邮箱 / 用户名" />
            </Field>
            <Field label="绑定手机号" half htmlFor="credential-phone">
              <TextInput id="credential-phone" value={form.phone} onChange={set('phone')} />
            </Field>
            <Field label="密码" htmlFor="credential-password" hint="不存也能用——留空表示这条只记账号信息">
              <input id="credential-password" className="inp" type="password" autoComplete="off" value={form.password} onChange={(event) => set('password')(event.target.value)} />
            </Field>
            <Field label="密保手机" half htmlFor="credential-bind-phone">
              <TextInput id="credential-bind-phone" value={form.bind_phone} onChange={set('bind_phone')} />
            </Field>
            <Field label="密保问题" half htmlFor="credential-security-question">
              <TextInput id="credential-security-question" value={form.security_question} onChange={set('security_question')} />
            </Field>
            <Field label="密保答案" half htmlFor="credential-security-answer">
              <TextInput id="credential-security-answer" value={form.security_answer} onChange={set('security_answer')} />
            </Field>
            <Field label="备注" htmlFor="credential-note">
              <TextArea id="credential-note" rows={2} value={form.note} onChange={set('note')} placeholder="例：不要动原石，不要抽卡" />
            </Field>
          </div>

          <div className="note">不要在这里存短信验证码或临时密码——那些一次性用完就该消失。</div>
          {error && form.customer_id ? <div className="note note--alert">{error}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}

/* ---------------- 明文取用 ---------------- */

async function revealSecret(cred) {
  const ready = await promptUnlock({ reason: `查看「${cred.customer_name || ''} · ${cred.label || cred.masked_hint}」的登录信息，需要先解开保险箱。` })
  if (!ready) return
  let data
  try {
    data = await api.post(`/api/credentials/${cred.id}/reveal`, { action: 'view' })
  } catch (err) {
    toastErr(err)
    return
  }
  openOverlay((close) => <RevealModal cred={cred} data={data} close={close} />, `credential-reveal-${cred.id}`)
}

function RevealModal({ cred, data, close }) {
  const secret = data.secret || {}
  const rows = [
    ['游戏账号', secret.account],
    ['密码', secret.password],
    ['绑定手机号', secret.phone],
    ['密保手机', secret.bind_phone],
    ['密保问题', secret.security_question],
    ['密保答案', secret.security_answer],
    ['备注', secret.note],
  ].filter(([, value]) => String(value || '').trim())
  const allText = rows.map(([key, value]) => `${key}：${value}`).join('\n')

  /** 复制也算一次取用，单独留痕 */
  async function copyOne(label, value) {
    const ok = await copyText(String(value))
    toast(ok ? '已复制（已记入审计）' : '复制失败', ok ? 'ok' : 'err')
    if (ok) api.post(`/api/credentials/${cred.id}/reveal`, { action: 'copy', field: label }).catch(() => {})
  }

  async function copyAll() {
    const ok = await copyText(allText)
    toast(ok ? '整条已复制（已记入审计）' : '复制失败', ok ? 'ok' : 'err')
    if (ok) api.post(`/api/credentials/${cred.id}/reveal`, { action: 'copy', field: '整条' }).catch(() => {})
  }

  return (
    <Modal
      title={`${cred.customer_name || ''} · ${cred.label || '登录凭证'}`}
      wide
      onClose={() => close(null)}
      footer={<button className="btn btn--primary" type="button" onClick={() => close(null)}>看完了，关掉</button>}
    >
      <div className="stack">
        <div className="cluster sm dim">
          <span>{data.game_name || '未指定游戏'}</span>
          {data.server ? <span>{`· ${data.server}`}</span> : null}
          {data.role_name ? <span>{`· ${data.role_name}`}</span> : null}
          <span>·</span>
          <span>{LOGIN_TYPE_LABEL[data.login_type] || data.login_type}</span>
        </div>
        <div className="veil-clear">
          <div className="secretgrid">
            {rows.map(([label, value]) => (
              <React.Fragment key={label}>
                <div className="secretgrid__k">{label}</div>
                <div className="secretgrid__v">
                  <code>{String(value)}</code>
                  <button className="btn btn--sm btn--icon btn--quiet" type="button" title="复制" onClick={() => copyOne(label, value)}>
                    <ClipboardCopy {...iconProps(14)} />
                  </button>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
        <div className="note note--warn">{`本次取用于 ${fmtDateTime(data.revealed_at)} 记入审计日志。关闭后请勿口头转述或转发截图。`}</div>
        <div className="cluster">
          <button className="btn btn--sm" type="button" onClick={copyAll}><ClipboardCopy {...iconProps(14)} />复制整条</button>
          <span className="dim tiny">仅在客户明确要求代登时使用</span>
        </div>
      </div>
    </Modal>
  )
}

/* ---------------- 审计日志 ---------------- */

function openAudit() {
  return openOverlay((close) => <AuditDrawer close={close} />, 'vault-audit')
}

function AuditDrawer({ close }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    api
      .get('/api/vault/audit', { limit: 300 })
      .then((data) => active && setItems(data.items || []))
      .catch((err) => {
        if (!active) return
        setError(err?.message || String(err))
        setItems([])
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <Drawer
      wide
      title="取用记录"
      subtitle="谁、什么时候、看了哪条"
      onClose={() => close(null)}
      footer={<button className="btn" type="button" onClick={() => close(null)}>关掉</button>}
    >
      <div className="stack">
        <div className="note">这个列表只记不删。如果发现不是你本人的操作，请立刻改保险箱密码并检查这台电脑。</div>
        {error ? <div className="note note--alert">{error}</div> : null}
        {items === null ? (
          <div className="refactor-loading"><span /><span /><span /></div>
        ) : items.length ? (
          <div className="itemlist">
            {items.map((entry) => (
              <div className="item" key={entry.id} style={{ cursor: 'default', alignItems: 'flex-start' }}>
                <div className="item__main">
                  <div className="item__title">
                    {AUDIT_ACTION_LABEL[entry.action] || entry.action}
                    {String(entry.action).includes('failed') ? <span className="tag tag--oxblood">失败</span> : null}
                  </div>
                  <div className="item__meta">
                    <span>{entry.customer_name || ''}</span>
                    <span>{entry.target || ''}</span>
                    <span className="mono">{entry.ip || ''}</span>
                  </div>
                  <div className="tbl__meta">{`${fmtDateTime(entry.created_at)} · ${relTime(entry.created_at)} · 操作人 ${entry.actor || '—'}`}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="dim sm">还没有任何取用记录。</p>
        )}
      </div>
    </Drawer>
  )
}
