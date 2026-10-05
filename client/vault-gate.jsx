import React, { useEffect, useRef, useState } from 'react'
import { api } from './lib/api.js'
import Modal from './app/modal.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { refreshVault, removeVaultListener, setVaultListener, syncVault, vaultState } from '../public/js/vaultgate.js'

/* ============================================================
   保险箱门禁（React 版）
   ============================================================

   状态还是 public/js/vaultgate.js 里那一份（vaultState + syncVault + 监听器），
   这样顶栏的锁扣、设置页里的保险箱状态和这里的页面看到的是同一个真相。

   和旧版一样：
     await promptUnlock({ reason })   解不开就返回 false
     await ensureVaultReady()         没设过密码先引导设置

   区别只在弹窗换成了 React 渲染的（旧版是 ui.js 的 modal()）。
   ============================================================ */

/** 订阅保险箱状态：解锁 / 落锁 / 过期都会让页面重画 */
export function useVaultState() {
  const [state, setState] = useState({ ...vaultState })
  useEffect(() => {
    const listener = (next) => setState({ ...next })
    setVaultListener(listener)
    // 挂载时先对齐一次（别的页面可能已经解开或落锁了）
    setState({ ...vaultState })
    return () => removeVaultListener(listener)
  }, [])
  return state
}

export function promptUnlock({ reason = '要取用游戏登录凭证，先解开保险箱', allowCancel = true } = {}) {
  if (vaultState.unlocked) return Promise.resolve(true)
  return openOverlay((close) => <UnlockModal reason={reason} allowCancel={allowCancel} close={close} />, 'vault-unlock')
}

/** 取用凭证前的统一入口：没设密码先让设 */
export async function ensureVaultReady() {
  await refreshVault()
  if (!vaultState.configured) {
    const ok = await openOverlay((close) => <SetupModal close={close} />, 'vault-setup')
    if (!ok) return false
    return true
  }
  return promptUnlock()
}

function UnlockModal({ reason, allowCancel, close }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [stamped, setStamped] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [])

  async function unlock() {
    if (!password) {
      setError('请输入保险箱密码')
      return
    }
    setBusy(true)
    setError('')
    try {
      const state = await api.post('/api/vault/unlock', { password })
      // 盖个章再关，让人看清「解开了」这件事发生了
      setStamped(true)
      syncVault(state)
      await new Promise((resolve) => setTimeout(resolve, 260))
      close(true)
    } catch (err) {
      setError(err?.message || '解锁失败')
      inputRef.current?.select()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="解开保险箱"
      onClose={() => close(false)}
      footer={
        <>
          {allowCancel ? <button className="btn" type="button" onClick={() => close(false)}>先不解</button> : null}
          <button className="btn btn--primary" type="button" disabled={busy} data-loading={busy ? '1' : undefined} onClick={unlock}>解开</button>
        </>
      }
    >
      <div className="stack stack--tight">
        <div style={{ display: 'flex', justifyContent: 'center', padding: '2px 0 6px' }}>
          <div className={`seal-mark${stamped ? ' seal-stamp' : ''}`}>封</div>
        </div>
        <p className="muted sm">{reason}</p>
        <div className="field field--full">
          <label className="lbl" htmlFor="vault-password">保险箱密码</label>
          <input
            id="vault-password"
            ref={inputRef}
            className="inp"
            type="password"
            autoComplete="current-password"
            placeholder="保险箱密码"
            aria-invalid={error ? 'true' : undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                unlock()
              }
            }}
          />
        </div>
        {error ? <div className="note note--alert">{error}</div> : null}
        <div className="hint">这是和登录密码分开的独立密码。钥匙只放在内存里，闲置 20 分钟自动落锁。</div>
      </div>
    </Modal>
  )
}

function SetupModal({ close }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 60)
    return () => window.clearTimeout(timer)
  }, [])

  async function setup() {
    if (password !== confirm) {
      setError('两次输入不一致')
      return
    }
    setBusy(true)
    setError('')
    try {
      const state = await api.post('/api/vault/setup', { password })
      syncVault(state)
      close(true)
    } catch (err) {
      setError(err?.message || '设置失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="先给保险箱设个密码"
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(false)}>以后再说</button>
          <button className="btn btn--primary" type="button" disabled={busy} data-loading={busy ? '1' : undefined} onClick={setup}>设置并解锁</button>
        </>
      }
    >
      <div className="stack stack--tight">
        <p className="muted sm">游戏登录凭证会用 AES-256-GCM 加密后存进数据库。这把钥匙由这个密码推导，不写进任何文件——忘了就真的解不开了。</p>
        <div className="field field--full">
          <label className="lbl" htmlFor="vault-new-password">
            保险箱密码<span className="req">*</span>
          </label>
          <input
            id="vault-new-password"
            ref={inputRef}
            className="inp"
            type="password"
            autoComplete="new-password"
            placeholder="至少 8 位，不要纯数字"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="field field--full">
          <label className="lbl" htmlFor="vault-confirm-password">
            确认密码<span className="req">*</span>
          </label>
          <input
            id="vault-confirm-password"
            className="inp"
            type="password"
            autoComplete="new-password"
            placeholder="再输一次"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        {error ? <div className="note note--alert">{error}</div> : null}
        <div className="note">建议和登录密码不一样，并且记在你自己的密码管理器里。</div>
      </div>
    </Modal>
  )
}
