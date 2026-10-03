import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, Gamepad2, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { api } from '../public/js/api.js'
import { fmtDate } from '../public/js/dom.js'
import { confirmDelete, confirmModal, toast, toastErr } from '../public/js/ui.js'
import { gameForm } from '../public/js/views/games.js'

const iconProps = (size = 16) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

function firstLine(text, max = 70) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (!lines.length) return ''
  const head = lines[0].length > max ? `${lines[0].slice(0, max)}…` : lines[0]
  return lines.length > 1 ? `${head}（共 ${lines.length} 行）` : head
}

function GameIcon({ game }) {
  if (game.icon) return <img className="games-avatar" src={game.icon} alt="" loading="lazy" />
  return <span className="games-avatar games-avatar--fallback">{(game.name || '?').slice(0, 1)}</span>
}

function GameRow({ game, navigate, onEdit, onToggle, onDelete }) {
  return (
    <article className={`games-row${game.status === 'archived' ? ' is-archived' : ''}`}>
      <div className="games-row__identity">
        <GameIcon game={game} />
        <div>
          <div className="games-row__name"><b>{game.name}</b>{game.short_name ? <span className="games-short-name">{game.short_name}</span> : null}{game.status === 'archived' ? <span className="games-tag games-tag--archived">已归档</span> : null}</div>
          <div className="games-row__meta"><span>{game.service_count || 0} 个在架服务</span><span>{game.order_count || 0} 张单</span>{game.servers?.length ? <span>区服：{game.servers.join(' / ')}</span> : <span>没填区服</span>}</div>
          {game.notice ? <div className="games-row__notice"><i />{firstLine(game.notice)}</div> : null}
          {game.note ? <div className="games-row__note">{game.note}</div> : null}
        </div>
      </div>
      <div className="games-row__currency">{game.currency || '未设置货币'}</div>
      <div className="games-row__date">{game.created_at ? `建于 ${fmtDate(game.created_at)}` : '—'}</div>
      <div className="games-row__actions">
        <button className="react-mini-button" type="button" title="编辑游戏" onClick={() => onEdit(game)}><Pencil {...iconProps(15)} /></button>
        <button className="react-mini-button" type="button" title={game.status === 'active' ? '归档游戏' : '恢复上架'} onClick={() => onToggle(game)}>{game.status === 'active' ? <Archive {...iconProps(15)} /> : <RefreshCw {...iconProps(15)} />}</button>
        <button className="react-mini-button games-delete" type="button" title="彻底删除" onClick={() => onDelete(game)}><Trash2 {...iconProps(15)} /></button>
      </div>
    </article>
  )
}

function EmptyGames({ filtered, onNew }) {
  return <div className="games-empty"><Gamepad2 {...iconProps(23)} /><b>{filtered ? '没有符合条件的游戏' : '还没有加游戏'}</b><span>{filtered ? '换个关键词试试，或者清空筛选。' : '先添加正在代肝的游戏，区服和货币也可以一起设置。'}</span><button className="refactor-button refactor-button--primary" type="button" onClick={onNew}><Plus {...iconProps(15)} />新建游戏</button></div>
}

