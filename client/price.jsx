import React, { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Copy, Edit3, Eye, FolderPlus, Gamepad2, Layers3, Plus, Search, SlidersHorizontal, Trash2 } from 'lucide-react'
import { api, PRICE_TYPE_LABEL, PRICE_TYPE_UNIT_LABEL } from './lib/api.js'
import { fmtMoney, fmtQty } from './lib/formatters.js'
import { confirmDelete, toast, toastErr } from './lib/legacy-ui.js'
import { categoryForm, openExporter, serviceForm, servicePeek, sumDialog } from './lib/legacy-features.js'

const iconProps = (size = 15) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

const unitOf = (service) => service.unit_label || PRICE_TYPE_UNIT_LABEL[service.price_type] || '单'

function priceRange(services) {
  const values = services.map((service) => Number(service.base_price)).filter(Number.isFinite)
  if (!values.length) return '暂无价格'
  const low = Math.min(...values)
  const high = Math.max(...values)
  return low === high ? `¥${fmtMoney(low)}` : `¥${fmtMoney(low)} - ¥${fmtMoney(high)}`
}

function tierSummary(tiers, unit) {
  const ordered = [...tiers].sort((a, b) => (Number(a.min_qty) || 0) - (Number(b.min_qty) || 0))
  const first = ordered[0]
  const last = ordered[ordered.length - 1]
  const firstRange = `${fmtQty(first.min_qty || 1)}${unit}`
  const lastRange = last.max_qty === null || last.max_qty === undefined || last.max_qty === '' ? `${fmtQty(last.min_qty || 1)}${unit}+` : `${fmtQty(last.min_qty || 1)}-${fmtQty(last.max_qty)}${unit}`
  const prices = ordered.slice(0, 2).map((tier) => {
    const range = tier.max_qty === null || tier.max_qty === undefined || tier.max_qty === '' ? `${fmtQty(tier.min_qty || 1)}${unit}+` : `${fmtQty(tier.min_qty || 1)}-${fmtQty(tier.max_qty)}${unit}`
    return `${range} ¥${fmtMoney(tier.unit_price)}/${unit}`
  })
  return `${tiers.length} 档 · ${firstRange} 起 · ${lastRange}${prices.length ? ` · ${prices.join('；')}${tiers.length > prices.length ? '…' : ''}` : ''}`
}

function optionSummary(options) {
  const items = options.slice(0, 2).map((option) => {
    const price = option.price_mode === 'percent' ? ` +${fmtQty(option.price)}%` : Number(option.price) ? ` +¥${fmtMoney(option.price)}` : ''
    const note = String(option.description || '').trim()
    return `${option.name || '未命名'}${price}${note ? `（说明：${note}）` : ''}`
  }).filter(Boolean)
  return `${options.length} 个${items.length ? ` · ${items.join('、')}${options.length > items.length ? '…' : ''}` : ''}`
}

