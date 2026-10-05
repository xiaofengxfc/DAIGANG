import React, { useMemo, useState } from 'react'
import { Copy, Quote } from 'lucide-react'
import { PRICE_TYPE_LABEL, api } from './lib/api.js'
import { fmtMoney, fmtQty } from './lib/formatters.js'
import { defaultUnit, unitPriceFor } from '../shared/order-calc.js'
import { toast, toastErr } from './app/toast-store.js'
import Drawer from './app/drawer.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { copyText } from './lib/dom.js'

/* ============================================================
   做报价单（React 版）
   ============================================================

   原来是 public/js/views/quotes.js 里的 openQuoteComposer()：勾服务 → 实时长出一张
   报价单 → 复制成文字发微信。和开单台是一对表兄弟，只是这边不落订单、只落一张报价单。

   调用方式跟旧版一致：

     await openQuoteComposer({ navigate, onReload })
     await openQuoteComposer({ navigate, onReload }, { existing: quote })

   钱的口径同样走 shared/order-calc.js。
   ============================================================ */

const iconProps = (size) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })
const FORM_ID = 'quote-composer'

export async function openQuoteComposer(ctx, { existing = null } = {}) {
  const [book, custRes, gameRes] = await Promise.all([
    api.get('/api/pricebook'),
    api.get('/api/customers', { status: 'active', limit: 500 }),
    api.get('/api/games', { status: 'active' }),
  ])

  const allServices = []
  for (const category of book.categories || []) {
    for (const service of category.services || []) allServices.push({ ...service, _cat: category.name, _catId: category.id })
  }
  for (const service of book.loose || []) allServices.push({ ...service, _cat: '未分类', _catId: 0 })

  const initialPicked = {}
  for (const item of existing?.items || []) {
    const service = allServices.find((candidate) => candidate.id === item.ref_id)
    if (service) {
      initialPicked[service.id] = {
        quantity: item.quantity,
        unitPrice: item.snapshot?.price_overridden ? item.unit_price : '',
        optionIds: (item.snapshot?.addons || []).map((addon) => addon.id),
      }
    }
  }

  return openOverlay(
    (close) => (
      <QuoteComposer
        ctx={ctx}
        close={close}
        existing={existing}
        customers={custRes.items || []}
        games={gameRes.items || []}
        categories={book.categories || []}
        allServices={allServices}
        initialPicked={initialPicked}
      />
    ),
    existing ? `quote-composer-${existing.id}` : 'quote-composer'
  )
}

