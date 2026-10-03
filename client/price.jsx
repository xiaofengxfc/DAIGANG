import React, { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Copy, Edit3, FolderPlus, Gamepad2, Layers3, Plus, Search, Trash2 } from 'lucide-react'
import { api, PRICE_TYPE_LABEL, PRICE_TYPE_UNIT_LABEL } from './lib/api.js'
import { fmtMoney, fmtQty } from './lib/formatters.js'
import { confirmDelete, toast, toastErr } from './lib/legacy-ui.js'
import { categoryForm, openExporter, serviceForm, sumDialog, gameForm } from './lib/legacy-features.js'

const iconProps = (size = 15) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

const unitOf = (service) => service.unit_label || PRICE_TYPE_UNIT_LABEL[service.price_type] || '单'

function priceRange(services) {
  const values = services.map((service) => Number(service.base_price)).filter(Number.isFinite)
  if (!values.length) return '暂无价格'
  const low = Math.min(...values)
  const high = Math.max(...values)
  return low === high ? `¥${fmtMoney(low)}` : `¥${fmtMoney(low)} - ¥${fmtMoney(high)}`
}

function ServiceRow({ service, onEdit, onToggle, onDelete }) {
  const tiers = service.tiers || []
  const options = service.options || []
  return (
    <div className={`price-service${service.status === 'archived' ? ' is-archived' : ''}`}>
      <div className="price-service__main">
        <div className="price-service__name"><b>{service.name}</b>{service.is_daily ? <span className="price-tag price-tag--jade">每天</span> : null}{tiers.length ? <span className="price-tag">{tiers.length} 档</span> : null}{options.length ? <span className="price-tag">{options.length} 个增项</span> : null}</div>
        {service.description ? <p>{service.description}</p> : null}
        {service.package_items?.length ? <small>套餐含：{service.package_items.join(' · ')}</small> : null}
      </div>
      <div className="price-service__type">{PRICE_TYPE_LABEL[service.price_type] || service.price_type}<small>/{unitOf(service)} · 起订 {fmtQty(service.min_qty || 1)}</small></div>
      <div className="price-service__money"><b>¥{fmtMoney(service.base_price)}</b>{service.currency_amount ? <small>可得 {fmtQty(service.currency_amount)}</small> : null}</div>
      <div className="price-service__actions"><button className="react-mini-button" type="button" title="编辑服务" onClick={() => onEdit(service)}><Edit3 {...iconProps(14)} /></button><button className="react-mini-button" type="button" title={service.status === 'active' ? '归档服务' : '恢复服务'} onClick={() => onToggle(service)}>{service.status === 'active' ? <ChevronDown {...iconProps(14)} /> : <ChevronRight {...iconProps(14)} />}</button><button className="react-mini-button price-danger" type="button" title="删除服务" onClick={() => onDelete(service)}><Trash2 {...iconProps(14)} /></button></div>
    </div>
  )
}

function CategoryBlock({ category, onEdit, onService, onSum, onToggle, onDelete, onEditService, onToggleService, onDeleteService }) {
  const [open, setOpen] = useState(false)
  const services = category.services || []
  return (
    <section className={`price-category${category.status === 'archived' ? ' is-archived' : ''}`}>
      <header className="price-category__head">
        <button className="price-category__toggle" type="button" onClick={() => setOpen((value) => !value)}>{open ? <ChevronDown {...iconProps(16)} /> : <ChevronRight {...iconProps(16)} />}<span><b>{category.name}</b><small>{services.length} 项 · {priceRange(services)}</small></span></button>
        {category.notice ? <p>{category.notice}</p> : null}
        <div className="price-category__actions"><button className="react-mini-button" type="button" title="组合报价" onClick={() => onSum(category)} disabled={!services.length}><Copy {...iconProps(14)} /></button><button className="react-mini-button" type="button" title="新建服务" onClick={() => onService(category)}><Plus {...iconProps(14)} /></button><button className="react-mini-button" type="button" title="编辑大类" onClick={() => onEdit(category)}><Edit3 {...iconProps(14)} /></button><button className="react-mini-button" type="button" title={category.status === 'active' ? '归档大类' : '恢复大类'} onClick={() => onToggle(category)}>{category.status === 'active' ? <ChevronDown {...iconProps(14)} /> : <ChevronRight {...iconProps(14)} />}</button><button className="react-mini-button price-danger" type="button" title="删除大类" onClick={() => onDelete(category)}><Trash2 {...iconProps(14)} /></button></div>
      </header>
      {open ? <div className="price-category__body">{services.length ? services.map((service) => <ServiceRow key={service.id} service={service} onEdit={onEditService} onToggle={onToggleService} onDelete={onDeleteService} />) : <div className="price-category__empty">还没有服务项，点右侧加号添加第一项。</div>}</div> : null}
    </section>
  )
}