function ServiceRow({ service, onEdit, onPeek, onAdvanced, onToggle, onDelete }) {
  const tiers = service.tiers || []
  const options = service.options || []
  const unit = unitOf(service)
  return (
    <div className={`price-service${service.status === 'archived' ? ' is-archived' : ''}`}>
      <div className="price-service__main">
        <div className="price-service__name"><b>{service.name}</b>{service.is_daily ? <span className="price-tag price-tag--jade">每天</span> : null}{tiers.length ? <span className="price-tag">{tiers.length} 档</span> : null}{options.length ? <span className="price-tag">{options.length} 个增项</span> : null}</div>
        {service.description ? <p title={service.description}>{service.description}</p> : <p className="price-service__muted">暂无说明</p>}
        {service.package_items?.length ? <small title={service.package_items.join(' · ')}>套餐含：{service.package_items.join(' · ')}</small> : null}
      </div>
      <div className="price-service__type"><b>{PRICE_TYPE_LABEL[service.price_type] || service.price_type}</b><small>/{unit} · 起订 {fmtQty(service.min_qty || 1)}{service.max_qty ? ` · 上限 ${fmtQty(service.max_qty)}` : ''}</small></div>
      <div className="price-service__money"><b>¥{fmtMoney(service.base_price)}</b>{service.currency_amount ? <small>可得 {fmtQty(service.currency_amount)}</small> : null}</div>
      <div className="price-service__tiers" title={[tiers.length ? tierSummary(tiers, unit) : '', options.length ? optionSummary(options) : ''].filter(Boolean).join(' · ')}>{tiers.length ? <b>{tierSummary(tiers, unit)}</b> : null}{options.length ? <small>{optionSummary(options)}</small> : null}</div>
      <div className="price-service__actions"><button className="react-mini-button" type="button" title="查看服务详情" onClick={() => onPeek(service)}><Eye {...iconProps(14)} /></button><button className="react-mini-button" type="button" title="高级设置：阶梯价和增项" onClick={() => onAdvanced(service)}><SlidersHorizontal {...iconProps(14)} /></button><button className="react-mini-button" type="button" title="编辑服务" onClick={() => onEdit(service)}><Edit3 {...iconProps(14)} /></button><button className="react-mini-button" type="button" title={service.status === 'active' ? '归档服务' : '恢复服务'} onClick={() => onToggle(service)}>{service.status === 'active' ? <Archive {...iconProps(14)} /> : <ArchiveRestore {...iconProps(14)} />}</button><button className="react-mini-button price-danger" type="button" title="删除服务" onClick={() => onDelete(service)}><Trash2 {...iconProps(14)} /></button></div>
    </div>
  )
}

function CategoryBlock({ category, open, onOpenChange, onEdit, onService, onSum, onToggle, onDelete, onEditService, onPeekService, onAdvancedService, onToggleService, onDeleteService }) {
  const services = category.services || []
  return (
    <section className={`price-category${category.status === 'archived' ? ' is-archived' : ''}`} id={`price-category-${category.id}`}>
      <header className="price-category__head">
        <button className="price-category__toggle" type="button" aria-expanded={open} onClick={() => onOpenChange(!open)}>{open ? <ChevronDown {...iconProps(16)} /> : <ChevronRight {...iconProps(16)} />}<span><b>{category.name}</b><small>{services.length} 项 · {priceRange(services)}</small></span></button>
        {category.notice ? <p title={category.notice}>{category.notice}</p> : null}
        <div className="price-category__actions"><button className="react-mini-button react-mini-button--label" type="button" title="在此分类添加服务" onClick={() => onService(category)}><Plus {...iconProps(14)} /><span>添加服务</span></button><button className="react-mini-button" type="button" title="组合报价" onClick={() => onSum(category)} disabled={!services.length}><Copy {...iconProps(14)} /></button><button className="react-mini-button" type="button" title="编辑大类" onClick={() => onEdit(category)}><Edit3 {...iconProps(14)} /></button><button className="react-mini-button" type="button" title={category.status === 'active' ? '归档大类' : '恢复大类'} onClick={() => onToggle(category)}>{category.status === 'active' ? <Archive {...iconProps(14)} /> : <ArchiveRestore {...iconProps(14)} />}</button><button className="react-mini-button price-danger" type="button" title="删除大类" onClick={() => onDelete(category)}><Trash2 {...iconProps(14)} /></button></div>
      </header>
      {open ? <div className="price-category__body"><div className="price-service__labels"><span>服务项目</span><span>计价方式</span><span>基准价</span><span>阶梯与增项</span><span>操作</span></div>{services.length ? services.map((service) => <ServiceRow key={service.id} service={service} onEdit={onEditService} onPeek={onPeekService} onAdvanced={onAdvancedService} onToggle={onToggleService} onDelete={onDeleteService} />) : <div className="price-category__empty">还没有服务项，点“添加服务”即可使用当前游戏和分类。</div>}</div> : null}
    </section>
  )
}

