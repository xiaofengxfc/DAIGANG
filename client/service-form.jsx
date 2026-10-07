import React, { useState } from 'react'
import { api, PRICE_TYPES } from './lib/api.js'
import { toast } from './app/toast-store.js'
import Drawer from './app/drawer.jsx'
import { Field, SelectInput, TagsInput, TextArea, TextInput } from './app/fields.jsx'
import { openOverlay } from './app/overlay-host.jsx'

/* ============================================================
   服务项表单（React 版）
   ============================================================

   原来是 public/js/views/price.js 里的 serviceForm() + gameCategoryField()。

     const saved = await openServiceForm(service, { games, categories }, { quick: true })
     if (saved) reload()

   两种形态（和旧版一致）：
     · quick  —— 从价格表「添加服务」进来，只填最常用的几项，
                 阶梯价 / 套餐增项 / 可获得货币留到详情抽屉里补；
     · 完整   —— 从服务行的「编辑服务」进来，13 个字段全在。

   游戏和大类两个下拉是**互相牵制**的（原来这里是两个各管各的 select，
   分类下拉会把所有游戏的分类全列出来，很容易选出「游戏=崩铁、分类=原神日常」
   这种自相矛盾的服务项）：
     · 改游戏 → 分类列表只留这个游戏的和通用的，原来选的大类清掉
     · 改分类 → 如果这个大类属于某个游戏，游戏自动跟着切过去
     · 打开表单时当前这条的大类永远保留在列表里，绝不因为筛选而把它悄悄丢掉
   ============================================================ */

const FORM_ID = 'service-form'

/** 校验失败要聚焦的那个框：默认按字段名拼 id，对不上的在这里点名 */
const FOCUS_ID = { currency_amount: 'service-currency' }

export function openServiceForm(values = {}, { games = [], categories = [] } = {}, { quick = false } = {}) {
  return openOverlay(
    (close) => <ServiceForm values={values} games={games} categories={categories} quick={quick} close={close} />,
    'service-form'
  )
}

