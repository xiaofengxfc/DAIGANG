import React, { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

/* ============================================================
   抽屉（React 版）
   ============================================================

   刻意复用旧 ui.js 的类名（dialog.drawer / .drawer__head / .drawer__body /
   .drawer__foot），因为 client/styles.css 直接 @import 了旧的 app.css，
   这些样式都在。这样 React 抽屉和旧抽屉长得一模一样，迁移期间不会出现
   「有的抽屉是新的、有的是旧的」这种视觉断层。

   用原生 <dialog> + showModal()：自动进 top layer，不受父元素 overflow /
   transform 裁剪，Esc 关闭和遮罩也由浏览器管一半。
   ============================================================ */

export function Drawer({ title, subtitle, wide = false, footer = null, onClose, children }) {
  const ref = useRef(null)
  // onClose 放进 ref：父组件每次渲染都传新函数，不能让 effect 跟着重跑
  // （重跑会 close 再 showModal，滚动位置和焦点都会丢）
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const onCancel = (event) => {
      event.preventDefault()
      if (closeRef.current) closeRef.current()
    }
    // 点遮罩关闭：只有落在 dialog 自身（而不是内部内容）时才算
    const onClick = (event) => {
      if (event.target === node && closeRef.current) closeRef.current()
    }
    // 有人从外面调 dlg.close()（测试、脚本、以后别处的代码）时也要收摊。
    // 只认 'cancel' 的话，对话框是关掉了，但 React 这边还挂在浮层栈里没卸载。
    const onClosed = () => {
      if (closeRef.current) closeRef.current()
    }
    node.addEventListener('cancel', onCancel)
    node.addEventListener('click', onClick)
    node.addEventListener('close', onClosed)
    if (!node.open) node.showModal()
    return () => {
      node.removeEventListener('cancel', onCancel)
      node.removeEventListener('click', onClick)
      node.removeEventListener('close', onClosed)
      if (node.open) node.close()
    }
  }, [])

  return (
    <dialog className={`drawer${wide ? ' drawer--wide' : ''}`} ref={ref}>
      <div className="drawer__head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="drawer__title">{title}</div>
          {subtitle ? <div className="sm dim">{subtitle}</div> : null}
        </div>
        <button className="btn btn--icon btn--quiet" type="button" aria-label="关闭" onClick={onClose}>
          <X size={16} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>
      <div className="drawer__body">{children}</div>
      {footer ? <div className="drawer__foot">{footer}</div> : null}
    </dialog>
  )
}

export default Drawer
