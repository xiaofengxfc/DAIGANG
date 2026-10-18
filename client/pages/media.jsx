import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CalendarClock, Check, CheckCircle2, Clock3, FileVideo, FolderOpen, Pencil, Plus, Radio, RefreshCw, RotateCcw, Send, Trash2, Upload, UserRound, X } from 'lucide-react'
import { api } from '../lib/api.js'
import { toast, toastErr } from '../app/toast-store.js'

const EMPTY = { platforms: [], accounts: [], materials: [], tasks: [], summary: {}, executor: { configured: false } }
const STATUS = {
  queued: ['待发布', 'amber'],
  scheduled: ['已排期', 'slate'],
  publishing: ['发布中', 'cinnabar'],
  success: ['已完成', 'jade'],
  failed: ['失败', 'oxblood'],
  cancelled: ['已取消', 'outline'],
}

function iconProps(size = 16) {
  return { size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true }
}

function Toggle({ active, onClick, children, disabled = false }) {
  return <button type="button" className={`media-toggle${active ? ' is-selected' : ''}`} onClick={onClick} disabled={disabled}>{children}</button>
}

function statusTag(status) {
  const [label, tone] = STATUS[status] || [status, 'outline']
  return <span className={`tag tag--${tone}`}>{label}</span>
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(value) {
  if (!value) return '未设置'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export default function MediaPage({ reloadKey = 0 }) {
  const [activeTab, setActiveTab] = useState('publish')
  const [data, setData] = useState(EMPTY)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [draft, setDraft] = useState({ title: '', content: '', topics: '', publish_at: '', platform_keys: [], account_ids: [], material_ids: [] })
  const [accountForm, setAccountForm] = useState({ platform: '', account_name: '', profile_url: '', note: '' })
  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dependencyStatus, setDependencyStatus] = useState(null)
  const [dependencyInstalling, setDependencyInstalling] = useState(false)
  const [dependencyRefreshing, setDependencyRefreshing] = useState(false)
  const [loginJobs, setLoginJobs] = useState({})
  const fileRef = useRef(null)

  const load = async ({ quiet = false } = {}) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    try {
      setData(await api.get('/api/media/bootstrap'))
    } catch (err) {
      toastErr(err)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { load() }, [reloadKey])
  useEffect(() => {
    api.get('/api/media/dependencies').then(setDependencyStatus).catch(() => {})
  }, [reloadKey])

  const selectedPlatforms = useMemo(() => new Set(draft.platform_keys), [draft.platform_keys])
  const accountOptions = useMemo(() => data.accounts.filter((account) => account.auth_state !== 'disabled' && (!selectedPlatforms.size || selectedPlatforms.has(account.platform))), [data.accounts, selectedPlatforms])
  const updateDraft = (key, value) => setDraft((current) => ({ ...current, [key]: value }))
  const toggleDraftValue = (key, value) => setDraft((current) => ({ ...current, [key]: current[key].includes(value) ? current[key].filter((item) => item !== value) : [...current[key], value] }))

  async function uploadFiles(event) {
    const files = [...(event.target.files || [])]
    event.target.value = ''
    if (!files.length) return
    setUploading(true)
    try {
      for (const file of files) {
        const response = await fetch('/api/media/materials/upload', {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
          body: file,
          credentials: 'same-origin',
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error || `上传「${file.name}」失败`)
      }
      toast(`已上传 ${files.length} 个素材`, 'ok')
      await load({ quiet: true })
    } catch (err) {
      toastErr(err)
    } finally {
      setUploading(false)
    }
  }

  async function createTask(event) {
    event.preventDefault()
    if (!draft.title.trim()) return toast('请先填写标题', 'warn')
    if (!draft.platform_keys.length) return toast('至少选择一个发布平台', 'warn')
    if (!draft.account_ids.length) return toast('至少选择一个账号', 'warn')
    if (!draft.material_ids.length) return toast('至少选择一个素材', 'warn')
    setSaving(true)
    try {
      const saved = await api.post('/api/media/tasks', draft)
      setDraft({ title: '', content: '', topics: '', publish_at: '', platform_keys: [], account_ids: [], material_ids: [] })
      toast(saved.status === 'scheduled' ? '发布任务已排期' : '发布任务已加入队列', 'ok')
      setActiveTab('records')
      await load({ quiet: true })
    } catch (err) {
      toastErr(err)
    } finally {
      setSaving(false)
    }
  }

  async function addAccount(event) {
    event.preventDefault()
    if (!accountForm.platform || !accountForm.account_name.trim()) return toast('请填写平台和账号名称', 'warn')
    try {
      await api.post('/api/media/accounts', accountForm)
      setAccountForm({ platform: '', account_name: '', profile_url: '', note: '' })
      toast('账号已添加', 'ok')
      await load({ quiet: true })
    } catch (err) {
      toastErr(err)
    }
  }

  async function deleteAccount(id) {
    if (!window.confirm('删除这个账号记录？已创建的发布任务不会被删除。')) return
    try { await api.del(`/api/media/accounts/${id}`); await load({ quiet: true }) } catch (err) { toastErr(err) }
  }

  async function deleteMaterial(id) {
    if (!window.confirm('删除这个素材文件？')) return
    try { await api.del(`/api/media/materials/${id}`); await load({ quiet: true }) } catch (err) { toastErr(err) }
  }

  async function renameMaterial(id, filename) {
    try {
      await api.patch(`/api/media/materials/${id}`, { filename })
      toast('素材名称已更新', 'ok')
      await load({ quiet: true })
      return true
    } catch (err) {
      toastErr(err)
      return false
    }
  }

  async function uploadCookie(accountId, event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const response = await fetch(`/api/media/accounts/${accountId}/cookie`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: file, credentials: 'same-origin' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || '登录态导入失败')
      toast('登录态已导入，账号标记为已验证', 'ok')
      await load({ quiet: true })
    } catch (err) { toastErr(err) }
  }

  async function loginAccount(accountId) {
    try {
      const started = await api.post(`/api/media/accounts/${accountId}/login`, {})
      setLoginJobs((current) => ({ ...current, [accountId]: { job: started.job, status: 'running', message: '浏览器已打开，请完成登录' } }))
      for (let i = 0; i < 220; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const status = await api.get(`/api/media/accounts/${accountId}/login/status`, { job: started.job })
        setLoginJobs((current) => ({ ...current, [accountId]: status }))
        if (['success', 'failed'].includes(status.status)) {
          toast(status.status === 'success' ? '账号登录态已保存' : (status.message || '账号登录失败'), status.status === 'success' ? 'ok' : 'warn')
          await load({ quiet: true })
          break
        }
      }
    } catch (err) { toastErr(err) }
  }

  async function installDependencies() {
    setDependencyInstalling(true)
    try {
      const started = await api.post('/api/media/dependencies/install', {})
      if (!started.ok) {
        setDependencyStatus(started.status || dependencyStatus)
        toast(started.error || '暂时不能安装依赖', 'warn')
        return
      }
      toast('开始安装 Python 依赖和 Chromium，请稍候', 'ok', 5000)
      let finalJob = null
      for (let i = 0; i < 120; i += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500))
        const status = await api.get('/api/media/dependencies/install/status', { job: started.job })
        finalJob = status
        setDependencyStatus((current) => ({ ...(current || {}), install_job: status }))
        if (['success', 'failed'].includes(status.status)) break
      }
      const fresh = await api.get('/api/media/dependencies')
      setDependencyStatus({ ...fresh, install_job: finalJob })
      if (finalJob?.status === 'failed') toast(finalJob.error || '依赖安装失败，请查看安装日志', 'warn', 8000)
    } catch (err) { toastErr(err) } finally { setDependencyInstalling(false) }
  }

  async function refreshDependencies() {
    setDependencyRefreshing(true)
    try {
      setDependencyStatus(await api.get('/api/media/dependencies', { force: 1 }))
      toast('依赖检测已完成', 'ok')
    } catch (err) { toastErr(err) } finally { setDependencyRefreshing(false) }
  }

  async function taskAction(path, successMessage) {
    try {
      const result = await api.post(path, {})
      if (result.available === false) toast('任务已保留，配置执行器后可继续发布', 'warn')
      else toast(successMessage, result.status === 'failed' ? 'warn' : 'ok')
      await load({ quiet: true })
    } catch (err) { toastErr(err) }
  }

  if (loading) return <div className="refactor-loading"><span /><span /><span /></div>

  return (
    <div className="media-page">
      <div className="media-page__head">
        <div>
          <h2>自媒体发布</h2>
          <p>统一管理素材、平台账号和跨平台发布任务。</p>
        </div>
        <div className="media-page__head-actions">
          <span className={`media-executor${data.executor?.configured ? ' is-ready' : ''}`}><i />{data.executor?.configured ? '执行器已连接' : '管理模式'}</span>
          <button type="button" className="refactor-icon-button" title="刷新媒体数据" onClick={() => load({ quiet: true })} disabled={refreshing}><RefreshCw className={refreshing ? 'spin' : ''} {...iconProps(16)} /></button>
        </div>
      </div>

      <div className="media-summary">
        <div><Radio {...iconProps(17)} /><span><b>{data.summary?.queued || 0}</b><small>待处理任务</small></span></div>
        <div><FolderOpen {...iconProps(17)} /><span><b>{data.summary?.materials || 0}</b><small>素材文件</small></span></div>
        <div><UserRound {...iconProps(17)} /><span><b>{data.summary?.accounts || 0}</b><small>可用账号</small></span></div>
        <div><AlertTriangle {...iconProps(17)} /><span><b>{data.summary?.failed || 0}</b><small>失败任务</small></span></div>
      </div>

      <div className="media-tabs" role="tablist" aria-label="自媒体模块">
        {[["publish", "发布任务", Send], ["materials", "素材库", FolderOpen], ["accounts", "账号管理", UserRound], ["records", "发布记录", Clock3]].map(([key, label, Icon]) => <button key={key} type="button" role="tab" aria-selected={activeTab === key} className={activeTab === key ? 'is-active' : ''} onClick={() => setActiveTab(key)}><Icon {...iconProps(16)} />{label}</button>)}
      </div>

      {!data.executor?.configured || activeTab === 'accounts' ? <MediaDependencyCard status={dependencyStatus} installing={dependencyInstalling} refreshing={dependencyRefreshing} onInstall={installDependencies} onRefresh={refreshDependencies} /> : null}

      {activeTab === 'publish' ? <PublishComposer data={data} draft={draft} updateDraft={updateDraft} toggleDraftValue={toggleDraftValue} accountOptions={accountOptions} onSubmit={createTask} onUpload={() => fileRef.current?.click()} uploading={uploading} saving={saving} fileRef={fileRef} uploadFiles={uploadFiles} /> : null}
      {activeTab === 'materials' ? <MaterialsView data={data} onUpload={() => fileRef.current?.click()} onDelete={deleteMaterial} onRename={renameMaterial} uploading={uploading} fileRef={fileRef} uploadFiles={uploadFiles} /> : null}
      {activeTab === 'accounts' ? <AccountsView data={data} form={accountForm} setForm={setAccountForm} onSubmit={addAccount} onDelete={deleteAccount} onUploadCookie={uploadCookie} onLogin={loginAccount} loginJobs={loginJobs} /> : null}
      {activeTab === 'records' ? <RecordsView tasks={data.tasks} onAction={taskAction} /> : null}
    </div>
  )
}

