import React, { useEffect, useState } from 'react'
import { currentToasts, subscribeToasts } from './toast-store.js'

/* ============================================================
   吐司（React 版）
   ============================================================

   旧的 public/js/ui.js 里是自己往 body 上挂 div.toasts 再塞 .toast。
   现在两边都走 app/toast-store.js：ui.js 的 toast() 转发进来，这里负责画。
   类名和结构照旧（.toasts / .toast / .toast__ico / data-show），
   样式直接继承 app.css，所以新旧页面弹出来的东西长得一模一样。

   挂在 App 最外层（登录页也要有），不然登录失败之类就提示不出来了。
   ============================================================ */

function ToastItem({ item }) {
  const [shown, setShown] = useState(false)

  // 先渲染出来再加 data-show：有这一步才有「淡入」而不是直接蹦出来
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  // 到点了先淡出，等动画走完由 store 把这条摘掉
  useEffect(() => {
    const timer = setTimeout(() => setShown(false), item.ms)
    return () => clearTimeout(timer)
  }, [item.ms])

  const tone = item.tone === 'err' ? ' toast--err' : item.tone === 'ok' ? ' toast--ok' : ''
  const mark = item.tone === 'err' ? '!' : item.tone === 'ok' ? '✓' : '·'

  return (
    <div className={`toast${tone}`} data-show={shown ? '1' : undefined}>
      <span className="toast__ico">{mark}</span>
      <span>{item.message}</span>
    </div>
  )
}

export default function ToastHost() {
  const [items, setItems] = useState(() => currentToasts())

  useEffect(() => {
    const unsubscribe = subscribeToasts(setItems)
    setItems(currentToasts())
    return unsubscribe
  }, [])

  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((item) => (
        <ToastItem key={item.id} item={item} />
      ))}
    </div>
  )
}
