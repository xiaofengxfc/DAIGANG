/* ============================================================
   保险箱门禁
   独立密码 + 查看/复制二次验证。这里是唯一盖章的地方。
   ============================================================ */

import { api } from '../../client/lib/api.js'
import { h, icon } from './dom.js'
import { modal, toastErr } from './ui.js'

export const vaultState = {
  configured: false,
  unlocked: false,
  expires_in_ms: 0,
  lock_reason: '',
}

export function syncVault(next) {
  if (!next) return vaultState
  Object.assign(vaultState, next)
  notifyVault()
  return vaultState
}

let onVaultChange = null
let vaultListeners = []

export function setVaultListener(fn) {
  if (typeof fn !== 'function') return
  if (!vaultListeners.includes(fn)) vaultListeners.push(fn)
  onVaultChange = fn
}

/** 重建外壳时清掉旧监听，否则登出再登录会一直堆，还会往拆掉的按钮上写 */
export function resetVaultListeners() {
  vaultListeners = []
  onVaultChange = null
}

function notifyVault() {
  for (const fn of vaultListeners) {
    try {
      fn(vaultState)
    } catch {
      /* 单个监听器出错不该影响状态同步 */
    }
  }
}

export async function refreshVault() {
  try {
    return syncVault(await api.get('/api/vault/status'))
  } catch {
    return vaultState
  }
}

/**
 * 解锁保险箱。已解锁直接返回 true。
 * 没设过密码就引导去设置。
 */
export function promptUnlock({ reason = '要取用游戏登录凭证，先解开保险箱', allowCancel = true } = {}) {
  if (vaultState.unlocked) return Promise.resolve(true)

  return new Promise((resolve) => {
    const input = h('input.inp', {
      type: 'password',
      autocomplete: 'current-password',
      placeholder: '保险箱密码',
      'aria-label': '保险箱密码',
    })
    const errBox = h('div.note.note--alert', { hidden: true })
    const seal = h('div.seal-mark', '封')
    const sealWrap = h(
      'div',
      { style: { display: 'flex', justifyContent: 'center', padding: '2px 0 6px' } },
      seal
    )

    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }

    const m = modal({
      title: '解开保险箱',
      body: h(
        'div.stack.stack--tight',
        sealWrap,
        h('p.muted.sm', reason),
        h('div.field.field--full', h('label.lbl', { for: 'vp' }, '保险箱密码'), input),
        errBox,
        h('div.hint', '这是和登录密码分开的独立密码。钥匙只放在内存里，闲置 20 分钟自动落锁。')
      ),
      actions: [
        ...(allowCancel ? [{ label: '先不解', onClick: () => finish(false) }] : []),
        {
          label: '解开',
          tone: 'primary',
          keepOpen: true,
          onClick: async () => {
            const pwd = input.value
            if (!pwd) {
              input.setAttribute('aria-invalid', 'true')
              errBox.textContent = '请输入保险箱密码'
              errBox.hidden = false
              return false
            }
            errBox.hidden = true
            try {
              const st = await api.post('/api/vault/unlock', { password: pwd })
              seal.classList.add('seal-stamp')
              syncVault(st)
              await new Promise((r) => setTimeout(r, 260))
              // 先 resolve(true) 再 close —— 顺序反了的话，close 触发的
              // onClose 会抢先把 promise 定成 false，解锁成功也当失败。
              finish(true)
              m.close()
            } catch (err) {
              input.setAttribute('aria-invalid', 'true')
              input.select()
              errBox.textContent = err.message || '解锁失败'
              errBox.hidden = false
            }
            return false
          },
        },
      ],
      onClose: () => finish(false),
    })

    input.id = 'vp'
    setTimeout(() => input.focus(), 60)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        const btn = m.node.querySelector('.modal__foot .btn--primary')
        if (btn) btn.click()
      }
    })
  })
}

/** 取用凭证前的统一入口：没设密码先让设 */
export async function ensureVaultReady() {
  await refreshVault()
  if (!vaultState.configured) {
    const ok = await new Promise((resolve) => {
      let done = false
      const finish = (v) => {
        if (done) return
        done = true
        resolve(v)
      }
      const p1 = h('input.inp', { type: 'password', autocomplete: 'new-password', placeholder: '至少 8 位，不要纯数字' })
      const p2 = h('input.inp', { type: 'password', autocomplete: 'new-password', placeholder: '再输一次' })
      const errBox = h('div.note.note--alert', { hidden: true })
      const m = modal({
        title: '先给保险箱设个密码',
        body: h(
          'div.stack.stack--tight',
          h(
            'p.muted.sm',
            '游戏登录凭证会用 AES-256-GCM 加密后存进数据库。这把钥匙由这个密码推导，不写进任何文件——忘了就真的解不开了。'
          ),
          h('div.field.field--full', h('label.lbl', '保险箱密码 *'), p1),
          h('div.field.field--full', h('label.lbl', '确认密码 *'), p2),
          errBox,
          h('div.note', '建议和登录密码不一样，并且记在你自己的密码管理器里。')
        ),
        actions: [
          { label: '以后再说', onClick: () => finish(false) },
          {
            label: '设置并解锁',
            tone: 'primary',
            keepOpen: true,
            onClick: async () => {
              if (p1.value !== p2.value) {
                errBox.textContent = '两次输入不一致'
                errBox.hidden = false
                return false
              }
              try {
                const st = await api.post('/api/vault/setup', { password: p1.value })
                syncVault(st)
                // 同样：先 resolve 再 close，否则会被 onClose 抢成 false
                finish(true)
                m.close()
              } catch (err) {
                errBox.textContent = err.message || '设置失败'
                errBox.hidden = false
              }
              return false
            },
          },
        ],
        onClose: () => finish(false),
      })
      setTimeout(() => p1.focus(), 60)
    })
    if (!ok) return false
    return true
  }
  return promptUnlock()
}

export async function lockVault() {
  try {
    syncVault(await api.post('/api/vault/lock'))
  } catch (err) {
    toastErr(err)
  }
}

/* ---------- 顶栏上的锁扣 ---------- */

export function vaultLockButton() {
  const btn = h('button.btn.btn--icon.btn--quiet', { type: 'button' })
  const paint = () => {
    const open = vaultState.unlocked
    const configured = vaultState.configured
    btn.replaceChildren(icon(open ? 'shield' : 'vault', 17))
    btn.title = !configured ? '保险箱还没设密码' : open ? '保险箱已解锁，点一下落锁' : '保险箱已锁定，点一下解开'
    btn.setAttribute('aria-label', btn.title)
    btn.classList.toggle('tone-jade', open)
    btn.classList.toggle('tone-cinnabar', configured && !open)
  }
  paint()
  btn.addEventListener('click', async () => {
    if (!vaultState.configured) {
      const ok = await ensureVaultReady()
      if (ok) paint()
      return
    }
    if (vaultState.unlocked) {
      await lockVault()
    } else {
      await promptUnlock({ reason: '解开保险箱才能看客户账号密码。' })
    }
    paint()
  })
  setVaultListener(paint)
  return btn
}