function ServiceForm({ values, games, categories, quick, close }) {
  const isEdit = Boolean(values.id)
  const [form, setForm] = useState(() => ({
    name: values.name || '',
    game_id: values.game_id === null || values.game_id === undefined ? '' : String(values.game_id),
    category_id: values.category_id === null || values.category_id === undefined ? '' : String(values.category_id),
    price_type: values.price_type || 'fixed',
    unit_label: values.unit_label || '',
    base_price: values.base_price === null || values.base_price === undefined ? '' : String(values.base_price),
    min_qty: values.min_qty === null || values.min_qty === undefined || values.min_qty === '' ? '1' : String(values.min_qty),
    max_qty: values.max_qty === null || values.max_qty === undefined ? '' : String(values.max_qty),
    currency_amount: values.currency_amount === null || values.currency_amount === undefined ? '' : String(values.currency_amount),
    description: values.description || '',
    is_daily: values.is_daily === null || values.is_daily === undefined ? '' : String(values.is_daily),
    package_items: Array.isArray(values.package_items) ? values.package_items : [],
    status: values.status || 'active',
    note: values.note || '',
  }))
  const [errors, setErrors] = useState({})
  const [alert, setAlert] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  // 货币名字填在游戏上，这里只填数量。跟着**当前选中的**游戏走（而不是打开表单时的那一个），
  // 这样换游戏 / 换大类时标签上的「（星声）」会跟着变，不会指着一个已经换掉的游戏。
  const gameIdOf = form.game_id || categories.find((category) => String(category.id) === String(form.category_id))?.game_id || ''
  const currency = games.find((game) => String(game.id) === String(gameIdOf))?.currency || ''

  async function submit(event) {
    event.preventDefault()
    // 自定义块报的错（还没选大类）优先于其他校验 —— 和旧引擎的顺序一样
    if (!form.category_id) {
      setAlert('请先选一个大类。价格表的结构是：游戏 → 大类 → 服务项，服务项不能直接挂到游戏上。')
      return
    }
    const next = {}
    if (!String(form.name).trim()) next.name = '请填写服务名'
    if (String(form.base_price).trim() === '') next.base_price = '请填写基准单价'
    else if (!Number.isFinite(Number(form.base_price))) next.base_price = '请填数字'
    if (String(form.min_qty).trim() !== '' && !Number.isFinite(Number(form.min_qty))) next.min_qty = '请填数字'
    if (String(form.max_qty).trim() !== '' && !Number.isFinite(Number(form.max_qty))) next.max_qty = '请填数字'
    if (String(form.currency_amount).trim() !== '' && !Number.isFinite(Number(form.currency_amount))) next.currency_amount = '请填数字'
    setErrors(next)
    setAlert('')
    if (Object.keys(next).length) {
      // 「可获得货币」那个框的 id 是 service-currency（不是 service-currency_amount），
      // 照 key 直接拼会找不到元素、焦点不动。
      document.getElementById(FOCUS_ID[Object.keys(next)[0]] || `service-${Object.keys(next)[0]}`)?.focus()
      return
    }

    setBusy(true)
    try {
      const payload = {
        ...form,
        name: String(form.name).trim(),
        game_id: form.game_id || null,
        // 留空才算没填；填了 0 就存 0（以前 || 1 会把界面上的 0 悄悄变成 1）
        min_qty: String(form.min_qty).trim() === '' ? 1 : Number(form.min_qty),
        max_qty: form.max_qty === '' || form.max_qty === null ? null : Number(form.max_qty),
        // 留空 = 不显示，存 NULL（和「封顶量」一个规矩）
        currency_amount: form.currency_amount === '' || form.currency_amount === null ? null : Number(form.currency_amount),
      }
      const saved = isEdit ? await api.patch(`/api/services/${values.id}`, payload) : await api.post('/api/services/append', payload)
      toast('服务项已保存', 'ok')
      close(saved)
    } catch (err) {
      setAlert(err && err.message ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const fields = quick ? (
    <>
      <Field label="服务名" required htmlFor="service-name" error={errors.name}>
        <TextInput id="service-name" maxLength={120} value={form.name} onChange={set('name')} placeholder="例：每日委托 / 深渊 12 层 / 活动全包" aria-invalid={errors.name ? 'true' : undefined} />
      </Field>
      <GameCategoryFields games={games} categories={categories} gameId={form.game_id} categoryId={form.category_id} gameName={values.game_name || ''} categoryName={values.category_name || ''} onGame={set('game_id')} onCategory={set('category_id')} />
      <Field label="计价方式" required half htmlFor="service-price-type">
        <SelectInput id="service-price-type" value={form.price_type} onChange={set('price_type')} options={PRICE_TYPES} />
      </Field>
      <Field label="单位" half htmlFor="service-unit">
        <TextInput id="service-unit" maxLength={20} value={form.unit_label} onChange={set('unit_label')} placeholder="天 / 次 / 层 / 个 / 套" />
      </Field>
      <Field label="基准单价" required half suffix="元" htmlFor="service-base-price" error={errors.base_price}>
        <TextInput id="service-base-price" money value={form.base_price} onChange={set('base_price')} aria-invalid={errors.base_price ? 'true' : undefined} />
      </Field>
      <Field label="起订量" half htmlFor="service-min-qty" error={errors.min_qty}>
        <TextInput id="service-min-qty" numeric value={form.min_qty} onChange={set('min_qty')} />
      </Field>
      <Field label="说明（可选）" htmlFor="service-description">
        <TextArea id="service-description" rows={2} maxLength={2000} value={form.description} onChange={set('description')} placeholder="客户问到时需要说明的内容" />
      </Field>
    </>
  ) : (
    <>
      <Field label="服务名" required htmlFor="service-name" error={errors.name}>
        <TextInput id="service-name" maxLength={120} value={form.name} onChange={set('name')} placeholder="例：每日委托 / 深渊 12 层 / 活动全包" aria-invalid={errors.name ? 'true' : undefined} />
      </Field>
      <GameCategoryFields games={games} categories={categories} gameId={form.game_id} categoryId={form.category_id} gameName={values.game_name || ''} categoryName={values.category_name || ''} onGame={set('game_id')} onCategory={set('category_id')} />
      <Field label="计价方式" required half htmlFor="service-price-type" hint="按数量会自动用阶梯价（如果配了的话）">
        <SelectInput id="service-price-type" value={form.price_type} onChange={set('price_type')} options={PRICE_TYPES} />
      </Field>
      <Field label="单位" half htmlFor="service-unit">
        <TextInput id="service-unit" maxLength={20} value={form.unit_label} onChange={set('unit_label')} placeholder="天 / 次 / 层 / 个 / 套" />
      </Field>
      <Field label="基准单价" required half suffix="元" htmlFor="service-base-price" error={errors.base_price}>
        <TextInput id="service-base-price" money value={form.base_price} onChange={set('base_price')} aria-invalid={errors.base_price ? 'true' : undefined} />
      </Field>
      <Field label="起订量" half htmlFor="service-min-qty" error={errors.min_qty}>
        <TextInput id="service-min-qty" numeric value={form.min_qty} onChange={set('min_qty')} />
      </Field>
      <Field label="封顶量（留空不限）" half htmlFor="service-max-qty" error={errors.max_qty}>
        <TextInput id="service-max-qty" numeric value={form.max_qty} onChange={set('max_qty')} />
      </Field>
      <Field
        label="可获得货币"
        half
        suffix={currency}
        htmlFor="service-currency"
        error={errors.currency_amount}
        hint={
          currency
            ? `这个服务项能让客户拿到多少「${currency}」。留空就不显示。价格表图片 / Word 和详情里都会带上。`
            : '这个服务项能让客户拿到多少游戏货币。货币名字先去「游戏」里填，填了这里才显示得出来。留空就不显示。'
        }
      >
        <TextInput id="service-currency" numeric value={form.currency_amount} onChange={set('currency_amount')} placeholder="例：200" />
      </Field>
      <Field label="说明" htmlFor="service-description">
        <TextArea id="service-description" rows={3} maxLength={2000} value={form.description} onChange={set('description')} placeholder="客户问的时候你能直接念出来的一段话" />
      </Field>
      <Field label="每天都做" half htmlFor="service-is-daily" hint="默认跟着大类走 —— 往「日常」大类里加的服务项自动就算每天做">
        <SelectInput
          id="service-is-daily"
          value={form.is_daily}
          onChange={set('is_daily')}
          options={[
            { value: '', label: '跟随大类（推荐）' },
            { value: '1', label: '是，每天都做' },
            { value: '0', label: '否，一次性的' },
          ]}
        />
      </Field>
      <Field label="套餐包含内容" htmlFor="service-package-items" hint="套餐价 / 全包类服务用。逗号分隔，报价单上会逐条列出来。">
        <TagsInput id="service-package-items" value={form.package_items} onChange={set('package_items')} />
      </Field>
      <Field label="状态" half htmlFor="service-status">
        <SelectInput
          id="service-status"
          value={form.status}
          onChange={set('status')}
          options={[
            { value: 'active', label: '在架' },
            { value: 'archived', label: '已下架（老订单不受影响）' },
          ]}
        />
      </Field>
      <Field label="内部备注" half htmlFor="service-note">
        <TextInput id="service-note" value={form.note} onChange={set('note')} />
      </Field>
    </>
  )

  return (
    <Drawer
      title={isEdit ? '改服务项' : '快速添加服务'}
      wide
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>
            取消
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn--primary" type="submit" form={FORM_ID} disabled={busy}>
            {busy ? '保存中…' : quick ? '保存服务' : '保存'}
          </button>
        </>
      }
    >
      <form id={FORM_ID} noValidate onSubmit={submit}>
        <div className="stack">
          {quick ? <div className="hint">先录入客户最常用的信息；阶梯价、套餐、增项和可获得货币可在保存后从服务行的高级设置补充。</div> : null}
          <div className="formgrid">{fields}</div>
          {alert ? <div className="note note--alert">{alert}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}

/** 游戏 ↔ 大类 联动的那两个下拉（自定义块，占满一行） */
function GameCategoryFields({ games, categories, gameId, categoryId, gameName = '', categoryName = '', onGame, onCategory }) {
  // 只在打开表单时保留「当前这条」的大类（万一它和游戏对不上，也不能悄悄改掉它）。
  // 用户一旦手动换游戏，就不再保留 —— 否则换了游戏还看得到别的游戏的大类，很迷惑。
  const [keepCurrent, setKeepCurrent] = useState(Boolean(categoryId))

  const list = categories.filter((category) => {
    if (keepCurrent && categoryId && String(category.id) === String(categoryId)) return true
    if (category.status === 'archived') return false
    if (!gameId) return true
    return !category.game_id || String(category.game_id) === String(gameId)
  })

  // 原值不在候选里（游戏 / 大类被归档了）时，这两个裸 select 不会像 SelectInput 那样
  // 自己补一个「（原值：X）」的占位项 —— 那样浏览器会默认选中第一项，
  // 界面上看着已经是「通用 / 没选大类」，state 里却还是老的外键，一保存就对不上。
  const gameKnown = !gameId || games.some((game) => String(game.id) === String(gameId))
  const categoryKnown = Boolean(categoryId) && list.some((category) => String(category.id) === String(categoryId))

  return (
    // field--full 不能省：旧引擎对自定义块会补一个
    // （ui.js: `if (f.width !== 'half') node.classList.add('field--full')`），
    // 少了它这两个下拉就会挤进表单网格的一列里。
    <div className="row-2 field--full">
      <div className="field field--full">
        <label className="lbl" htmlFor="service-game">
          属于哪个游戏
        </label>
        <select
          id="service-game"
          className="sel"
          value={gameId}
          onChange={(event) => {
            onGame(event.target.value)
            // 换了游戏，原来选的大类未必属于这个游戏 —— 清掉重选，免得张冠李戴
            onCategory('')
            setKeepCurrent(false)
          }}
        >
          <option value="">通用（不属于某个游戏）</option>
          {gameKnown ? null : <option value={String(gameId)}>{gameName ? `${gameName}（已归档）` : `（原值：${gameId}）`}</option>}
          {games.map((game) => (
            <option key={game.id} value={String(game.id)}>
              {game.name}
            </option>
          ))}
        </select>
        <div className="hint">选「通用」表示这张价格表不绑游戏</div>
      </div>

      <div className="field field--full">
        <label className="lbl" htmlFor="service-category">
          放在哪个大类下<span className="req">*</span>
        </label>
        <select
          id="service-category"
          className="sel"
          value={categoryId}
          onChange={(event) => {
            const next = event.target.value
            onCategory(next)
            const picked = categories.find((category) => String(category.id) === next)
            // 大类属于某个游戏 → 游戏跟着大类走
            if (picked?.game_id && String(picked.game_id) !== String(gameId)) onGame(String(picked.game_id))
          }}
        >
          <option value="">{list.length ? '— 选一个大类 —' : '这个游戏下还没有大类'}</option>
          {categoryKnown || !categoryId ? null : <option value={String(categoryId)}>{categoryName ? `${categoryName}（已归档）` : `（原值：${categoryId}）`}</option>}
          {list.map((category) => {
            const foreign = category.game_id && String(category.game_id) !== String(gameId)
            return (
              <option key={category.id} value={String(category.id)}>
                {`${category.name}${category.game_name ? `（${category.game_name}）` : ''}${foreign ? ' ⚠' : ''}`}
              </option>
            )
          })}
        </select>
        <div className="hint">服务项必须挂在某个大类里。还没有大类就先去「新建分类」。</div>
      </div>
    </div>
  )
}
