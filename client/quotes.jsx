import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, FileText, Plus, Search, Trash2 } from 'lucide-react'
import { api } from './lib/api.js'
import { fmtMoney, copyText } from './lib/dom.js'
import Modal from './app/modal.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { toast, toastErr } from './app/toast-store.js'
import { confirmDelete } from './app/confirm.jsx'
import { openQuoteComposer } from './quote-composer.jsx'

const iconProps = (size = 15) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

export default function QuotesPage({ route, navigate, onNew, onReload, reloadKey }) {
  const query = useMemo(() => route.query.get('q') || '', [route.query.toString()])
  const [search, setSearch] = useState(query)
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const timer = useRef(null)

  useEffect(() => setSearch(query), [query])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    let active = true
    setItems(null)
    setError('')
    api.get('/api/quotes', { limit: 200, q: query }).then((data) => { if (active) setItems(data.items || []) }).catch((err) => { if (active) { setItems([]); setError(err.message || '报价单加载失败') } })
    return () => { active = false }
  }, [query, reloadKey])

  const updateSearch = (value) => {
    setSearch(value)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => navigate(`/quotes${value.trim() ? `?q=${encodeURIComponent(value.trim())}` : ''}`), 260)
  }

  const showText = async (quote) => {
    try {
      const result = await api.get(`/api/quotes/${quote.id}/text`)
      // 文字版弹窗以前是旧 ui.js 的 modal()，现在换成 React 的（复制逻辑一样）
      openOverlay((close) => (
        <Modal
          title={`报价单文字 · ${quote.quote_no}`}
          wide
          onClose={() => close(null)}
          footer={
            <>
              <button className="btn" type="button" onClick={() => close(null)}>关闭</button>
              <button
                className="btn btn--primary"
                type="button"
                onClick={async () => {
                  const ok = await copyText(result.text)
                  toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err')
                }}
              >
                复制
              </button>
            </>
          }
        >
          <pre className="plaintext quotes-plaintext">{result.text}</pre>
        </Modal>
      ), `quote-text-${quote.id}`)
    } catch (err) { toastErr(err) }
  }

  const convert = async (quote) => {
    try { const result = await api.post(`/api/quotes/${quote.id}/convert`); toast(`已生成订单 ${result.order_no}`, 'ok'); navigate(`/orders/${result.order_id}`) } catch (err) { toastErr(err) }
  }

  const remove = async (quote) => {
    try { if (!await confirmDelete({ title: '删掉这张报价单？', message: `${quote.quote_no} · ¥${fmtMoney(quote.total)}` })) return; await api.del(`/api/quotes/${quote.id}`); toast('已删除', 'ok'); await onReload() } catch (err) { toastErr(err) }
  }

  return (
    <div className="quotes-page">
      <header className="quotes-page__head"><div><h2>报价单</h2><p>{items?.length || 0} 张 · 客户点头后可以直接转成订单</p></div><button className="refactor-button refactor-button--primary" type="button" onClick={onNew}><Plus {...iconProps(15)} />做报价单</button></header>
      <section className="quotes-toolbar"><div className="quotes-toolbar__spacer" /><label className="quotes-search"><Search {...iconProps(15)} /><input type="search" value={search} placeholder="搜报价单号、标题或客户" onChange={(event) => updateSearch(event.target.value)} /></label></section>
      {error ? <div className="refactor-alert" role="alert">{error}</div> : null}
      <section className="quotes-panel"><div className="quotes-table-head"><span>报价单</span><span>项目</span><span>游戏</span><span>有效期</span><span>合计</span><span>操作</span></div>{items === null ? <div className="refactor-loading"><span /><span /><span /></div> : items.length ? <div className="quotes-list">{items.map((quote) => <article className="quotes-row" key={quote.id}><button className="quotes-row__main" type="button" onClick={() => showText(quote)}><span><b>{quote.quote_no}</b>{quote.customer_name ? <small>{quote.customer_name}</small> : null}</span><strong>{quote.title || '未命名报价'}</strong></button><span className="quotes-row__items">{quote.item_count || 0} 项</span><span className="quotes-row__game">{quote.game_name || '通用'}</span><span className="quotes-row__valid">{quote.valid_until || '—'}</span><span className="quotes-row__total">¥{fmtMoney(quote.total)}</span><div className="quotes-row__actions"><button className="react-mini-button" type="button" title="看文字版" onClick={() => showText(quote)}><FileText {...iconProps(14)} /></button><button className="react-mini-button" type="button" title="转成订单" onClick={() => convert(quote)}><ArrowRight {...iconProps(14)} /></button><button className="react-mini-button quotes-danger" type="button" title="删除" onClick={() => remove(quote)}><Trash2 {...iconProps(14)} /></button></div></article>)}</div> : <div className="quotes-empty"><FileText {...iconProps(23)} /><b>{query ? '没有找到报价单' : '还没做过报价单'}</b><span>{query ? '换个关键词试试。' : '从价格表勾选服务项，生成一段可以直接发给客户的报价。'}</span><button className="refactor-button refactor-button--primary" type="button" onClick={onNew}><Plus {...iconProps(15)} />做第一张报价单</button></div>}</section>
    </div>
  )
}
