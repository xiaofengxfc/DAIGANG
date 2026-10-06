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
const SCREEN_STAGES = [
  { id: 'bag', title: '背包', key: 'B', resources: ['贝币', '星声'], openDelay: 1100 },
  { id: 'map', title: '地图', key: 'M', resources: ['体力'], openDelay: 1400 },
]
const MAX_SCREEN_FRAMES = 8

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
        // Keep the state unknown when the status request itself fails. The
        // screen endpoint will return the actual engine/capture error on click.
        if (alive) setOcrOk(null)
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
   * 自动流程：激活鸣潮 → B 读背包货币 → ESC → M 读体力 → ESC。
   * 每个值需识别到两次才会采纳；单页最多扫八帧，仍缺值就返回游戏并停止。
   */
  async function watchScreen(side) {
    if (watchers.current.before || watchers.current.after) return
    if (ocrOk === false) {
      toast('这台机器上用不了屏幕识别：装一个本地 OCR（设置页有指引），或者用 Windows 自带的那个', 'err', 4200)
      return
    }
    const token = { stop: false }
    watchers.current[side] = token
    setBusy((prev) => ({ ...prev, [side]: 'watch' }))

    const sessionBase = `w${Date.now()}-${++sessionSeq.current}`
    const sessions = []
    const got = {}
    const pending = {}
    const seenIcons = []
    const smallText = {}
    const layoutFallback = {}
    let engine = ''
    let pageOpen = false
    let focused = false
    let returnedToGame = false
    let stoppedReason = ''
    // 两件不同的「返回」：escError 是没按回游戏（游戏界面可能还开着，要人管），
    // backError 只是没把浏览器切到前台（数据已经认全了，纯便利问题，不该降级结果）。
    let escError = ''
    let backError = ''
    let progressHint = '正在切回鸣潮…'

    const paintProgress = (stage, extra = progressHint) => {
      const have = stage.resources.filter((key) => got[key] !== undefined)
      setNotes((prev) => ({
        ...prev,
        [side]: (
          <>
            <strong>{`${stage.title}识别中：${have.length}/${stage.resources.length}${have.length ? `（${have.join('、')}）` : ''}`}</strong>
            {engine ? <div className="tiny" style={tinyTopStyle}>{`引擎：${engine}${seenIcons.length ? ` · 图标：${seenIcons.join('、')}` : ''}`}</div> : null}
            {Object.keys(pending).length ? (
              <div className="tiny" style={tinyStyle}>
                {'正在复核：' + Object.entries(pending).map(([key, p]) => `${key} ${p.votes}/${p.need}`).join(' · ')}
              </div>
            ) : null}
            <div className="tiny" style={tinyTopStyle}>{extra}</div>
          </>
        ),
      }))
    }

    paintProgress(SCREEN_STAGES[0])
    try {
      const focus = await api.post('/api/ocr/screen/focus')
      if (!focus || !focus.ok) throw new Error((focus && focus.error) || '没有切换到鸣潮窗口')
      focused = true
      progressHint = `已切回鸣潮${focus.title ? `（${focus.title}）` : ''}，准备打开背包…`
      // Give the restored game window a moment to repaint before capturing it.
      await new Promise((resolve) => setTimeout(resolve, 500))

      for (const stage of SCREEN_STAGES) {
        if (token.stop) break
        const session = `${sessionBase}-${stage.id}`
        sessions.push(session)
        progressHint = `正在按 ${stage.key} 打开${stage.title}…`
        paintProgress(stage)
        const opened = await api.post('/api/ocr/screen/key', { key: stage.key })
        if (!opened || !opened.ok) throw new Error((opened && opened.error) || `没有打开${stage.title}`)
        pageOpen = true
        returnedToGame = false
        progressHint = `已打开${stage.title}，等待画面稳定…`
        paintProgress(stage)
        await new Promise((resolve) => setTimeout(resolve, stage.openDelay))

        for (let attempt = 0; attempt < MAX_SCREEN_FRAMES && !token.stop; attempt++) {
          const result = await api.post('/api/ocr/screen', { session, min_votes: 2 })
          if (result.engine) engine = result.engine
          if (Array.isArray(result.hits)) {
            for (const hit of result.hits) {
              const label = `${hit.key}(分${hit.score}${hit.source === 'ocr-layout' ? '·格式兜底' : hit.warn ? '·字太小' : ''})`
              if (!seenIcons.includes(label)) seenIcons.push(label)
              if (hit.source === 'ocr-layout') layoutFallback[hit.key] = hit.warn || '按数字格式识别'
              else if (hit.warn) smallText[hit.key] = true
            }
          }
          for (const [key, value] of Object.entries(result.agreed || {})) {
            if (stage.resources.includes(key)) got[key] = value.value
            delete pending[key]
          }
          for (const [key, value] of Object.entries(result.pending || {})) {
            if (stage.resources.includes(key)) pending[key] = value
          }
          fill(side, got)
          const missing = stage.resources.filter((key) => got[key] === undefined)
          progressHint = `${stage.title}画面扫描 ${attempt + 1}/${MAX_SCREEN_FRAMES} 次${missing.length ? `，还差${missing.join('、')}` : ''}`
          paintProgress(stage)
          if (!missing.length) break
          if (attempt + 1 < MAX_SCREEN_FRAMES) await new Promise((resolve) => setTimeout(resolve, 850))
        }

        if (token.stop) break
        const missing = stage.resources.filter((key) => got[key] === undefined)
        if (missing.length) {
          stoppedReason = `${stage.title}连续识别 ${MAX_SCREEN_FRAMES} 帧后仍缺少：${missing.join('、')}。流程已停止。`
          break
        }

        // ESC after each successful page, and the finally block handles every failure path.
        await api.post('/api/ocr/screen/key', { key: 'ESC' })
        pageOpen = false
        returnedToGame = true
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    } catch (err) {
      stoppedReason = err.message || '屏幕识别流程失败。'
    } finally {
      if (pageOpen) {
        try {
          await api.post('/api/ocr/screen/key', { key: 'ESC' })
          pageOpen = false
          returnedToGame = true
          await new Promise((resolve) => setTimeout(resolve, 450))
        } catch (err) {
          escError = `未能自动按 ESC 返回游戏：${err.message || '按键发送失败'}`
        }
      }
      watchers.current[side] = null
      setBusy((prev) => ({ ...prev, [side]: '' }))
      for (const session of sessions) {
        try {
          await api.post('/api/ocr/screen/reset', { session })
        } catch {
          /* 清不掉就算了，服务端也会自己过期 */
        }
      }
      // 数据已经认完（或已经报了错），把前台还给用户点「识别画面」的那个窗口，
      // 省得每次都要手动 Alt+Tab 回来。失败只提示，不影响识别结果。
      if (focused) {
        try {
          const back = await api.post('/api/ocr/screen/return')
          if (back && back.ok === false) backError = `没能自动切回浏览器：${back.error || '未知原因'}`
        } catch (err) {
          backError = `没能自动切回浏览器：${err.message || '切回失败'}`
        }
      }
    }

    if (token.stop) return
    const count = RES_KEYS.filter((key) => got[key] !== undefined).length
    const small = Object.keys(smallText)
    const complete = count === RES_KEYS.length && !stoppedReason && !escError
    const summary = stoppedReason
      ? `${stoppedReason}${returnedToGame ? ' 已按 ESC 返回游戏。' : ''}`
      : (complete ? '三项都识别到了，请核对后再保存。' : `已识别 ${count}/3 项。`)
    setNotes((prev) => ({
      ...prev,
      [side]: (
        <>
          <strong>{summary}</strong>
          {escError ? <div className="tiny tone-amber" style={amberStyle}>{escError}</div> : null}
          {backError ? <div className="tiny tone-amber" style={amberStyle}>{backError}</div> : null}
          {small.length ? (
            <div className="tiny tone-amber" style={amberStyle}>
              {`${small.join('、')} 字太小，自带 OCR 可能读错位数，请对照游戏核验。`}
            </div>
          ) : null}
          {Object.keys(layoutFallback).length ? (
            <div className="tiny tone-amber" style={amberStyle}>{`${Object.keys(layoutFallback).join('、')} 是按数字格式补出的，请对照游戏核验。`}</div>
          ) : null}
          <div className="tiny" style={tinyTopStyle}>
            {complete ? '背包和地图各自识别两次一致后才会填入。' : '只会填写复核一致的数值；未识别字段保持原样。'}
          </div>
        </>
      ),
    }))
    if (complete) toast('贝币、星声和体力已识别，请核对', 'ok', 4200)
    else toast(escError || stoppedReason || `已识别 ${count}/3 项`, 'err', escError ? 5200 : 4200)
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
            title="切回鸣潮后自动按 B 识别背包，再按 M 识别体力"
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
