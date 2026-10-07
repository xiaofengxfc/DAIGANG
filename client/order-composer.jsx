import React, { useEffect, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { PRICE_TYPE_LABEL, api } from './lib/api.js'
import { fmtDate, fmtMoney, fmtQty, remainInfo, todayStr } from './lib/formatters.js'
import {
  addDays,
  calcPicked,
  dailyPlan,
  defaultUnit,
  gainSum,
  svcIsDaily,
  unitPriceFor,
} from '../shared/order-calc.js'
import { toast, toastErr } from './app/toast-store.js'
import Drawer from './app/drawer.jsx'
import { openCustomerForm } from './customer-form.jsx'
import { openOverlay } from './app/overlay-host.jsx'

/* ============================================================
   开单台（React 版）
   ============================================================

   原来是 public/js/views/orders.js 里的 openComposer()，那一大段是
   整个应用的正身：选客户、挑服务、改数量改价、勾增项、算钱、自动填交付日期。

   调用方式保持原样（ctx 提供 navigate / onReload）：

     await openComposer({ navigate, onReload })                       // 开新单
     await openComposer({ navigate, onReload }, { existing: order })   // 改明细
     await openComposer({ navigate, onReload }, { presetCustomer: id })

   钱的口径在 shared/order-calc.js，和服务端、旧开单台是同一份。
   旧的那份 openComposer 先留着：旧订单详情页（/orders/:id）的「改明细」还在用它，
   等详情页也搬过来再删。
   ============================================================ */

const FORM_ID = 'order-composer'

export async function openOrderComposer(ctx, { existing = null, presetCustomer = null } = {}) {
  const [book, custRes, gameRes] = await Promise.all([
    api.get('/api/pricebook'),
    api.get('/api/customers', { status: 'active', limit: 500 }),
    api.get('/api/games', { status: 'active' }),
  ])

  const customers = custRes.items || []
  const games = gameRes.items || []
  const allServices = []
  for (const cat of book.categories || []) {
    // _catDaily / _catGameId 带上大类的信息：服务项自己没设时要用它兜底
    for (const service of cat.services || []) {
      allServices.push({ ...service, _catName: cat.name, _catId: cat.id, _catDaily: cat.is_daily, _catGameId: cat.game_id })
    }
  }
  for (const service of book.loose || []) {
    allServices.push({ ...service, _catName: '未分类', _catId: 0, _catDaily: false, _catGameId: service.game_id })
  }
  const servicesById = new Map(allServices.map((service) => [service.id, service]))
  // 货币名字配在游戏上
  const gameById = new Map((book.games || []).map((game) => [String(game.id), game]))

  // 改单时：把原来的明细填回勾选状态。
  // 指向的服务项已经不在价格表里（比如报价单转来的单）就改不了，原样保留。
  const initialPicked = {}
  const unmappable = []
  if (existing) {
    for (const item of existing.items || []) {
      const service = servicesById.get(item.ref_id)
      if (service) {
        initialPicked[service.id] = {
          quantity: item.quantity,
          unitPrice: item.snapshot?.price_overridden ? item.unit_price : '',
          optionIds: (item.snapshot?.addons || []).map((addon) => addon.id),
        }
      } else {
        unmappable.push(item)
      }
    }
  }

  return openOverlay(
    (close) => (
      <OrderComposer
        ctx={ctx}
        close={close}
        existing={existing}
        presetCustomer={presetCustomer}
        customers={customers}
        games={games}
        categories={book.categories || []}
        allServices={allServices}
        servicesById={servicesById}
        gameById={gameById}
        initialPicked={initialPicked}
        unmappable={unmappable}
      />
    ),
    existing ? `order-composer-${existing.id}` : 'order-composer'
  )
}

/**
 * 路由 /orders/new 用：进来就开一张新单，关掉就回订单列表。
 * 和旧版一样 —— 底下垫着订单列表，抽屉浮在上面。
 */
export function OrderComposerRoute({ navigate, onReload }) {
  useEffect(() => {
    let alive = true
    openOrderComposer({ navigate, onReload })
      .then((saved) => {
        // 开成功了开单台自己会跳去新单详情，这里只处理「用户关掉了没开」的情况
        if (alive && !saved) navigate('/orders')
      })
      .catch((err) => toastErr(err))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

function OrderComposer({
  ctx,
  close,
  existing,
  presetCustomer,
  customers: initialCustomers,
  games,
  categories,
  allServices,
  servicesById,
  gameById,
  initialPicked,
  unmappable,
}) {
  const [customers, setCustomers] = useState(initialCustomers)
  const [picked, setPicked] = useState(initialPicked)
  const [form, setForm] = useState(() => ({
    customer_id: existing ? String(existing.customer_id) : presetCustomer ? String(presetCustomer) : '',
    ordered_at: existing ? fmtDate(existing.ordered_at) : todayStr(),
    due_at: existing && existing.due_at ? fmtDate(existing.due_at) : '',
    title: existing?.title || '',
    note: existing?.note || '',
    internal_note: existing?.internal_note || '',
    discount: String(existing?.discount ?? 0),
    platform_fee: String(existing?.platform_fee ?? 0),
    cost: String(existing?.cost ?? 0),
  }))
  const [query, setQuery] = useState('')
  const [gameFilter, setGameFilter] = useState('')
  const [catFilter, setCatFilter] = useState('')
  // 用户自己动过交付日期就撒手不管；清空 = 交回给自动
  const [dueTouched, setDueTouched] = useState(Boolean(existing?.due_at))
  const [dueAuto, setDueAuto] = useState({ days: 0, name: '' })
  const [busy, setBusy] = useState(false)

  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  /* ============================================================
     这一单是哪个（哪些）游戏 —— 由**挑中的服务项**推出来，不用手选。
     ============================================================

     以前开单台上有个「游戏」下拉，但它其实只管存进订单、并不过滤服务项；
     真正过滤的是挑服务区那个「按游戏筛选」。两个控件各管一半，于是：
       · 以为选了游戏就能只看到那个游戏的服务 —— 结果列表没变（用户报的就是这个）；
       · 一张单里混了两个游戏的服务时，订单头上的游戏只能写一个（或者空着），
         进度里该记哪套资源也说不清。
     现在明细说了算：一个游戏就写它，多个就拼成「鸣潮 + 异环」，
     一张单想混几个游戏就混几个。
     ============================================================ */
  const pickedGames = useMemo(() => {
    const out = []
    for (const id of Object.keys(picked)) {
      const service = servicesById.get(Number(id))
      if (!service) continue
      const gid = service.game_id || service._catGameId || ''
      if (!gid) continue
      const key = String(gid)
      if (out.some((g) => g.key === key)) continue
      out.push({ key, name: gameById.get(key)?.name || '' })
    }
    return out
  }, [picked, servicesById, gameById])
  // 头上一行显示用：一个游戏写名字，多个拼起来，一个都没有就说还没挑
  const pickedGameText = pickedGames.length
    ? pickedGames.map((g) => g.name).filter(Boolean).join(' + ')
    : ''

  const pickableCats = useMemo(() => {
    const withService = categories.filter((category) => category.services && category.services.length)
    if (!gameFilter) return withService
    const own = withService.filter((category) => String(category.game_id || '') === gameFilter)
    // 这个游戏一个大类都没有（服务项全挂在「通用」大类下）时，把通用大类带上，否则筛选框空着没法用
    return own.length ? own : withService.filter((category) => !category.game_id)
  }, [categories, gameFilter])

  // 大类列表完全由上面选的游戏决定；选中的大类被筛掉了就退回「全部大类」
  useEffect(() => {
    if (catFilter && !pickableCats.some((category) => String(category.id) === catFilter)) setCatFilter('')
  }, [pickableCats, catFilter])

  /**
   * 按游戏筛了之后**自动选大类**：一个游戏通常就一个大类（比如鸣潮一个、异环一个），
   * 这时候还让人再从下拉里挑一次纯属多余 —— 筛了游戏却还看着「全部大类」，
   * 就是用户说的「挑了游戏没自动选分类」。有好几个大类时才留给他自己选。
   */
  useEffect(() => {
    if (!gameFilter) return
    if (pickableCats.length === 1) setCatFilter(String(pickableCats[0].id))
    // 只在换游戏时自动选一次；之后用户自己改大类不要再被拽回去
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameFilter])

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const byCategory = new Map()
    for (const service of allServices) {
      if (!service.name) continue
      if (gameFilter && String(service.game_id || '') !== gameFilter && service.game_id) continue
      // 大类筛：跟搜索、游戏筛是「都要满足」的关系
      if (catFilter && String(service._catId || '') !== catFilter) continue
      if (keyword && !`${service.name} ${service.description} ${service._catName}`.toLowerCase().includes(keyword)) continue
      const key = service._catName || '未分类'
      if (!byCategory.has(key)) byCategory.set(key, [])
      byCategory.get(key).push(service)
    }
    return [...byCategory.entries()]
  }, [allServices, query, gameFilter, catFilter])

  /** 「星声 240」这种：从服务项上取 [货币名, 每个多少]；游戏没配货币名就是 null */
  const gainPair = (service) => {
    const raw = service?.currency_amount
    if (raw === null || raw === undefined || raw === '') return null
    const per = Number(raw)
    if (!Number.isFinite(per) || per <= 0) return null
    const gid = service.game_id || service._catGameId || ''
    const name = String(gameById.get(String(gid))?.currency || '').trim()
    return name ? [name, per] : null
  }
  const gainText = (service) => {
    const pair = gainPair(service)
    return pair ? `${pair[0]} ${fmtQty(pair[1])}` : ''
  }

  const { lines, subtotal, addons } = useMemo(() => calcPicked(picked, servicesById), [picked, servicesById])
  const discount = Math.max(0, Number(form.discount) || 0)
  const fee = Math.max(0, Number(form.platform_fee) || 0)
  const cost = Math.max(0, Number(form.cost) || 0)
  const total = Math.max(0, subtotal + addons - discount)
  // 这一单加起来能给客户拿到多少货币（数量算进去）
  const totalGain = gainSum(
    Object.entries(picked)
      .map(([id, sel]) => {
        const pair = gainPair(servicesById.get(Number(id)))
        return pair ? [pair[0], pair[1] * (Number(sel.quantity) || 1)] : null
      })
      .filter(Boolean)
  )
  const plan = useMemo(() => dailyPlan(picked, servicesById), [picked, servicesById])

  // 单子里有每天都做的服务项 → 交付日期按天数自动填。用户自己动过就不碰了。
  useEffect(() => {
    if (dueTouched) return
    const next = plan.days > 0 ? addDays(form.ordered_at, plan.days) : ''
    setDueAuto(plan.days > 0 ? plan : { days: 0, name: '' })
    setForm((current) => (current.due_at === next ? current : { ...current, due_at: next }))
  }, [dueTouched, plan, form.ordered_at])

  const remain = remainInfo(form.ordered_at, form.due_at)
  const pickedCount = Object.keys(picked).length

  function toggle(service) {
    setPicked((current) => {
      if (current[service.id]) {
        const next = { ...current }
        delete next[service.id]
        return next
      }
      return {
        ...current,
        [service.id]: {
          quantity: Number(service.min_qty) || 1,
          unitPrice: '',
          // 价格表里勾了「默认选中」的增项，开单时直接带上 ——
          // 不然每次都要手动补勾一遍，等于白设。
          optionIds: (service.options || []).filter((option) => option.default_selected).map((option) => option.id),
        },
      }
    })
  }

  function patchSelection(id, patch) {
    setPicked((current) => (current[id] ? { ...current, [id]: { ...current[id], ...patch } } : current))
  }

  function toggleOption(id, optionId, on) {
    setPicked((current) => {
      const sel = current[id]
      if (!sel) return current
      const ids = new Set(sel.optionIds)
      if (on) ids.add(optionId)
      else ids.delete(optionId)
      return { ...current, [id]: { ...sel, optionIds: [...ids] } }
    })
  }

  async function addCustomer() {
    const created = await openCustomerForm()
    if (!created) return
    setCustomers((current) => [...current, created])
    set('customer_id')(String(created.id))
  }

  async function submit() {
    if (!pickedCount) {
      toast('还没挑服务项', 'err')
      return
    }
    if (!form.customer_id) {
      toast('先选客户，或者点「新客户」建一个', 'err')
      document.getElementById('composer-customer')?.focus()
      return
    }

    const editableById = new Map(
      Object.entries(picked).map(([id, sel]) => [
        Number(id),
        {
          service_id: Number(id),
          quantity: Number(sel.quantity) || 1,
          option_ids: [...sel.optionIds],
          unit_price: sel.unitPrice === '' ? undefined : Number(sel.unitPrice),
        },
      ])
    )

    // 拼出这次要保存的明细，顺序尽量跟原来一致：
    //   · 原来就有、现在还能改的 → 用新填的值
    //   · 原来就有、服务项已经没了的 → 带 keep_id 原样保留（服务端从库里读，不重算）
    //   · 原来有但现在被取消勾选的 → 不带，等于删掉
    //   · 这次新挑的 → 追加到最后
    const items = []
    const usedIds = new Set()
    if (existing) {
      const unmappableIds = new Set(unmappable.map((item) => item.id))
      for (const item of existing.items || []) {
        if (unmappableIds.has(item.id)) {
          items.push({ keep_id: item.id })
          continue
        }
        const editable = editableById.get(item.ref_id)
        if (editable) {
          items.push(editable)
          usedIds.add(item.ref_id)
        }
      }
    }
    for (const [id, payloadItem] of editableById) {
      if (!usedIds.has(id)) items.push(payloadItem)
    }

    const payload = {
      customer_id: Number(form.customer_id),
      // 游戏**不发了**：服务端按 items 里的服务项自己推。
      // 以前这里发的是那个手选的下拉值，和服务项实际属于哪个游戏可以完全无关。
      title: form.title,
      discount,
      platform_fee: fee,
      cost,
      ordered_at: form.ordered_at,
      due_at: form.due_at || null,
      note: form.note,
      internal_note: form.internal_note,
      // 明细一律发出去 —— 改不了的用 keep_id 让服务端原样保留，
      // 这样其它明细的改动才存得下来。
      items,
    }

    setBusy(true)
    try {
      const saved = existing ? await api.patch(`/api/orders/${existing.id}`, payload) : await api.post('/api/orders', payload)
      if (existing && unmappable.length) toast('单据已更新（那几条改不了的明细原样保留）', 'ok', 3400)
      else toast(existing ? '单据已更新' : `开单成功 · ${saved.order_no}`, 'ok')
      close(saved)
      if (!existing && ctx && ctx.navigate) ctx.navigate(`/orders/${saved.id}`)
      else if (ctx && ctx.onReload) ctx.onReload()
    } catch (err) {
      toastErr(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title={existing ? `改单 · ${existing.order_no}` : '开一张新单'}
      subtitle={existing ? '改完会重算金额并替换明细快照' : '选客户、挑服务，价格自动算'}
      wide
      onClose={() => close(null)}
      footer={
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flex: '1' }}>
            <span className="sm dim">合计</span>
            <span className="quote-sheet__totalfig">{`¥${fmtMoney(total)}`}</span>
          </div>
          <button className="btn" type="button" onClick={() => close(null)}>
            取消
          </button>
          <button className="btn btn--primary" type="submit" form={FORM_ID} disabled={busy} data-loading={busy ? '1' : undefined}>
            {existing ? '保存改动' : '开单'}
          </button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <div className="stack">
          <div className="formgrid">
            <div className="field">
              <label className="lbl" htmlFor="composer-customer">
                客户<span className="req">*</span>
              </label>
              {/* nowrap + 让 select 自己缩：不然 select 的 width:100% 会把「新客户」挤到下一行 */}
              <div className="cluster" style={{ gap: '6px', flexWrap: 'nowrap' }}>
                <div style={{ flex: '1 1 auto', minWidth: '0' }}>
                  <select id="composer-customer" className="sel" value={form.customer_id} onChange={(event) => set('customer_id')(event.target.value)}>
                    <option value="">— 选客户 —</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={String(customer.id)}>
                        {`${customer.name}${customer.phone ? ` · ${customer.phone}` : ''}`}
                      </option>
                    ))}
                  </select>
                </div>
                <button className="btn btn--sm" type="button" onClick={addCustomer}>
                  <Plus size={14} strokeWidth={1.8} absoluteStrokeWidth aria-hidden />
                  新客户
                </button>
              </div>
            </div>

            <div className="field">
              <span className="lbl">游戏</span>
              {/* 不是下拉：游戏由下面挑的服务项推出来，改不了（也不需要改） */}
              <div className="inp" style={{ display: 'flex', alignItems: 'center', gap: '6px' }} data-testid="composer-games">
                {pickedGameText ? (
                  <>
                    <span>{pickedGameText}</span>
                    {pickedGames.length > 1 ? <span className="tiny dim">{`混了 ${pickedGames.length} 个游戏`}</span> : null}
                  </>
                ) : (
                  <span className="dim">挑了服务项自动填</span>
                )}
              </div>
              <div className="hint">按挑中的服务项自动推，可以混着挑多个游戏的服务。</div>
            </div>

            <div className="field">
              <label className="lbl" htmlFor="composer-ordered-at">
                下单日期
              </label>
              <input id="composer-ordered-at" className="inp" type="date" value={form.ordered_at} onChange={(event) => set('ordered_at')(event.target.value)} />
            </div>

            <div className="field">
              <label className="lbl" htmlFor="composer-due-at">
                交付日期
              </label>
              <input
                id="composer-due-at"
                className="inp"
                type="date"
                value={form.due_at}
                onChange={(event) => {
                  // 用户动过就以他填的为准；清空则回到自动。
                  // 不管填没填，只要人动过，这个日期就不再是「自动填的」，提示必须撤掉。
                  setDueTouched(event.target.value !== '')
                  setDueAuto({ days: 0, name: '' })
                  set('due_at')(event.target.value)
                }}
              />
            </div>

            {/* 两个日期下面：还剩几天 */}
            <div className="field field--full">
              <div className={`remain${remain.kind === 'none' ? ' remain--none' : remain.kind === 'invalid' ? ' remain--bad' : ` remain--${remain.kind}`}`}>
                {remain.kind === 'none' ? (
                  form.due_at ? null : <span className="dim sm">填了交付日期，这里会算还剩几天</span>
                ) : remain.kind === 'invalid' ? (
                  <>
                    <span className="remain__big">交付日期比下单日期还早</span>
                    <span className="dim sm">{`下单到交付 ${remain.span} 天，检查一下`}</span>
                  </>
                ) : (
                  <>
                    <span className="remain__big">{remain.text}</span>
                    {/* 写「下单到交付 30 天」而不是「一共 31 天」：自动填的交付日期就是按服务项
                        的天数推出来的，这里再用「算头算尾」的 31 天，跟上面「30 天」自相矛盾。 */}
                    {remain.span !== null ? <span className="dim sm">{`下单到交付 ${remain.span} 天`}</span> : null}
                    {/* 说清楚这个日期是怎么来的，免得以为是手滑填错了 */}
                    {dueAuto.days > 0 ? (
                      <span className="dim sm">{`${dueAuto.name ? `按「${dueAuto.name}」` : ''}${dueAuto.days} 天自动填的，可以直接改`}</span>
                    ) : null}
                  </>
                )}
              </div>
            </div>

            <div className="field field--full">
              <label className="lbl" htmlFor="composer-title">
                订单标题
              </label>
              <input id="composer-title" className="inp" placeholder="不填就用服务名拼一个" value={form.title} onChange={(event) => set('title')(event.target.value)} />
            </div>
          </div>

          <div>
            <div className="sechead">
              <h3>挑服务</h3>
              <span className="sechead__note">勾上就进单子，数量可以改</span>
            </div>
          </div>

          <div className="cluster" style={{ marginBottom: '6px' }}>
            <input className="inp" type="search" placeholder="搜服务名…" value={query} onChange={(event) => setQuery(event.target.value)} />
            <select className="sel" style={{ width: 'auto', minWidth: '130px' }} aria-label="按游戏筛选" value={gameFilter} onChange={(event) => setGameFilter(event.target.value)}>
              <option value="">全部游戏</option>
              {games.map((game) => (
                <option key={game.id} value={String(game.id)}>
                  {game.name}
                </option>
              ))}
            </select>
            <select className="sel" style={{ width: 'auto', minWidth: '130px' }} aria-label="按大类筛选" value={catFilter} onChange={(event) => setCatFilter(event.target.value)}>
              <option value="">全部大类</option>
              {pickableCats.map((category) => (
                <option key={category.id} value={String(category.id)}>
                  {category.name}
                </option>
              ))}
            </select>
          </div>

          <div className="picker">
            <div className="picker__scroll">
              {groups.length ? (
                groups.map(([catName, list]) => (
                  <div className="pickgroup" key={catName}>
                    <div className="pickgroup__head">
                      <span className="pickgroup__name">{catName}</span>
                      <span className="pickgroup__n">{`${list.length} 项`}</span>
                    </div>
                    {list.map((service) => (
                      <ServiceRow
                        key={service.id}
                        service={service}
                        selection={picked[service.id]}
                        gain={gainText(service)}
                        onToggle={() => toggle(service)}
                        onQty={(raw) => {
                          const value = Number(raw)
                          const bad = raw.trim() !== '' && !Number.isFinite(value)
                          // 空着当 1（金额那边也是 || 1）；填了非数字就标红，并且按 0 存 ——
                          // 绝不能让 NaN 流进金额，那会把整单算成 ¥0 还存下去。
                          patchSelection(service.id, { quantity: raw.trim() === '' || bad ? 0 : value, qtyBad: bad })
                        }}
                        onPrice={(raw) => {
                          const value = Number(raw)
                          const bad = raw.trim() !== '' && !Number.isFinite(value)
                          // 填了非数字：标红，并且这一行退回「按基准单价算」。
                          patchSelection(service.id, { unitPrice: raw.trim() === '' || bad ? '' : value, priceBad: bad })
                        }}
                        onOption={(optionId, on) => toggleOption(service.id, optionId, on)}
                      />
                    ))}
                  </div>
                ))
              ) : (
                <div className="empty">
                  <div className="empty__body">没有匹配的服务项。</div>
                  <button className="btn btn--sm" type="button" onClick={() => ctx && ctx.navigate && ctx.navigate('/price')}>
                    去价格表加一个
                  </button>
                </div>
              )}
            </div>
            <div className="picker__foot">
              {pickedCount ? (
                <span className="cluster" style={{ gap: '6px' }}>
                  <span className="pickcount">{String(pickedCount)}</span>
                  <span>已选</span>
                </span>
              ) : (
                <span className="dim">还没勾服务项</span>
              )}
              <div style={{ flex: '1' }} />
              {pickedCount ? (
                <button className="btn btn--sm btn--quiet" type="button" onClick={() => setPicked({})}>
                  清空
                </button>
              ) : null}
            </div>
          </div>

          <div>
            <div className="sechead">
              <h3>金额</h3>
            </div>
          </div>

          <div className="formgrid">
            <div className="field">
              <label className="lbl" htmlFor="composer-discount">
                折扣（元）
              </label>
              <input id="composer-discount" className="inp inp--fig" inputMode="decimal" value={form.discount} onChange={(event) => set('discount')(event.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="composer-fee">
                平台手续费（元）
              </label>
              <input id="composer-fee" className="inp inp--fig" inputMode="decimal" value={form.platform_fee} onChange={(event) => set('platform_fee')(event.target.value)} />
            </div>
            <div className="field">
              <label className="lbl" htmlFor="composer-cost">
                成本（元）
              </label>
              <input id="composer-cost" className="inp inp--fig" inputMode="decimal" value={form.cost} onChange={(event) => set('cost')(event.target.value)} />
            </div>
          </div>

          <div className="stack stack--tight">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px 12px', fontSize: 'var(--fs-sm)' }}>
              <span className="dim">{`服务小计（${lines.length} 项）`}</span>
              <span className="num">{`¥${fmtMoney(subtotal)}`}</span>
              <span className="dim">增项合计</span>
              <span className="num">{`¥${fmtMoney(addons)}`}</span>
              <span className="dim">折扣</span>
              <span className="num tone-oxblood">{`−¥${fmtMoney(discount)}`}</span>
              <span className="dim">利润预估</span>
              <span className="num">{`¥${fmtMoney(total - fee - cost)}`}</span>
              {totalGain ? <span className="dim">可得</span> : null}
              {totalGain ? <span className="num">{totalGain}</span> : null}
            </div>
          </div>

          {unmappable.length ? (
            <div className="note note--warn">
              {`这张单有 ${unmappable.length} 条明细（${unmappable.map((item) => item.name).join('、')}）在价格表里已经找不到对应的服务项，多半是从报价单转过来的。` +
                '这几条在这里改不了，保存时会原样保留（不会被删掉，也不会被重算）。其它明细的改动照常保存。'}
            </div>
          ) : null}

          <div>
            <div className="sechead">
              <h3>备注</h3>
            </div>
          </div>

          <div className="field field--full">
            <label className="lbl" htmlFor="composer-note">
              给客户看的备注
            </label>
            <textarea id="composer-note" className="ta" rows={2} placeholder="给客户看的备注" value={form.note} onChange={(event) => set('note')(event.target.value)} />
          </div>
          <div className="field field--full">
            <label className="lbl" htmlFor="composer-inner-note">
              只有自己看得到的备注
            </label>
            <textarea id="composer-inner-note" className="ta" rows={2} placeholder="只有自己看得到的备注" value={form.internal_note} onChange={(event) => set('internal_note')(event.target.value)} />
          </div>

          <div className="note">提交后，服务名、单价、数量、套餐内容、增项会一起冻进这张单的快照里。之后你在价格表里怎么改价，这张单都不受影响。</div>
        </div>
      </form>
    </Drawer>
  )
}

/** 一行服务项：勾选框 + 名字/价格 + 数量/改价 + 增项 */
function ServiceRow({ service, selection, gain, onToggle, onQty, onPrice, onOption }) {
  const on = Boolean(selection)
  const quantity = selection ? selection.quantity : ''
  const unitPrice = selection && selection.unitPrice !== '' ? selection.unitPrice : ''
  const auto = unitPriceFor(service, service.tiers, Number(quantity) || 1)

  return (
    <div className={`pickrow${on ? ' pickrow--on' : ''}`}>
      <div className="pickrow__top">
        <input className="chk" type="checkbox" aria-label={`选择 ${service.name}`} checked={on} onChange={onToggle} />
        <button className="pickrow__main" type="button" onClick={onToggle}>
          <span className="pickrow__line">
            <span className="pickrow__name">{service.name}</span>
            {/* 能给客户拿到多少 —— 代肝卖的就是这个，挑的时候就摆在名字旁边 */}
            {gain ? <span className="pickrow__gain">{gain}</span> : null}
            {/* 价格常驻：不勾选也知道多少钱 */}
            <span className="pickrow__fig">
              {`¥${fmtMoney(service.base_price)}`}
              <em>{`/${defaultUnit(service)}`}</em>
            </span>
          </span>
          <span className="pickrow__meta">
            {[PRICE_TYPE_LABEL[service.price_type] || service.price_type, service.tiers?.length ? `${service.tiers.length} 档阶梯价` : null, service.description || null]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </button>
      </div>
      <div className="pickrow__ctrl" style={{ display: on ? '' : 'none' }}>
        <div className="cluster" style={{ gap: '6px' }}>
          <input
            className={`inp inp--fig${selection?.qtyBad ? ' is-bad' : ''}`}
            inputMode="decimal"
            style={{ width: '76px' }}
            aria-label={`${service.name} 数量`}
            value={quantity === '' ? '' : String(quantity)}
            onChange={(event) => onQty(event.target.value)}
          />
          <span className="dim tiny">{defaultUnit(service)}</span>
          <input
            className={`inp inp--fig${selection?.priceBad ? ' is-bad' : ''}`}
            inputMode="decimal"
            style={{ width: '86px' }}
            placeholder="改价"
            aria-label={`${service.name} 单价`}
            value={unitPrice === '' ? '' : String(unitPrice)}
            onChange={(event) => onPrice(event.target.value)}
          />
          <span className="dim tiny">元</span>
        </div>
      </div>
      <div className="pickrow__detail" style={{ display: on ? '' : 'none' }}>
        <div className="cluster" style={{ gap: '10px' }}>
          {(service.options || []).length ? (
            (service.options || []).map((option) => (
              <label className="inline" key={option.id} style={{ cursor: 'pointer', gap: '5px' }}>
                <input className="chk" type="checkbox" checked={(selection?.optionIds || []).includes(option.id)} onChange={(event) => onOption(option.id, event.target.checked)} />
                <span className="sm">{option.name}</span>
                <span className="dim tiny">{option.price_mode === 'percent' ? `+${option.price}%` : option.price ? `+${fmtMoney(option.price)}元` : '不加价'}</span>
              </label>
            ))
          ) : (
            <span className="dim tiny">这个服务项没有增项</span>
          )}
        </div>
        <span className="dim tiny">
          {on && Number(quantity) >= 1 ? `按 ${fmtQty(quantity)} ${defaultUnit(service)} 算，基准单价 ¥${fmtMoney(auto)}` : ''}
        </span>
      </div>
    </div>
  )
}