function PublishComposer({ data, draft, updateDraft, toggleDraftValue, accountOptions, onSubmit, onUpload, uploading, saving, fileRef, uploadFiles }) {
  return (
    <form className="media-composer" onSubmit={onSubmit}>
      <section className="panel media-panel">
        <div className="media-panel__head"><div><h3>创建发布任务</h3><p>一次选择多个平台和账号，任务会保存在本机队列。</p></div><button type="button" className="refactor-button refactor-button--compact" onClick={onUpload} disabled={uploading}><Upload {...iconProps(14)} />{uploading ? '上传中…' : '上传素材'}</button></div>
        <input ref={fileRef} type="file" accept="video/*,image/*" multiple hidden onChange={uploadFiles} />
        <label className="refactor-field"><span className="refactor-field__label">标题<b>*</b></span><input className="refactor-input" value={draft.title} onChange={(event) => updateDraft('title', event.target.value)} placeholder="例如：本周代肝攻略分享" maxLength={180} required /></label>
        <label className="refactor-field"><span className="refactor-field__label">正文</span><textarea className="refactor-input media-textarea" value={draft.content} onChange={(event) => updateDraft('content', event.target.value)} placeholder="填写平台通用正文，支持换行" rows={6} maxLength={10000} /></label>
        <div className="media-form-grid"><label className="refactor-field"><span className="refactor-field__label">话题</span><input className="refactor-input" value={draft.topics} onChange={(event) => updateDraft('topics', event.target.value)} placeholder="用逗号分隔，例如：代肝,游戏攻略" /></label><label className="refactor-field"><span className="refactor-field__label">定时发布</span><input className="refactor-input" type="datetime-local" value={draft.publish_at} onChange={(event) => updateDraft('publish_at', event.target.value)} /></label></div>
        <fieldset className="media-fieldset"><legend>发布平台<b>*</b></legend><div className="media-option-grid">{data.platforms.map((platform) => <Toggle key={platform.key} active={draft.platform_keys.includes(platform.key)} onClick={() => toggleDraftValue('platform_keys', platform.key)}>{platform.name}<small>{platform.kind}</small></Toggle>)}</div></fieldset>
        <fieldset className="media-fieldset"><legend>发布账号<b>*</b></legend>{accountOptions.length ? <div className="media-option-grid">{accountOptions.map((account) => <Toggle key={account.id} active={draft.account_ids.includes(account.id)} onClick={() => toggleDraftValue('account_ids', account.id)}><span>{account.account_name}</span><small>{account.platform_name} · {account.auth_state === 'ready' ? '已验证' : '待验证'}</small></Toggle>)}</div> : <div className="media-inline-empty"><UserRound {...iconProps(16)} />请先在“账号管理”添加与平台匹配的账号</div>}</fieldset>
        <fieldset className="media-fieldset"><legend>素材文件<b>*</b></legend>{data.materials.length ? <div className="media-material-options">{data.materials.map((material) => <label key={material.id} className={`media-material-option${draft.material_ids.includes(material.id) ? ' is-selected' : ''}`}><input type="checkbox" checked={draft.material_ids.includes(material.id)} onChange={() => toggleDraftValue('material_ids', material.id)} /><FileVideo {...iconProps(16)} /><span><b>{material.filename}</b><small>{formatBytes(material.file_size)} · {formatDate(material.created_at)}</small></span></label>)}</div> : <div className="media-inline-empty"><FolderOpen {...iconProps(16)} />还没有素材，点击右上角上传文件</div>}</fieldset>
        <div className="media-submit-row"><span>创建后可在发布记录里取消、重试或交给执行器。</span><button type="submit" className="refactor-button refactor-button--primary" disabled={saving}><Send {...iconProps(15)} />{saving ? '创建中…' : '创建发布任务'}</button></div>
      </section>
      <aside className="media-side-column"><section className="panel media-panel"><div className="media-panel__head"><div><h3>已选内容</h3><p>提交前快速确认任务范围。</p></div></div><div className="media-preview-list"><div><span>平台</span><b>{draft.platform_keys.length ? draft.platform_keys.map((key) => data.platforms.find((p) => p.key === key)?.name || key).join('、') : '尚未选择'}</b></div><div><span>账号</span><b>{draft.account_ids.length ? `${draft.account_ids.length} 个账号` : '尚未选择'}</b></div><div><span>素材</span><b>{draft.material_ids.length ? `${draft.material_ids.length} 个文件` : '尚未选择'}</b></div><div><span>发布时间</span><b>{draft.publish_at ? formatDate(draft.publish_at) : '创建后立即进入队列'}</b></div></div></section><section className="media-hint"><CalendarClock {...iconProps(17)} /><span><b>任务状态会持续保留</b><small>未配置执行器时，任务停留在本机队列；配置 `XFC_MEDIA_EXECUTOR_URL` 后即可交给目标项目的发布服务。</small></span></section></aside>
    </form>
  )
}