export default function GamesPage({ route, navigate, onNew, onReload, reloadKey }) {
  const query = useMemo(() => ({ q: route.query.get('q') || '', only: route.query.get('only') || '' }), [route.query.toString()])
  const [search, setSearch] = useState(query.q)
  const [items, setItems] = useState(null)
  const [error, setError] = useState('')
  const timer = useRef(null)

  useEffect(() => setSearch(query.q), [query.q])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    let active = true
    setItems(null)
    setError('')
    api.get('/api/games', { limit: 200, q: query.q }).then((data) => {
      if (active) setItems(data.items || [])
    }).catch((err) => {
      if (!active) return
      setItems([])
      setError(err.message || '游戏列表加载失败')
    })
    return () => { active = false }
  }, [query.q, reloadKey])

  const all = items || []
  const activeCount = all.filter((game) => game.status === 'active').length
  const archivedCount = all.filter((game) => game.status === 'archived').length
  const rows = query.only === 'archived' ? all.filter((game) => game.status === 'archived') : query.only === 'active' ? all.filter((game) => game.status === 'active') : all
  const navigateQuery = (overrides) => {
    const next = { ...query, ...overrides }
    const params = new URLSearchParams()
    if (next.q) params.set('q', next.q)
    if (next.only) params.set('only', next.only)
    navigate(`/games${params.toString() ? `?${params.toString()}` : ''}`)
  }

  const edit = async (game) => {
    try {
      const saved = await gameForm(game)
      if (saved) await onReload()
    } catch (err) {
      toastErr(err)
    }
  }

  const toggle = async (game) => {
    try {
      if (game.status === 'active') {
        const usage = await api.get(`/api/games/${game.id}/usage`)
        const ok = await confirmModal({ title: `归档「${game.name}」？`, message: `归档后它不再出现在新建服务项和开单选项里，但 ${usage.orders} 张老订单和 ${usage.credentials} 条登录凭证都会保留。`, confirmLabel: '归档' })
        if (!ok) return
      }
      await api.patch(`/api/games/${game.id}`, { status: game.status === 'active' ? 'archived' : 'active' })
      toast(game.status === 'active' ? '已归档' : '已恢复上架', 'ok')
      await onReload()
    } catch (err) {
      toastErr(err)
    }
  }

  const remove = async (game) => {
    try {
      const usage = await api.get(`/api/games/${game.id}/usage`)
      const used = usage.services + usage.categories + usage.orders + usage.credentials
      const ok = await confirmDelete({ title: `彻底删除「${game.name}」？`, message: used ? `当前关联 ${usage.categories} 个分类、${usage.services} 个服务项、${usage.orders} 张订单、${usage.credentials} 条登录凭证。删除后关联数据会变成未指定游戏。` : '这个游戏没有关联数据，可以安全删除。' })
      if (!ok) return
      await api.del(`/api/games/${game.id}`, { hard: 1 })
      toast('已删除', 'ok')
      await onReload()
    } catch (err) {
      toastErr(err)
    }
  }

  return (
    <div className="games-page">
      <header className="games-page__head">
        <div><span className="refactor-eyebrow">业务目录</span><h2>游戏</h2><p>{activeCount} 个上架{archivedCount ? ` · ${archivedCount} 个已归档` : ''}</p></div>
        <button className="refactor-button refactor-button--primary" type="button" onClick={onNew}><Plus {...iconProps(15)} />新建游戏</button>
      </header>
      <section className="games-toolbar" aria-label="游戏筛选">
        <div className="games-filters" role="tablist" aria-label="游戏状态">
          <button className={`games-filter${!query.only ? ' is-active' : ''}`} type="button" role="tab" aria-selected={!query.only} onClick={() => navigateQuery({ only: '' })}>全部</button>
          <button className={`games-filter${query.only === 'active' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={query.only === 'active'} onClick={() => navigateQuery({ only: 'active' })}>上架 {activeCount}</button>
          {archivedCount ? <button className={`games-filter${query.only === 'archived' ? ' is-active' : ''}`} type="button" role="tab" aria-selected={query.only === 'archived'} onClick={() => navigateQuery({ only: 'archived' })}>已归档 {archivedCount}</button> : null}
        </div>
        <div className="games-toolbar__spacer" />
        <label className="games-search"><Search {...iconProps(15)} /><input type="search" value={search} placeholder="搜游戏名、简称或备注" onChange={(event) => { const value = event.target.value; setSearch(value); window.clearTimeout(timer.current); timer.current = window.setTimeout(() => navigateQuery({ q: value.trim() }), 260) }} /><kbd>/</kbd></label>
      </section>
      {error ? <div className="refactor-alert" role="alert">{error}</div> : null}
      <section className="games-panel">
        <div className="games-table-head"><span>游戏</span><span>货币</span><span>建档</span><span>操作</span></div>
        {items === null ? <div className="refactor-loading"><span /><span /><span /></div> : rows.length ? <div className="games-list">{rows.map((game) => <GameRow key={game.id} game={game} onEdit={edit} onToggle={toggle} onDelete={remove} />)}</div> : <EmptyGames filtered={Boolean(query.q || query.only)} onNew={onNew} />}
      </section>
      {archivedCount ? <p className="games-footnote">已归档游戏不会出现在新建服务和开单选项中，老订单与登录凭证仍然保留。</p> : null}
    </div>
  )
}
