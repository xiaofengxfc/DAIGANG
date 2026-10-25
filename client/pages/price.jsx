import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Archive, ArchiveRestore, ChevronDown, ChevronRight, Copy, Edit3, Eye, FolderPlus, Gamepad2, GripVertical, Layers3, Plus, Search, SlidersHorizontal, Sparkles, Trash2 } from 'lucide-react'
import { api, PRICE_TYPE_LABEL } from '../lib/api.js'
import { fmtMoney, fmtQty } from '../lib/formatters.js'
import { toast, toastErr } from '../app/toast-store.js'
import { confirmDelete } from '../app/confirm.jsx'
import { openCategoryForm } from '../forms/category-form.jsx'
import { openPriceSum } from '../components/price-sum.jsx'
import { openExporter } from '../components/price-exporter.jsx'
import { openPriceScan } from '../components/price-scan.jsx'
import { openServiceForm } from '../forms/service-form.jsx'
import { openServicePeek } from '../components/service-peek.jsx'
import { unitOf as unitOfShared } from '../../shared/pricing.js'
import { moveId, nudgeId, reorderInPlace as reorderInPlacePure } from '../lib/sortable.js'

const iconProps = (size = 15) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

/**
 * 一个可拖拽排序的列表（大类之间、大类下的服务项之间都用它）。
 *
 * 为什么收成一个 hook 而不是每处写一遍：拖拽这套东西真正麻烦的是**边界**——
 * 拖到自己身上、拖到列表外、落下时数据已经刷新过（id 找不到了）、
 * 位置没变不该发请求。复制三份的话，改一处忘两处是迟早的事。
 *
 * 为什么是原生 HTML5 拖拽而不是引一个库：这个项目只有 React 和 lucide 两个
 * 运行时依赖，为「挪个位置」装一整套 dnd-kit 不划算。
 *
 * 两个细节是刻意的：
 *
 *   1. **按下把手才允许拖**（`armed`）。整行直接 `draggable` 的话，在行里选文字、
 *      按按钮都会变成「开始拖拽」，按钮点不动。
 *   2. **键盘也能排**（把手是 `<button>`，↑ ↓ 挪一格）。原生拖拽在触屏上不生效，
 *      而且没有键盘通路就没法用 —— 顺手补上，成本很低。
 */
function useSortable(ids, onReorder) {
  const [dragId, setDragId] = useState(null)
  /** 落点：{ id, after }。after 决定插在目标的前面还是后面 */
  const [dropAt, setDropAt] = useState(null)
  const [armed, setArmed] = useState(null)

  const reset = () => { setDragId(null); setDropAt(null); setArmed(null) }

  /**
   * 松手就解除「可拖」。
   *
   * 监听的是 **window** 而不是把手自己：在把手上按下、把鼠标移到别处再松开时，
   * 把手上的 `mouseup` 根本不会触发 —— 那一行就会一直停在 `draggable` 状态，
   * 之后在它上面选文字、点按钮全变成「开始拖拽」。
   */
  useEffect(() => {
    if (armed === null) return undefined
    const clear = () => setArmed(null)
    window.addEventListener('mouseup', clear)
    return () => window.removeEventListener('mouseup', clear)
  }, [armed])

  /** 把 `id` 挪到列表里第 `to` 位。位置没变就不发请求 */
  const commit = (next) => {
    if (!next || next.join(',') === ids.join(',')) return
    onReorder(next)
  }

  /** 键盘：往上 / 往下挪一格 */
  const nudge = (id, delta) => {
    const next = nudgeId(ids, id, delta)
    if (next === ids) return
    commit(next)
  }

  const drop = () => {
    const target = dropAt
    if (dragId === null || !target) return reset()
    const next = moveId(ids, dragId, target.id, target.after)
    reset()
    if (next === ids) return
    commit(next)
  }

  return {
    dragId,
    /** 行上要挂的类名：拖拽中 / 落点在它前面 / 落点在它后面 */
    classOf: (id) => [
      dragId === id ? 'is-dragging' : '',
      dropAt?.id === id ? (dropAt.after ? 'is-drop-after' : 'is-drop-before') : '',
    ].filter(Boolean).join(' '),
    /** 给整行 */
    rowProps: (id) => ({
      draggable: armed === id,
      onDragStart: (event) => {
        setDragId(id)
        event.dataTransfer.effectAllowed = 'move'
        // 有些浏览器（Firefox）不 setData 就不触发拖拽
        event.dataTransfer.setData('text/plain', String(id))
      },
      onDragEnd: reset,
      onDragOver: (event) => {
        if (dragId === null || dragId === id) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        // 落在上半部分就插到它前面，下半部分插到后面 —— 和指示线的位置一致
        const rect = event.currentTarget.getBoundingClientRect()
        setDropAt({ id, after: event.clientY > rect.top + rect.height / 2 })
      },
      onDrop: (event) => { event.preventDefault(); drop() },
    }),
    /** 给把手 */
    handleProps: (id) => ({
      onMouseDown: () => setArmed(id),
      onKeyDown: (event) => {
        if (event.key === 'ArrowUp') { event.preventDefault(); nudge(id, -1) }
        else if (event.key === 'ArrowDown') { event.preventDefault(); nudge(id, 1) }
      },
    }),
  }
}

/**
 * 一个拖拽把手。看着小，但它是「这一行能挪」的唯一提示 —— 没有它没人知道能拖。
 */
function DragHandle({ label, ...rest }) {
  return (
    <button className="price-grip" type="button" title={`按住拖动改顺序（也可以选中后按 ↑ ↓）· ${label}`} aria-label={`调整「${label}」的顺序`} {...rest}>
      <GripVertical {...iconProps(14)} />
    </button>
  )
}

const unitOf = (service) => unitOfShared(service)

