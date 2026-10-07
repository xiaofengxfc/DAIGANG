/**
 * B站比价的 AI 层：把「判断」交给模型，把「数字」死死攥在自己手里。
 *
 * ============ 为什么这样切 ============
 *
 * 价格错了会开错单，而且**在界面上看不出来** —— 你会看到一个合理的价然后照着用。
 * 名字错了你看得出来（名字就写在行上）。所以分界线是：
 *
 *     模型只能决定「留 / 删 / 叫什么名字 / 是什么口径 / 包含什么」
 *     模型**不能**产出价格，一个数字都不能
 *
 * 这不是靠 prompt 里叮嘱「请不要修改价格」实现的，是靠两件事：
 *
 *   1. 输出的 JSON schema 里**根本没有价格字段** —— 模型没有地方放数字；
 *   2. 拿回回复后只按白名单取字段（`pickFields`），多出来的键一律丢掉。
 *
 * 价格自始至终来自 OCR 原文，模型只是决定要不要用这一行。
 *
 * ============ 降级 ============
 *
 * 没配 key、超时、返回格式不对 —— 一律返回 `{ok:false}`，调用方原样走
 * 现有的规则管线。AI 是加分项，不是依赖。
 */
import { aiChatJson, aiConfig } from './ai.mjs'

/** 一次调用最多塞多少行 OCR 文本。超了就截断 —— 宁可少判几帧，不要超时全丢 */
const MAX_LINES_PER_CALL = 420

/** 服务名清单最多列多少个（库大的时候挑前 N 个，避免 prompt 爆掉） */
const MAX_VOCAB = 120

/**
 * 模型能返回的字段白名单。
 *
 * 只取这些键，**其余全丢**。所以就算模型被诱导着吐了一个 `price` 字段，
 * 它也在到达业务逻辑之前就被这里扔掉了。
 */
const DECISION_FIELDS = ['frame', 'line', 'keep', 'scope', 'inclusions', 'why']
const RENAME_FIELDS = ['from', 'to']

/** 口径的合法取值。模型给了别的值就当 unknown，不要让它自由发挥 */
const SCOPES = new Set(['total', 'per_day', 'per_week', 'per_month', 'per_period', 'per_unit', 'unknown'])

function pickFields(row) {
  const out = {}
  for (const key of DECISION_FIELDS) {
    if (row && row[key] !== undefined) out[key] = row[key]
  }
  return out
}

/** 名字清洗：去掉首尾空白和引号，限长。模型偶尔会把名字裹在引号里 */
function cleanAiName(value) {
  return String(value || '')
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
}

/** 服务名不可能这么长。超过就是「整行原文」而不是名字 */
const MAX_NAME_CHARS = 24

/**
 * 名字归一化：去掉空白和标点，只留实义字符。
 * 用来判断「这个名字是不是库内某一项」，所以 `黑海岸群岛` 和 `黑海岸 群岛` 算同一个。
 */
export function normalizeServiceName(value) {
  return String(value || '').replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}

/**
 * 这个名字是不是库内已有的服务项（归一化后完全同名）。
 *
 * 用在一个很重要的地方：**AI 说「这行删掉」时，如果这行的名字和库内某个服务项
 * 完全同名，就不删。**
 *
 * 理由是实测出来的：假端点把 `黑海岸群岛 ¥20`、`虎口山脉 ¥20` 判成了噪音，
 * 这三项因此失去了建议。真模型也会犯这种错，而代价是**用户少看到一个真价**
 * —— 他看不到自己失去了什么。
 *
 * 反过来，「和库内同名」这件事本身是很强的证据：库里有这一项、视频里有这一项
 * 带价，那它几乎一定是真的价格行。所以这一条覆盖是有把握的。
 *
 * 注意它和口径过滤是**互补**的，不冲突：`每日委托 ¥2`（其实是每天 2 元）如果
 * 库里有 `每日委托`，这条会保住它不被删 —— 但 AI 同时给出的 `per_day` 口径
 * 会把它挡在「库内单位是 30天」之外。删是删不得的，混算是不行的，两件事分开管。
 */
