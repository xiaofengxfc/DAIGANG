import React, { useEffect, useRef } from 'react'

/* ============================================================
   对话框（React 版）
   ============================================================

   和 drawer.jsx 是一对：抽屉走右边、对话框居中，类名同样沿用旧 ui.js
   （dialog.modal / .modal--wide / .modal__body / .modal__title / .modal__foot），
   样式从 public/css/app.css 继承。

   旧 modal() 是把标题放进 .modal__body 里的，这里保持一致。
   ============================================================ */

export function Modal({ title, wide = false, footer = null, onClose, children }) {
  const ref = useRef(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    const node = ref.current
    if (!node) return undefined
    const onCancel = (event) => {
      event.preventDefault()
      if (closeRef.current) closeRef.current()
    }
    const onClick = (event) => {
      if (event.target === node && closeRef.current) closeRef.current()
    }
    node.addEventListener('cancel', onCancel)
    node.addEventListener('click', onClick)
    document.body.classList.add('is-locked')
    if (!node.open) node.showModal()
    return () => {
      node.removeEventListener('cancel', onCancel)
      node.removeEventListener('click', onClick)
      document.body.classList.remove('is-locked')
      if (node.open) node.close()
    }
  }, [])

  return (
    <dialog className={`modal${wide ? ' modal--wide' : ''}`} ref={ref}>
      <div className="modal__body">
        {title ? <h2 className="modal__title">{title}</h2> : null}
        {children}
      </div>
      {footer ? <div className="modal__foot">{footer}</div> : null}
    </dialog>
  )
}

export default Modal