export default function PricePage({ route, navigate, onNewGame, onNewCategory, onReload, reloadKey }) {
  const query = useMemo(() => ({ game: route.query.get('game') || '', q: route.query.get('q') || '' }), [route.query.toString()])
  const [book, setBook] = useState(null)
  const [search, setSearch] = useState(query.q)
  const [error, setError] = useState('')

  useEffect(() => setSearch(query.q), [query.q])
  useEffect(() => {
    let active = true
    setBook(null)
    setError('')
    api.get('/api/pricebook').then((data) => { if (active) setBook(data) }).catch((err) => { if (active) { setBook({ games: [], categories: [], loose: [] }); setError(err.message || '价格表加载失败') } })
    return () => { active = false }
  }, [reloadKey])

  const update = (overrides) => {
    const next = { ...query, ...overrides }
    const params = new URLSearchParams()
    if (next.game) params.set('game', next.game)
    if (next.q) params.set('q', next.q)
    navigate(`/price${params.toString() ? `?${params.toString()}` : ''}`)
  }

  const data = book || { games: [], categories: [], loose: [] }
  const gameMap = new Map((data.games || []).map((game) => [String(game.id), game]))
  const categories = (data.categories || []).filter((category) => !query.game || String(category.game_id || '') === query.game)
  const loose = (data.loose || []).filter((service) => !query.game || String(service.game_id || '') === query.game)
  const text = query.q.trim().toLowerCase()
  const match = (value) => !text || String(value || '').toLowerCase().includes(text)
  const visibleCategories = categories.map((category) => ({ ...category, services: (category.services || []).filter((service) => match(`${service.name} ${service.description} ${category.name}`)) })).filter((category) => match(`${category.name} ${category.notice}`) || category.services.length)
  const visibleLoose = loose.filter((service) => match(`${service.name} ${service.description}`))

  const groupMap = new Map()
  for (const category of visibleCategories) {
    const key = category.game_id ? String(category.game_id) : ''
    if (!groupMap.has(key)) groupMap.set(key, { key, game: gameMap.get(key), categories: [], loose: [] })
    groupMap.get(key).categories.push(category)
  }
  for (const service of visibleLoose) {
    const key = service.game_id ? String(service.game_id) : ''
    if (!groupMap.has(key)) groupMap.set(key, { key, game: gameMap.get(key), categories: [], loose: [] })
    groupMap.get(key).loose.push(service)
  }
  const groups = [...groupMap.values()]

  const editCategory = async (category) => { try { if (await categoryForm(category, data.games || [])) await onReload() } catch (err) { toastErr(err) } }
  const newService = async (category) => { try { if (await serviceForm({ category_id: category.id, game_id: category.game_id || '' }, { games: data.games || [], categories: data.categories || [] })) await onReload() } catch (err) { toastErr(err) } }
  const editService = async (service) => { try { if (await serviceForm(service, { games: data.games || [], categories: data.categories || [] })) await onReload() } catch (err) { toastErr(err) } }
  const toggleCategory = async (category) => { try { await api.patch(`/api/categories/${category.id}`, { status: category.status === 'active' ? 'archived' : 'active' }); toast(category.status === 'active' ? '大类已归档' : '大类已恢复', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const deleteCategory = async (category) => { try { const usage = await api.get(`/api/categories/${category.id}/usage`); if (!await confirmDelete({ title: `删除「${category.name}」？`, message: usage.services ? `${usage.services} 个服务项会变成未分类，老订单不受影响。` : '这个大类没有服务项。' })) return; await api.del(`/api/categories/${category.id}`, { hard: 1 }); toast('大类已删除', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const toggleService = async (service) => { try { await api.patch(`/api/services/${service.id}`, { status: service.status === 'active' ? 'archived' : 'active' }); toast(service.status === 'active' ? '服务已归档' : '服务已恢复', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const deleteService = async (service) => { try { const usage = await api.get(`/api/services/${service.id}/usage`); if (!await confirmDelete({ title: `删除「${service.name}」？`, message: usage.orders ? `${usage.orders} 张订单使用过它，老订单快照不会改变。` : '这个服务还没有关联订单。' })) return; await api.del(`/api/services/${service.id}`, { hard: 1 }); toast('服务已删除', 'ok'); await onReload() } catch (err) { toastErr(err) } }

  return (
    <div className="price-page">
      <header className="price-page__head"><div><span className="refactor-eyebrow">业务目录</span><h2>价格表</h2><p>{data.games.length} 个游戏 · {data.categories.length} 个大类 · {data.categories.reduce((sum, category) => sum + (category.services || []).length, 0) + data.loose.length} 个服务项</p></div><div className="price-page__head-actions"><button className="refactor-button" type="button" onClick={() => openExporter(null, { games: data.games || [] })}><Copy {...iconProps(15)} />导出</button><button className="refactor-button" type="button" onClick={onNewGame}><Gamepad2 {...iconProps(15)} />新建价格表</button><button className="refactor-button refactor-button--primary" type="button" onClick={() => onNewCategory()}><FolderPlus {...iconProps(15)} />新建大类</button></div></header>
      <section className="price-toolbar"><div className="price-games">{[...data.games, { id: '', name: '通用' }].map((game) => <button key={game.id || 'generic'} className={`price-game${query.game === String(game.id) ? ' is-active' : ''}`} type="button" onClick={() => update({ game: String(game.id) })}>{game.name}</button>)}</div><div className="price-toolbar__spacer" /><label className="price-search"><Search {...iconProps(15)} /><input type="search" value={search} placeholder="搜大类、服务或说明" onChange={(event) => { const value = event.target.value; setSearch(value); window.clearTimeout(window.__priceTimer); window.__priceTimer = window.setTimeout(() => update({ q: value.trim() }), 260) }} /></label></section>
      {error ? <div className="refactor-alert" role="alert">{error}</div> : null}
      <section className="price-groups">{book === null ? <div className="refactor-loading"><span /><span /><span /></div> : groups.length ? groups.map((group) => <section className="price-group" key={group.key || 'generic'}><header className="price-group__head"><div><h3>{group.game?.name || '通用价格'}</h3><span>{group.categories.length} 个大类 · {group.loose.length ? `${group.loose.length} 个未分类服务` : '服务均已归类'}</span></div>{group.game?.currency ? <em>{group.game.currency}</em> : null}</header><div className="price-group__body">{group.categories.map((category) => <CategoryBlock key={category.id} category={category} onEdit={editCategory} onService={newService} onSum={(cat) => sumDialog(cat, cat.services || [])} onToggle={toggleCategory} onDelete={deleteCategory} onEditService={editService} onToggleService={toggleService} onDeleteService={deleteService} />)}{group.loose.length ? <div className="price-loose"><b>未分类服务</b>{group.loose.map((service) => <ServiceRow key={service.id} service={service} onEdit={editService} onToggle={toggleService} onDelete={deleteService} />)}</div> : null}</div></section>) : <div className="price-empty"><Layers3 {...iconProps(24)} /><b>{query.q ? '没有找到匹配的价格' : '还没有价格表'}</b><span>{query.q ? '换个关键词试试。' : '先新建游戏，再建立大类和服务项。'}</span><button className="refactor-button refactor-button--primary" type="button" onClick={onNewGame}><Plus {...iconProps(15)} />新建价格表</button></div>}</section>
    </div>
  )
}
