import React from 'react'
import { Copy } from 'lucide-react'
import { copyText } from '../lib/dom.js'
import { toast } from './toast-store.js'

/* ============================================================
   复制按钮（React 版）
   ============================================================

   旧 ui.js 里的 copyButton()：一个 .btn.btn--sm，title 是它的用途，
   点一下把传进来的文字放进剪贴板，成了就说一声。

     <CopyButton text={`${service.name} ¥30/层`} label="复制价款" />
   ============================================================ */

export function CopyButton({ text, label = '复制', onCopied = null }) {
  return (
    <button
      className="btn btn--sm"
      type="button"
      title={label}
      onClick={async (event) => {
        event.stopPropagation()
        const ok = await copyText(text)
        toast(ok ? '已复制' : '复制失败，请手动选中', ok ? 'ok' : 'err', 1600)
        if (ok && onCopied) onCopied()
      }}
    >
      <Copy size={15} strokeWidth={1.8} absoluteStrokeWidth aria-hidden="true" />
      {label}
    </button>
  )
}

export default CopyButton