function QuoteComposer({ ctx, close, existing, customers, games, categories, allServices, initialPicked }) {
  const [picked, setPicked] = useState(initialPicked)
  const [title, setTitle] = useState(existing?.title || '代肝报价单')
  const [note, setNote] = useState(existing?.note || '')
  const [validUntil, setValidUntil] = useState(existing?.valid_until || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10))
  const [customerId, setCustomerId] = useState(existing?.customer_id ? String(existing.customer_id) : '')
  const [gameId, setGameId] = useState(existing?.game_id ? String(existing.game_id) : '')
  const [query, setQuery] = useState('')
  const [catFilter, setCatFilter] = useState('')
  const [showText, setShowText] = useState(false)
  const [busy, setBusy] = useState(false)

  const pickableCats = useMemo(() => {
    const withService = categories.filter((category) => category.services && category.services.length)
    if (!gameId) return withService
    const own = withService.filter((category) => String(category.game_id || '') === gameId)
    // 这个游戏一个大类都没有（服务项全挂在「通用」大类下）时，把通用大类带上
    return own.length ? own : withService.filter((category) => !category.game_id)
  }, [categories, gameId])

  const effectiveCat = pickableCats.some((category) => String(category.id) === catFilter) ? catFilter : ''

  const groups = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    const byCategory = new Map()
    for (const service of allServices) {
      if (effectiveCat && String(service._catId || '') !== effectiveCat) continue
      if (keyword && !`${service.name} ${service.description} ${service._cat}`.toLowerCase().includes(keyword)) continue
      if (!byCategory.has(service._cat)) byCategory.set(service._cat, [])
      byCategory.get(service._cat).push(service)
    }
    return [...byCategory.entries()]
  }, [allServices, query, effectiveCat])

  /** 勾好的服务项算一遍：每行的单价、增项、小计，以及合计 */
  const sheet = useMemo(() => {
    const lines = []
    let total = 0
    for (const [id, selection] of Object.entries(picked)) {
      const service = allServices.find((candidate) => String(candidate.id) === String(id))
      if (!service) continue
      const qty = Number(selection.quantity) || 1
      const unit = selection.unitPrice === '' ? unitPriceFor(service, service.tiers, qty) : Number(selection.unitPrice)
      let amount = unit * qty
      const addons = []
      for (const option of service.options || []) {
        if (!(selection.optionIds || []).includes(option.id)) continue
        amount += option.price_mode === 'percent' ? (amount * Number(option.price)) / 100 : Number(option.price)
        addons.push(`${option.name}${option.price_mode === 'percent' ? ` +${option.price}%` : option.price ? ` +${fmtMoney(option.price)}元` : ''}`)
      }
      total += amount
      lines.push({ service, qty, unit, amount, addons })
    }
    return { lines, total }
  }, [picked, allServices])

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
          // 价格表里勾了「默认选中」的增项直接带上，跟开单台一个规矩
          optionIds: (service.options || []).filter((option) => option.default_selected).map((option) => option.id),
        },
      }
    })
  }

  const patch = (id, values) => setPicked((current) => (current[id] ? { ...current, [id]: { ...current[id], ...values } } : current))

  function toggleOption(id, optionId, on) {
    setPicked((current) => {
      const selection = current[id]
      if (!selection) return current
      const ids = new Set(selection.optionIds)
      if (on) ids.add(optionId)
      else ids.delete(optionId)
      return { ...current, [id]: { ...selection, optionIds: [...ids] } }
    })
  }

  function buildText() {
    const out = [`【${title || '代肝报价单'}】`]
    const customer = customers.find((item) => String(item.id) === customerId)
    const game = games.find((item) => String(item.id) === gameId)
    if (customer) out.push(`客户：${customer.name}`)
    if (game) out.push(`游戏：${game.name}`)
    out.push('————————————')
    sheet.lines.forEach((line, index) => {
      out.push(`${index + 1}. ${line.service.name}`)
      out.push(`   ${fmtMoney(line.unit)} 元/${defaultUnit(line.service)} × ${fmtQty(line.qty)} = ${fmtMoney(line.amount)} 元`)
      if (line.addons.length) out.push(`   含：${line.addons.join('、')}`)
      if (line.service.description) out.push(`   说明：${line.service.description}`)
    })
    out.push('————————————')
    out.push(`合计：${fmtMoney(sheet.total)} 元`)
    if (note) out.push(`备注：${note}`)
    if (validUntil) out.push(`有效期至：${validUntil}`)
    return out.join('\n')
  }

  async function copyAll() {
    if (!sheet.lines.length) {
      toast('还没勾服务项', 'err')
      return
    }
    const ok = await copyText(buildText())
    toast(ok ? '报价单文字已复制，去微信粘吧' : '复制失败，可以手动框选文字版', ok ? 'ok' : 'err', 2600)
  }

  async function save() {
    if (!pickedCount) {
      toast('至少勾一个服务项', 'err')
      return
    }
    const items = Object.entries(picked).map(([id, selection]) => ({
      service_id: Number(id),
      quantity: Number(selection.quantity) || 1,
      option_ids: [...(selection.optionIds || [])],
      unit_price: selection.unitPrice === '' ? undefined : Number(selection.unitPrice),
    }))
    const payload = {
      customer_id: customerId ? Number(customerId) : null,
      game_id: gameId ? Number(gameId) : null,
      title,
      items,
      note,
      valid_until: validUntil || null,
    }
    setBusy(true)
    try {
      const saved = existing ? await api.patch(`/api/quotes/${existing.id}`, payload) : await api.post('/api/quotes', payload)
      toast('报价单已保存', 'ok')
      close(saved)
      if (ctx && ctx.onReload) ctx.onReload()
    } catch (err) {
      toastErr(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      wide
      title={existing ? `改报价单 · ${existing.quote_no}` : '做一张报价单'}
      subtitle="勾服务 → 算钱 → 复制文字发微信"
      onClose={() => close(null)}
      footer={
        <>
          <div style={{ flex: '1' }} />
          <button className="btn" type="button" onClick={() => close(null)}>关闭</button>
          <button className="btn" type="button" onClick={copyAll}><Copy {...iconProps(14)} />复制文字</button>
          <button className="btn btn--primary" type="submit" form={FORM_ID} disabled={busy} data-loading={busy ? '1' : undefined}>
            {existing ? '保存改动' : '存成报价单'}
          </button>
        </>
      }
    >
      <form
        id={FORM_ID}
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
      >
        <div className="stack">
          <div className="formgrid">
            <div className="field field--full">
              <label className="lbl" htmlFor="quote-title">抬头</label>
              <input id="quote-title" className="inp" value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div className="field field--full">
              <label className="lbl" htmlFor="quote-customer">客户</label>
              <select id="quote-customer" className="sel" value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
                <option value="">— 不指定客户（先给路人报价）—</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={String(customer.id)}>{`${customer.name}${customer.phone ? ` · ${customer.phone}` : ''}`}</option>
                ))}
              </select>
            </div>
            <div className="field field--full">
              <label className="lbl" htmlFor="quote-game">游戏</label>
              <select id="quote-game" className="sel" value={gameId} onChange={(event) => setGameId(event.target.value)}>
                <option value="">— 不指定游戏 —</option>
                {games.map((game) => (
                  <option key={game.id} value={String(game.id)}>{game.name}</option>
                ))}
              </select>
            </div>
            <div className="field field--full">
              <label className="lbl" htmlFor="quote-valid">有效期至</label>
              <input id="quote-valid" className="inp" type="date" value={validUntil} onChange={(event) => setValidUntil(event.target.value)} />
            </div>
          </div>

          <div className="split">
            <div className="stack stack--tight">
              <div className="sechead">
                <h3>挑服务</h3>
                <span className="sechead__note">勾上就进单</span>
              </div>
              <div className="cluster" style={{ gap: '6px' }}>
                <input className="inp" type="search" placeholder="搜服务名…" value={query} onChange={(event) => setQuery(event.target.value)} />
                <select className="sel" style={{ width: 'auto', minWidth: '130px' }} aria-label="按大类筛选" value={effectiveCat} onChange={(event) => setCatFilter(event.target.value)}>
                  <option value="">全部大类</option>
                  {pickableCats.map((category) => (
                    <option key={category.id} value={String(category.id)}>{category.name}</option>
                  ))}
                </select>
              </div>
              <div className="picker">
                <div className="picker__scroll">
                  {!allServices.length ? (
                    <div className="empty">
                      <div className="empty__body">价格表还是空的。</div>
                      <button className="btn btn--sm" type="button" onClick={() => ctx && ctx.navigate && ctx.navigate('/price')}>先去建价格表</button>
                    </div>
                  ) : !groups.length ? (
                    <div className="empty">
                      <div className="empty__body">没有匹配的服务项。</div>
                      <button className="btn btn--sm" type="button" onClick={() => ctx && ctx.navigate && ctx.navigate('/price')}>去价格表看看</button>
                    </div>
                  ) : (
                    groups.map(([catName, list]) => (
                      <div className="pickgroup" key={catName}>
                        <div className="pickgroup__head">
                          <span className="pickgroup__name">{catName}</span>
                          <span className="pickgroup__n">{`${list.length} 项`}</span>
                        </div>
                        {list.map((service) => (
                          <QuoteServiceRow
                            key={service.id}
                            service={service}
                            selection={picked[service.id]}
                            onToggle={() => toggle(service)}
                            onQty={(raw) => patch(service.id, { quantity: Number(raw) || 0 })}
                            onPrice={(raw) => patch(service.id, { unitPrice: raw === '' ? '' : Number(raw) })}
                            onOption={(optionId, on) => toggleOption(service.id, optionId, on)}
                          />
                        ))}
                      </div>
                    ))
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
                    <button className="btn btn--sm btn--quiet" type="button" onClick={() => setPicked({})}>清空</button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="stack stack--tight">
              <div className="sechead">
                <h3>报价单</h3>
                <div style={{ flex: '1' }} />
                <button className="btn btn--sm" type="button" onClick={() => setShowText((value) => !value)}>
                  <Quote {...iconProps(14)} />
                  {showText ? '收起文字版' : '看文字版'}
                </button>
              </div>
              <div className="stack stack--tight">
                {sheet.lines.length ? (
                  <div className="quote-sheet">
                    <div className="quote-sheet__head">
                      <strong>{title || '代肝报价单'}</strong>
                      <div style={{ flex: '1' }} />
                      <span className="dim sm">{`有效期至 ${validUntil || '—'}`}</span>
                    </div>
                    <div className="quote-sheet__lines">
                      {sheet.lines.map((line) => (
                        <div className="qline" key={line.service.id}>
                          <div>
                            <div>{line.service.name}</div>
                            <div className="tbl__meta">{`${fmtMoney(line.unit)} 元/${defaultUnit(line.service)} × ${fmtQty(line.qty)} = ${fmtMoney(line.amount)} 元`}</div>
                            {line.addons.length ? <div className="tbl__meta">{`含 ${line.addons.join(' · ')}`}</div> : null}
                          </div>
                          <div className="qline__amt">{`¥${fmtMoney(line.amount)}`}</div>
                        </div>
                      ))}
                    </div>
                    <div className="quote-sheet__total">
                      <span>合计</span>
                      <span className="quote-sheet__totalfig">{`¥${fmtMoney(sheet.total)}`}</span>
                    </div>
                  </div>
                ) : (
                  <div className="empty">
                    <div className="empty__mark"><Quote {...iconProps(20)} /></div>
                    <div className="empty__title">右边勾几个服务项</div>
                    <p className="empty__body">报价单会实时长出来，右边这段文字可以直接复制发微信。</p>
                  </div>
                )}
              </div>
              {showText ? <pre className="plaintext">{buildText()}</pre> : null}
              <div className="field field--full">
                <label className="lbl" htmlFor="quote-note">备注</label>
                <textarea id="quote-note" className="ta" rows={2} placeholder="例：包月更划算；三个号同时做可再谈" value={note} onChange={(event) => setNote(event.target.value)} />
              </div>
            </div>
          </div>
        </div>
      </form>
    </Drawer>
  )
}

