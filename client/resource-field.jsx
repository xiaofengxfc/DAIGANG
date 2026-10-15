import React, { useEffect, useRef, useState } from 'react'
import { Eye, RefreshCw } from 'lucide-react'
import { api } from './lib/api.js'
import { fmtQty } from './lib/formatters.js'
import { RES_KEYS, buildResources, deltaText, joinResourceSections, parseResources, sectionText } from '../shared/resources.js'
import { profileForGame, profileKeys } from '../shared/game-profiles.js'
import { rememberFrameToken } from './lib/screen-frames.js'
import { toast, toastErr } from './app/toast-store.js'

/* ============================================================
   资源对比字段（React 版）
   ============================================================

   原来是 public/js/views/orderbits.js 里的 resourcesField()：
   星声 / 体力 / 贝币 各一个框，外加一个「其他」兜底，
   「做之前」和「做之后」两排，中间自动算「本次消耗」。
   两边都能点「识别画面」（看屏幕）或「识别截图」（选一张图）。

   **记哪几个资源、按哪个键打开哪个界面，由订单上的游戏决定**
   （父组件把 order.game_name 传进来）。鸣潮记三个、异环记五个，
   「体力」在两边都记，但图标是两张不同的图 —— 这些全在
   shared/game-profiles.js 里，这里只负责渲染。

   交给父组件的值是两行文本（resources_before / resources_after），
   和旧版 collect() 塞进去的完全一样 —— 后端存的还是同一格式。

   ---- 一单混了两个游戏怎么办 ----

   一张单里既有鸣潮又有异环时，一行文本装不下两套数（「体力」两边都记，
   可不是同一个数），所以每个游戏渲染成**一块自己的表**，各点各的
   「识别画面」，存进去时按【游戏名】分段（shared/resources.js 里那套）。

   为什么不合成一块、点一次自动跑遍两个游戏？识别要先把游戏窗口切到前台，
   而「哪个窗口是游戏」是猜的（focus 那条规则）；两个游戏同时在跑的时候
   来回切更容易认错画面。分开点，切哪个、开哪一页都是明确的。
   ============================================================ */

const tinyStyle = { marginTop: '2px', opacity: '.85' }
const tinyTopStyle = { marginTop: '4px', opacity: '.85' }
const amberStyle = { marginTop: '2px' }
const MAX_SCREEN_FRAMES = 8

/**
 * 外壳：决定渲染一块还是多块。自己不带 hook（条件 return 不能夹在 hook 中间），
 * 真正的实现都在下面两个组件里。
 */
export default function ResourceField(props) {
  const games = (props.games || []).filter(Boolean)
  if (games.length > 1) return <MultiGameField {...props} games={games} />
  return <SingleGameField {...props} game={games[0] || props.game || ''} />
}

/**
 * 一个游戏一块表。多游戏时每一块都是它，各自管自己那一段文本。
 * 里面所有状态都只属于**这一个游戏** —— 这是「按游戏分开记」最省事的做法：
 * 换游戏只是换一块，不用把已有的识别流程拆开重写。
 */
