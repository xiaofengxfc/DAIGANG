import React, { useRef, useState } from 'react'
import { api } from './lib/api.js'
import { todayStr } from './lib/formatters.js'
import { lastResourcesAfter } from '../shared/resources.js'
import { toast } from './app/toast-store.js'
import Drawer from './app/drawer.jsx'
import { Field, TagsInput, TextArea } from './app/fields.jsx'
import ResourceField from './resource-field.jsx'
import { takeFrameTokens, peekFrameTokens, dropFrameTokens } from './lib/screen-frames.js'
import { saveScreenshot } from './lib/screenshot.js'
import { openOverlay } from './app/overlay-host.jsx'

/* ============================================================
   记一条进度 / 改一条进度（React 版）
   ============================================================

   原来是 public/js/views/orderbits.js 里的 progressDrawer() / editProgressDrawer()。
   调用方式和旧的完全一样：

     progressDrawer(order, onReload)
     editProgressDrawer(progress, onReload)

   「做之前」的资源会带上一条的「做之后」—— 连着记的时候不用重抄。
   ============================================================ */

const NEW_FORM_ID = 'progress-form'
const EDIT_FORM_ID = 'progress-edit-form'

export async function openProgressForm(order, onDone) {
  // 连着记的时候，「做之前」直接带上一条的「做之后」。
  // 列表接口给的行是轻量的、不带 progress，所以这里补一次详情，
  // 否则从列表点进来永远带不上（旧版是从详情页点的，那边本来就有）。
  let full = order
  try {
    full = await api.get(`/api/orders/${order.id}`)
  } catch {
    full = order
  }
  const carried = lastResourcesAfter(full)
  return openOverlay(
    (close) => <ProgressForm order={full} carried={carried} onDone={onDone} close={close} />,
    `progress-form-${order.id}`
  )
}

/**
 * 改一条已记的进度。`game` 是这张单的游戏名 —— 用来决定资源字段显示哪几个
 * （异环比鸣潮多记甲硬币 / 方斯 / 环石 / 都市活力），不传就按默认那份来。
 * `games` 是这一单涉及的全部游戏（多游戏时资源按【游戏】分段各记一套）。
 */
export function openEditProgressForm(progress, onDone, game = '', games = []) {
  return openOverlay(
    (close) => <EditProgressForm progress={progress} game={game} games={games} onDone={onDone} close={close} />,
    `progress-edit-${progress.id}`
  )
}

function ProgressForm({ order, carried, onDone, close }) {
  const [form, setForm] = useState({ happened_on: todayStr(), content: '', media: [], note: '' })
  const [resources, setResources] = useState({ resources_before: carried || '', resources_after: '' })
  // 已经上传成功的截屏 URL：key 是帧 token，value 是上传后的 URL。
  // 提交失败重试时直接复用，不会因为「取走即删」把图丢掉，也不会重复上传。
  const shotUrlsRef = useRef(new Map())
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    if (!form.happened_on) next.happened_on = '请填写日期'
    if (!String(form.content).trim()) next.content = '请填写这次做了什么'
    setErrors(next)
    if (Object.keys(next).length) {
      document.getElementById(`progress-${Object.keys(next)[0]}`)?.focus()
      return
    }

    setBusy(true)
    setServerError('')
    const tokens = peekFrameTokens(order.id)
    try {
      // 「识别画面」认下来的截屏：取回原图 → 浏览器里压缩 → 上传，
      // 拿到 URL 后和手填的链接一起挂到这条进度的 media 上。
      // 时间线那边本来就会把 media 里的图片渲染出来、点开可下载，
      // 所以这一步做完，截图就真的留在这条进度里了。
      //
      // 注意这里是**两步**：先上传、再 POST 进度。而取帧接口是「取走即删」，
      // 所以不能一进来就把 token 桶清掉：只要 POST 失败（校验没过 / 后端 500 /
      // 断网），用户点重试时图和 token 就都没了，且全程没有提示。
      // 现在改成上传成功的 URL 记在 shotUrlsRef 里，重试直接复用；
      // 桶只在**提交成功之后**才 drop。
      const shotUrls = await uploadShots(tokens)
      const media = [...(form.media || []), ...shotUrls.filter(Boolean)]
      const saved = await api.post(`/api/orders/${order.id}/progress`, { ...form, media, ...resources })
      // 走到这里说明进度已经存下、截图也已经挂上去了，这时才清桶
      dropFrameTokens(order.id)
      shotUrlsRef.current.clear()
      toast(shotUrls.length ? `进度记下了，附了 ${shotUrls.length} 张截屏` : '进度记下了', 'ok')
      close(saved)
      if (onDone) onDone(saved)
    } catch (err) {
      setServerError(err && err.message ? err.message : '记不下这条进度')
    } finally {
      setBusy(false)
    }
  }

  /**
   * 逐张上传，并记住「token → URL」。
   * 提交失败重试时走缓存，不会再去取一次已经被删掉的帧。
   * 单张失败不抛（截图是锦上添花，不该挡住记进度）。
   */
  async function uploadShots(tokens) {
    const urls = []
    for (const token of tokens || []) {
      let url = shotUrlsRef.current.get(token)
      if (!url) {
        url = await saveScreenshot(token)
        if (url) shotUrlsRef.current.set(token, url)
      }
      if (url) urls.push(url)
    }
    return urls
  }

  return (
    <Drawer
      title="记一条进度"
      subtitle={`${order.order_no} · ${order.title || ''}`}
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>
            取消
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn--primary" type="submit" form={NEW_FORM_ID} disabled={busy}>
            {busy ? '记录中…' : '记下'}
          </button>
        </>
      }
    >
      <form id={NEW_FORM_ID} noValidate onSubmit={submit}>
        <div className="stack">
          <div className="hint">以后客户问“做到哪了”，直接把这条发给他就行。</div>
          <div className="formgrid">
            <Field label="日期" required half htmlFor="progress-happened-on" error={errors.happened_on}>
              <input
                id="progress-happened-on"
                name="happened_on"
                className="inp"
                type="date"
                value={form.happened_on}
                onChange={(event) => set('happened_on')(event.target.value)}
                aria-invalid={errors.happened_on ? 'true' : undefined}
              />
            </Field>

            <ResourceField
              before={carried || ''}
              beforeFrom={carried ? '上一条的「做之后」' : ''}
              game={order.game_name}
              games={(order.games || []).map((g) => g.name).filter(Boolean)}
              // 识别画面留下的截屏凭据按订单寄存（见 client/lib/screen-frames.js），
              // 提交时按这个 id 取回来挂到 media 上
              orderId={order.id}
              onChange={setResources}
            />

            <Field label="这次做了什么" required htmlFor="progress-content" error={errors.content}>
              <TextArea
                id="progress-content"
                name="content"
                rows={4}
                value={form.content}
                onChange={set('content')}
                aria-invalid={errors.content ? 'true' : undefined}
                placeholder="例：清完今日委托 + 派遣，深渊打到第 7 层"
              />
            </Field>

            <Field label="截图 / 录屏链接" htmlFor="progress-media" hint="把图床或相册链接粘进来，多个用逗号分隔。也可以先在别处截好图再贴链接。">
              <TagsInput id="progress-media" name="media" value={form.media} onChange={set('media')} />
            </Field>

            <Field label="备注" htmlFor="progress-note">
              <TextArea id="progress-note" name="note" rows={2} value={form.note} onChange={set('note')} placeholder="例：第 7 层差一颗星，明天补" />
            </Field>
          </div>

          {serverError ? <div className="note note--alert">{serverError}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}