/** 报价单里的一行服务项：跟开单台比少了「可得」和阶梯提示，数量和改价更窄 */
function QuoteServiceRow({ service, selection, onToggle, onQty, onPrice, onOption }) {
  const on = Boolean(selection)
  return (
    <div className={`pickrow${on ? ' pickrow--on' : ''}`}>
      <div className="pickrow__top">
        <input className="chk" type="checkbox" aria-label={`选择 ${service.name}`} checked={on} onChange={onToggle} />
        <button className="pickrow__main" type="button" onClick={onToggle}>
          <span className="pickrow__line">
            <span className="pickrow__name">{service.name}</span>
            <span className="pickrow__fig">
              {`¥${fmtMoney(service.base_price)}`}
              <em>{`/${defaultUnit(service)}`}</em>
            </span>
          </span>
          <span className="pickrow__meta">
            {[PRICE_TYPE_LABEL[service.price_type] || service.price_type, service.description || null].filter(Boolean).join(' · ')}
          </span>
        </button>
      </div>
      <div className="pickrow__ctrl" style={{ display: on ? '' : 'none' }}>
        <div className="cluster" style={{ gap: '6px' }}>
          <input
            className="inp inp--fig"
            inputMode="decimal"
            style={{ width: '70px' }}
            aria-label={`${service.name} 数量`}
            value={selection ? String(selection.quantity) : ''}
            onChange={(event) => onQty(event.target.value)}
          />
          <span className="dim tiny">{defaultUnit(service)}</span>
          <input
            className="inp inp--fig"
            inputMode="decimal"
            style={{ width: '82px' }}
            placeholder="改价"
            aria-label={`${service.name} 单价`}
            value={selection && selection.unitPrice !== '' ? String(selection.unitPrice) : ''}
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
              </label>
            ))
          ) : (
            <span className="dim tiny">这个服务项没有增项</span>
          )}
        </div>
      </div>
    </div>
  )
}
