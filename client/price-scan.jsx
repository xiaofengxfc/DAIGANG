import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  ExternalLink,
  Image as ImageIcon,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  X,
} from 'lucide-react'
import { api } from './lib/api.js'
import { fmtMoney } from './lib/formatters.js'
import { toast, toastErr } from './app/toast-store.js'
import Drawer from './app/drawer.jsx'
import { openOverlay } from './app/overlay-host.jsx'

/* ============================================================
   B站自动比价
   ============================================================

   价格是这个系统里最不能出错的数据，所以这个界面的核心不是「一键填好」，
   而是**让每一条建议都能被核对**：

     · 每个建议价都带着它的来源视频、来源帧原图、以及 OCR 认出来的原文；
     · 机器没把握的（单位口径不同、匹配分低、同一视频给了多个价）不猜，
       单独列出来并写清原因，让人来定；
     · 写入是最后一步，只写勾中的行，只改基准价。

   流程：检查环境 → 起扫描任务 → 轮询进度 → 出预览表 → 确认写入。

     openPriceScan(game, { onApplied })
   ============================================================ */

export function openPriceScan(game, options = {}) {
  return openOverlay((close) => <PriceScan game={game} close={close} {...options} />, 'price-scan')
}

const iconProps = (size = 15) => ({ size, strokeWidth: 1.8, absoluteStrokeWidth: true, 'aria-hidden': true })

const frameURL = (frame) => `/api/price-scan/frame/${String(frame).split('/').map(encodeURIComponent).join('/')}`

/** 把「现价 → 建议价」的变化说成人话 */
function deltaLabel(row) {
  const before = Number(row.current_price) || 0
  const after = Number(row.suggested_price)
  if (!Number.isFinite(after)) return { text: '—', tone: 'muted' }
  if (!before) return { text: '原本没价', tone: 'jade' }
  const diff = after - before
  if (Math.abs(diff) < 0.005) return { text: '和现价一致', tone: 'muted' }
  const ratio = after / before
  const pct = Math.round((ratio - 1) * 100)
  const tone = diff > 0 ? 'up' : 'down'
  // 涨跌超过一倍的多半是口径不同（月价 vs 单次），单独标出来让人多看一眼
  const extreme = ratio >= 2 || ratio <= 0.5
  return { text: `${diff > 0 ? '+' : ''}${pct}%${extreme ? '（幅度大，请核对）' : ''}`, tone, extreme }
}

/** 建议行按可信程度排序：样本够 + 有变化的排前面，最该看的先看到 */
const ROW_ORDER = { ready: 0, changed: 1, insufficient: 2, none: 3 }

