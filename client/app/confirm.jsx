import React from 'react'
import Modal from './modal.jsx'
import { openOverlay } from './overlay-host.jsx'

/* ============================================================
   确认对话框（React 版）
   ============================================================

   旧 ui.js 里 confirmModal / confirmDelete 是命令式的，返回 Promise<boolean>：

     if (!await confirmDelete({ title: '删掉这笔收款？', message: '…' })) return

   React 页面（游戏、客户、价格表、财务、报价单）现在都在用它们 —— 点下去弹出来的
   却是旧 DOM 对话框。这里换成 React 渲染的，调用方式一字不改。

   这里都是「页面上点一下 → 弹一个确认」；确认框会叠在打开它的那层上面，
   服务项详情抽屉里点「删除」就是「抽屉 + 确认框」两层，确认完抽屉再自己关掉。
   ============================================================ */

export function confirmDialog({ title, message, confirmLabel = '确定', cancelLabel = '取消', tone = 'primary', extra = null }) {
  return openOverlay((close) => (
    <Modal
      title={title}
      onClose={() => close(false)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(false)}>
            {cancelLabel}
          </button>
          <button
            className={`btn${tone === 'primary' ? ' btn--primary' : tone === 'danger' ? ' btn--danger' : ''}`}
            type="button"
            onClick={() => close(true)}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="stack stack--tight">
        <p className="muted">{message}</p>
        {extra}
      </div>
    </Modal>
  ))
}

/** 删除前问一句。危险动作，按钮用朱砂色。 */
export function confirmDelete({ title, message, confirmLabel = '删除' }) {
  return confirmDialog({ title, message, confirmLabel, tone: 'danger' })
}
