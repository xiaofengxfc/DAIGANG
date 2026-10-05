import React, { useEffect, useRef, useState } from 'react'
import { Eye, RefreshCw } from 'lucide-react'
import { api } from './lib/api.js'
import { fmtQty } from './lib/formatters.js'
import { RES_KEYS, buildResources, deltaText, parseResources } from '../shared/resources.js'
import { toast, toastErr } from './app/toast-store.js'

/* ============================================================
   资源对比字段（React 版）
   ============================================================

   原来是 public/js/views/orderbits.js 里的 resourcesField()：
   星声 / 体力 / 贝币 各一个框，外加一个「其他」兜底，
   「做之前」和「做之后」两排，中间自动算「本次消耗」。
   两边都能点「识别画面」（看屏幕）或「识别截图」（选一张图）。

   交给父组件的值是两行文本（resources_before / resources_after），
   和旧版 collect() 塞进去的完全一样 —— 后端存的还是同一格式。
   ============================================================ */

const tinyStyle = { marginTop: '2px', opacity: '.85' }
const tinyTopStyle = { marginTop: '4px', opacity: '.85' }
const amberStyle = { marginTop: '2px' }

export default function ResourceField({ before = '', after = '', beforeFrom = '', onChange }) {
  const [sides, setSides] = useState(() => ({ before: parseResources(before), after: parseResources(after) }))
  const [notes, setNotes] = useState({ before: null, after: null })
  const [busy, setBusy] = useState({ before: '', after: '' })
  const [ocrOk, setOcrOk] = useState(null)

  const fileBefore = useRef(null)
  const fileAfter = useRef(null)
  const sessionSeq = useRef(0)
  // 正在「看屏幕」的循环：卸载时要让它停下来，不然会一直轮询到 90 秒
  const watchers = useRef({ before: null, after: null })
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const values = {
    resources_before: buildResources(sides.before, sides.before.other),
    resources_after: buildResources(sides.after, sides.after.other),
  }

  // 值一变就报给父组件（旧版是提交时 collect，这里随时同步，提交结果一样）
  useEffect(() => {
    if (onChangeRef.current) onChangeRef.current(values)
  }, [values.resources_before, values.resources_after])

  useEffect(() => {
    let alive = true
    api
      .get('/api/ocr/status')
      .then((status) => {
        if (alive) setOcrOk(Boolean(status && status.available))
      })
      .catch(() => {
        if (alive) setOcrOk(false)
      })
    return () => {
      alive = false
      for (const side of ['before', 'after']) {
        if (watchers.current[side]) watchers.current[side].stop = true
      }
    }
  }, [])

  const fileRefOf = (side) => (side === 'before' ? fileBefore : fileAfter)

  const patch = (side, key, value) => {
    setSides((prev) => ({ ...prev, [side]: { ...prev[side], [key]: value } }))
  }

  const fill = (side, got) => {
    setSides((prev) => {
      const next = { ...prev[side] }
      for (const key of RES_KEYS) {
        if (got[key] === undefined || got[key] === null) continue
        next[key] = String(got[key])
      }
      return { ...prev, [side]: next }
    })
  }

  async function recognizeShot(side, file) {
    if (!file) return
    if (file.size > 1.5 * 1024 * 1024) {
      toast('截图请压到 1.5MB 以内', 'err', 3600)
      return
    }
    setBusy((prev) => ({ ...prev, [side]: 'shot' }))
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result)
        reader.onerror = () => reject(new Error('读不了这个文件'))
        reader.readAsDataURL(file)
      })
      const result = await api.post('/api/ocr', { data_url: dataUrl })
      const got = result.resources || {}
      const found = RES_KEYS.filter((key) => got[key] !== undefined && got[key] !== null)
      fill(side, got)

      // 认出来的原文也摊开给用户核对 —— 认错的时候一眼能看出来
      const lines = (result.lines || []).filter((line) => line.trim()).slice(0, 8)
      // 「看到了图标但没配上数字」也要说出来，不然用户不知道为什么留空
      const gotKeys = new Set((result.hits || []).map((hit) => hit.key))
      const weak = (result.seen || [])
        .filter((seen) => (seen.value === undefined || seen.value === null) && !gotKeys.has(seen.key))
        .map((seen) => `${seen.key}${seen.score ? `(分${seen.score})` : ''}`)
      const fallback = (result.hits || []).filter((hit) => hit.source === 'ocr-layout').map((hit) => hit.key)

      setNotes((prev) => ({
        ...prev,
        [side]: (
          <>
            <strong>{found.length ? `认出 ${found.length} 项，请核对一下再保存` : '这三个资源一个都没认出来，可以手动填'}</strong>
            {result.warning ? <div className="tiny" style={tinyStyle}>{result.warning}</div> : null}
            {result.engine ? (
              <div className="tiny" style={tinyStyle}>
                {`引擎：${result.engine}${result.anchor ? ` · 定标图标：${result.anchor.key}(分${result.anchor.score})` : ''}`}
              </div>
            ) : null}
            {fallback.length ? <div className="tiny tone-amber" style={amberStyle}>{`${fallback.join('、')} 是按数字格式补出的，请对照截图核对。`}</div> : null}
            {weak.length ? <div className="tiny" style={tinyStyle}>{`没配上数字的：${weak.join('、')}`}</div> : null}
            {lines.length ? <div className="tiny" style={tinyTopStyle}>{`识别到的原文：${lines.join(' ｜ ')}`}</div> : null}
          </>
        ),
      }))
      toast(found.length ? `认出 ${found.length} 项，核对后再保存` : '这张图里没认出资源数字', found.length ? 'ok' : 'err', 3600)
    } catch (err) {
      toastErr(err)
    } finally {
      setBusy((prev) => ({ ...prev, [side]: '' }))
      const node = fileRefOf(side).current
      if (node) node.value = ''
    }
  }

  /**
   * 识别画面：切到游戏，程序每不到一秒截一次屏。
   * 每个数字要**认到两次以上**才采纳（服务端按 session 累计票数），
   * 所以填进框里的不是「认了一次」的结果，是复核过的。
   */
  async function watchScreen(side) {
    if (watchers.current[side]) return
    if (ocrOk === false) {
      toast('这台机器上用不了屏幕识别：装一个本地 OCR（设置页有指引），或者用 Windows 自带的那个', 'err', 4200)
      return
    }
    const token = { stop: false }
    watchers.current[side] = token
    setBusy((prev) => ({ ...prev, [side]: 'watch' }))

    const session = `w${Date.now()}-${++sessionSeq.current}`
    const got = {}
    const pending = {}
    const seenIcons = []
    const smallText = {}
    const layoutFallback = {}
    let engine = ''
    const deadline = Date.now() + 90000

    const paintProgress = (extra) => {
      const have = RES_KEYS.filter((key) => got[key] !== undefined)
      setNotes((prev) => ({
        ...prev,
        [side]: (
          <>
            <strong>{`正在看屏幕… 已认到 ${have.length}/${RES_KEYS.length}${have.length ? `（${have.join('、')}）` : ''}`}</strong>
            {engine ? <div className="tiny" style={tinyTopStyle}>{`引擎：${engine}${seenIcons.length ? ` · 图标：${seenIcons.join('、')}` : ''}`}</div> : null}
            {Object.keys(pending).length ? (
              <div className="tiny" style={tinyStyle}>
                {'正在复核：' + Object.entries(pending).map(([key, p]) => `${key} ${p.votes}/${p.need}`).join(' · ')}
              </div>
            ) : null}
            <div className="tiny" style={tinyTopStyle}>{extra || '切到游戏，停在能看到这几个资源的界面；每个数字要认到两次才采纳。'}</div>
          </>
        ),
      }))
    }

    paintProgress()
    try {
      while (!token.stop && Date.now() < deadline && RES_KEYS.some((key) => got[key] === undefined)) {
        let result = null
        try {
          result = await api.post('/api/ocr/screen', { session, min_votes: 2 })
        } catch {
          // 单次失败（比如切窗口时截到黑屏）不算结束，接着看
          await new Promise((resolve) => setTimeout(resolve, 1000))
          continue
        }
        if (token.stop) break
        if (result.engine) engine = result.engine
        if (Array.isArray(result.hits)) {
          for (const hit of result.hits) {
            const label = `${hit.key}(分${hit.score}${hit.source === 'ocr-layout' ? '·格式兜底' : hit.warn ? '·字太小' : ''})`
            if (!seenIcons.includes(label)) seenIcons.push(label)
          }
          // 字太小的读法单独记一句，收尾时一起提醒
          for (const hit of result.hits) {
            if (hit.source === 'ocr-layout') layoutFallback[hit.key] = hit.warn || '按数字格式识别'
            else if (hit.warn) smallText[hit.key] = true
          }
        }
        for (const [key, value] of Object.entries(result.agreed || {})) {
          got[key] = value.value
          delete pending[key]
        }
        for (const [key, value] of Object.entries(result.pending || {})) pending[key] = value
        fill(side, got)
        paintProgress()
        if (RES_KEYS.every((key) => got[key] !== undefined)) break
        await new Promise((resolve) => setTimeout(resolve, 850))
      }
      if (token.stop) return

      const count = RES_KEYS.filter((key) => got[key] !== undefined).length
      const missing = RES_KEYS.filter((key) => got[key] === undefined)
      const small = Object.keys(smallText)
      setNotes((prev) => ({
        ...prev,
        [side]: (
          <>
            <strong>{count === RES_KEYS.length ? '三个都认到了，核对一下再保存' : `认到 ${count} 个${missing.length ? `，${missing.join('、')} 没认到` : ''}`}</strong>
            {small.length ? (
              <div className="tiny tone-amber" style={amberStyle}>
                {`${small.join('、')} 这几个字太小（顶栏文字不到 21px），自带 OCR 有时会读错位数 —— 这 ${small.length} 个请对着游戏核一遍。想要更准就装一个本地 OCR 引擎（设置页有指引）。`}
              </div>
            ) : null}
            {Object.keys(layoutFallback).length ? (
              <div className="tiny tone-amber" style={amberStyle}>{`${Object.keys(layoutFallback).join('、')} 是按数字格式补出的，请对照截图核对。`}</div>
            ) : null}
            <div className="tiny" style={tinyTopStyle}>
              {count === RES_KEYS.length ? '每个数字都认到两次以上才填进来的。' : '认不出来就先留空自己填 —— 认不准的时候它不会硬凑一个数字。'}
            </div>
          </>
        ),
      }))
      toast(
        count === RES_KEYS.length ? (small.length ? '认到了，但有几个字太小，请核对' : '三个都认到了') : `认到 ${count} 个`,
        count ? 'ok' : 'err',
        small.length ? 5200 : 3600
      )
    } finally {
      watchers.current[side] = null
      setBusy((prev) => ({ ...prev, [side]: '' }))
      try {
        await api.post('/api/ocr/screen/reset', { session })
      } catch {
        /* 清不掉就算了，服务端也会自己过期 */
      }
    }
  }

  function buildSide(side, label, isFirst) {
    const parsed = sides[side]
    return (
      <div className="field field--full">
        <div className="cluster">
          <label className="lbl">{label}</label>
          <div style={{ flex: '1' }} />
          <button
            className="btn btn--sm btn--primary"
            type="button"
            title="切到游戏，程序会一直看着屏幕，三个都认到就自动停"
            data-loading={busy[side] === 'watch' ? '1' : undefined}
            onClick={() => watchScreen(side)}
          >
            <RefreshCw size={14} strokeWidth={1.8} absoluteStrokeWidth aria-hidden />
            识别画面
          </button>
          <button
            className="btn btn--sm"
            type="button"
            title="选一张游戏截图，自动认星声 / 体力 / 贝币"
            data-loading={busy[side] === 'shot' ? '1' : undefined}
            onClick={() => fileRefOf(side).current?.click()}
          >
            <Eye size={14} strokeWidth={1.8} absoluteStrokeWidth aria-hidden />
            识别截图
          </button>
        </div>
        <div className="cluster" style={{ gap: '6px', flexWrap: 'wrap' }}>
          {RES_KEYS.map((key) => (
            <label className="inline" key={key} style={{ gap: '4px' }}>
              <span className="dim tiny">{key}</span>
              <input
                className="inp inp--fig"
                inputMode="numeric"
                style={{ width: '92px' }}
                aria-label={`${label} ${key}`}
                value={parsed[key]}
                onChange={(event) => patch(side, key, event.target.value)}
              />
            </label>
          ))}
        </div>
        <input
          className="inp"
          placeholder="其他（可选）"
          aria-label={`${label} 其他资源`}
          value={parsed.other}
          onChange={(event) => patch(side, 'other', event.target.value)}
        />
        {/* 「做之前」是带上一条来的时候，说清来历，免得以为填错了 */}
        {isFirst && beforeFrom ? <div className="hint">{`「做之前」带的是${beforeFrom}，不对就直接改。`}</div> : null}
        {/* 差值那行旧引擎两边都渲染（「做之前」永远是空的），这里保持一致 */}
        <div className="hint">{side === 'after' ? deltaText(values.resources_before, values.resources_after, fmtQty) : ''}</div>
        {notes[side] ? <div className="note note--ok">{notes[side]}</div> : null}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          ref={fileRefOf(side)}
          onChange={(event) => recognizeShot(side, event.target.files && event.target.files[0])}
        />
      </div>
    )
  }

  return (
    // field--full 不能省：旧引擎会给自定义块补一个，少了它这两排会挤进网格的一列
    <div className="stack stack--tight field--full">
      {buildSide('before', '资源对比 · 做之前', true)}
      {buildSide('after', '资源对比 · 做之后', false)}
    </div>
  )
}
