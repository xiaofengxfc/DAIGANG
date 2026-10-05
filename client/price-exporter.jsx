import React, { useEffect, useRef, useState } from 'react'
import { Download, FileText } from 'lucide-react'
import { api } from './lib/api.js'
import { toast, toastErr } from './lib/legacy-ui.js'
import Drawer from './app/drawer.jsx'
import { Field, SelectInput, TextInput } from './app/fields.jsx'
import { openOverlay } from './app/overlay-host.jsx'
import { canvasToBlob, downloadBlob, renderPriceCard } from '../public/js/pricecard.js'

/* ============================================================
   导出价格表（React 版）
   ============================================================

   原来是 public/js/views/price.js 里的 openExporter()。

     openExporter(ctx, { games })

   图片和 Word 都从服务端同一个「导出模型」生成，内容保证一致：
     · 图片 —— 在浏览器里用 canvas 画（public/js/pricecard.js），
                所以预览能直接给你看「发出去的就是这张」；
     · Word —— 直接下载服务端生成的 .docx（真实表格，阶梯价逐档列出）。

   默认「每个游戏各出一份」：发给客户时只发他那款游戏，不把几个游戏的价目
   混在同一张图 / 同一个文档里。导出会自动裁掉多余内容（空大类、超出条数的
   服务项），发微信和打印都好看。
   ============================================================ */

const iconProps = (size = 14) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

export function openExporter(ctx, { games = [] } = {}) {
  return openOverlay((close) => <PriceExporter games={games} close={close} />, 'price-exporter')
}

