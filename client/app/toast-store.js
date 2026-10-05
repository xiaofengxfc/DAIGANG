/* ============================================================
   吐司的状态（不依赖 React）
   ============================================================

   为什么单独拆一个文件：旧栈的 public/js/ui.js 也要用同一份吐司。
   两边各弹各的话，屏幕上会同时出现两个 .toasts 容器，位置一模一样、
   互相盖住。所以状态放这里，React 只负责把它画出来（app/toast.jsx），
   ui.js 的 toast() 也只是转发进来。

   这个文件不 import 任何东西，谁都能用，不会绕出循环依赖。
   ============================================================ */

let items = []
let seq = 0
const listeners = new Set()

function emit() {
  const snapshot = [...items]
  for (const listener of listeners) listener(snapshot)
}

export function subscribeToasts(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function currentToasts() {
  return [...items]
}

/** 弹一条。tone: info / ok / err */
export function toast(message, tone = 'info', ms = 2600) {
  const id = ++seq
  items = [...items, { id, message: String(message ?? ''), tone, ms }]
  emit()
  // 多留 240ms 给淡出动画，和旧版一致
  setTimeout(() => {
    items = items.filter((item) => item.id !== id)
    emit()
  }, ms + 240)
  return id
}

export function toastErr(error) {
  const message = typeof error === 'string' ? error : error && error.message ? error.message : '出错了'
  return toast(message, 'err', 4200)
}
