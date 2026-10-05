import React, { useEffect, useState } from 'react'

/* ============================================================
   浮层宿主：让 React 组件也能被「命令式」打开
   ============================================================

   旧代码是 ui.js 那套命令式的：gameForm() 返回一个 Promise，内部自己
   往 body 上挂 <dialog>，靠手搓 DOM 建表单。React 页面沿用这套调用方式
   （await 一个 Promise，拿到保存结果）时，就没法用状态和 hooks 写表单。

   这里做一个折中：调用方还是 await 一个 Promise，但浮层本身是 React 渲染的。

     const saved = await openGameForm(game)
     if (saved) reload()

   实现是一叠浮层的订阅：openOverlay 把渲染函数压进去并等 Promise，
   <OverlayHost/> 按顺序渲染出来，组件里调 close(值) 就 resolve 并弹出。

   **为什么会是一叠而不是一个**：旧界面里对话框是会互相叠的 ——
   服务项详情抽屉上点「阶梯价」会再开一个抽屉，阶梯价里点「加一档」再开一个。
   所以这里保留嵌套能力，每层各自是一个原生 <dialog>（浏览器自己管 top layer，
   后开的盖在上面，Esc 只关最上面那层）。

   防连点：同一把 key 的浮层如果已经在最上面，就先把它关掉再开新的
   （连点两下「新建游戏」不该叠出两个一模一样的抽屉）。
   ============================================================ */

let stack = []
let seq = 0
const listeners = new Set()

function publish() {
  const snapshot = [...stack]
  for (const listener of listeners) listener(snapshot)
}

/**
 * 打开一个浮层，返回 Promise。
 * render 收到一个 close(值) 函数：调它就卸载这一层并 resolve(值)。
 * key 用来防连点：最上面那层如果是同一个 key，先关掉它。
 */
export function openOverlay(render, key = '') {
  const top = stack[stack.length - 1]
  if (top && key && top.key === key) top.settle(null)
  return new Promise((resolve) => {
    const entry = {
      id: ++seq,
      key,
      render,
      settle(value) {
        const index = stack.indexOf(entry)
        if (index >= 0) {
          stack.splice(index, 1)
          publish()
        }
        resolve(value)
      },
    }
    stack.push(entry)
    publish()
  })
}

/** 关掉最上面那层（比如按了 Esc、或者会话失效时统一收口） */
export function closeOverlay(value = null) {
  const top = stack[stack.length - 1]
  if (top) top.settle(value)
}

/** 把还开着的浮层全部关掉（退出登录、切换账号时用） */
export function closeAllOverlays(value = null) {
  while (stack.length) stack[stack.length - 1].settle(value)
}

export default function OverlayHost() {
  const [entries, setEntries] = useState(() => [...stack])

  useEffect(() => {
    listeners.add(setEntries)
    // 订阅之前可能已经有浮层等着了（比如首屏就调了 openOverlay），补一次
    setEntries([...stack])
    return () => {
      listeners.delete(setEntries)
    }
  }, [])

  // 滚动锁由宿主统一管：叠了好几层的时候，里层关掉不能把外层的锁也解了。
  // （旧 ui.js 的对话框自己管自己的锁，两边不会同时开着，所以不冲突。）
  useEffect(() => {
    if (entries.length) document.body.classList.add('is-locked')
    else document.body.classList.remove('is-locked')
  }, [entries.length])

  useEffect(() => () => document.body.classList.remove('is-locked'), [])

  if (!entries.length) return null
  return entries.map((entry) => <React.Fragment key={entry.id}>{entry.render(entry.settle)}</React.Fragment>)
}