function PriceExporter({ games, close }) {
  const [scope, setScope] = useState('per-game')
  const [withDesc, setWithDesc] = useState(true)
  // null = 用户还没动过，用服务端给的默认值（也不往请求里塞这个参数）
  const [contact, setContact] = useState(null)
  const [footer, setFooter] = useState(null)
  const [contactText, setContactText] = useState('')
  const [footerText, setFooterText] = useState('')
  const [model, setModel] = useState(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [summary, setSummary] = useState('正在生成预览…')
  const [busy, setBusy] = useState('')

  // 每次刷新带一个号：慢的那次回来时如果已经不是最新的，就整个丢掉，
  // 不然快速改几个下拉会被旧结果盖回去。
  const tokenRef = useRef(0)

  const baseQuery = (extra) => {
    const query = { full: '1', format: 'full', with_desc: withDesc ? '1' : '0' }
    if (contact !== null) query.contact = contact
    if (footer !== null) query.footer = footer
    return { ...query, ...extra }
  }

  /** 这次导出会产出哪几份 */
  const targets = (source) => {
    if (!source) return []
    if (scope === 'merged') return [{ key: '', name: '', count: source.itemCount }]
    if (scope.startsWith('game:')) {
      const id = scope.slice(5)
      const one = (source.gameOptions || []).find((game) => game.key === id)
      return one ? [one] : []
    }
    return (source.gameOptions || []).slice()
  }

  const list = targets(model)

  async function refresh() {
    const token = ++tokenRef.current
    let all
    try {
      all = await api.get('/api/pricebook/export-model', baseQuery())
    } catch (err) {
      setSummary('预览生成失败：' + (err.message || ''))
      return
    }
    if (token !== tokenRef.current) return
    setModel(all)

    // 用户没改过的话，把服务端给的默认值回填进输入框
    if (contact === null) setContactText(all.contact || '')
    if (footer === null) setFooterText(all.footer || '')

    // 预览哪一份：合并就看全部；拆分就看第一份（一般就是第一个游戏）
    const jobs = targets(all)
    let preview = all
    let previewName = ''
    if (scope !== 'merged' && jobs.length) {
      const first = jobs[0]
      previewName = first.name
      if (first.key) {
        try {
          preview = await api.get('/api/pricebook/export-model', baseQuery({ game_id: first.key }))
        } catch {
          preview = all
        }
      }
    }
    if (token !== tokenRef.current) return

    let canvas
    try {
      canvas = renderPriceCard(preview, { scale: 1 })
    } catch (err) {
      setSummary('预览画不出来：' + (err.message || ''))
      return
    }
    setPreviewUrl(canvas.toDataURL('image/png'))

    const hidden = preview.hiddenServices + preview.hiddenCategories
    const parts = []
    if (scope === 'per-game') parts.push(jobs.length > 1 ? `会生成 ${jobs.length} 份，每个游戏一份（不混在一起）` : '会生成 1 份')
    else if (scope === 'merged') parts.push('会生成 1 份，所有游戏合在一起')
    else parts.push(`只导出「${previewName || preview.subtitle}」1 份`)
    parts.push(`本份预览：${preview.itemCount} 个服务项、${preview.groups.length} 个大类` + (hidden ? `，另有 ${hidden} 项没展开` : ''))
    setSummary(parts.join(' · '))
  }

  // 改选项 → 重新生成预览。输入联系方式/页脚时按住 220ms 再刷新，
  // 免得每敲一个字都画一遍 canvas。
  useEffect(() => {
    const timer = setTimeout(() => {
      refresh()
    }, 220)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, withDesc, contact, footer])

  const safeName = (text) => String(text || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)
  const fileName = (source, target, ext) => {
    const game = scope === 'merged' ? '' : target?.name || ''
    return `${safeName(source.shopName)}-${safeName(game || '价目表')}-${source.date}.${ext}`
  }

  /** 逐个游戏取模型；合并模式就取一次 */
  async function eachModel() {
    const jobs = targets(model)
    const out = []
    for (const target of jobs) {
      if (scope === 'merged') {
        out.push({ target, model })
      } else {
        const one = target.key ? await api.get('/api/pricebook/export-model', baseQuery({ game_id: target.key })) : model
        out.push({ target, model: one })
      }
    }
    return out
  }

  async function exportImages() {
    if (!model) return
    setBusy('img')
    try {
      const jobs = await eachModel()
      if (!jobs.length) return
      let count = 0
      for (const job of jobs) {
        const canvas = renderPriceCard(job.model, { scale: 2 })
        const blob = await canvasToBlob(canvas)
        if (!blob) {
          toast('这个浏览器不支持生成图片，请换 Chrome / Edge / Safari 试试', 'err', 4200)
          return
        }
        downloadBlob(blob, fileName(job.model, job.target, 'png'))
        count++
        // 连着下多个文件，给它一点间隔，免得被浏览器拦掉
        if (count < jobs.length) await new Promise((resolve) => setTimeout(resolve, 400))
      }
      toast(count > 1 ? `已生成 ${count} 张完整图片` : '图片已生成，去下载文件夹看看', 'ok', 3600)
    } catch (err) {
      toastErr(err)
    } finally {
      setBusy('')
    }
  }

  async function exportDocx() {
    if (!model) return
    setBusy('doc')
    try {
      const jobs = await eachModel()
      if (!jobs.length) return
      let count = 0
      for (const job of jobs) {
        const query = new URLSearchParams(baseQuery())
        if (scope !== 'merged' && job.target.key) query.set('game_id', job.target.key)
        const res = await fetch(`/api/pricebook/export.docx?${query.toString()}`, { credentials: 'same-origin' })
        if (!res.ok) {
          let message = '生成文档失败'
          try {
            const body = await res.json()
            if (body && body.error) message = body.error
          } catch {
            /* 保持默认提示 */
          }
          toast(message, 'err', 4200)
          return
        }
        downloadBlob(await res.blob(), fileName(job.model, job.target, 'docx'))
        count++
        if (count < jobs.length) await new Promise((resolve) => setTimeout(resolve, 400))
      }
      toast(count > 1 ? `已生成 ${count} 份 Word 文档，每个游戏一份` : 'Word 文档已生成，可以用 Word / WPS 打开和修改', 'ok', 3600)
    } catch (err) {
      toastErr(err)
    } finally {
      setBusy('')
    }
  }

  return (
    <Drawer
      title="导出价格表"
      subtitle="生成能直接发微信的图片，或者能打印、能编辑的 Word 文档"
      wide
      onClose={() => close(null)}
      footer={
        <>
          <button className="btn" type="button" onClick={() => close(null)}>
            关闭
          </button>
          <div style={{ flex: '1' }} />
          <button className="btn" type="button" disabled={!list.length || busy === 'doc'} data-loading={busy === 'doc' ? '1' : undefined} onClick={exportDocx}>
            <FileText {...iconProps()} />
            生成 Word 文档
          </button>
          <button className="btn btn--primary" type="button" disabled={!list.length || busy === 'img'} data-loading={busy === 'img' ? '1' : undefined} onClick={exportImages}>
            <Download {...iconProps()} />
            生成图片
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="formgrid">
          <Field label="导出范围" htmlFor="export-scope" hint="默认每个游戏单独出一份，发给客户时只发他那款游戏，不会把几个游戏混在一张图上。">
            <SelectInput
              id="export-scope"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'per-game', label: '每个游戏各出一份（推荐 · 分开的文件）' },
                { value: 'merged', label: '全部游戏合并成一份' },
                ...(games || []).map((game) => ({ value: `game:${game.id}`, label: `只要「${game.name}」这一份` })),
              ]}
            />
          </Field>

          {/* 这一格没有控件，只是一句说明（旧版也是这样） */}
          <Field label="图片内容" hint="按游戏生成一张完整的客户速览长图；Word 会保留完整服务和阶梯价。" />

          <Field label="带说明文字">
            <label className="inline" style={{ cursor: 'pointer' }}>
              <input className="chk" type="checkbox" checked={withDesc} onChange={(event) => setWithDesc(event.target.checked)} />
              <span className="sm">展示服务说明、套餐内容和增项</span>
            </label>
          </Field>

          <Field label="联系方式" htmlFor="export-contact">
            <TextInput
              id="export-contact"
              value={contactText}
              onChange={(value) => {
                setContactText(value)
                setContact(value)
              }}
              placeholder="例：微信 xiaofeng"
            />
          </Field>

          <Field label="页脚说明" htmlFor="export-footer">
            <TextInput
              id="export-footer"
              value={footerText}
              onChange={(value) => {
                setFooterText(value)
                setFooter(value)
              }}
              placeholder="例：价格随版本更新，以最新报价为准"
            />
          </Field>
        </div>

        <div className="sechead" style={{ marginBottom: '0' }}>
          <h3>预览</h3>
          <span className="sechead__note">这就是生成出来的图片</span>
        </div>

        <div className="exporter__preview">
          <div className="stack">{previewUrl ? <img src={previewUrl} alt="价格表速览卡预览" /> : null}</div>
        </div>

        <div className="hint">{summary}</div>

        <div className="note">图片按游戏生成一张完整长图；Word 是 A4 完整价目册，使用真实表格并逐档列出阶梯价。</div>
      </div>
    </Drawer>
  )
}