export function isKnownServiceName(name, vocabulary) {
  const key = normalizeServiceName(name)
  if (!key) return false
  if (vocabulary instanceof Set) return vocabulary.has(key)
  return false
}

/**
 * 判断模型给的「修正名」能不能用。
 *
 * 这个守卫是拿假端点试出来的：让它把**整行原文**当名字返回，结果
 * `精托：日常体力+活动：238包月`、`云陵谷20 今州城20 中曲台地50 荒石高地50`
 * 全成了「名字」，匹配率从 34 项掉到 15 项 —— 而且**看不出来是 AI 干的**，
 * 界面上只会显示一堆奇怪的服务名。
 *
 * 改名是**纠正**，不是重写。所以只接受两种：
 *   · 新名字是库内已有的服务名（这是最有价值的纠正：把 OCR 认歪的写法
 *     换成库里的写法）；
 *   · 新名字和原名字足够像（`声厘`→`声匣`、`黎娜西塔`→`黎那汐塔`）。
 * 其余一律拒绝，保留原名字 —— 宁可少纠一个，也不能把匹配搞垮。
 */
export function acceptRename(oldName, newName, vocabulary = new Set()) {
  const from = String(oldName || '').trim()
  const to = String(newName || '').trim()
  if (!to) return false
  if (to === from) return false
  if (to.length > MAX_NAME_CHARS) return false
  // 明显是「把整行抄回来了」：比原名长出一大截
  if (to.length > from.length + 8) return false
  // 库里真有这个名字，接受（放在「包含原名」检查之前 ——
  // `深渊` → 库里的 `深渊满星` 是合法纠正，而 `深渊` → `深渊20 满星30` 不是）
  if (vocabulary.has(to)) return true
  if (!from) return false
  /**
   * 「原名 + 一堆别的」是整行抄回来的典型样子，一律拒。
   *
   * 实测：一行里有两个候选时，模型把 `黑海岸群岛、泰缇斯之底` 当成
   * `黑海岸群岛` 的修正名返回，字符级相似度 0.59 够高，被放行了 ——
   * 结果这一项的匹配直接垮掉。相似度看不出「多出来一截」这件事，包含关系能。
   */
  if (to.includes(from)) return false
  // 否则要求「像」—— 复用匹配那套相似度，阈值放低（OCR 纠错往往只差一个字）
  return nameSimilarity(from, to) >= RENAME_SIMILARITY
}

/**
 * 两个名字像不像。取「二元组 Dice」和「字符级 Dice」里大的那个。
 *
 * 为什么要两个：**二元组对两字名字完全失效**。`声厘` 和 `声匣` 的二元组分别是
 * `声厘` 和 `声匣`，一个都不重合，Dice = 0 —— 而这恰恰是最常见的 OCR 纠错
 * （同音/形近字认错）。字符级能看出它们共用一个「声」。
 *
 * 反过来，长名字上二元组更准（`黎娜西塔`/`黎那汐塔` 字符级 0.5、二元组 0，
 * 靠字符级救回来；而 `深渊`/`深境` 这种短的，字符级也够用）。
 */
function nameSimilarity(a, b) {
  return Math.max(bigramDice(a, b), charDice(a, b))
}