function GroupWorkspace({ group, query, onNewCategory, onService, onEditCategory, onSum, onToggleCategory, onDeleteCategory, onEditService, onPeekService, onAdvancedService, onToggleService, onDeleteService }) {
  const categories = group.categories || []
  const [selected, setSelected] = useState('all')
  const [openMap, setOpenMap] = useState(() => new Map(categories.slice(0, 1).map((category) => [String(category.id), true])))
  const text = query.q.trim()

  useEffect(() => {
    if (text) setOpenMap(new Map(categories.map((category) => [String(category.id), true])))
  }, [text, group.key])

  const allOpen = categories.length > 0 && categories.every((category) => openMap.get(String(category.id)))
  const visible = selected === 'all' ? categories : categories.filter((category) => String(category.id) === selected)
  const setCategoryOpen = (id, value) => setOpenMap((current) => new Map(current).set(String(id), value))
  const selectCategory = (id) => {
    setSelected(id)
    if (id !== 'all') setCategoryOpen(id, true)
    requestAnimationFrame(() => document.getElementById(`price-category-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }
  const setAllOpen = () => setOpenMap(new Map(categories.map((category) => [String(category.id), !allOpen])))

  return (
    <section className="price-group" key={group.key || 'generic'}>
      <header className="price-group__head"><div><div className="price-group__eyebrow">当前价格表</div><h3>{group.game?.name || '通用价格'}</h3><span>{categories.length} 个大类 · {group.loose.length ? `${group.loose.length} 个未分类服务` : '服务均已归类'}</span></div><div className="price-group__head-actions">{group.game?.currency ? <em>{group.game.currency}</em> : null}<button className="refactor-button refactor-button--compact" type="button" onClick={() => onNewCategory(group.key || '')}><FolderPlus {...iconProps(14)} />新建大类</button></div></header>
      <div className="price-workspace">
        <aside className="price-directory" aria-label={`${group.game?.name || '通用价格'}分类目录`}><div className="price-directory__head"><b>分类目录</b><span>{categories.length}</span></div><button className={`price-directory__item${selected === 'all' ? ' is-active' : ''}`} type="button" onClick={() => selectCategory('all')}><span>全部分类</span><small>{categories.reduce((count, category) => count + (category.services || []).length, 0)} 项</small></button>{categories.map((category) => <button className={`price-directory__item${selected === String(category.id) ? ' is-active' : ''}`} type="button" key={category.id} onClick={() => selectCategory(String(category.id))}><span>{category.name}</span><small>{(category.services || []).length}</small></button>)}{!categories.length ? <p className="price-directory__empty">还没有分类</p> : null}<button className="price-directory__add" type="button" onClick={() => onNewCategory(group.key || '')}><Plus {...iconProps(14)} />新建分类</button></aside>
        <div className="price-catalog"><div className="price-catalog__tools"><span>{selected === 'all' ? '全部分类' : categories.find((category) => String(category.id) === selected)?.name}</span><div><button className="refactor-button refactor-button--compact" type="button" onClick={setAllOpen} disabled={!categories.length}>{allOpen ? <ChevronDown {...iconProps(14)} /> : <ChevronRight {...iconProps(14)} />}{allOpen ? '全部收起' : '全部展开'}</button>{selected !== 'all' ? <button className="refactor-button refactor-button--compact" type="button" onClick={() => onService(categories.find((category) => String(category.id) === selected))}><Plus {...iconProps(14)} />添加服务</button> : null}</div></div>{visible.map((category) => <CategoryBlock key={category.id} category={category} open={!!openMap.get(String(category.id))} onOpenChange={(value) => setCategoryOpen(category.id, value)} onEdit={onEditCategory} onService={onService} onSum={onSum} onToggle={onToggleCategory} onDelete={onDeleteCategory} onEditService={onEditService} onPeekService={onPeekService} onAdvancedService={onAdvancedService} onToggleService={onToggleService} onDeleteService={onDeleteService} />)}{group.loose.length ? <div className="price-loose"><div className="price-loose__head"><b>未分类服务</b><span>请编辑服务并选择一个分类</span></div>{group.loose.map((service) => <ServiceRow key={service.id} service={service} onEdit={onEditService} onPeek={onPeekService} onAdvanced={onAdvancedService} onToggle={onToggleService} onDelete={onDeleteService} />)}</div> : null}{!visible.length && !group.loose.length ? <div className="price-category__empty price-category__empty--large">还没有分类，先新建一个分类再添加服务。</div> : null}</div>
      </div>
    </section>
  )
}

export default function PricePage({ route, navigate, onNewGame, onNewCategory, onReload, reloadKey }) {
  const query = useMemo(() => ({ game: route.query.get('game') || '', q: route.query.get('q') || '', status: route.query.get('status') || 'active' }), [route.query.toString()])
  const [book, setBook] = useState(null)
  const [search, setSearch] = useState(query.q)
  const [error, setError] = useState('')

  useEffect(() => setSearch(query.q), [query.q])
  useEffect(() => {
    let active = true
    setBook(null)
    setError('')
    api.get('/api/pricebook', { status: query.status }).then((data) => { if (active) setBook(data) }).catch((err) => { if (active) { setBook({ games: [], categories: [], loose: [] }); setError(err.message || '价格表加载失败') } })
    return () => { active = false }
  }, [reloadKey])

  const update = (overrides) => {
    const next = { ...query, ...overrides }
    const params = new URLSearchParams()
    if (next.game) params.set('game', next.game)
    if (next.q) params.set('q', next.q)
    if (next.status && next.status !== 'active') params.set('status', next.status)
    navigate(`/price${params.toString() ? `?${params.toString()}` : ''}`)
  }

  const data = book || { games: [], categories: [], loose: [] }
  const gameMap = new Map((data.games || []).map((game) => [String(game.id), game]))
  const gameFilter = query.game === 'generic' ? '' : query.game
  const categories = (data.categories || []).filter((category) => {
    if (!query.game) return true
    if (query.game === 'generic') return !category.game_id
    return !category.game_id || String(category.game_id) === gameFilter
  })
  const loose = (data.loose || []).filter((service) => {
    if (!query.game) return true
    if (query.game === 'generic') return !service.game_id
    return !service.game_id || String(service.game_id) === gameFilter
  })
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

  const createCategory = async (gameId = '') => { try { if (await categoryForm({}, data.games || [], gameId && gameId !== 'generic' ? gameId : null)) await onReload() } catch (err) { toastErr(err) } }
  const editCategory = async (category) => { try { if (await categoryForm(category, data.games || [])) await onReload() } catch (err) { toastErr(err) } }
  const newService = async (category) => {
    if (!category?.id) {
      toast('先建一个大类，服务项要挂在大类下面', 'err')
      return createCategory(query.game)
    }
    try {
      if (await serviceForm({ category_id: category.id, game_id: category.game_id || (query.game !== 'generic' ? query.game : '') }, { games: data.games || [], categories: data.categories || [] }, { quick: true })) await onReload()
    } catch (err) { toastErr(err) }
  }
  const editService = async (service) => { try { if (await serviceForm(service, { games: data.games || [], categories: data.categories || [] })) await onReload() } catch (err) { toastErr(err) } }
  const peekContext = { meta: { games: data.games || [], categories: data.categories || [] }, app: { reload: () => {} } }
  const peekService = (service) => { try { servicePeek(service, peekContext, { onChanged: onReload }) } catch (err) { toastErr(err) } }
  const toggleCategory = async (category) => { try { await api.patch(`/api/categories/${category.id}`, { status: category.status === 'active' ? 'archived' : 'active' }); toast(category.status === 'active' ? '大类已归档' : '大类已恢复', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const deleteCategory = async (category) => { try { const usage = await api.get(`/api/categories/${category.id}/usage`); if (!await confirmDelete({ title: `删除「${category.name}」？`, message: usage.services ? `${usage.services} 个服务项会变成未分类，老订单不受影响。` : '这个大类没有服务项。' })) return; await api.del(`/api/categories/${category.id}`, { hard: 1 }); toast('大类已删除', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const toggleService = async (service) => { try { await api.patch(`/api/services/${service.id}`, { status: service.status === 'active' ? 'archived' : 'active' }); toast(service.status === 'active' ? '服务已归档' : '服务已恢复', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const deleteService = async (service) => { try { const usage = await api.get(`/api/services/${service.id}/usage`); if (!await confirmDelete({ title: `删除「${service.name}」？`, message: usage.orders ? `${usage.orders} 张订单使用过它，老订单快照不会改变。` : '这个服务还没有关联订单。' })) return; await api.del(`/api/services/${service.id}`, { hard: 1 }); toast('服务已删除', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const quickAddService = () => {
    if (!query.game) {
      toast('请先选择一个游戏或通用价格表，再添加服务', 'err')
      return
    }
    const group = groups.find((item) => item.key === (query.game === 'generic' ? '' : query.game))
    const category = group?.categories?.[0]
    if (category) newService(category)
    else createCategory(query.game)
  }

  return (
    <div className="price-page">
      <header className="price-page__head"><div><span className="refactor-eyebrow">业务目录 / 价格工作区</span><h2>价格表</h2><p>{data.games.length} 个游戏 · {data.categories.length} 个大类 · {data.categories.reduce((sum, category) => sum + (category.services || []).length, 0) + data.loose.length} 个服务项</p></div><div className="price-page__head-actions"><button className="refactor-button" type="button" onClick={() => openExporter(null, { games: data.games || [] })}><Copy {...iconProps(15)} />导出</button><button className="refactor-button" type="button" onClick={onNewGame}><Gamepad2 {...iconProps(15)} />新建价格表</button><button className="refactor-button" type="button" onClick={() => createCategory(query.game)}><FolderPlus {...iconProps(15)} />新建大类</button><button className="refactor-button refactor-button--primary" type="button" onClick={quickAddService}><Plus {...iconProps(15)} />添加服务</button></div></header>
      <section className="price-toolbar"><div className="price-games"><button className={`price-game${!query.game ? ' is-active' : ''}`} type="button" onClick={() => update({ game: '' })}>全部价格表</button>{data.games.map((game) => <button key={game.id} className={`price-game${query.game === String(game.id) ? ' is-active' : ''}`} type="button" onClick={() => update({ game: String(game.id) })}>{game.name}</button>)}<button className={`price-game${query.game === 'generic' ? ' is-active' : ''}`} type="button" onClick={() => update({ game: 'generic' })}>通用</button></div><div className="price-toolbar__spacer" /><div className="price-status" role="group" aria-label="价格状态"><button className={query.status === 'active' ? 'is-active' : ''} type="button" onClick={() => update({ status: 'active' })}>在架</button><button className={query.status === 'archived' ? 'is-active' : ''} type="button" onClick={() => update({ status: 'archived' })}>已归档</button><button className={query.status === 'all' ? 'is-active' : ''} type="button" onClick={() => update({ status: 'all' })}>全部</button></div><label className="price-search"><Search {...iconProps(15)} /><input type="search" value={search} placeholder="搜大类、服务或说明" onChange={(event) => { const value = event.target.value; setSearch(value); window.clearTimeout(window.__priceTimer); window.__priceTimer = window.setTimeout(() => update({ q: value.trim() }), 260) }} /></label></section>
      {error ? <div className="refactor-alert" role="alert">{error}</div> : null}
      <section className="price-groups">{book === null ? <div className="refactor-loading"><span /><span /><span /></div> : groups.length ? groups.map((group) => <GroupWorkspace key={group.key || 'generic'} group={group} query={query} onNewCategory={createCategory} onService={newService} onEditCategory={editCategory} onSum={(cat) => sumDialog(cat, cat.services || [])} onToggleCategory={toggleCategory} onDeleteCategory={deleteCategory} onEditService={editService} onPeekService={peekService} onAdvancedService={peekService} onToggleService={toggleService} onDeleteService={deleteService} />) : <div className="price-empty"><Layers3 {...iconProps(24)} /><b>{query.q ? '没有找到匹配的价格' : '还没有价格表'}</b><span>{query.q ? '换个关键词试试。' : '先新建游戏，再建立大类和服务项。'}</span><button className="refactor-button refactor-button--primary" type="button" onClick={onNewGame}><Plus {...iconProps(15)} />新建价格表</button></div>}</section>
    </div>
  )
}