function MaterialsView({ data, onUpload, onDelete, onRename, uploading, fileRef, uploadFiles }) {
  const [editingId, setEditingId] = useState(null)
  const [editingName, setEditingName] = useState('')
  const [savingId, setSavingId] = useState(null)

  function beginEdit(material) {
    setEditingId(material.id)
    setEditingName(material.filename)
  }

  async function saveEdit(material) {
    const name = editingName.trim()
    if (!name) return toast('素材名称不能为空', 'warn')
    setSavingId(material.id)
    const saved = await onRename(material.id, name)
    setSavingId(null)
    if (saved) {
      setEditingId(null)
      setEditingName('')
    }
  }

  function cancelEdit() {
    setEditingId(null)
    setEditingName('')
  }

  return <section className="panel media-panel"><div className="media-panel__head"><div><h3>素材库</h3><p>图片和视频统一保存在本机 data/uploads/media 目录。</p></div><><button type="button" className="refactor-button refactor-button--primary" onClick={onUpload} disabled={uploading}><Upload {...iconProps(15)} />{uploading ? '上传中…' : '上传素材'}</button><input ref={fileRef} type="file" accept="video/*,image/*" multiple hidden onChange={uploadFiles} /></></div>{data.materials.length ? <div className="media-material-list">{data.materials.map((material) => <div className="media-material-row" key={material.id}><div className="media-material-row__icon"><FileVideo {...iconProps(19)} /></div><div className="media-material-row__main">{editingId === material.id ? <input className="refactor-input media-material-name-input" value={editingName} maxLength={180} autoFocus onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') saveEdit(material); if (event.key === 'Escape') cancelEdit() }} /> : <b>{material.filename}</b>}<small>{material.mime_type} · {formatBytes(material.file_size)} · {formatDate(material.created_at)}</small></div>{editingId === material.id ? <><button type="button" className="refactor-icon-button" title="保存名称" onClick={() => saveEdit(material)} disabled={savingId === material.id}><Check {...iconProps(15)} /></button><button type="button" className="refactor-icon-button" title="取消编辑" onClick={cancelEdit} disabled={savingId === material.id}><X {...iconProps(15)} /></button></> : <><a className="refactor-button refactor-button--compact" href={material.url} target="_blank" rel="noreferrer">预览</a><button type="button" className="refactor-icon-button" title="编辑素材名称" onClick={() => beginEdit(material)}><Pencil {...iconProps(15)} /></button><button type="button" className="refactor-icon-button" title="删除素材" onClick={() => onDelete(material.id)}><Trash2 {...iconProps(15)} /></button></>}</div>)}</div> : <div className="empty media-empty"><FolderOpen className="empty__mark" {...iconProps(28)} /><b className="empty__title">还没有素材</b><p className="empty__body">上传图片或视频后，就可以在发布任务中重复使用。</p></div>}</section>
}

function AccountsView({ data, form, setForm, onSubmit, onDelete, onUploadCookie, onLogin, loginJobs }) {
  return <div className="media-two-column"><section className="panel media-panel"><div className="media-panel__head"><div><h3>添加发布账号</h3><p>先登记账号，再导入目标平台的 Playwright 登录态。</p></div></div><form className="media-account-form" onSubmit={onSubmit}><label className="refactor-field"><span className="refactor-field__label">平台<b>*</b></span><select className="refactor-input" value={form.platform} onChange={(event) => setForm((current) => ({ ...current, platform: event.target.value }))}><option value="">选择平台</option>{data.platforms.map((platform) => <option key={platform.key} value={platform.key}>{platform.name}</option>)}</select></label><label className="refactor-field"><span className="refactor-field__label">账号名称<b>*</b></span><input className="refactor-input" value={form.account_name} onChange={(event) => setForm((current) => ({ ...current, account_name: event.target.value }))} placeholder="例如：主账号" /></label><label className="refactor-field"><span className="refactor-field__label">主页地址</span><input className="refactor-input" value={form.profile_url} onChange={(event) => setForm((current) => ({ ...current, profile_url: event.target.value }))} placeholder="可选" /></label><label className="refactor-field"><span className="refactor-field__label">备注</span><textarea className="refactor-input media-textarea" rows={4} value={form.note} onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))} placeholder="可记录账号用途或登录提示" /></label><button type="submit" className="refactor-button refactor-button--primary"><Plus {...iconProps(15)} />添加账号</button></form></section><section className="panel media-panel"><div className="media-panel__head"><div><h3>已登记账号</h3><p>{data.accounts.length} 个账号</p></div></div>{data.accounts.length ? <div className="media-account-list">{data.accounts.map((account) => { const login = loginJobs[account.id]; return <div className="media-account-row" key={account.id}><div className="media-account-row__mark"><UserRound {...iconProps(17)} /></div><div className="media-account-row__main"><b>{account.account_name}</b><small>{account.platform_name}{account.profile_url ? ` · ${account.profile_url}` : ''}</small></div><span className={`tag tag--${account.auth_state === 'ready' ? 'jade' : account.auth_state === 'disabled' ? 'outline' : 'amber'}`}>{account.auth_state === 'ready' ? '已验证' : account.auth_state === 'disabled' ? '已停用' : '待验证'}</span><button type="button" className="refactor-button refactor-button--compact" onClick={() => onLogin(account.id)} disabled={login?.status === 'running'}><UserRound {...iconProps(13)} />{login?.status === 'running' ? '登录中…' : '打开登录'}</button><label className="media-cookie-button"><input type="file" accept="application/json,.json" onChange={(event) => onUploadCookie(account.id, event)} hidden /><span>{account.has_cookie ? '替换登录态' : '导入登录态'}</span></label><button type="button" className="refactor-icon-button" title="删除账号" onClick={() => onDelete(account.id)}><Trash2 {...iconProps(15)} /></button></div> })}</div> : <div className="empty media-empty"><UserRound className="empty__mark" {...iconProps(28)} /><b className="empty__title">还没有账号</b><p className="empty__body">添加账号后即可在发布任务中选择。</p></div>}</section></div>
}

function MediaDependencyCard({ status, installing, refreshing, onInstall, onRefresh }) {
  const python = status?.python
  const ready = Boolean(status?.executor?.ready)
  const job = status?.install_job
  return <section className={`media-dependency-card${ready ? ' is-ready' : ''}`}><div className="media-dependency-card__head"><div><span className="refactor-eyebrow">执行环境</span><h3>{ready ? 'Python 发布执行器可用' : '需要安装 Python 发布依赖'}</h3></div><button type="button" className="refactor-button refactor-button--compact" onClick={onRefresh} disabled={installing || refreshing}><RefreshCw {...iconProps(14)} />{refreshing ? '检测中…' : '重新检测'}</button></div><div className="media-dependency-grid"><span className={python?.available ? 'is-ok' : ''}>Python {python?.available ? python.version : '未检测到'}</span><span className={python?.dependencies ? 'is-ok' : ''}>Flask {python?.dependencies ? '已安装' : '未安装'}</span><span className={python?.playwright ? 'is-ok' : ''}>Playwright {python?.playwright ? '已安装' : '未安装'}</span><span className={python?.browser ? 'is-ok' : ''}>Chromium {python?.browser ? '已安装' : '未安装'}</span><span className={status?.chrome?.available ? 'is-ok' : ''}>Chrome {status?.chrome?.available ? '已找到' : '未找到'}</span></div>{job?.status === 'running' ? <p className="media-dependency-log">{job.step || '安装中…'}<br /><small>{job.log?.slice(-240) || '正在准备安装'}</small></p> : null}{job?.status === 'failed' ? <p className="media-dependency-log is-error"><b>{job.error || '依赖安装失败'}</b><br /><small>{job.log?.slice(-1200) || '没有返回安装日志'}</small></p> : null}{!python?.available ? <p className="media-dependency-note">请先安装 Python 3.10+，再点击安装。<a href={status?.install?.python_download || 'https://www.python.org/downloads/windows/'} target="_blank" rel="noreferrer">打开 Python 下载页</a></p> : <button type="button" className="refactor-button refactor-button--primary" onClick={onInstall} disabled={installing || ready}>{installing ? '安装进行中…' : ready ? '依赖已就绪' : '安装 Python 依赖与 Chromium'}</button>}</section>
}

function RecordsView({ tasks, onAction }) {
  return <section className="panel media-panel"><div className="media-panel__head"><div><h3>发布记录</h3><p>任务会保留标题、平台、账号和执行结果。</p></div></div>{tasks.length ? <div className="media-task-list">{tasks.map((task) => <article className="media-task-row" key={task.id}><div className="media-task-row__main"><div className="media-task-row__title"><b>{task.title}</b>{statusTag(task.status)}</div><p>{task.platform_names?.join('、') || '未选择平台'} · {task.account_ids?.length || 0} 个账号 · {task.material_ids?.length || 0} 个素材</p><small>{task.publish_at ? `计划 ${formatDate(task.publish_at)}` : `创建于 ${formatDate(task.created_at)}`}{task.error_msg ? ` · ${task.error_msg}` : ''}</small></div><div className="media-task-row__actions">{['queued', 'scheduled', 'failed'].includes(task.status) ? <button type="button" className="refactor-button refactor-button--compact" onClick={() => onAction(`/api/media/tasks/${task.id}/dispatch`, '已提交发布执行器')}><Send {...iconProps(14)} />发布</button> : null}{['queued', 'scheduled', 'publishing'].includes(task.status) ? <button type="button" className="refactor-button refactor-button--compact" onClick={() => onAction(`/api/media/tasks/${task.id}/cancel`, '任务已取消')}><X {...iconProps(14)} />取消</button> : null}{task.status === 'failed' ? <button type="button" className="refactor-icon-button" title="重试任务" onClick={() => onAction(`/api/media/tasks/${task.id}/retry`, '任务已重新排队')}><RotateCcw {...iconProps(15)} /></button> : null}</div></article>)}</div> : <div className="empty media-empty"><Clock3 className="empty__mark" {...iconProps(28)} /><b className="empty__title">还没有发布记录</b><p className="empty__body">创建第一个发布任务后，它会出现在这里。</p></div>}</section>
}