function SingleGameField({ before = '', after = '', beforeFrom = '', game = '', orderId = '', onChange }) {
  // 订单上选的游戏 → 这张表：记哪几个资源、按什么键打开哪些界面
  const profile = profileForGame(game)
  const keys = profileKeys(profile)
  const stages = profile.stages || []
  const gameName = (profile.names && profile.names[0]) || profile.id
  // 解析和拼回都用**并集**（RES_KEYS）：万一历史文本里带着别的游戏的资源名，
  // 它会落到「其他」框里原样留着，不会因为换了游戏就悄悄丢字。
  const [sides, setSides] = useState(() => ({ before: parseResources(before, RES_KEYS), after: parseResources(after, RES_KEYS) }))
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
    resources_before: buildResources(sides.before, sides.before.other, RES_KEYS),
    resources_after: buildResources(sides.after, sides.after.other, RES_KEYS),
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
      for (const key of keys) {
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
      // 手工截图不知道截的是哪一屏，所以这个游戏名下所有资源一起找（和后端默认一致）；
      // 只是把「本游戏有哪几个」讲明白，省得后端拿整份模板表去扫。
      // deep=1 额外要一份「每个图标模板各匹配多少分」的体检 —— 认不出来时靠它定位。
      const result = await api.post(
        '/api/ocr',
        {
          data_url: dataUrl,
          game: gameName,
          keys: [...new Set(stages.flatMap((s) => s.resources))],
        },
        { deep: 1 }
      )
      const got = result.resources || {}
      const found = keys.filter((key) => got[key] !== undefined && got[key] !== null)
      fill(side, got)

      // 认出来的原文也摊开给用户核对 —— 认错的时候一眼能看出来
      const lines = (result.lines || []).filter((line) => line.trim()).slice(0, 8)
      // 「看到了图标但没配上数字」也要说出来，不然用户不知道为什么留空
      const gotKeys = new Set((result.hits || []).map((hit) => hit.key))
      const weak = (result.seen || [])
        .filter((seen) => (seen.value === undefined || seen.value === null) && !gotKeys.has(seen.key))
        .map((seen) => `${seen.key}${seen.score ? `(分${seen.score})` : ''}`)
      const fallback = (result.hits || []).filter((hit) => hit.source === 'ocr-layout').map((hit) => hit.key)

      /* 图标体检：每个模板在这张图顶栏上的最好分数。
         认不出来的时候这一行就是答案 —— 分数都低说明模板跟画面不是一个版本，
         某个分数高但没进结果说明是阈值或取数字那一步的事。 */
      const probe = result.icon_probe && !result.icon_probe.error ? result.icon_probe : null
      const probeLine = probe
        ? probe.items.map((it) => `${it.key} ${it.score}${it.passes ? '' : '(没过)'}`).join(' · ')
        : result.icon_probe && result.icon_probe.error
          ? result.icon_probe.error
          : ''

      setNotes((prev) => ({
        ...prev,
        [side]: (
          <>
            <strong>{found.length ? `认出 ${found.length} 项，请核对一下再保存` : `${keys.length} 个资源一个都没认出来，可以手动填`}</strong>
            {result.warning ? <div className="tiny" style={tinyStyle}>{result.warning}</div> : null}
            {result.engine ? (
              <div className="tiny" style={tinyStyle}>
                {`引擎：${result.engine}${result.anchor ? ` · 定标图标：${result.anchor.key}(分${result.anchor.score})` : ''}`}
              </div>
            ) : null}
            {fallback.length ? <div className="tiny tone-amber" style={amberStyle}>{`${fallback.join('、')} 是按数字格式补出的，请对照截图核对。`}</div> : null}
            {weak.length ? <div className="tiny" style={tinyStyle}>{`没配上数字的：${weak.join('、')}`}</div> : null}
            {probeLine ? <div className="tiny" style={tinyTopStyle}>{`图标体检（阈值 ${probe.min_score}）：${probeLine}`}</div> : null}
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
   * 自动流程：激活游戏窗口 → 按 profile 里第一段的键读一遍 → ESC →
   * 第二段的键再读一遍 → ESC。每个值需识别到两次才会采纳；
   * 单页最多扫八帧，仍缺值就返回游戏并停止。
   * 具体是 B 背包 / M 地图，还是别的键，看订单上那个游戏的 profile。
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
    let progressHint = `正在切回${gameName}…`

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

    paintProgress(stages[0])
    try {
      // 带上游戏名：切窗口是按游戏找的（鸣潮和异环的进程名/窗口标题都不一样）
      const focus = await api.post('/api/ocr/screen/focus', { game: gameName })
      if (!focus || !focus.ok) throw new Error((focus && focus.error) || `没有切换到${gameName}窗口`)
      focused = true
      // 按通用规则猜中的窗口要说出来：猜错的话后面认出来的全是别的游戏的画面
      if (focus.matched_by === 'fallback') {
        progressHint = `没认出${gameName}的窗口特征，按通用规则切到了 ${focus.title || focus.process}`
      } else {
        progressHint = `已切回${gameName}${focus.title ? `（${focus.title}）` : ''}，准备打开${stages[0].title}…`
      }
      // Give the restored game window a moment to repaint before capturing it.
      await new Promise((resolve) => setTimeout(resolve, 500))

      for (const stage of stages) {
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

        // 这一阶段「认全了」的那一帧的凭据。内层循环一认满就 break，
        // 所以这里留下的就是那次真正被采纳的画面。
        let keeperToken = ''
        for (let attempt = 0; attempt < MAX_SCREEN_FRAMES && !token.stop; attempt++) {
          const result = await api.post('/api/ocr/screen', { session, stage: stage.id, min_votes: 2, game: gameName, keys: stage.resources })
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
          if (!missing.length) {
            keeperToken = result.frame_token || ''
            break
          }
          if (attempt + 1 < MAX_SCREEN_FRAMES) await new Promise((resolve) => setTimeout(resolve, 850))
        }

        if (token.stop) break
        const missing = stage.resources.filter((key) => got[key] === undefined)
        if (missing.length) {
          stoppedReason = `${stage.title}连续识别 ${MAX_SCREEN_FRAMES} 帧后仍缺少：${missing.join('、')}。流程已停止。`
          break
        }

        /* 认全了就记下这一帧的凭据（不取走）。
           真正的图还在服务端暂存着，等用户点保存时再去取；用户不保存就自己过期，
           所以不会在 uploads 里留下没人引用的孤儿截图。 */
        if (keeperToken) rememberFrameToken(orderId, side, keeperToken)

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
    const count = keys.filter((key) => got[key] !== undefined).length
    const small = Object.keys(smallText)
    const complete = count === keys.length && !stoppedReason && !escError
    const summary = stoppedReason
      ? `${stoppedReason}${returnedToGame ? ' 已按 ESC 返回游戏。' : ''}`
      : (complete ? `${keys.length} 项都识别到了，请核对后再保存。` : `已识别 ${count}/${keys.length} 项。`)
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
            {complete ? `${stages.map((s) => s.title).join('和')}各自识别两次一致后才会填入。` : '只会填写复核一致的数值；未识别字段保持原样。'}
          </div>
        </>
      ),
    }))
    if (complete) toast(`${keys.join('、')}已识别，请核对`, 'ok', 4200)
    else toast(escError || stoppedReason || `已识别 ${count}/${keys.length} 项`, 'err', escError ? 5200 : 4200)
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
            title={`切回${gameName}后自动按 ${stages.map((s) => `${s.key} 识别${s.title}`).join('，再按 ')}`}
            data-loading={busy[side] === 'watch' ? '1' : undefined}
            onClick={() => watchScreen(side)}
          >
            <RefreshCw size={14} strokeWidth={1.8} absoluteStrokeWidth aria-hidden />
            识别画面
          </button>
          <button
            className="btn btn--sm"
            type="button"
            title={`选一张游戏截图，自动认 ${keys.join(' / ')}`}
            data-loading={busy[side] === 'shot' ? '1' : undefined}
            onClick={() => fileRefOf(side).current?.click()}
          >
            <Eye size={14} strokeWidth={1.8} absoluteStrokeWidth aria-hidden />
            识别截图
          </button>
        </div>
        <div className="cluster" style={{ gap: '6px', flexWrap: 'wrap' }}>
          {keys.map((key) => (
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

/**
 * 多游戏：一个游戏一块单游戏表，各自识别、各自记。
 * 存进订单的还是**一行**文本，按【游戏名】分段（【鸣潮】… 【异环】…）。
 *
 * 哪一段是哪一块的，靠 game 名对；用户只填了一块也没关系 ——
 * 空的那段拼接时会整段丢掉，不会留一个光秃秃的【异环】在库里。
 */
function MultiGameField({ games, before = '', after = '', beforeFrom = '', orderId = '', onChange }) {
  // 初始值从分段文本里各取自己那一段；之后每一块自己维护自己的正文
  const [parts, setParts] = useState(() => {
    const init = {}
    for (const game of games) init[game] = { before: sectionText(before, game), after: sectionText(after, game) }
    return init
  })
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const textBefore = joinResourceSections(games.map((game) => ({ game, body: parts[game] && parts[game].before })))
  const textAfter = joinResourceSections(games.map((game) => ({ game, body: parts[game] && parts[game].after })))

  useEffect(() => {
    if (onChangeRef.current) onChangeRef.current({ resources_before: textBefore, resources_after: textAfter })
  }, [textBefore, textAfter])

  return (
    <div className="stack stack--tight field--full">
      <div className="hint">{`这一单有 ${games.length} 个游戏（${games.join(' + ')}），各记各的：切到哪个游戏就点那一块的「识别画面」。`}</div>
      {games.map((game, index) => (
        <SingleGameField
          key={game}
          game={game}
          orderId={orderId}
          before={(parts[game] && parts[game].before) || ''}
          after={(parts[game] && parts[game].after) || ''}
          // 「做之前」带上一条的提示只在第一块说一次，不然两块都挂一句很吵
          beforeFrom={index === 0 ? beforeFrom : ''}
          onChange={(next) => setParts((prev) => ({ ...prev, [game]: { before: next.resources_before, after: next.resources_after } }))}
        />
      ))}
    </div>
  )
}