function EditProgressForm({ progress, game = '', games = [], onDone, close }) {
  const [form, setForm] = useState({
    happened_on: progress.happened_on || '',
    content: progress.content || '',
    media: Array.isArray(progress.media) ? progress.media : [],
    note: progress.note || '',
  })
  const [resources, setResources] = useState({
    resources_before: progress.resources_before || '',
    resources_after: progress.resources_after || '',
  })
  const [errors, setErrors] = useState({})
  const [serverError, setServerError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  async function submit(event) {
    event.preventDefault()
    const next = {}
    if (!form.happened_on) next.happened_on = '请填写日期'
    if (!String(form.content).trim()) next.content = '请填写这次做了什么'
    setErrors(next)
    if (Object.keys(next).length) {
      document.getElementById(`progress-edit-${Object.keys(next)[0]}`)?.focus()
      return
    }

    setBusy(true)
    setServerError('')
    try {
      const saved = await api.patch(`/api/progress/${progress.id}`, { ...form, ...resources })
      toast('已更新', 'ok')
      close(saved)
      if (onDone) onDone(saved)
    } catch (err) {
      setServerError(err && err.message ? err.message : '改不动这条进度')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Drawer
      title="改这条进度"
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>
            取消
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn--primary" type="submit" form={EDIT_FORM_ID} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <form id={EDIT_FORM_ID} noValidate onSubmit={submit}>
        <div className="stack">
          <div className="formgrid">
            <Field label="日期" required half htmlFor="progress-edit-happened-on" error={errors.happened_on}>
              <input
                id="progress-edit-happened-on"
                name="happened_on"
                className="inp"
                type="date"
                value={form.happened_on}
                onChange={(event) => set('happened_on')(event.target.value)}
                aria-invalid={errors.happened_on ? 'true' : undefined}
              />
            </Field>

            <ResourceField
              before={progress.resources_before || ''}
              after={progress.resources_after || ''}
              game={game}
              games={games}
              onChange={setResources}
            />

            <Field label="这次做了什么" required htmlFor="progress-edit-content" error={errors.content}>
              <TextArea
                id="progress-edit-content"
                name="content"
                rows={4}
                value={form.content}
                onChange={set('content')}
                aria-invalid={errors.content ? 'true' : undefined}
              />
            </Field>

            <Field label="截图链接" htmlFor="progress-edit-media">
              <TagsInput id="progress-edit-media" name="media" value={form.media} onChange={set('media')} />
            </Field>

            <Field label="备注" htmlFor="progress-edit-note">
              <TextArea id="progress-edit-note" name="note" rows={2} value={form.note} onChange={set('note')} />
            </Field>
          </div>

          {serverError ? <div className="note note--alert">{serverError}</div> : null}
        </div>
      </form>
    </Drawer>
  )
}