/** 「3 分钟前」「2 小时前」——比一串 ISO 时间戳好读 */
function fmtWhen(iso) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return '之前'
  const mins = Math.floor((Date.now() - t) / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

function rowRank(row) {
  if (!row.sample_count) return ROW_ORDER.none
  if (!row.enough) return ROW_ORDER.insufficient
  const changed = Math.abs((Number(row.suggested_price) || 0) - (Number(row.current_price) || 0)) > 0.005
  return changed ? ROW_ORDER.changed : ROW_ORDER.ready
}

/* ============================================================ */

function PriceScan({ game, close, onApplied }) {
  const [readiness, setReadiness] = useState(null)
  const [job, setJob] = useState(null)
  const [keyword, setKeyword] = useState('')
  const [maxVideos, setMaxVideos] = useState(8)
  const [refresh, setRefresh] = useState(false)
  const [minSamples, setMinSamples] = useState(3)
  const [starting, setStarting] = useState(false)
  const [installing, setInstalling] = useState(null)
  /**
   * AI 甄别的配置。密钥只进不出：服务端从不回明文，这里也不留副本 ——
   * 保存完就把输入框清空，只显示「已配置 + 尾号」。
   */
  const [ai, setAi] = useState(null)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiForm, setAiForm] = useState({ base_url: '', model: '', api_key: '' })
  const [aiSaving, setAiSaving] = useState(false)
  const [aiTest, setAiTest] = useState(null)
  const [applying, setApplying] = useState(false)
  /**
   * 写价时顺便把 AI 抽到的「包含内容」补进 package_items。
   * 默认关 —— 这是改给客户看的文案，不是改一个数，得用户自己点头。
   */
  const [fillInclusions, setFillInclusions] = useState(false)
  const [picked, setPicked] = useState(() => new Set())
  const [edited, setEdited] = useState({})
  const [expanded, setExpanded] = useState(() => new Set())
  const [tab, setTab] = useState('all')
  /**
   * 这次结果是从库里捞回来的上一次扫描，不是刚跑完的。
   *
   * 任务本来就持久化在 price_scan_jobs 里，但界面之前从来不读它 ——
   * 于是「扫完关掉抽屉、想再看一眼」就没了，只能重扫一遍（再等一两分钟、
   * 再下几十兆视频）。结果是存着的，那就该能看。
   */
  const [restored, setRestored] = useState(false)
  /**
   * 大类候选：从视频的分节标题里认出来的（`梦州地图`、`主线：`）。
   * 勾选后批量建成大类 —— 这是「价格表结构对不上」时最省事的一条路：
   * 不然得先退出比价、去价格表建大类、再回来重新扫一遍。
   */
  const [sectionPicked, setSectionPicked] = useState(new Set())
  /** 这个游戏下已有的大类名，用来在候选里标出「已经有了」 */
  const [categoryNames, setCategoryNames] = useState([])
  /** 建服务项时要选大类，得带上 id —— 只有名字没法写进 category_id */
  const [categoryOptions, setCategoryOptions] = useState([])
  /** 这一次已经建成的（名字 → 服务端返回的 id），建成后立刻标出来 */
  const [createdSections, setCreatedSections] = useState({})
  const [creatingSections, setCreatingSections] = useState(false)
  /**
   * 改派：把某个建议行改到另一个服务项上。
   *
   * 键是「原本匹配到的服务项 id」，值是「用户改成的服务项 id」。
   * 为什么需要它：机器认名字靠模糊匹配，总会认错（`黎那汐塔` 能靠编辑距离
   * 匹到别的项上）。没有改派的话，用户面对一条认错的行只有「丢掉」一个选择 ——
   * 明明价格是对的，只是挂错了地方。这跟「确认/修正」是两回事。
   */
  const [targets, setTargets] = useState({})
  /** 这个游戏下的全部服务项，供改派时挑 */
  const [services, setServices] = useState([])
  /**
   * 要不要给「样本够」的行做默认勾选。
   *
   * 只有本次会话自己点出来的结果才勾 —— 从库里捞回来的历史结果一律不勾。
   * 恢复是「回头看看上次扫出了什么」，不是「接着写上次的结论」；
   * 默认勾上会让人手一滑把上次的判断又写一遍。
   *
   * 用 ref 而不是 state：轮询那个 effect 只依赖 jobId，用 state 会读到旧值。
   */
  const autoPickRef = useRef(false)
  const pollRef = useRef(null)

  const jobId = job?.id

  /* ---- 环境检查 + 接上已有任务 ---- */
  const loadAi = useCallback(async () => {
    try {
      const data = await api.get('/api/price-scan/ai')
      setAi(data)
      setAiForm((current) => ({
        base_url: current.base_url || data.base_url || '',
        model: current.model || data.model || '',
        api_key: '',
      }))
      return data
    } catch {
      return null
    }
  }, [])

  const saveAi = useCallback(async (patch = {}) => {
    setAiSaving(true)
    try {
      const body = { ...aiForm, ...patch }
      // 密钥留空表示「不动」—— 界面上点一次保存就抹掉 key 太吓人
      if (!String(body.api_key || '').trim()) delete body.api_key
      const data = await api.post('/api/price-scan/ai', body)
      setAi(data)
      setAiForm((current) => ({ ...current, api_key: '' }))
      setAiTest(null)
      toast(data.configured ? 'AI 配置好了' : '存下了，但还没配全')
      return data
    } catch (err) {
      toastErr(err)
      return null
    } finally {
      setAiSaving(false)
    }
  }, [aiForm])

  const probeAi = useCallback(async () => {
    setAiTest({ pending: true })
    try {
      const data = await api.post('/api/price-scan/ai/test', {})
      setAiTest(data)
      if (data.ok) toast(`连上了，${data.ms}ms`)
      else toastErr(data.error || '连不上')
    } catch (err) {
      setAiTest({ ok: false, error: String(err) })
      toastErr(err)
    }
  }, [])

  const loadReadiness = useCallback(async () => {
    try {
      const data = await api.get('/api/price-scan/readiness')
      setReadiness(data)
      if (data.defaults) {
        setMaxVideos((current) => (current === 8 ? data.defaults.max_videos : current))
        setMinSamples((current) => (current === 3 ? data.defaults.min_samples : current))
      }

      /**
       * 接上一个已经在跑的任务（可能是本会话起的，也可能是服务重启前起的）。
       * 这种要保留默认勾选：用户正盯着它跑，跑完就该把「样本够」的勾上。
       */
      if (data.active && data.active.game_id === game.id) {
        autoPickRef.current = true
        setJob(data.active)
        return data
      }

      /**
       * 没有在跑的任务，就把上一次扫出来的结果捞回来。
       *
       * 任务本来就持久化在 price_scan_jobs 里，界面之前从来不读它 —— 于是
       * 「扫完关掉抽屉、想再看一眼」就没了，只能重扫一遍（再等一两分钟、
       * 再下几十兆视频）。结果是存着的，那就该能看。
       *
       * 只捞**这个游戏**的、最近的、有匹配结果的那一次：别的游戏的结果摆在这儿
       * 只会让人以为扫错了游戏。捞回来的**一律不默认勾选** —— 恢复是「回头看看
       * 上次扫出了什么」，不是「接着写上次的结论」，默认勾上容易手一滑又写一遍。
       *
       * 这两件事放在同一个函数里顺序做，是因为它们抢同一份状态：
       * 拆成两个 effect 并行跑时，恢复历史结果会把「接上在跑的任务」给覆盖掉
       * （或者反过来），而且谁后到谁说了算，取决于两次请求谁先回来。
       */
      try {
        const list = await api.get('/api/price-scan/jobs', { game_id: game.id, limit: 8 })
        const last = (list?.items || []).find((item) => item.status === 'done' && item.match_count > 0)
        if (last) {
          const full = await api.get(`/api/price-scan/jobs/${last.id}`)
          autoPickRef.current = false
          setJob(full)
          setRestored(true)
        }
      } catch {
        /* 捞不回来就当没有，不影响新扫一次 */
      }
      return data
    } catch (err) {
      toastErr(err)
      return null
    }
  }, [game.id])

  useEffect(() => {
    void loadReadiness()
  }, [loadReadiness])

  useEffect(() => {
    void loadAi()
  }, [loadAi])

  /**
   * 拉这个游戏的服务项清单，供改派和「建服务项」用。
   *
   * 只拉本游戏的：后端 applyScan 会校验服务项属于该任务对应的游戏，
   * 列出别的游戏只会让人白挑一次再被拒。
   */
  const loadServices = useCallback(async () => {
    try {
      const data = await api.get('/api/services', { game_id: game.id })
      const list = Array.isArray(data) ? data : data?.items || []
      setServices(list.filter((service) => service.status !== 'archived'))
    } catch {
      /* 拉不到就只是少个改派选项 */
    }
  }, [game.id])

  useEffect(() => {
    void loadServices()
  }, [loadServices])

  /**
   * 拉大类清单，用来在候选里标「已经有了」。
   *
   * 只算这个游戏的和通用的（game_id 为空）—— 别的游戏的大类名不该让这里
   * 以为「已经存在」，否则你会看到一个明明属于别的游戏的名字被标成重复，
   * 于是该建的没建。
   */
  const loadCategories = useCallback(async () => {
    try {
      const data = await api.get('/api/categories')
      const list = Array.isArray(data) ? data : data?.items || []
      const mine = list
        .filter((item) => item.status !== 'archived')
        .filter((item) => !item.game_id || String(item.game_id) === String(game.id))
      setCategoryNames(mine.map((item) => item.name))
      setCategoryOptions(mine.map((item) => ({ id: item.id, name: item.name })))
    } catch {
      /* 拉不到就只是不标重复，不影响建 */
    }
  }, [game.id])

  useEffect(() => {
    void loadCategories()
  }, [loadCategories])

  const serviceMap = useMemo(() => new Map(services.map((service) => [service.id, service])), [services])

  /**
   * 这个任务里已经写过的行（服务项 id → 写进去的值）。
   *
   * 恢复历史结果时必须显示出来：不然用户看到一条「建议 239」，而库里其实
   * 早就是 239 了，会以为没写成功又点一次。
   */
  const appliedMap = useMemo(() => {
    const map = new Map()
    for (const item of job?.applied || []) map.set(item.service_id, item)
    return map
  }, [job?.applied])

  /**
   * 大类候选 + 「库里是不是已经有了」的判断。
   *
   * 判断放在前端做，而不是扫的时候一并算好：扫描结果会一直留着（可以恢复上次的
   * 结果），而这期间你可能已经手动把某个大类建出来了。用建的时候的清单去比，
   * 才不会出现「界面说没有、点下去报重复」。
   */
  const sections = useMemo(() => {
    const existing = new Map(categoryNames.map((name) => [normalizeName(name), name]))
    return (job?.sections || []).map((section) => {
      const key = normalizeName(section.name)
      const exact = existing.get(key)
      if (exact) return { ...section, dup: exact, similar: '' }
      // 没有完全同名的，再看像不像 —— `托管类` 和已有的 `托管` 是同一件事
      let best = ''
      let bestScore = 0
      for (const [existKey, existName] of existing) {
        if (!existKey) continue
        const score = Math.max(dice(key, existKey), existKey.includes(key) || key.includes(existKey) ? 0.6 : 0)
        if (score > bestScore) { bestScore = score; best = existName }
      }
      return { ...section, dup: '', similar: bestScore >= 0.5 ? best : '' }
    })
  }, [job?.sections, categoryNames])

  /** 勾上「没重复、也不像已有大类」的那些 —— 批量建的时候最常用的一步 */
  const pickCleanSections = useCallback(() => {
    setSectionPicked(new Set(sections.filter((s) => !s.dup && !s.similar && !createdSections[s.name]).map((s) => s.name)))
  }, [sections, createdSections])

  const createSections = useCallback(async () => {
    const names = [...sectionPicked].filter((name) => !createdSections[name])
    if (!names.length) {
      toast('没有要建的大类')
      return
    }
    setCreatingSections(true)
    try {
      const result = await api.post(`/api/price-scan/jobs/${job.id}/categories`, { names })
      const made = result?.created || []
      const skipped = result?.skipped || []
      if (made.length) {
        setCreatedSections((current) => {
          const next = { ...current }
          for (const row of made) next[row.name] = row.id
          return next
        })
        setSectionPicked(new Set())
        await loadCategories()
      }
      /**
       * 跳过的要说清楚为什么。用户勾了 5 个只建出 3 个却只看到一句「建好了」，
       * 剩下 2 个就得自己一个个去猜 —— 是重名？还是名字不合法？
       */
      const dup = skipped.filter((s) => s.reason === 'duplicate')
      if (made.length && !skipped.length) toast(`建好了 ${made.length} 个大类`)
      else if (made.length) toast(`建好了 ${made.length} 个，跳过 ${skipped.length} 个（${dup.length ? '已有同名' : skipped[0]?.reason || '不合法'}）`)
      else if (dup.length) toastErr(`这 ${dup.length} 个大类都已经有了`)
      else toastErr('一个都没建成，检查一下名字')
    } catch (err) {
      toastErr(err)
    } finally {
      setCreatingSections(false)
    }
  }, [sectionPicked, createdSections, job?.id, loadCategories])

  /**
   * 从扫描结果建服务项。
   *
   * 这是给**新加的游戏**用的：库里一个服务项都没有时，比价必然 0 匹配 ——
   * 不是坏了，是没东西可以匹配。这一步让 AI 把认出来的名字合并、起名、归类，
   * 用户改完勾选，一键建进库里，**下次扫描就能匹上了**。
   */
  const [proposals, setProposals] = useState(null)
  const [proposalAi, setProposalAi] = useState(null)
  const [proposalError, setProposalError] = useState('')
  const [proposalLoading, setProposalLoading] = useState(false)
  const [proposalPicked, setProposalPicked] = useState(new Set())
  /** 用户改过的名字 / 价格 / 大类，按来源名字存 —— 用下标存的话删一条就全错位了 */
  const [proposalEdits, setProposalEdits] = useState({})
  const [creatingServices, setCreatingServices] = useState(false)

  const loadProposals = useCallback(async () => {
    if (!job?.id) return
    setProposalLoading(true)
    setProposalError('')
    try {
      const data = await api.post(`/api/price-scan/jobs/${job.id}/propose-services`, {})
      setProposals(data?.items || [])
      setProposalAi(data?.ai || null)
      setProposalPicked(new Set())
      setProposalEdits({})
    } catch (err) {
      setProposalError(String(err?.message || err))
    } finally {
      setProposalLoading(false)
    }
  }, [job?.id])

  /** 编辑值：用户没改过就用 AI 给的 */
  const proposalValue = useCallback((item, field) => {
    const key = item.sources[0]
    const edit = proposalEdits[key]
    if (edit && edit[field] !== undefined) return edit[field]
    if (field === 'category_id') return item.category_id ?? ''
    return item[field]
  }, [proposalEdits])

  const editProposal = useCallback((item, field, value) => {
    const key = item.sources[0]
    setProposalEdits((current) => ({ ...current, [key]: { ...(current[key] || {}), [field]: value } }))
  }, [])

  const createServices = useCallback(async () => {
    const items = (proposals || [])
      .filter((item) => proposalPicked.has(item.sources[0]))
      .map((item) => ({
        name: String(proposalValue(item, 'name') || '').trim(),
        price: Number(proposalValue(item, 'price')),
        category_id: proposalValue(item, 'category_id') || null,
        sources: item.sources,
      }))
    if (!items.length) {
      toast('没有要建的服务项')
      return
    }
    setCreatingServices(true)
    try {
      const result = await api.post(`/api/price-scan/jobs/${job.id}/services`, { items })
      const made = result?.created || []
      const skipped = result?.skipped || []
      if (made.length) {
        // 建完把建过的从清单里去掉 —— 留着的话用户会重复勾，然后被告知「重名」
        setProposals((current) => (current || []).filter((item) => !proposalPicked.has(item.sources[0])))
        setProposalPicked(new Set())
        await Promise.all([loadServices(), loadCategories()])
        toast(`建好了 ${made.length} 个服务项，扫描到的价也一起写进去了`)
      }
      if (skipped.length) {
        const dup = skipped.filter((s) => s.reason === 'duplicate')
        toastErr(`${skipped.length} 个没建：${dup.length ? '已有同名服务项' : skipped[0]?.reason || '名字或价格不合法'}`)
      }
    } catch (err) {
      toastErr(err)
    } finally {
      setCreatingServices(false)
    }
  }, [proposals, proposalPicked, proposalValue, job?.id, loadServices, loadCategories])

  /** 这一行最终会写到哪个服务项上 */
  const targetOf = useCallback((row) => targets[row.service_id] ?? row.service_id, [targets])

  /**
   * 两个建议行被改派到了同一个服务项 —— 后写的会盖掉先写的。
   * 这种事必须当场拦下来，不然用户以为写了两项，实际只落了一项。
   */
  const conflicts = useMemo(() => {
    const seen = new Map()
    for (const row of job?.matched || []) {
      if (!picked.has(row.service_id)) continue
      const id = targetOf(row)
      seen.set(id, (seen.get(id) || 0) + 1)
    }
    return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id))
  }, [job?.matched, picked, targetOf])

  useEffect(() => {
    if (!keyword) setKeyword(`${game.name} 代肝 价格表`)
  }, [game.name, keyword])

  /* ---- 轮询进度 ---- */
  useEffect(() => {
    if (!jobId) return undefined
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        const next = await api.get(`/api/price-scan/jobs/${jobId}`)
        if (stopped) return
        setJob(next)
        if (next.status === 'running') {
          pollRef.current = window.setTimeout(tick, 1500)
        } else if (next.status === 'done' && next.matched?.length && autoPickRef.current) {
          // 第一次拿到结果时，把「样本够 + 确实有变化」的行默认勾上 ——
          // 这是用户最可能想写的那些，其余让他自己挑。
          // autoPickRef 是关着的（恢复历史结果）就一律不勾，见它的定义处。
          setPicked((current) => {
            if (current.size) return current
            const chosen = new Set()
            for (const row of next.matched || []) {
              if (row.enough && row.suggested_price !== null) chosen.add(row.service_id)
            }
            return chosen
          })
        }
      } catch (err) {
        if (!stopped) toastErr(err)
      }
    }
    pollRef.current = window.setTimeout(tick, 600)
    return () => {
      stopped = true
      window.clearTimeout(pollRef.current)
    }
  }, [jobId])

  /* ---- 装依赖 ---- */
  useEffect(() => {
    if (!installing?.id) return undefined
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        const next = await api.get(`/api/price-scan/install/${installing.id}`)
        if (stopped) return
        setInstalling(next)
        if (next.status === 'running') {
          pollRef.current = window.setTimeout(tick, 1200)
        } else {
          if (next.status === 'done') toast('yt-dlp 装好了')
          if (next.status === 'failed') toastErr(next.error || '安装失败')
          void loadReadiness()
        }
      } catch (err) {
        if (!stopped) toastErr(err)
      }
    }
    pollRef.current = window.setTimeout(tick, 800)
    return () => {
      stopped = true
      window.clearTimeout(pollRef.current)
    }
  }, [installing?.id, loadReadiness])

  /* ---- 动作 ---- */

  const start = async () => {
    setStarting(true)
    setJob(null)
    setRestored(false)
    autoPickRef.current = true
    setPicked(new Set())
    setEdited({})
    setExpanded(new Set())
    setTab('all')
    try {
      const result = await api.post('/api/price-scan/start', {
        game_id: game.id,
        keyword: keyword.trim(),
        max_videos: Number(maxVideos) || 8,
        min_samples: Number(minSamples) || 3,
        refresh,
      })
      if (!result.ok) {
        toastErr(result.error || '起不来')
        if (result.job) setJob(result.job)
        return
      }
      setJob(result.job)
      toast('开始扫描了，进度会实时更新')
    } catch (err) {
      toastErr(err)
    } finally {
      setStarting(false)
    }
  }

  const cancel = async () => {
    try {
      const result = await api.post(`/api/price-scan/jobs/${jobId}/cancel`, {})
      if (!result.ok) toastErr(result.error || '取消失败')
      else toast('正在取消…')
    } catch (err) {
      toastErr(err)
    }
  }

  const install = async () => {
    try {
      const result = await api.post('/api/price-scan/install', {})
      if (!result.ok) {
        toastErr(result.error || '装不了')
        if (result.status) setReadiness((current) => ({ ...current, ...result.status }))
        return
      }
      if (result.already) {
        toast(result.message || '已经装好了')
        void loadReadiness()
        return
      }
      setInstalling({ id: result.job, status: 'running', step: '准备安装', log: '' })
    } catch (err) {
      toastErr(err)
    }
  }

  const apply = async () => {
    if (conflicts.size) {
      toastErr('有两行被改派到了同一个服务项，先错开再写')
      return
    }
    const rows = [...picked]
      .map((serviceId) => {
        const row = (job?.matched || []).find((item) => item.service_id === serviceId)
        if (!row) return null
        const price = edited[serviceId] !== undefined ? Number(edited[serviceId]) : Number(row.suggested_price)
        if (!Number.isFinite(price) || price < 0) return null
        // 改派过的行写它改到的那个服务项
        const target = targetOf(row)
        /**
         * 包含内容跟着**改派后的那一项**走，而且只在用户勾了「顺便补上」时带。
         * 从这一行的样本里挑一条有 inclusions 的 —— AI 抽的是视频原文，不加工。
         */
        const inclusions = fillInclusions && target === serviceId
          ? (row.samples || []).find((s) => s.inclusions)?.inclusions || ''
          : ''
        return { service_id: target, price, inclusions }
      })
      .filter(Boolean)
    if (!rows.length) {
      toastErr('还没勾选要写入的行')
      return
    }
    setApplying(true)
    try {
      const result = await api.post(`/api/price-scan/jobs/${jobId}/apply`, { rows, fill_inclusions: fillInclusions })
      const extra = result.filled?.length ? `，补了 ${result.filled.length} 项的包含内容` : ''
      toast(`写入完成：改了 ${result.changed} 项（提交 ${result.applied.length} 项）${extra}`)
      if (onApplied) onApplied(result)
      close(result)
    } catch (err) {
      toastErr(err)
    } finally {
      setApplying(false)
    }
  }

  const reassign = (serviceId, nextTargetId) => {
    setTargets((current) => {
      const next = { ...current }
      // 改回它原本匹配到的项，就等于没改派过
      if (nextTargetId === serviceId) delete next[serviceId]
      else next[serviceId] = nextTargetId
      return next
    })
  }

  const togglePick = (serviceId) => {
    setPicked((current) => {
      const next = new Set(current)
      if (next.has(serviceId)) next.delete(serviceId)
      else next.add(serviceId)
      return next
    })
  }

  const toggleExpand = (serviceId) => {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(serviceId)) next.delete(serviceId)
      else next.add(serviceId)
      return next
    })
  }

  /* ---- 派生数据 ---- */

  const rows = useMemo(() => {
    const list = [...(job?.matched || [])]
    list.sort((a, b) => rowRank(a) - rowRank(b) || b.sample_count - a.sample_count || a.service_name.localeCompare(b.service_name, 'zh'))
    return list
  }, [job?.matched])

  const counts = useMemo(() => {
    const list = job?.matched || []
    return {
      all: list.length,
      ready: list.filter((row) => row.enough && row.sample_count > 0).length,
      insufficient: list.filter((row) => !row.enough && row.sample_count > 0).length,
      none: list.filter((row) => !row.sample_count).length,
      unmatched: (job?.unmatched || []).length,
    }
  }, [job?.matched, job?.unmatched])

  const visibleRows = useMemo(() => {
    if (tab === 'ready') return rows.filter((row) => row.enough && row.sample_count > 0)
    if (tab === 'insufficient') return rows.filter((row) => !row.enough && row.sample_count > 0)
    if (tab === 'none') return rows.filter((row) => !row.sample_count)
    return rows
  }, [rows, tab])

  const pickCount = picked.size
  /** 勾选的行里，有几项的样本带着 AI 抽到的「包含内容」—— 没有就不显示那个勾选框 */
  const inclusionCount = [...picked].filter((serviceId) => {
    const row = (job?.matched || []).find((item) => item.service_id === serviceId)
    return (row?.samples || []).some((s) => s.inclusions)
  }).length
  const running = job?.status === 'running'
  const done = job?.status === 'done'
  const failed = job?.status === 'failed'
  const blocked = readiness && !readiness.ready

  /* ---- 渲染 ---- */

  const footer = done && tab === 'build' && proposals ? (
    <div className="ps-foot">
      <span className="ps-foot__note">
        已勾选 <b>{proposalPicked.size}</b> 个，建成后挂在「{game.name}」下，
        <b>扫描到的价会一起写成基准价</b>，视频里的原话会记成别名
      </span>
      <div className="ps-foot__actions">
        <button className="refactor-button" type="button" onClick={close}>先不建</button>
        <button className="refactor-button refactor-button--primary" type="button" disabled={!proposalPicked.size || creatingServices} onClick={createServices}>
          {creatingServices ? <Loader2 {...iconProps(15)} className="ps-spin" /> : <Plus {...iconProps(15)} />}
          建选中的 {proposalPicked.size} 个服务项
        </button>
      </div>
    </div>
  ) : done && tab === 'sections' ? (
    <div className="ps-foot">
      <span className="ps-foot__note">
        已勾选 <b>{sectionPicked.size}</b> 个，建成后挂在「{game.name}」下，只建大类、不建服务项
      </span>
      <div className="ps-foot__actions">
        <button className="refactor-button" type="button" onClick={close}>先不建</button>
        <button className="refactor-button refactor-button--primary" type="button" disabled={!sectionPicked.size || creatingSections} onClick={createSections}>
          {creatingSections ? <Loader2 {...iconProps(15)} className="ps-spin" /> : <Plus {...iconProps(15)} />}
          建选中的 {sectionPicked.size} 个大类
        </button>
      </div>
    </div>
  ) : done && rows.length ? (
    <div className="ps-foot">
      <span className="ps-foot__note">
        {conflicts.size
          ? <span className="ps-foot__bad">有 {conflicts.size} 个服务项被两行同时改派到了，先错开</span>
          : <>已勾选 <b>{pickCount}</b> 项，只改<strong>基准价</strong>，不动阶梯价和增项</>}
        {pickCount && inclusionCount ? (
          <label className="ps-foot__opt">
            <input type="checkbox" checked={fillInclusions} onChange={(event) => setFillInclusions(event.target.checked)} />
            顺便把视频里写的包含内容补进服务项（只追加，不覆盖已有的）
            <em>{inclusionCount} 项有</em>
          </label>
        ) : null}
      </span>
      <div className="ps-foot__actions">
        <button className="refactor-button" type="button" onClick={close}>先不写</button>
        <button className="refactor-button refactor-button--primary" type="button" disabled={!pickCount || applying || conflicts.size > 0} onClick={apply}>
          {applying ? <Loader2 {...iconProps(15)} className="ps-spin" /> : <Download {...iconProps(15)} />}
          写入选中的 {pickCount} 项
        </button>
      </div>
    </div>
  ) : null

  return (
    <Drawer
      wide
      title="B站自动比价"
      subtitle={`${game.name} · 搜价格表视频，认出价格后取中位数给你确认`}
      onClose={close}
      footer={footer}
    >
      <div className="ps">
        {/* ---------- 环境检查 ---------- */}
        {readiness === null ? (
          <div className="ps-loading"><Loader2 {...iconProps(18)} className="ps-spin" /><span>正在检查环境…</span></div>
        ) : null}

        {blocked ? (
          <div className="ps-block">
            <div className="ps-block__head"><AlertTriangle {...iconProps(17)} /><b>还不能用，先解决这几件事</b></div>
            <ul className="ps-block__list">
              {readiness.blockers.map((item) => <li key={item.code}>{item.message}</li>)}
            </ul>
            {installing ? (
              <div className="ps-install">
                <div className="ps-install__step"><Loader2 {...iconProps(14)} className="ps-spin" />{installing.step || '安装中…'}</div>
                <pre className="ps-install__log">{(installing.log || '').slice(-1200)}</pre>
              </div>
            ) : (
              <div className="ps-block__actions">
                {readiness.blockers.some((item) => item.code === 'ytdlp') ? (
                  <button className="refactor-button refactor-button--primary" type="button" onClick={install}><Download {...iconProps(15)} />自动安装 yt-dlp</button>
                ) : null}
                <button className="refactor-button" type="button" onClick={loadReadiness}><RefreshCw {...iconProps(15)} />重新检查</button>
              </div>
            )}
          </div>
        ) : null}

        {readiness && !blocked ? (
          <>
            {/* ---------- 起任务 ---------- */}
            <section className="ps-setup">
              <div className="ps-setup__row">
                <label className="ps-field ps-field--grow">
                  <span>搜索关键词</span>
                  <span className="ps-input"><Search {...iconProps(14)} /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder={`${game.name} 代肝 价格表`} disabled={running} /></span>
                </label>
                <label className="ps-field">
                  <span>最多看几个视频</span>
                  <input type="number" min="1" max="20" value={maxVideos} onChange={(event) => setMaxVideos(event.target.value)} disabled={running} />
                </label>
                <label className="ps-field">
                  <span>至少几个样本</span>
                  <input type="number" min="1" max="20" value={minSamples} onChange={(event) => setMinSamples(event.target.value)} disabled={running} />
                </label>
                <div className="ps-setup__go">
                  {running ? (
                    <button className="refactor-button" type="button" onClick={cancel}><Square {...iconProps(15)} />取消</button>
                  ) : (
                    <button className="refactor-button refactor-button--primary" type="button" onClick={start} disabled={starting}>
                      {starting ? <Loader2 {...iconProps(15)} className="ps-spin" /> : <Play {...iconProps(15)} />}
                      开始扫描
                    </button>
                  )}
                </div>
              </div>
              <p className="ps-setup__hint">
                下载视频、抽帧、逐帧 OCR 认价，再和库内 {game.name} 的服务项对齐，按多个视频取中位数。
                跑一次通常要一两分钟。认不出的会单列出来，不会瞎猜。
              </p>
              <label className="ps-foot__opt ps-setup__refresh">
                <input type="checkbox" checked={refresh} onChange={(event) => setRefresh(event.target.checked)} disabled={running} />
                <span>
                  重新扫一遍（默认跳过扫过的视频）
                  <em>同一个视频的下载和 OCR 结果会留着复用，第二次扫快得多。只有视频里的价格表变了、或者想换一批视频时才需要勾。</em>
                </span>
              </label>

              {/* ---------- AI 甄别（可选） ---------- */}
              <div className={`ps-ai${ai?.configured ? ' is-on' : ''}`}>
                <button className="ps-ai__head" type="button" onClick={() => setAiOpen((v) => !v)}>
                  <Sparkles {...iconProps(13)} />
                  <span className="ps-ai__title">AI 甄别</span>
                  <span className="ps-ai__state">
                    {ai?.configured ? `${ai.model}` : '没配（不影响用，配上更准）'}
                  </span>
                  <ChevronDown {...iconProps(13)} className={`ps-ai__caret${aiOpen ? ' is-open' : ''}`} />
                </button>
                {aiOpen ? (
                  <div className="ps-ai__body">
                    <p className="ps-ai__why">
                      价格表视频里混着主播口播、聊天记录、播放器界面 —— 实测约两成「认出来的价」根本不是价。
                      规则判不了（<code>改为</code>、<code>星期三</code> 单看都像正常词），接个模型就能判。
                      <strong>模型碰不到价格</strong>：它只能决定留不留、什么口径、名字要不要改，价格永远来自 OCR 原文。
                    </p>
                    <div className="ps-ai__grid">
                      <label className="ps-field">
                        <span>接口地址（OpenAI 兼容）</span>
                        <input
                          value={aiForm.base_url}
                          onChange={(event) => setAiForm((f) => ({ ...f, base_url: event.target.value }))}
                          placeholder="https://api.deepseek.com/v1"
                          disabled={aiSaving}
                        />
                      </label>
                      <label className="ps-field">
                        <span>模型名</span>
                        <input
                          value={aiForm.model}
                          onChange={(event) => setAiForm((f) => ({ ...f, model: event.target.value }))}
                          placeholder="deepseek-chat"
                          disabled={aiSaving}
                        />
                      </label>
                      <label className="ps-field ps-field--grow">
                        <span>
                          API key
                          {ai?.key_set ? <em className="ps-ai__kept">已配置（尾号 {ai.key_tail}，留空就是不改）</em> : null}
                        </span>
                        <input
                          type="password"
                          value={aiForm.api_key}
                          onChange={(event) => setAiForm((f) => ({ ...f, api_key: event.target.value }))}
                          placeholder={ai?.key_set ? '留空表示不改' : 'sk-…'}
                          disabled={aiSaving}
                          autoComplete="off"
                        />
                      </label>
                    </div>
                    <div className="ps-ai__foot">
                      <span className="ps-ai__note">
                        {ai?.key_source === 'env'
                          ? 'key 来自环境变量 XFC_AI_API_KEY（不会写进数据库）'
                          : ai?.key_set ? 'key 存在本地数据库里，只在服务端使用，接口从不回明文' : 'key 只在服务端使用'}
                      </span>
                      <div className="ps-ai__actions">
                        {ai?.key_set ? (
                          <button className="ps-link" type="button" disabled={aiSaving} onClick={() => saveAi({ clear_key: true, api_key: '' })}>清掉 key</button>
                        ) : null}
                        <button className="refactor-button" type="button" disabled={aiSaving || !ai?.key_set} onClick={probeAi}>
                          {aiTest?.pending ? <Loader2 {...iconProps(14)} className="ps-spin" /> : <RefreshCw {...iconProps(14)} />}
                          测试连接
                        </button>
                        <button className="refactor-button refactor-button--primary" type="button" disabled={aiSaving} onClick={() => saveAi()}>
                          {aiSaving ? <Loader2 {...iconProps(14)} className="ps-spin" /> : null}
                          保存
                        </button>
                      </div>
                    </div>
                    {aiTest && !aiTest.pending ? (
                      <div className={`ps-ai__result${aiTest.ok ? ' is-ok' : ' is-bad'}`}>
                        {aiTest.ok
                          ? `连上了：${aiTest.model || ''} 用了 ${aiTest.ms}ms`
                          : `连不上：${aiTest.error}`}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </section>

            {/* ---------- 进度 ---------- */}
            {job ? (
              <section className="ps-progress">
                {restored && !running ? (
                  <div className="ps-restored">
                    <RefreshCw {...iconProps(13)} />
                    <span>
                      这是<strong>{fmtWhen(job.created_at)}</strong>那次扫描的结果（关键词「{job.keyword}」），不是刚跑的。
                      价格表可能已经变过了，要重新对一遍就再点一次「开始扫描」。
                    </span>
                  </div>
                ) : null}
                <div className="ps-progress__head">
                  <span className={`ps-status ps-status--${job.status}`}>
                    {running ? <Loader2 {...iconProps(13)} className="ps-spin" /> : failed ? <AlertTriangle {...iconProps(13)} /> : <CheckCircle2 {...iconProps(13)} />}
                    {job.stage || job.status}
                  </span>
                  <span className="ps-progress__meta">
                    关键词「{job.keyword}」 · 视频 {job.progress?.videos_done || 0}/{job.progress?.videos_total || 0}
                    {' '}· 抽帧 {job.progress?.frames || 0} · 已识别 {job.progress?.ocr_frames || 0} 帧
                    {' '}· 认出 {job.progress?.parsed_names || 0} 个名字
                    {job.progress?.reused_videos ? <>{' '}· <span className="ps-progress__reused">复用 {job.progress.reused_videos} 个（没重新下载）</span></> : null}
                  </span>
                </div>
                {job.error ? <div className="ps-error">{job.error}</div> : null}

                {job.videos?.length ? (
                  <div className="ps-videos">
                    {job.videos.map((video) => (
                      <div key={video.bvid} className={`ps-video is-${video.status}`}>
                        <span className="ps-video__bvid">{video.bvid}</span>
                        <span className="ps-video__title" title={video.title}>{video.title}</span>
                        <span className="ps-video__stat">
                          {video.status === 'failed' ? <span className="ps-bad" title={video.error}>{video.error || '失败'}</span>
                            : video.status === 'parsed' ? `认出 ${video.parsed} 项（${video.ocr_frames}/${video.frames} 帧）`
                              : video.status === 'cached' ? <span className="ps-video__reused" title="这个视频上次扫过了，直接用了上次的识别结果，没有重新下载和 OCR">复用上次结果 · 认出 {video.parsed} 项</span>
                                : video.status === 'pending' ? '排队中' : '处理中…'}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}

                {job.ai?.enabled || job.ai?.errors ? (
                  <div className={`ps-aibar${job.ai?.errors ? ' is-bad' : ''}`}>
                    {job.ai.errors ? <AlertTriangle {...iconProps(12)} /> : <Sparkles {...iconProps(12)} />}
                    {job.ai.errors ? (
                      <span>
                        <strong>AI 这一步没成功</strong>（{job.ai.errors} 次），所以这次的结果是**纯规则**跑出来的。
                        {job.ai.last_error ? <em className="ps-aibar__err">{job.ai.last_error}</em> : null}
                        <br />
                        价格表照样能用，只是少了一道甄别。去上面「AI 甄别」里点一下「测试连接」看看。
                      </span>
                    ) : (
                      <span>
                        <strong>{job.ai.model}</strong> 过了一遍：剔掉 <b>{job.ai.dropped}</b> 行不是价格的
                        {job.ai.drop_overridden ? <>、拦下 <b>{job.ai.drop_overridden}</b> 行「库内确实有这一项」的误删</> : null}
                        {job.ai.renamed ? <>、纠正 <b>{job.ai.renamed}</b> 个认歪的名字</> : null}
                        {job.ai.rescued ? <>、兜底匹上 <b>{job.ai.rescued}</b> 个</> : null}
                        。<em>价格一个字都没动过。</em>
                        {job.ai.cached ? <em className="ps-aibar__cached">其中 {job.ai.cached} 个视频的判断是复用的（同一个视频、同一个模型、库没变，答案就不会变）。</em> : null}
                      </span>
                    )}
                    {job.ai.dropped_samples?.length ? (
                      <details className="ps-aibar__detail">
                        <summary>看剔掉了什么</summary>
                        <ul>
                          {job.ai.dropped_samples.map((s) => <li key={s}>{s}</li>)}
                        </ul>
                      </details>
                    ) : null}
                    {job.ai.renamed_samples?.length ? (
                      <details className="ps-aibar__detail">
                        <summary>看纠正了哪些名字</summary>
                        <ul>
                          {job.ai.renamed_samples.map((s) => <li key={s}>{s}</li>)}
                        </ul>
                      </details>
                    ) : null}
                    {job.ai.drop_overridden_samples?.length ? (
                      <details className="ps-aibar__detail">
                        <summary>看拦下了什么</summary>
                        <ul>
                          {job.ai.drop_overridden_samples.map((s) => <li key={s}>{s}</li>)}
                        </ul>
                      </details>
                    ) : null}
                    {job.ai.rename_rejected_samples?.length ? (
                      <details className="ps-aibar__detail">
                        <summary>看拒了哪些改名</summary>
                        <ul>
                          {job.ai.rename_rejected_samples.map((s) => <li key={s}>{s}</li>)}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                ) : null}

                {running && job.log?.length ? (
                  <details className="ps-logbox">
                    <summary>看日志（{job.log.length} 条）</summary>
                    <pre className="ps-log">{job.log.map((line) => line.text).join('\n')}</pre>
                  </details>
                ) : null}
              </section>
            ) : null}

            {/* ---------- 预览 ---------- */}
            {done && (rows.length || counts.unmatched || sections.length) ? (
              <section className="ps-result">
                <div className="ps-tabs" role="tablist">
                  <button className={tab === 'all' ? 'is-active' : ''} type="button" onClick={() => setTab('all')}>全部 {counts.all}</button>
                  <button className={tab === 'ready' ? 'is-active' : ''} type="button" onClick={() => setTab('ready')}>样本够 {counts.ready}</button>
                  <button className={tab === 'insufficient' ? 'is-active' : ''} type="button" onClick={() => setTab('insufficient')}>样本不足 {counts.insufficient}</button>
                  <button className={tab === 'none' ? 'is-active' : ''} type="button" onClick={() => setTab('none')}>没给出建议 {counts.none}</button>
                  <button className={tab === 'unmatched' ? 'is-active' : ''} type="button" onClick={() => setTab('unmatched')}>没匹配上 {counts.unmatched}</button>
                  {sections.length ? (
                    <button className={tab === 'sections' ? 'is-active' : ''} type="button" onClick={() => setTab('sections')}>大类候选 {sections.length}</button>
                  ) : null}
                  {counts.unmatched ? (
                    <button className={tab === 'build' ? 'is-active' : ''} type="button" onClick={() => setTab('build')}>
                      建服务项 {proposals ? proposals.length : counts.unmatched}
                    </button>
                  ) : null}
                  <div className="ps-tabs__spacer" />
                  {tab === 'sections' ? (
                    <>
                      <button className="ps-link" type="button" onClick={pickCleanSections}>勾上不重复的</button>
                      <button className="ps-link" type="button" onClick={() => setSectionPicked(new Set())}>清空</button>
                    </>
                  ) : tab === 'build' ? null : (
                    <>
                      <button className="ps-link" type="button" onClick={() => setPicked(new Set(rows.filter((row) => row.enough && row.suggested_price !== null).map((row) => row.service_id)))}>全选样本够的</button>
                      <button className="ps-link" type="button" onClick={() => setPicked(new Set())}>清空</button>
                    </>
                  )}
                </div>

                {tab === 'unmatched' ? (
                  <UnmatchedList items={job.unmatched || []} />
                ) : tab === 'build' ? (
                  <ServiceProposalPanel
                    items={proposals}
                    ai={proposalAi}
                    loading={proposalLoading}
                    error={proposalError}
                    picked={proposalPicked}
                    categories={categoryOptions}
                    valueOf={proposalValue}
                    onEdit={editProposal}
                    onReload={loadProposals}
                    onToggle={(key) => setProposalPicked((current) => {
                      const next = new Set(current)
                      if (next.has(key)) next.delete(key)
                      else next.add(key)
                      return next
                    })}
                    onPickAll={() => setProposalPicked(new Set((proposals || []).map((item) => item.sources[0])))}
                    onClear={() => setProposalPicked(new Set())}
                  />
                ) : tab === 'sections' ? (
                  <SectionList
                    sections={sections}
                    existing={categoryNames}
                    picked={sectionPicked}
                    created={createdSections}
                    onToggle={(name) => setSectionPicked((current) => {
                      const next = new Set(current)
                      if (next.has(name)) next.delete(name)
                      else next.add(name)
                      return next
                    })}
                  />
                ) : (
                  <div className="ps-table">
                    {visibleRows.map((row) => (
                      <PreviewRow
                        key={row.service_id}
                        row={row}
                        jobId={job.id}
                        services={services}
                        serviceMap={serviceMap}
                        targetId={targetOf(row)}
                        conflict={conflicts.has(targetOf(row))}
                        applied={appliedMap.get(targetOf(row))}
                        picked={picked.has(row.service_id)}
                        edited={edited[row.service_id]}
                        expanded={expanded.has(row.service_id)}
                        onTogglePick={() => togglePick(row.service_id)}
                        onToggleExpand={() => toggleExpand(row.service_id)}
                        onEdit={(value) => setEdited((current) => ({ ...current, [row.service_id]: value }))}
                        onReassign={(nextId) => reassign(row.service_id, nextId)}
                      />
                    ))}
                    {!visibleRows.length ? <div className="ps-empty">这一类里没有内容</div> : null}
                  </div>
                )}
              </section>
            ) : null}
          </>
        ) : null}
      </div>
    </Drawer>
  )
}

/* ============================================================
   一行建议
   ============================================================ */

/** AI 判出来的口径，翻成人话显示在样本上 */
const SCOPE_TEXT = Object.freeze({
  per_day: '每天',
  per_week: '每周',
  per_month: '每月',
  per_period: '每期',
  per_unit: '按个数',
  total: '一次性',
})

function PreviewRow({ row, jobId, services, serviceMap, targetId, conflict, applied, picked, edited, expanded, onTogglePick, onToggleExpand, onEdit, onReassign }) {
  const noSuggestion = row.suggested_price === null
  const reassigned = targetId !== row.service_id
  /**
   * 改派之后，「现价 → 建议价」里的现价要跟着换成**目标服务项**的现价。
   * 这里是最容易出错的地方：显示的现价、算出来的涨跌，必须都是「即将被覆盖的那个值」，
   * 而不是原来匹配到的那个项的。否则用户看着 A 的现价，实际写的是 B。
   */
  const target = reassigned ? serviceMap.get(targetId) : null
  const currentPrice = target ? target.base_price : row.current_price
  const targetName = target ? target.name : row.service_name
  const targetUnit = target ? target.unit_label : row.service_unit
  const delta = deltaLabel({ current_price: currentPrice, suggested_price: row.suggested_price })
  const price = edited !== undefined ? edited : row.suggested_price === null ? '' : String(row.suggested_price)
  const reason = row.only_unit_mismatch
    ? '视频里的计价单位和库内不一致，不拿来比'
    : row.only_ambiguous
      ? '同一个视频给了多个口径，无法确定用哪个'
      : row.only_low_confidence
        ? '匹配分太低，不敢认'
        : noSuggestion ? '没有可用样本' : ''

  return (
    <div className={`ps-row${picked ? ' is-picked' : ''}${noSuggestion ? ' is-empty' : ''}${reassigned ? ' is-reassigned' : ''}${conflict ? ' is-conflict' : ''}`}>
      <div className="ps-row__main">
        <label className="ps-row__pick">
          <input type="checkbox" checked={picked} onChange={onTogglePick} />
        </label>
        <button className="ps-row__expand" type="button" onClick={onToggleExpand} aria-label="展开来源">
          {expanded ? <ChevronDown {...iconProps(14)} /> : <ChevronRight {...iconProps(14)} />}
        </button>

        <div className="ps-row__name">
          <select
            className="ps-row__select"
            value={String(targetId)}
            onChange={(event) => onReassign(Number(event.target.value))}
            title={reassigned ? `原本匹配到「${row.service_name}」，已改派到这里` : '认错服务项了就改派到正确的那个'}
          >
            {/* 匹配到的那个项可能已经被归档（不在 services 里），补一个选项免得选不回去 */}
            {!serviceMap.has(row.service_id) ? <option value={String(row.service_id)}>{row.service_name}（已归档）</option> : null}
            {services.map((service) => (
              <option key={service.id} value={String(service.id)}>
                {service.name}{service.unit_label ? ` /${service.unit_label}` : ''}　现价 ¥{fmtMoney(service.base_price)}
              </option>
            ))}
          </select>
          {targetUnit ? <span className="ps-tag">/{targetUnit}</span> : null}
          {row.confidence === 'low' && !reassigned ? <span className="ps-tag ps-tag--warn" title="匹配分低，请重点核对">低置信</span> : null}
          {reassigned ? <span className="ps-tag ps-tag--warn" title={`原本匹配到「${row.service_name}」`}>已改派</span> : null}
          {conflict ? <span className="ps-tag ps-tag--bad" title="另一行也被改派到了这个服务项，先错开再写">撞项</span> : null}
          {applied ? <span className="ps-tag ps-tag--done" title={`这次任务已经写过：${applied.before} → ${applied.after}`}>已写入 {applied.after}</span> : null}
          {row.category_name && !reassigned ? <small>{row.category_name}</small> : null}
        </div>

        <div className="ps-row__price">
          <span className="ps-old" title={reassigned ? `「${targetName}」的现价` : '现价'}>¥{fmtMoney(currentPrice)}</span>
          <span className="ps-arrow">→</span>
          <input
            className="ps-new"
            type="number"
            step="0.01"
            min="0"
            value={price}
            placeholder="—"
            onChange={(event) => onEdit(event.target.value)}
            disabled={noSuggestion && edited === undefined}
          />
        </div>

        <div className={`ps-row__delta is-${delta.tone}`}>{delta.text}</div>

        <div className="ps-row__samples" title={`样本价：${row.prices.join('、')}`}>
          {row.sample_count ? (
            <>
              <b>{row.sample_count}</b> 个样本
              {!row.enough ? <span className="ps-tag ps-tag--warn">不足 {row.min_samples}</span> : null}
            </>
          ) : (
            <span className="ps-tag ps-tag--muted" title={reason}>无样本</span>
          )}
        </div>
      </div>

      {expanded ? (
        <div className="ps-detail">
          {reason && !row.sample_count ? <div className="ps-detail__note"><AlertTriangle {...iconProps(13)} />{reason}</div> : null}

          {row.samples?.length ? (
            <div className="ps-detail__block">
              <div className="ps-detail__title">参与计算的样本（{row.samples.length} 个视频）</div>
              {row.samples.map((sample, index) => (
                <div key={`${sample.video}-${index}`} className="ps-sample">
                  <span className="ps-sample__price">¥{fmtMoney(sample.price)}{sample.unit ? `/${sample.unit}` : ''}</span>
                  <span className="ps-sample__name">「{sample.parsed_name}」</span>
                  <a className="ps-sample__video" href={`https://www.bilibili.com/video/${sample.video}`} target="_blank" rel="noreferrer" title={sample.video_title}>
                    {sample.video} <ExternalLink {...iconProps(11)} />
                  </a>
                  <span className="ps-sample__score" title={`匹配分 ${sample.score}（${sample.signal}）`}>{sample.score}</span>
                  {sample.matched_by === 'ai' ? (
                    <span className="ps-tag ps-tag--ai" title={`AI 兜底匹上的（把握：${sample.ai_confidence || '?'}）${sample.ai_why ? ` · ${sample.ai_why}` : ''}`}>AI 匹的</span>
                  ) : null}
                  {sample.scope ? (
                    <span className="ps-tag" title="AI 判出来的计价口径">{SCOPE_TEXT[sample.scope] || sample.scope}</span>
                  ) : null}
                  {sample.frame ? <FrameThumb jobId={jobId} frame={sample.frame} /> : null}
                  {sample.line ? <span className="ps-sample__line" title="OCR 认出来的整行原文">「{sample.line}」</span> : null}
                  {sample.inclusions ? <span className="ps-sample__inc" title="视频里说明的包含内容">含：{sample.inclusions}</span> : null}
                </div>
              ))}
            </div>
          ) : null}

          {row.excluded?.length ? (
            <div className="ps-detail__block">
              <div className="ps-detail__title">被剔除的样本（{row.excluded.length} 条）</div>
              {row.excluded.map((sample, index) => (
                <div key={`${sample.video}-x-${index}`} className="ps-sample is-excluded">
                  <span className="ps-sample__price">¥{fmtMoney(sample.price)}{sample.unit ? `/${sample.unit}` : ''}</span>
                  <span className="ps-sample__name">「{sample.parsed_name}」</span>
                  <span className="ps-sample__why">{sample.reason}</span>
                </div>
              ))}
            </div>
          ) : null}

          {row.dispersion ? (
            <div className="ps-detail__note">
              样本价 {row.prices.join('、')} · 四分位距 {row.dispersion.iqr}
              {row.dispersion.ratio !== null ? `（相对中位数 ${Math.round(row.dispersion.ratio * 100)}%）` : ''}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** 来源帧缩略图：点开看原图，这是核对 OCR 有没有认错的唯一办法 */
function FrameThumb({ jobId, frame }) {
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)
  const url = frameURL(frame)
  // 帧是中间产物，超过 24 小时会被清理。看旧任务时图就没了 ——
  // 与其给个碎图图标，不如直接说清楚为什么没了。
  if (broken) return <span className="ps-frame ps-frame--gone" title="这一帧的中间产物已经清理掉了（默认留 24 小时）">帧已清理</span>
  return (
    <>
      <button className="ps-frame" type="button" onClick={() => setOpen(true)} title="看这一帧原图">
        <img src={url} alt="来源帧" loading="lazy" onError={() => setBroken(true)} />
        <span className="ps-frame__icon"><ImageIcon {...iconProps(12)} /></span>
      </button>
      {open ? (
        <div className="ps-lightbox" role="dialog" onClick={() => setOpen(false)}>
          <img src={url} alt="来源帧原图" />
          <div className="ps-lightbox__hint">点任意处关闭 · 这一帧就是上面那个价的出处</div>
        </div>
      ) : null}
    </>
  )
}

/* ============================================================
   大类候选
   ============================================================ */

/**
 * 比较两个大类名像不像。
 *
 * 为什么不直接调后端的 compareNames：那是给「视频里的价 → 库里的服务项」用的，
 * 阈值和降级策略都是为价格服务的。这里只要一个「会不会是同一个东西」的判断，
 * 而且要能在渲染里同步算（每条候选都要和所有已有大类比一遍）。
 */
function normalizeName(value) {
  return String(value || '').replace(/[\s（）()【】[\]·、,，.。:：!！?？'"“”‘’—\-_/]/g, '').toLowerCase()
}

/** Dice 系数（按二元组）—— 比编辑距离更抗「托管 / 托管类」这种包含关系 */
function dice(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const grams = new Map()
  for (let i = 0; i < a.length - 1; i += 1) {
    const g = a.slice(i, i + 2)
    grams.set(g, (grams.get(g) || 0) + 1)
  }
  let hit = 0
  for (let i = 0; i < b.length - 1; i += 1) {
    const g = b.slice(i, i + 2)
    const n = grams.get(g) || 0
    if (n > 0) { hit += 1; grams.set(g, n - 1) }
  }
  return (2 * hit) / (a.length - 1 + b.length - 1)
}

/** 从视频分节标题里认出来的大类候选，勾选后批量建 */
function SectionList({ sections, picked, created, onToggle }) {
  if (!sections.length) return <div className="ps-empty">这次没从视频里认出分节标题</div>
  return (
    <div className="ps-sections">
      <p className="ps-sections__hint">
        价格表视频是按板块排的，板块名（<code>梦州地图</code>、<code>主线：</code>）就是大类。
        勾几个建出来，这些板块下的服务项下次就能对上号。
      </p>
      {sections.map((section) => {
        const built = created[section.name]
        return (
          <label
            key={section.name}
            className={`ps-section${picked.has(section.name) ? ' is-picked' : ''}${built ? ' is-done' : ''}`}
          >
            <input
              type="checkbox"
              checked={Boolean(picked.has(section.name) || built)}
              disabled={Boolean(built)}
              onChange={() => onToggle(section.name)}
            />
            <div className="ps-section__body">
              <div className="ps-section__head">
                <span className="ps-section__name">{section.name}</span>
                <span className="ps-tag">{section.video_count} 个视频</span>
                {built ? <span className="ps-tag ps-tag--done">已建好</span> : null}
                {section.dup && !built ? <span className="ps-tag ps-tag--bad" title="同名的大类已经存在">已有</span> : null}
                {!section.dup && section.similar && !built ? (
                  <span className="ps-tag ps-tag--warn" title="和已有的大类很像，可能本来就是同一个">像「{section.similar}」</span>
                ) : null}
              </div>
              {section.items?.length ? (
                <div className="ps-section__items">
                  这个板块下面认出来：
                  {section.items.slice(0, 8).map((item) => <span key={item} className="ps-chip ps-chip--sm">{item}</span>)}
                  {section.items.length > 8 ? <span className="ps-section__more">等 {section.items.length} 项</span> : null}
                </div>
              ) : null}
            </div>
          </label>
        )
      })}
    </div>
  )
}

/**
 * 把「没匹上的名字」建成服务项。
 *
 * 新加一个游戏时库里一个服务项都没有，比价必然 0 匹配 —— 不是坏了，
 * 是没东西可以匹配。这个面板就是补那一步：AI 把认出来的名字合并、起名、归类，
 * 用户改完勾选，一键建进库里，**下次扫描就能匹上了**。
 *
 * 名字改短了也不会丢匹配：建的时候会把**视频里的原话记成别名**，
 * 下次 `套餐①：至东国满探索100%探索+神瞳+前置任务+供奉` 照样能匹到「至东国满探索」。
 */
function ServiceProposalPanel({ items, ai, loading, error, picked, categories, valueOf, onEdit, onToggle, onReload, onPickAll, onClear }) {
  if (loading) return <div className="ps-empty">正在让 AI 整理这份清单…（大概十几秒）</div>
  if (error) {
    return (
      <div className="ps-empty">
        整理失败了：{error}
        <div className="ps-suggest__actions"><button className="ps-link" type="button" onClick={onReload}>再试一次</button></div>
      </div>
    )
  }
  if (!items) {
    return (
      <div className="ps-propose__intro">
        <p>
          库里没有能对上的服务项时，扫描出来的名字会全部落在「没匹配上」里。
          <b>这不是扫描坏了，是价格表里还没有这些项。</b>
          让 AI 把这些名字整理成一份可建的清单，你改完勾选，一键建进库里 ——
          <b>下次扫描就能匹上了</b>。
        </p>
        <button className="refactor-button refactor-button--primary" type="button" onClick={onReload}>
          让 AI 整理这份清单
        </button>
      </div>
    )
  }
  if (!items.length) return <div className="ps-empty">没有可建的名字</div>

  return (
    <div className="ps-propose">
      <p className="ps-propose__hint">
        名字和价格都能改。建的时候会<b>把视频里的原话记成别名</b>，
        所以你把名字改短（<code>套餐①：至东国满探索100%探索+…</code> → <code>至东国满探索</code>）
        下次照样能匹上。
        {ai?.enabled ? <span className="ps-propose__ai">AI 整理用了 {(ai.ms / 1000).toFixed(1)}s</span> : null}
        {ai && !ai.enabled ? <span className="ps-propose__warn">没配 AI，名字是视频里的原话，得你自己改</span> : null}
        {ai?.error ? <span className="ps-propose__warn">AI 没成功（{ai.error}），下面是原话</span> : null}
      </p>
      <div className="ps-tabs__tools">
        <button className="ps-link" type="button" onClick={onPickAll}>全选</button>
        <button className="ps-link" type="button" onClick={onClear}>清空</button>
        <button className="ps-link" type="button" onClick={onReload}>让 AI 重新整理</button>
      </div>
      <div className="ps-propose__list">
        {items.map((item) => {
          const key = item.sources[0]
          const on = picked.has(key)
          const renamed = String(valueOf(item, 'name')) !== item.sources[0]
          return (
            <div key={key} className={`ps-propose__row${on ? ' is-picked' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => onToggle(key)} />
              <div className="ps-propose__body">
                <div className="ps-propose__main">
                  <input
                    className="ps-propose__name"
                    value={valueOf(item, 'name')}
                    onChange={(event) => onEdit(item, 'name', event.target.value)}
                    aria-label="服务名"
                  />
                  <span className="ps-propose__yuan">¥</span>
                  <input
                    className="ps-propose__price"
                    type="number"
                    min="0"
                    step="0.5"
                    value={valueOf(item, 'price') ?? ''}
                    onChange={(event) => onEdit(item, 'price', event.target.value)}
                    aria-label="单价"
                  />
                  <select
                    className="ps-propose__cat"
                    value={valueOf(item, 'category_id') || ''}
                    onChange={(event) => onEdit(item, 'category_id', event.target.value ? Number(event.target.value) : '')}
                    aria-label="大类"
                  >
                    <option value="">不归类</option>
                    {categories.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
                  </select>
                </div>
                <div className="ps-propose__meta">
                  <span className="ps-tag">{item.video_count} 个视频 · {item.sample_count} 条样本</span>
                  {item.from_ai ? <span className="ps-tag ps-tag--ai">AI 整理</span> : null}
                  {renamed ? <span className="ps-tag ps-tag--warn">改了名字，原话会记成别名</span> : null}
                  {item.why ? <span className="ps-propose__why">{item.why}</span> : null}
                </div>
                <div className="ps-propose__sources">
                  视频里这么写：
                  {item.sources.map((source) => <span key={source} className="ps-chip ps-chip--sm" title={source}>{source}</span>)}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 没匹配上的名字：列出来，用户能一眼看出是库里缺项还是认错了 */
function UnmatchedList({ items }) {
  if (!items.length) return <div className="ps-empty">所有认出来的名字都匹配上了</div>
  const bundles = items.filter((item) => item.reason === 'bundle')
  const rest = items.filter((item) => item.reason !== 'bundle')
  return (
    <div className="ps-unmatched">
      {bundles.length ? (
        <div className="ps-unmatched__group">
          <div className="ps-detail__title">打包价（好几项一个总价，不摊给单项）</div>
          <div className="ps-unmatched__list">
            {bundles.map((item, index) => (
              <span key={`${item.parsed_name}-${index}`} className="ps-chip"><b>¥{fmtMoney(item.price)}</b>{item.parsed_name}</span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="ps-unmatched__group">
        <div className="ps-detail__title">认出来了但库里没有对应服务项（{rest.length} 条）</div>
        <div className="ps-unmatched__list">
          {rest.map((item, index) => (
            <span key={`${item.parsed_name}-${index}`} className="ps-chip"><b>¥{fmtMoney(item.price)}{item.unit ? `/${item.unit}` : ''}</b>{item.parsed_name}</span>
          ))}
        </div>
      </div>
      <p className="ps-unmatched__hint">
        这些多半是库里还没建的服务项。可以照这个价先去「添加服务」把项建出来，下次扫描就能自动对上了。
      </p>
    </div>
  )
}