/** 二元组 Dice 系数 */
function bigramDice(a, b) {
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

/** 字符级 Dice 系数（按字符去重计数，不看顺序） */
function charDice(a, b) {
  if (!a || !b) return 0
  if (a === b) return 1
  const pool = new Map()
  for (const ch of a) pool.set(ch, (pool.get(ch) || 0) + 1)
  let hit = 0
  for (const ch of b) {
    const n = pool.get(ch) || 0
    if (n > 0) { hit += 1; pool.set(ch, n - 1) }
  }
  return (2 * hit) / (a.length + b.length)
}

/** 改名相似度阈值。低一点没关系 —— 改名是给用户看的，不是自动写库的 */
const RENAME_SIMILARITY = 0.34

/**
 * 把视频的 OCR 结果整理成模型能读的文本。
 *
 * 每行前面给行号，标了价的写成 `[价→程序认成的名字]`，**不写「程序认出来是
 * 60 元」**。注意 OCR 原文本身是含数字的（`声厘60`）—— 不写进 prompt 模型就
 * 没法判断那行是什么，所以数字必然在。这里要避免的是**告诉模型哪个数字是价格**：
 * 说了它就会在回复里复述，而我们要的是它永远不产出数字。
 * 最终保障在输出侧（`DECISION_FIELDS` 白名单），这一步只是减少诱导。
 *
 * 把「程序认成的名字」写进去是有意的：模型要做的是**纠正**这个名字，而不是
 * 从整行原文里重新猜一个。不给它看原名字，它很容易把整行抄回来当名字
 * （实测过，匹配率直接腰斩）。
 */
function buildTranscript(frames) {
  const parts = []
  let budget = MAX_LINES_PER_CALL
  let truncated = 0
  for (const frame of frames) {
    const lines = []
    for (const line of frame.lines) {
      if (budget <= 0) { truncated += 1; break }
      budget -= 1
      const mark = line.priced
        ? `[价→${(line.names || []).join('、') || '?'}] `
        : ''
      lines.push(`${line.index}| ${mark}${line.text}`)
    }
    if (!lines.length) continue
    parts.push(`【第 ${frame.frame} 帧】\n${lines.join('\n')}`)
  }
  return { text: parts.join('\n\n'), truncated }
}

const TRIAGE_SYSTEM = `你在帮一个游戏代练（代肝）工作室核对价格表。
视频是别人（同行）发在 B站的代肝价格表，画面里除了价格表本身，还可能有：
主播的口播字幕、聊天记录、播放器界面、文档软件的工具栏、评论截图、广告语。

你的任务是**逐行判断这行是不是价格表里的一项服务**，并修正程序认错的名字。

判断「不是价格项」的典型情况：
- 主播在说话：「我一窍不通」、「然后我看了一下同行的价格」、「这个价格我觉得还行」
- 聊天/评论：「星期三」、「老板在吗」、「9月18日」
- 软件界面：「改为」、「查找替换」、「格式刷」、「AaBbCc」、「标题1」
- 广告/联系方式：「需要的老板+V：xxx」、「看主页联系」、「已结百单」
- 被截断的碎片：「第12层第」、「间 第」、「箱+全世界任务」（明显少字）
- OCR 乱码到读不出意思：「单独海当海云」、「土+八、 细」

判断「是价格项」的典型情况：
- 有明确的服务内容 + 价格：「全图全收集1230」、「深渊35」
- 地图/区域 + 服务：「罗伊冰原满探索450」、「纳塔5.8全收集100」
- 套餐分档：「套餐1：梦州满探索230」

名字修正：程序用 OCR 原文当名字，经常认歪。库里已有的服务名是重要线索 ——
如果这行说的东西和库里某一项明显是同一个，把名字改成**库里那个写法**。
例如 OCR 认成 「声厘」、库里叫 「声匣」，就改成 「声匣」。

口径（scope）判断这行的价格是什么口径：
- total       一次性总价（「全图全收集1230」）
- per_day     每天（「基础日常：一天 3」、「日体 5R/天」）
- per_week    每周
- per_month   每月（「150/月」）
- per_period  按版本/期/赛季（「深塔15/期」）
- per_unit    按个数（「15r/个」）
- unknown     看不出来

这一项很重要：**每天 3 元和一次性 300 元不能混在一起算平均**。
如果名字里带了「一天」「每天」「/天」，就一定是 per_day，哪怕它看起来像总价。

inclusions 写这行里说明「包含什么」的原文（括号里的、冒号后面的补充），
没有就留空字符串。不要自己编。`

/**
 * 判断一整个视频的 OCR 行。
 *
 * 一次调用判完一个视频的所有帧，而不是一帧一次 —— 相邻行是判断的重要线索
 * （「星期三」 单看像个服务名，夹在聊天记录里就不是），而且 8 个视频 8 次调用
 * 比 80 次调用省得多。
 *
 * @param {object}   opts
 * @param {string}   opts.game          游戏名
 * @param {string[]} opts.serviceNames  库内服务名（当词表用，帮它纠错）
 * @param {Array}    opts.frames        `[{frame, lines:[{index, text, priced}]}]`
 * @returns {Promise<{ok:boolean, decisions?:Map, error?:string, ms?:number, stats?:object}>}
 *          decisions 的键是 `帧号:行号`，值是白名单字段组成的对象
 */
export async function aiTriageVideo({ game, serviceNames = [], frames = [] }) {
  if (!aiConfig().enabled) return { ok: false, error: 'AI 没配置', skipped: true }
  if (!frames.length) return { ok: false, error: '没有可判的行', skipped: true }

  const vocab = serviceNames.slice(0, MAX_VOCAB)
  const { text, truncated } = buildTranscript(frames)

  const user = [
    `游戏：${game}`,
    '',
    '【库里已有的服务项】（纠正名字时优先用这些写法）',
    vocab.length ? vocab.join('、') : '（这个游戏下还没有服务项）',
    '',
    '【这个视频各帧的 OCR 文本】',
    text,
    '',
    '请对**每一个标了 [价] 的行**给出判断，没标 [价] 的行不用管。',
    truncated ? `（注意：文本过长，有 ${truncated} 行没放进来，只判你看到的部分）` : '',
  ].filter(Boolean).join('\n')

  const schemaHint = `只输出 JSON，不要任何解释文字，格式：
{"rows":[{"frame":1,"line":3,"keep":true,"scope":"total","inclusions":"星声4.5w","why":""}],
 "renames":[{"from":"声厘","to":"声匣"}]}

rows —— **每个标了 [价→…] 的行给一条**：
- frame / line：对应上面文本里的帧号和行号，必须原样抄
- keep：true 表示这行是价格表里的一项服务；false 表示不是（主播说话、界面、碎片、乱码）
- scope：total / per_day / per_week / per_month / per_period / per_unit / unknown
- inclusions：这行里说明包含内容的原文，没有就空字符串
- why：keep=false 时用不超过 20 个字说明为什么不是，keep=true 时留空

renames —— **只放认歪了的名字**，没有就给空数组：
- from：上面 [价→…] 里程序认出来的那个名字，必须原样抄
- to：改成的正确名字。**只在确实认歪时才写**，认对了就整条不要出现在这里

注意：一行里可能有多个 [价→A、B]，rows 里**只给这一行一条**（keep / scope 是整行的属性），
名字的纠正写在 renames 里、按名字逐条写 —— 不要在一行里塞多个名字。

**不要输出价格。** 价格由程序自己从原文取，你只需要判断留不留、什么口径、名字要不要改。`

  const result = await aiChatJson({ system: TRIAGE_SYSTEM, user, schemaHint })
  if (!result.ok) return { ok: false, error: result.error }

  const rows = Array.isArray(result.data?.rows) ? result.data.rows : []
  const renameRows = Array.isArray(result.data?.renames) ? result.data.renames : []
  if (!rows.length) return { ok: false, error: '模型没给出任何判断' }

  const decisions = new Map()
  let kept = 0
  let dropped = 0
  for (const raw of rows) {
    const row = pickFields(raw)
    const frame = Number(row.frame)
    const line = Number(row.line)
    if (!Number.isFinite(frame) || !Number.isFinite(line)) continue
    const scope = SCOPES.has(String(row.scope)) ? String(row.scope) : 'unknown'
    const decision = {
      keep: row.keep !== false,
      scope,
      inclusions: String(row.inclusions || '').trim().slice(0, 200),
      why: String(row.why || '').trim().slice(0, 40),
    }
    if (decision.keep) kept += 1
    else dropped += 1
    decisions.set(`${frame}:${line}`, decision)
  }

  /**
   * 改名是**按名字**而不是按行的，这一点很关键。
   *
   * 一行里可能有两个候选（`黑海岸群岛20 泰缇斯之底20` 认成两个名字），
   * 按行给一个名字的话，两个候选会被塞同一个名字 —— 实测就是这么把匹配搞垮的
   * （`黑海岸群岛` 和 `泰缇斯之底` 都被改成了 `黑海岸群岛、泰缇斯之底`）。
   * 按名字给就没这个问题，而且同一个认歪的名字出现在 5 行里也只需纠一次。
   */
  const renames = new Map()
  for (const raw of renameRows) {
    const row = {}
    for (const key of RENAME_FIELDS) if (raw && raw[key] !== undefined) row[key] = raw[key]
    const from = cleanAiName(row.from)
    const to = cleanAiName(row.to)
    if (!from || !to || from === to) continue
    // 同一个 from 出现多次时以第一次为准，不要让它反复改
    if (!renames.has(from)) renames.set(from, to)
  }

  return {
    ok: true,
    decisions,
    renames,
    ms: result.ms,
    usage: result.usage,
    model: result.model,
    stats: { rows: rows.length, kept, dropped, rename_suggestions: renames.size },
  }
}

/**
 * 规则匹不上的名字，让模型**从库内候选里选**。
 *
 * 关键设计：候选是程序按字符相似度挑出来的（宽进），模型只负责从里面挑一个或
 * 说「都不是」。**不让它自由发挥** —— 它没法编出一个库里不存在的服务项 id。
 */
export async function aiMatchUnmatched({ game, services = [], names = [] }) {
  if (!aiConfig().enabled) return { ok: false, error: 'AI 没配置', skipped: true }
  if (!names.length || !services.length) return { ok: false, error: '没有要匹配的东西', skipped: true }

  // 每个待匹配的名字，程序先挑一批候选给它选（宽进：宁可多给几个）
  const { similarity } = await import('./price-match.mjs')
  const items = names.slice(0, 40).map((item) => {
    const scored = services
      .map((s) => ({ id: s.id, name: s.name, score: similarity(item.name, s.name) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
    return { name: item.name, line: String(item.line || '').slice(0, 60), candidates: scored }
  })

  const user = [
    `游戏：${game}`,
    '',
    '下面是程序从视频里认出来、但用字符串相似度匹不上库内服务项的名字。',
    '每个名字后面是程序挑出来的候选（按相似度排序，可能都不对）。',
    '',
    ...items.map((item) => [
      `视频里的名字：「${item.name}」`,
      item.line ? `  出处：${item.line}` : '',
      `  候选：${item.candidates.map((c) => `${c.id}=${c.name}`).join(' / ') || '（无）'}`,
    ].filter(Boolean).join('\n')),
  ].join('\n')

  const schemaHint = `只输出 JSON：
{"picks":[{"name":"视频里的名字","service_id":123,"confidence":"high","why":""}]}

- name：原样抄视频里的名字
- service_id：从候选里选一个的 id；**如果候选里没有真正对应的，填 null**，不要硬凑
- confidence：high（明显是同一个）/ medium（可能是）/ low（拿不准）
- why：不超过 20 个字

宁可填 null 也不要瞎选。选错会把别人的价格写到这一项上。`

  const result = await aiChatJson({
    system: '你在把视频里的服务名对应到工作室价格表里已有的服务项。只做对应关系判断，不产出任何价格。',
    user,
    schemaHint,
  })
  if (!result.ok) return { ok: false, error: result.error }

  const picks = Array.isArray(result.data?.picks) ? result.data.picks : []
  const valid = new Set(services.map((s) => Number(s.id)))
  const out = []
  for (const raw of picks) {
    const name = cleanAiName(raw?.name)
    if (!name) continue
    const id = raw?.service_id === null || raw?.service_id === undefined ? null : Number(raw.service_id)
    // 模型只能从我们给的候选里选：不在 valid 里的 id 一律当「没选」
    const serviceId = id !== null && valid.has(id) ? id : null
    out.push({
      name,
      service_id: serviceId,
      confidence: ['high', 'medium', 'low'].includes(String(raw?.confidence)) ? String(raw.confidence) : 'low',
      why: String(raw?.why || '').trim().slice(0, 40),
    })
  }
  return { ok: true, picks: out, ms: result.ms, usage: result.usage, model: result.model }
}

export const __testing = { buildTranscript, pickFields, cleanAiName, DECISION_FIELDS, SCOPES }
