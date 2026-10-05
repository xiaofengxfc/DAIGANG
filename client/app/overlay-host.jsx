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

   实现就是一份「当前浮层」的订阅：openOverlay 把渲染函数放进去并等 Promise，
   <OverlayHost/> 把它渲染出来，组件里调 close(值) 就 resolve 并卸载。

   一次只开一个（对话框本来就是模态的），不做栈。
   ============================================================ */

let current = null
const listeners = new Set()

function publish() {
  for (const listener of listeners) listener(current)
}

/**
 * 打开一个浮层，返回 Promise。
 * render 收到一个 close(值) 函数：调它就卸载浮层并 resolve(值)。
 */
export function openOverlay(render) {
  // 前一个还开着就先关掉（比如连点两下「新建游戏」），
  // 不然它的 Promise 永远等不到 resolve，调用方的 await 就挂住了。
  if (current) current.settle(null)
  return new Promise((resolve) => {
    const entry = {
      render,
      settle(value) {
        if (current === entry) {
          current = null
          publish()
        }
        resolve(value)
      },
    }
    current = entry
    publish()
  })
}

/** 关掉当前浮层（比如按了 Esc、或者会话失效时统一收口） */
export function closeOverlay(value = null) {
  if (current) current.settle(value)
}

export default function OverlayHost() {
  const [overlay, setOverlay] = useState(current)

  useEffect(() => {
    listeners.add(setOverlay)
    // 订阅之前可能已经有浮层等着了（比如首屏就调了 openOverlay），补一次
    setOverlay(current)
    return () => {
      listeners.delete(setOverlay)
    }
  }, [])

  if (!overlay) return null
  return overlay.render(overlay.settle)
}