function priceRange(services) {
  const values = (services || []).map((service) => Number(service.base_price)).filter(Number.isFinite)
  // 一条都没有就不写价格区间（旧版也是这样：宁可不写，也不写「暂无价格」占着位置）
  if (!values.length) return ''
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

function ServiceRow({ service, currency = '', orphan = false, sortable = null, onEdit, onPeek, onAdvanced, onToggle, onDelete }) {
  const tiers = service.tiers || []
  const options = service.options || []
  const unit = unitOf(service)
  // 没传 sortable 就是这一层不支持排序（比如「未分类服务」那块），那时不画把手 ——
  // 画一个拖不动的把手比不画更让人困惑
  return (
    <div className={`price-service${service.status === 'archived' ? ' is-archived' : ''}${sortable ? ` ${sortable.classOf(service.id)}` : ''}`} {...(sortable ? sortable.rowProps(service.id) : {})}>
      <div className="price-service__main">
        {sortable ? <DragHandle label={service.name} {...sortable.handleProps(service.id)} /> : null}
        <div className="price-service__name"><b>{service.name}</b>{service.is_daily ? <span className="price-tag price-tag--jade">每天</span> : null}{tiers.length ? <span className="price-tag">{tiers.length} 档</span> : null}{options.length ? <span className="price-tag">{options.length} 个增项</span> : null}{orphan ? <span className="price-tag" title="它原来挂的大类不在当前这份列表里（多半是归档了）。重新选一个分类就能归位。">{`原大类：${service.category_name || '已删除'}`}</span> : null}</div>
        {service.description ? <p title={service.description}>{service.description}</p> : <p className="price-service__muted">暂无说明</p>}
        {service.package_items?.length ? <small title={service.package_items.join(' · ')}>套餐含：{service.package_items.join(' · ')}</small> : null}
      </div>
      <div className="price-service__type"><b>{PRICE_TYPE_LABEL[service.price_type] || service.price_type}</b><small>/{unit} · 起订 {fmtQty(service.min_qty || 1)}{service.max_qty ? ` · 上限 ${fmtQty(service.max_qty)}` : ''}</small></div>
      <div className="price-service__money"><b>¥{fmtMoney(service.base_price)}</b>{service.currency_amount ? <small>可得 {currency ? `${currency} ` : ''}{fmtQty(service.currency_amount)}</small> : null}</div>
      <div className="price-service__tiers" title={[tiers.length ? tierSummary(tiers, unit) : '', options.length ? optionSummary(options) : ''].filter(Boolean).join(' · ')}>{tiers.length ? <b>{tierSummary(tiers, unit)}</b> : null}{options.length ? <small>{optionSummary(options)}</small> : null}</div>
      <div className="price-service__actions"><button className="react-mini-button" type="button" title="查看服务详情" onClick={() => onPeek(service)}><Eye {...iconProps(14)} /></button><button className="react-mini-button" type="button" title="高级设置：阶梯价和增项" onClick={() => onAdvanced(service)}><SlidersHorizontal {...iconProps(14)} /></button><button className="react-mini-button" type="button" title="编辑服务" onClick={() => onEdit(service)}><Edit3 {...iconProps(14)} /></button><button className="react-mini-button" type="button" title={service.status === 'active' ? '归档服务' : '恢复服务'} onClick={() => onToggle(service)}>{service.status === 'active' ? <Archive {...iconProps(14)} /> : <ArchiveRestore {...iconProps(14)} />}</button><button className="react-mini-button price-danger" type="button" title="删除服务" onClick={() => onDelete(service)}><Trash2 {...iconProps(14)} /></button></div>
    </div>
  )
}

/**
 * 一条「待添加的服务项」。
 *
 * 这些是从 B站比价整理出来、**还没进价格表**的项。放在大类下面（而不是在比价
 * 面板里直接建）是因为：判断「这一项要不要建」得看这个大类现在已经有什么 ——
 * 原神的「主线」下面已经有 7.0、7.1 了，视频里那个「主线」是重复的还是新版本？
 * 在比价面板里看不到，在这里一眼就看到了。
 */
function DraftRow({ draft, busy, onAccept, onDelete }) {
  const aliases = String(draft.aliases || '').split('\n').map((s) => s.trim()).filter(Boolean)
  return (
    <div className="price-draft">
      <div className="price-draft__main">
        <div className="price-draft__name">
          <b>{draft.name}</b>
          <span className="price-tag price-tag--draft">待添加</span>
        </div>
        <div className="price-draft__money">¥{fmtMoney(draft.price)}</div>
        <div className="price-draft__actions">
          <button className="refactor-button refactor-button--compact refactor-button--primary" type="button" disabled={busy} onClick={() => onAccept(draft)}>
            <Plus {...iconProps(13)} />添加
          </button>
          <button className="react-mini-button price-danger" type="button" title="不要这一条（不会进价格表）" disabled={busy} onClick={() => onDelete(draft)}>
            <Trash2 {...iconProps(14)} />
          </button>
        </div>
      </div>
      {aliases.length ? (
        <p className="price-draft__alias" title={aliases.join('\n')}>
          视频里这么写：{aliases.join('、')}　<span>添加后会记成别名，下次比价直接匹上</span>
        </p>
      ) : null}
    </div>
  )
}

/** 一组待添加。放在大类正文的最上面 —— 那是这个页面上唯一需要你动手的东西 */
function DraftBlock({ drafts, busy, onAccept, onDelete, onAcceptAll, onClearAll }) {
  if (!drafts.length) return null
  return (
    <div className="price-drafts">
      <div className="price-drafts__head">
        <b>可添加的服务项</b>
        <span>{drafts.length} 项 · B站比价整理来的，点「添加」才会进价格表</span>
        <div className="price-drafts__actions">
          <button className="ps-link" type="button" disabled={busy} onClick={() => onAcceptAll(drafts)}>全部添加</button>
          <button className="ps-link" type="button" disabled={busy} onClick={() => onClearAll(drafts)}>全部删掉</button>
        </div>
      </div>
      {drafts.map((draft) => <DraftRow key={draft.id} draft={draft} busy={busy} onAccept={onAccept} onDelete={onDelete} />)}
    </div>
  )
}

function CategoryBlock({ category, currency = '', open, drafts = [], draftBusy = false, sortable = null, onOpenChange, onEdit, onService, onSum, onToggle, onDelete, onEditService, onPeekService, onAdvancedService, onToggleService, onDeleteService, onAcceptDraft, onDeleteDraft, onAcceptAllDrafts, onClearAllDrafts, onReorderService }) {
  const services = category.services || []
  // 搜索命中的那几条 vs 这个大类一共几条：标题要写「5 项（命中 2）」，
  // 空的时候也要分清「这个筛选下没有」和「这个大类下真的还没有」——
  // 不然一搜索，满员的分类会说自己「还没有服务项」。
  const all = category.allServices || services
  /**
   * 服务项的排序句柄。
   *
   * **只在「全部展开看某一类」之外的时候也照常给** —— 拖的是 `services` 这一份
   * （当前筛选下看得见的那些），因为你看不见的东西没法拖到它旁边。
   */
  const rowSort = useSortable(services.map((service) => service.id), (ids) => onReorderService(category, ids))
  return (
    <section className={`price-category${category.status === 'archived' ? ' is-archived' : ''}${sortable ? ` ${sortable.classOf(category.id)}` : ''}`} id={`price-category-${category.id}`} {...(sortable ? sortable.rowProps(category.id) : {})}>
      <header className="price-category__head">
        {sortable ? <DragHandle label={category.name} {...sortable.handleProps(category.id)} /> : null}
        <button className="price-category__toggle" type="button" aria-expanded={open} onClick={() => onOpenChange(!open)}>{open ? <ChevronDown {...iconProps(16)} /> : <ChevronRight {...iconProps(16)} />}<span><b>{category.name}</b><small>{all.length} 项{services.length !== all.length ? `（命中 ${services.length}）` : ''}{services.length ? ` · ${priceRange(services)}` : ''}</small>{/* 收起时也要能看见「这里还有 3 项等着你决定」 */}{drafts.length ? <em className="price-category__drafts">{drafts.length} 项待添加</em> : null}</span></button>
        {category.notice ? <p title={category.notice}>{category.notice}</p> : null}
        <div className="price-category__actions"><button className="react-mini-button react-mini-button--label" type="button" title="在此分类添加服务" onClick={() => onService(category)}><Plus {...iconProps(14)} /><span>添加服务</span></button><button className="react-mini-button" type="button" title="组合报价" onClick={() => onSum(category)} disabled={!all.length}><Copy {...iconProps(14)} /></button><button className="react-mini-button" type="button" title="编辑大类" onClick={() => onEdit(category)}><Edit3 {...iconProps(14)} /></button><button className="react-mini-button" type="button" title={category.status === 'active' ? '归档大类' : '恢复大类'} onClick={() => onToggle(category)}>{category.status === 'active' ? <Archive {...iconProps(14)} /> : <ArchiveRestore {...iconProps(14)} />}</button><button className="react-mini-button price-danger" type="button" title="删除大类" onClick={() => onDelete(category)}><Trash2 {...iconProps(14)} /></button></div>
      </header>
      {open ? <div className="price-category__body"><DraftBlock drafts={drafts} busy={draftBusy} onAccept={onAcceptDraft} onDelete={onDeleteDraft} onAcceptAll={onAcceptAllDrafts} onClearAll={onClearAllDrafts} /><div className="price-service__labels"><span>服务项目</span><span>计价方式</span><span>基准价</span><span>阶梯与增项</span><span>操作</span></div>{services.length ? services.map((service) => <ServiceRow key={service.id} service={service} currency={currency} sortable={services.length > 1 ? rowSort : null} onEdit={onEditService} onPeek={onPeekService} onAdvanced={onAdvancedService} onToggle={onToggleService} onDelete={onDeleteService} />) : <div className="price-category__empty">{category.rawTotal ? '这个筛选下没有服务项。' : '还没有服务项，点“添加服务”即可使用当前游戏和分类。'}</div>}</div> : null}
    </section>
  )
}

function GroupWorkspace({ group, query, drafts = [], draftBusy = false, onNewCategory, onService, onEditCategory, onSum, onToggleCategory, onDeleteCategory, onEditService, onPeekService, onAdvancedService, onToggleService, onDeleteService, onAcceptDraft, onDeleteDraft, onAcceptAllDrafts, onClearAllDrafts, onReorderCategory, onReorderService }) {
  const categories = group.categories || []
  const [selected, setSelected] = useState('all')
  // 默认全部收起：一屏先看完整棵树（有几个大类、各多少项、价格区间），想展开哪个点哪个。
  // 右上角的「全部展开」一键铺开；搜索时下面那个 effect 会自动全展开，方便直接看命中项。
  const [openMap, setOpenMap] = useState(() => new Map())
  const text = query.q.trim()
  // 大类的 id 列表变了（刷新、搜索）才需要重新铺开一次 —— 直接依赖 categories 数组
  // 会因为每次渲染都是新数组而反复触发。
  const categoryKey = categories.map((category) => category.id).join(',')

  useEffect(() => {
    if (text) setOpenMap(new Map(categories.map((category) => [String(category.id), true])))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, group.key, categoryKey])

  const allOpen = categories.length > 0 && categories.every((category) => openMap.get(String(category.id)))
  // 选中的大类被搜索/状态筛选挡掉时，退回「全部分类」：
  // 否则目录里明明还有别的分类，正文却只剩一句「还没有分类」。
  const current = selected === 'all' || categories.some((category) => String(category.id) === selected) ? selected : 'all'
  const visible = current === 'all' ? categories : categories.filter((category) => String(category.id) === current)
  const setCategoryOpen = (id, value) => setOpenMap((currentMap) => new Map(currentMap).set(String(id), value))
  const selectCategory = (id) => {
    setSelected(id)
    if (id !== 'all') setCategoryOpen(id, true)
    requestAnimationFrame(() => document.getElementById(`price-category-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }))
  }
  const setAllOpen = () => setOpenMap(new Map(categories.map((category) => [String(category.id), !allOpen])))
  /**
   * 大类的排序句柄。
   *
   * 拖的是**当前筛选下看得见的那些**大类（搜索时只有命中的几个），顺序按它们在
   * 列表里的相对位置算 —— 没显示的（被搜索筛掉的）留在原地不动，不会被挤走。
   */
  const categorySort = useSortable(visible.map((category) => category.id), (ids) => onReorderCategory(group, ids))

  /**
   * 待添加按大类分组。没归类（`category_id` 是空）的单独一堆 —— 那多半是 AI
   * 没判断出来，或者是建完之后大类被删了，得让用户看见并处理，不能悄悄吞掉。
   *
   * 大类被搜索/状态筛掉时也落到那一堆里：草稿不跟着搜索走，但它得有个地方显示，
   * 否则会变成「还在库里、界面上哪儿都找不到」。
   */
  const visibleIds = new Set(visible.map((category) => Number(category.id)))
  const draftsByCategory = new Map()
  const looseDrafts = []
  for (const draft of drafts) {
    const key = draft.category_id === null || draft.category_id === undefined ? null : Number(draft.category_id)
    if (key === null || !visibleIds.has(key)) { looseDrafts.push(draft); continue }
    if (!draftsByCategory.has(key)) draftsByCategory.set(key, [])
    draftsByCategory.get(key).push(draft)
  }
  const groupDraftCount = drafts.length

  return (
    <section className="price-group" key={group.key || 'generic'}>
      <header className="price-group__head"><div><h3>{group.game?.name || '通用价格'}</h3><span>{categories.length} 个大类{group.loose.length ? ` · ${group.loose.length} 个未分类服务` : group.looseTotal ? ` · 另有 ${group.looseTotal} 个未分类服务没被筛出来` : ' · 服务均已归类'}{groupDraftCount ? ` · ${groupDraftCount} 项待添加` : ''}</span></div><div className="price-group__head-actions">{group.game?.currency ? <em>{group.game.currency}</em> : null}<button className="refactor-button refactor-button--compact" type="button" onClick={() => onNewCategory(group.key || '')}><FolderPlus {...iconProps(14)} />新建大类</button></div></header>
      <div className="price-workspace">
        <aside className="price-directory" aria-label={`${group.game?.name || '通用价格'}分类目录`}><div className="price-directory__head"><b>分类目录</b><span>{categories.length}</span></div><button className={`price-directory__item${current === 'all' ? ' is-active' : ''}`} type="button" onClick={() => selectCategory('all')}><span>全部分类</span><small>{categories.reduce((count, category) => count + (category.services || []).length, 0)} 项</small></button>{categories.map((category) => <button className={`price-directory__item${current === String(category.id) ? ' is-active' : ''}`} type="button" key={category.id} onClick={() => selectCategory(String(category.id))}><span>{category.name}</span><small>{(category.services || []).length}</small></button>)}{!categories.length ? <p className="price-directory__empty">{query.q ? '这个筛选下没有分类' : '还没有分类'}</p> : null}<button className="price-directory__add" type="button" onClick={() => onNewCategory(group.key || '')}><Plus {...iconProps(14)} />新建分类</button></aside>
        <div className="price-catalog"><div className="price-catalog__tools"><span>{current === 'all' ? '全部分类' : categories.find((category) => String(category.id) === current)?.name}</span><div><button className="refactor-button refactor-button--compact" type="button" onClick={setAllOpen} disabled={!categories.length}>{allOpen ? <ChevronDown {...iconProps(14)} /> : <ChevronRight {...iconProps(14)} />}{allOpen ? '全部收起' : '全部展开'}</button>{current !== 'all' ? <button className="refactor-button refactor-button--compact" type="button" onClick={() => onService(categories.find((category) => String(category.id) === current))}><Plus {...iconProps(14)} />添加服务</button> : null}</div></div>{visible.map((category) => <CategoryBlock key={category.id} category={category} currency={group.game?.currency || ''} open={!!openMap.get(String(category.id))} drafts={draftsByCategory.get(Number(category.id)) || []} draftBusy={draftBusy} sortable={visible.length > 1 ? categorySort : null} onOpenChange={(value) => setCategoryOpen(category.id, value)} onEdit={onEditCategory} onService={onService} onSum={onSum} onToggle={onToggleCategory} onDelete={onDeleteCategory} onEditService={onEditService} onPeekService={onPeekService} onAdvancedService={onAdvancedService} onToggleService={onToggleService} onDeleteService={onDeleteService} onAcceptDraft={onAcceptDraft} onDeleteDraft={onDeleteDraft} onAcceptAllDrafts={onAcceptAllDrafts} onClearAllDrafts={onClearAllDrafts} onReorderService={onReorderService} />)}{looseDrafts.length ? <div className="price-loose price-loose--drafts"><DraftBlock drafts={looseDrafts} busy={draftBusy} onAccept={onAcceptDraft} onDelete={onDeleteDraft} onAcceptAll={onAcceptAllDrafts} onClearAll={onClearAllDrafts} /></div> : null}{group.loose.length ? <div className="price-loose"><div className="price-loose__head"><b>未分类服务</b><span>{group.loose.some((service) => service.category_name) ? '它原来那个大类不在当前列表里（多半是归档了），重新选一个分类就能归位' : '请编辑服务并选择一个分类'}</span></div>{group.loose.map((service) => <ServiceRow key={service.id} service={service} currency={group.game?.currency || ''} orphan={Boolean(service.category_name)} onEdit={onEditService} onPeek={onPeekService} onAdvanced={onAdvancedService} onToggle={onToggleService} onDelete={onDeleteService} />)}</div> : null}{!visible.length && !group.loose.length ? <div className="price-category__empty price-category__empty--large">还没有分类，先新建一个分类再添加服务。</div> : null}</div>
      </div>
    </section>
  )
}

export default function PricePage({ route, navigate, onNewGame, onReload, reloadKey }) {
  const query = useMemo(() => ({ game: route.query.get('game') || '', q: route.query.get('q') || '', status: route.query.get('status') || 'active' }), [route.query.toString()])
  const [book, setBook] = useState(null)
  /** 「添加/删掉」正在跑 —— 挡住重复点击。批量时一批只挡一次 */
  const [draftBusy, setDraftBusy] = useState(false)
  const [search, setSearch] = useState(query.q)
  const [error, setError] = useState('')
  // 上一次取数用的状态筛选：只有它变了才值得把列表清空重画（见下面那个 effect）
  const statusRef = useRef(query.status)
  const searchTimer = useRef(null)
  // 定时器里不能直接用当次渲染闭包里的 update：那里面装着**敲字那一刻**的筛选条件。
  // 敲完 260ms 内点了「已归档」或游戏标签，定时器一响会把刚点的筛选条件顶掉。
  const updateRef = useRef(null)

  useEffect(() => setSearch(query.q), [query.q])
  useEffect(() => () => window.clearTimeout(searchTimer.current), [])
  useEffect(() => {
    let active = true
    setError('')
    // 切「在架 / 已归档 / 全部」是换一份数据，先落骨架屏是应该的。
    // 但保存完（以及别的 reloadKey 刷新）那次**不能**清空 —— 清空会让整棵大类树
    // 卸载重建：展开的大类全部收起、滚动位置弹回顶部，看着就像「保存完页面跳走了」。
    if (statusRef.current !== query.status) {
      statusRef.current = query.status
      setBook(null)
    }
    // status 是**服务端**过滤的（在架 / 已归档 / 全部），所以它变了必须重新取数 ——
    // 只盯着 reloadKey 的话，点「已归档」页面会一直显示在架的那份数据。
    api.get('/api/pricebook', { status: query.status })
      .then((data) => { if (active) setBook(data) })
      .catch((err) => {
        if (!active) return
        setError(err.message || '价格表加载失败')
        // 刷新失败就留着上一次的表（顺手把错误条挂出来），别把用户正在看的东西抹掉
        setBook((current) => current || { games: [], categories: [], loose: [] })
      })
    return () => { active = false }
  }, [reloadKey, query.status])

  const update = (overrides) => {
    const next = { ...query, ...overrides }
    const params = new URLSearchParams()
    if (next.game) params.set('game', next.game)
    if (next.q) params.set('q', next.q)
    if (next.status && next.status !== 'active') params.set('status', next.status)
    navigate(`/price${params.toString() ? `?${params.toString()}` : ''}`)
  }
  // 定时器回调走这里取「最新一次渲染的 update」，拿到的就是最新的筛选条件
  updateRef.current = update

  const data = book || { games: [], categories: [], loose: [], drafts: [] }
  /**
   * 待添加的服务项（B站比价整理来的草稿，还没进价格表）。
   *
   * **不跟着搜索筛**：草稿不是价格表内容，它是「有件事等你决定」。搜个词就把它
   * 藏起来，用户会以为已经处理掉了。搜索时大类可能被藏起来，那种草稿会落到
   * 下面那个「没归类」的堆里，照样看得见。
   */
  const drafts = data.drafts || []
  const gameMap = new Map((data.games || []).map((game) => [String(game.id), game]))
  // 地址里的 game= 可能指着一个已经归档 / 删掉的游戏（旧书签，或者你选了它之后
  // 又去游戏页把它归档了）。那种情况下标签栏里一个都不亮，列表却已经被筛过，
  // 看着就像坏了 —— 退回「全部价格表」。数据没回来时先不判定，免得标签闪一下。
  const activeGame = !query.game || query.game === 'generic' || book === null || gameMap.has(query.game) ? query.game : ''
  const gameFilter = activeGame === 'generic' ? '' : activeGame
  // B站比价是按游戏搜的，得有一个具体的游戏才有意义（「全部」和「通用」都不行）
  const activeGameObj = activeGame && activeGame !== 'generic' ? gameMap.get(String(activeGame)) || null : null
  const categories = (data.categories || []).filter((category) => {
    if (!activeGame) return true
    if (activeGame === 'generic') return !category.game_id
    return !category.game_id || String(category.game_id) === gameFilter
  })
  const loose = (data.loose || []).filter((service) => {
    if (!activeGame) return true
    if (activeGame === 'generic') return !service.game_id
    return !service.game_id || String(service.game_id) === gameFilter
  })
  const text = query.q.trim().toLowerCase()
  const match = (value) => !text || String(value || '').toLowerCase().includes(text)
  // 游戏筛选也要落到**大类里面的**服务项上：一个服务项自己的 game_id 说了算，
  // 没绑游戏就跟它大类走。不然通用大类里挂给「原神」的服务项，会在崩铁的表里
  // 也列出来、还算进「N 个服务项」，而崩铁那份导出里并没有它 —— 页面和发出去的
  // 价格表对不上。（导出用的是同一条规则：!s.game_id || s.game_id === gameId）
  const inGame = (service, category) => {
    if (!activeGame) return true
    const own = service.game_id ? String(service.game_id) : category && category.game_id ? String(category.game_id) : ''
    if (activeGame === 'generic') return !own
    return !own || own === gameFilter
  }
  // 搜索只决定「显示哪几条」，不改变「这一节一共有几条」。
  // 所以每条大类都把两份都带上：allServices = 这个游戏范围内全部（组合报价和计数要用它），
  // services = 再命中搜索的那些（正文渲染用）。旧版标题写的就是「5 项（命中 2）」，
  // 组合报价也一直是拿全部算的 —— 只算命中的话，搜着搜着报价单会悄悄少几项。
  const visibleCategories = categories
    .map((category) => {
      const allServices = (category.services || []).filter((service) => inGame(service, category))
      return {
        ...category,
        // rawTotal = 库里这个大类的全部服务项（不分游戏、不分搜索）：
        // 正文空的时候要靠它分清「这个筛选下没有」和「这个大类里真的还没有」
        rawTotal: (category.services || []).length,
        allServices,
        services: allServices.filter((service) => match(`${service.name} ${service.description} ${category.name}`)),
      }
    })
    // 留下「名字/提示命中搜索」或者「有命中搜索的服务项」的大类。
    // 注意这里看的是命中后的 services —— 看 allServices 的话，
    // 搜一个谁都不命中的词，满员的分类还会一个个挂在页面上，空状态永远不出现。
    .filter((category) => match(`${category.name} ${category.notice}`) || category.services.length)
  const visibleLoose = loose.filter((service) => match(`${service.name} ${service.description}`))
  // 表头这几个数说的是**当前这个筛选范围**（游戏标签 + 状态）里的东西，
  // 不然点了某个游戏，上面写着全库的数、下面只有这一个游戏的表，对不上。
  const shownCategoryCount = categories.length
  const shownServiceCount = categories.reduce((sum, category) => sum + (category.services || []).filter((service) => inGame(service, category)).length, 0) + loose.length

  // 游戏被归档之后就不在 data.games 里了，但它的大类和服务项还在库里。
  // 这时退回记录自带的 game_name / game_currency，否则这一组会顶着一个空游戏
  // 渲染成「通用价格」，服务行上的「可得」也会丢掉货币名只剩一个数字。
  const gameOf = (row) => gameMap.get(String(row.game_id)) || (row.game_name ? { name: row.game_name, currency: row.game_currency || '' } : null)
  const groupMap = new Map()
  const groupFor = (row) => {
    const key = row.game_id ? String(row.game_id) : ''
    if (!groupMap.has(key)) groupMap.set(key, { key, game: gameOf(row), categories: [], loose: [], looseTotal: 0 })
    return groupMap.get(key)
  }
  for (const category of visibleCategories) groupFor(category).categories.push(category)
  for (const service of visibleLoose) groupFor(service).loose.push(service)
  // 未分类服务**一共**有几条（不受搜索影响）：搜索把它们藏起来时，
  // 组标题不能还写「服务均已归类」—— 那是句假话。
  // 这里**不能**顺手调 groupFor()：那会给「只有未分类服务、又被搜索藏起来」的游戏
  // 也造出一个组，页面就从「没有找到匹配的价格」变成一排「0 个大类」的空壳。
  const looseTotalByKey = new Map()
  for (const service of loose) {
    const key = service.game_id ? String(service.game_id) : ''
    looseTotalByKey.set(key, (looseTotalByKey.get(key) || 0) + 1)
  }
  for (const group of groupMap.values()) group.looseTotal = looseTotalByKey.get(group.key) || 0
  const groups = [...groupMap.values()]
  /** 这个游戏下的待添加。用全量那份（没被搜索筛过），见 `drafts` 的定义处 */
  const draftsOfGroup = (group) => drafts.filter((draft) => String(draft.game_id ?? '') === group.key)

  /**
   * 拖拽排序：先把界面改了，再发请求；失败了**退回去**并说一声。
   *
   * 为什么乐观更新：拖完等一个来回才动，手感是「没反应，我又拖了一次」——
   * 那会拖出第二个请求，把顺序弄乱。所以本地立刻生效，服务端只是确认。
   *
   * 为什么必须回滚：顺序是**存下来的**数据，不是界面状态。失败了还不退，
   * 用户看到的就是一个「下次刷新就变了」的假顺序，而且他不会知道要重来一次。
   */
  const reorder = async (resource, ids, applyLocal) => {
    const before = book
    setBook((current) => (current ? applyLocal(current) : current))
    try {
      await api.post(`/api/reorder/${resource}`, { ids })
    } catch (err) {
      setBook(before)
      toastErr(err)
    }
  }

  /**
   * 把 `list` 里符合 `match` 的那些元素，按 `orderedIds` 的顺序填回**原来的位置**。
   *
   * 大类那一份是**所有游戏混在一起**的扁平数组（服务端按 sort_order 出，界面再按
   * 游戏分组）。所以「重排某个游戏的大类」不能重排整个数组 —— 只能挑出这个游戏的
   * 那几个位置，把新顺序填回去，别的游戏的位置一动不动。
   *
   * 算法本身在 `./lib/sortable.js`（纯函数，冒烟测试直接 import 它）。
   */
  const reorderInPlace = reorderInPlacePure

  const reorderCategory = (group, orderedIds) => reorder('categories', orderedIds, (current) => ({
    ...current,
    categories: reorderInPlace(
      current.categories || [],
      (category) => String(category.game_id ?? '') === group.key,
      orderedIds,
    ),
  }))

  const reorderService = (category, orderedIds) => reorder('services', orderedIds, (current) => ({
    ...current,
    categories: (current.categories || []).map((item) => (
      item.id === category.id
        ? { ...item, services: reorderInPlace(item.services || [], () => true, orderedIds) }
        : item
    )),
  }))

  const createCategory = async (gameId = '') => { try { if (await openCategoryForm({}, data.games || [], gameId && gameId !== 'generic' ? gameId : null)) await onReload() } catch (err) { toastErr(err) } }
  const editCategory = async (category) => { try { if (await openCategoryForm(category, data.games || [])) await onReload() } catch (err) { toastErr(err) } }
  const newService = async (category) => {
    if (!category?.id) {
      toast('先建一个大类，服务项要挂在大类下面', 'err')
      return createCategory(activeGame)
    }
    try {
      if (await openServiceForm({ category_id: category.id, game_id: category.game_id || (activeGame !== 'generic' ? activeGame : '') }, { games: data.games || [], categories: data.categories || [] }, { quick: true })) await onReload()
    } catch (err) { toastErr(err) }
  }
  const editService = async (service) => { try { if (await openServiceForm(service, { games: data.games || [], categories: data.categories || [] })) await onReload() } catch (err) { toastErr(err) } }
  const peekContext = { meta: { games: data.games || [], categories: data.categories || [] }, app: { reload: () => {} } }
  const peekService = (service) => { try { openServicePeek(service, peekContext, { onChanged: onReload }) } catch (err) { toastErr(err) } }

  /**
   * 待添加的服务项：添加 / 删掉。
   *
   * 「添加」走的是**和手工「添加服务」完全一样的落库路径**（后端 acceptDraft），
   * 所以建出来的东西和手工建的没区别 —— 比价那边下次扫描就能匹上（别名带过去了）。
   *
   * 两个都做成一次一条、不并发：`busy` 挡住重复点击。批量走「全部添加」，
   * 那时后端一条条来，前端只等最后一次刷新。
   */
  const acceptDraft = async (draft) => {
    if (draftBusy) return
    setDraftBusy(true)
    try {
      const result = await api.post(`/api/service-drafts/${draft.id}/accept`, {})
      toast(result?.note ? `${draft.name} 已添加（${result.note}）` : `${draft.name} 已加进价格表`, 'ok')
      await onReload()
    } catch (err) { toastErr(err) } finally { setDraftBusy(false) }
  }
  const removeDraft = async (draft) => {
    if (draftBusy) return
    setDraftBusy(true)
    try {
      await api.del(`/api/service-drafts/${draft.id}`)
      toast(`「${draft.name}」不要了`, 'ok')
      await onReload()
    } catch (err) { toastErr(err) } finally { setDraftBusy(false) }
  }
  const acceptAllDrafts = async (list) => {
    if (draftBusy || !list.length) return
    setDraftBusy(true)
    let done = 0
    const failed = []
    try {
      // 一条条来而不是发一个批量接口：单条失败不该让整批回滚 ——
      // 20 项里有 1 项名字撞了，另外 19 项没理由不建。
      for (const draft of list) {
        try {
          await api.post(`/api/service-drafts/${draft.id}/accept`, {})
          done += 1
        } catch (err) {
          failed.push(`${draft.name}（${err?.message || '失败'}）`)
        }
      }
      if (done) toast(`加进去 ${done} 项`, 'ok')
      if (failed.length) toastErr(`${failed.length} 项没加上：${failed.slice(0, 3).join('、')}`)
      await onReload()
    } finally { setDraftBusy(false) }
  }
  const clearAllDrafts = async (list) => {
    if (draftBusy || !list.length) return
    if (!await confirmDelete({ title: `删掉这 ${list.length} 项待添加？`, message: '它们只是比价整理出来的草稿，删了不影响价格表里已有的服务项。' })) return
    setDraftBusy(true)
    // 逐条删、逐条算：中途失败时前面的已经删掉了，界面必须跟着刷新，
    // 否则用户看着还在、再点一次会对已删的 id 继续报错（旁边 acceptAllDrafts 就是这么做的）
    let done = 0
    const failed = []
    try {
      for (const draft of list) {
        try {
          await api.del(`/api/service-drafts/${draft.id}`)
          done += 1
        } catch (err) {
          failed.push(draft.name || draft.id)
          if (!failed.length || failed.length === 1) toastErr(err)
        }
      }
      if (done) toast(`删掉 ${done} 项待添加`, 'ok')
      if (failed.length) toastErr(`${failed.length} 项没删掉：${failed.slice(0, 3).join('、')}`)
    } finally {
      await onReload()
      setDraftBusy(false)
    }
  }

  const toggleCategory = async (category) => { try { await api.patch(`/api/categories/${category.id}`, { status: category.status === 'active' ? 'archived' : 'active' }); toast(category.status === 'active' ? '大类已归档' : '大类已恢复', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const deleteCategory = async (category) => { try { const usage = await api.get(`/api/categories/${category.id}/usage`); if (!await confirmDelete({ title: `删除「${category.name}」？`, message: usage.services ? `${usage.services} 个服务项会变成未分类，老订单不受影响。` : '这个大类没有服务项。' })) return; await api.del(`/api/categories/${category.id}`, { hard: 1 }); toast('大类已删除', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const toggleService = async (service) => { try { await api.patch(`/api/services/${service.id}`, { status: service.status === 'active' ? 'archived' : 'active' }); toast(service.status === 'active' ? '服务已归档' : '服务已恢复', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const deleteService = async (service) => { try { const usage = await api.get(`/api/services/${service.id}/usage`); if (!await confirmDelete({ title: `删除「${service.name}」？`, message: usage.order_items ? `${usage.order_items} 张订单使用过它，老订单快照不会改变。` : '这个服务还没有关联订单。' })) return; await api.del(`/api/services/${service.id}`, { hard: 1 }); toast('服务已删除', 'ok'); await onReload() } catch (err) { toastErr(err) } }
  const quickAddService = () => {
    if (!activeGame) {
      toast('请先选择一个游戏或通用价格表，再添加服务', 'err')
      return
    }
    // 搜索会把大类筛掉，但「添加服务」要的是「这个游戏下的大类」：
    // 只看筛过的 groups 的话，搜一个不命中任何大类的词再点添加服务，
    // 会莫名其妙弹出「新建大类」，而其实这个游戏下早就有大类了。
    const key = activeGame === 'generic' ? '' : activeGame
    const group = groups.find((item) => item.key === key)
    const category = group?.categories?.[0] || (data.categories || []).find((item) => String(item.game_id || '') === key)
    if (category) newService(category)
    else createCategory(activeGame)
  }

  // 全局搜索点「服务」会跳到 /price?s=<id>：把那条服务的详情抽屉直接打开。
  // （迁移之后这个参数没人认，点了等于什么都没发生。）
  // 等价格表取回来再开：抽屉里的「改价格和说明」要用到游戏和大类列表。
  const focusServiceId = route.query.get('s') || ''
  const openedServiceRef = useRef('')
  useEffect(() => {
    if (!focusServiceId) {
      openedServiceRef.current = ''
      return undefined
    }
    if (!book || openedServiceRef.current === focusServiceId) return undefined
    openedServiceRef.current = focusServiceId
    let active = true
    // 按 id 单独取：这条服务可能已经归档，不在当前这份价格表里
    api.get(`/api/services/${focusServiceId}/full`)
      .then((full) => {
        if (!active || !full || !full.service) return
        openServicePeek({ ...full.service, tiers: full.tiers || [], options: full.options || [] }, peekContext, { onChanged: onReload })
        // 参数用完就抹掉：留着的话再点一次同一个搜索结果地址没变，抽屉不会再开。
        // 走 ref：这个 effect 的依赖里没有 update，直接调会拿着**取数那一刻**的
        // query 去重建地址，把用户在这几百毫秒里改的筛选/搜索悄悄还原掉。
        updateRef.current({})
      })
      .catch((err) => {
        if (!active) return
        // 取失败也要把「开过了」的标记放掉，不然 s= 一直挂在地址上，
        // 同一个 id 再点一次地址没变、effect 也不再跑 —— 这个深链接就死了。
        openedServiceRef.current = ''
        toastErr(err)
      })
    return () => {
      active = false
    }
    // peekContext / update 每次渲染都是新的，故意不放进依赖（放进去会反复重开抽屉）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusServiceId, book])

  // 空状态要说清是「哪种空」：搜不到、这个筛选下没有、还是整个价格表都还是空的。
  // 一律写「还没有价格表」的话，点一下「通用」标签就会以为自己的价格表丢了。
  const emptyHint = query.q
    ? { title: '没有找到匹配的价格', note: '换个关键词试试。', action: '' }
    : activeGame
      ? { title: '这个筛选下还没有价格', note: '换个标签看看，或者就在这里新建一个大类。', action: 'category' }
      : { title: '还没有价格表', note: '先新建游戏，再建立大类和服务项。', action: 'game' }

  return (
    <div className="price-page">
      <header className="app-page__head price-page__head">
        <div className="app-page__title">
          <h1>价格表</h1>
          <p>{data.games.length} 个游戏 · {shownCategoryCount} 个大类 · {shownServiceCount} 个服务项</p>
        </div>
        <div className="app-page__actions price-page__head-actions"><button className="refactor-button" type="button" onClick={() => openExporter(null, { games: data.games || [] })}><Copy {...iconProps(15)} />导出</button><button className="refactor-button" type="button" disabled={!activeGameObj} title={activeGameObj ? `去 B站 搜「${activeGameObj.name} 代肝 价格表」的视频，认出价格后取中位数给你确认` : '先在上面选中一个游戏，比价是按游戏搜的'} onClick={() => openPriceScan(activeGameObj, { onApplied: () => onReload() })}><Sparkles {...iconProps(15)} />B站比价</button><button className="refactor-button" type="button" onClick={onNewGame}><Gamepad2 {...iconProps(15)} />新建价格表</button><button className="refactor-button" type="button" onClick={() => createCategory(activeGame)}><FolderPlus {...iconProps(15)} />新建大类</button><button className="refactor-button refactor-button--primary" type="button" onClick={quickAddService}><Plus {...iconProps(15)} />添加服务</button></div></header>
      <section className="price-toolbar"><div className="price-games"><button className={`price-game${!activeGame ? ' is-active' : ''}`} type="button" onClick={() => update({ game: '' })}>全部价格表</button>{data.games.map((game) => <button key={game.id} className={`price-game${activeGame === String(game.id) ? ' is-active' : ''}`} type="button" onClick={() => update({ game: String(game.id) })}>{game.name}</button>)}<button className={`price-game${activeGame === 'generic' ? ' is-active' : ''}`} type="button" onClick={() => update({ game: 'generic' })}>通用</button></div><div className="price-toolbar__spacer" /><div className="price-status" role="group" aria-label="价格状态"><button className={query.status === 'active' ? 'is-active' : ''} type="button" onClick={() => update({ status: 'active' })}>在架</button><button className={query.status === 'archived' ? 'is-active' : ''} type="button" onClick={() => update({ status: 'archived' })}>已归档</button><button className={query.status === 'all' ? 'is-active' : ''} type="button" onClick={() => update({ status: 'all' })}>全部</button></div><label className="price-search"><Search {...iconProps(15)} /><input type="search" value={search} placeholder="搜大类、服务或说明" onChange={(event) => { const value = event.target.value; setSearch(value); window.clearTimeout(searchTimer.current); searchTimer.current = window.setTimeout(() => updateRef.current({ q: value.trim() }), 260) }} /></label></section>
      {error ? <div className="refactor-alert" role="alert">{error}</div> : null}
      <section className="price-groups">{book === null ? <div className="refactor-loading"><span /><span /><span /></div> : groups.length ? groups.map((group) => <GroupWorkspace key={group.key || 'generic'} group={group} query={query} drafts={draftsOfGroup(group)} draftBusy={draftBusy} onNewCategory={createCategory} onService={newService} onEditCategory={editCategory} onSum={(cat) => openPriceSum(cat, cat.allServices || cat.services || [])} onToggleCategory={toggleCategory} onDeleteCategory={deleteCategory} onEditService={editService} onPeekService={peekService} onAdvancedService={peekService} onToggleService={toggleService} onDeleteService={deleteService} onAcceptDraft={acceptDraft} onDeleteDraft={removeDraft} onAcceptAllDrafts={acceptAllDrafts} onClearAllDrafts={clearAllDrafts} onReorderCategory={reorderCategory} onReorderService={reorderService} />) : <div className="price-empty"><Layers3 {...iconProps(24)} /><b>{emptyHint.title}</b><span>{emptyHint.note}</span>{emptyHint.action === 'game' ? <button className="refactor-button refactor-button--primary" type="button" onClick={onNewGame}><Plus {...iconProps(15)} />新建价格表</button> : null}{emptyHint.action === 'category' ? <button className="refactor-button refactor-button--primary" type="button" onClick={() => createCategory(activeGame)}><Plus {...iconProps(15)} />新建大类</button> : null}</div>}</section>
    </div>
  )
}
