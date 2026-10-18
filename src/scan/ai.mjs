/**
 * OpenAI 兼容的模型调用层。
 *
 * 只用最通用的 `/chat/completions`，所以填哪家都行：DeepSeek、OpenAI、
 * 各种中转站、本地 ollama（`http://127.0.0.1:11434/v1`）。
 *
 * 三条约束，都是围绕「别让模型碰到钱」：
 *
 *   1. **调用方给的 schema 里不能有价格字段。** 模型改不了数字，因为它压根
 *      没法输出数字 —— 比在 prompt 里叮嘱「不要改价格」可靠得多。
 *   2. **失败就是失败，绝不猜。** 超时、格式不对、被限流，一律返回 ok:false，
 *      由调用方决定降级；不返回半成品。
 *   3. **密钥不进日志、不进响应。** 状态接口只回「配了没」和尾号。
 */
import fs from 'node:fs'
import path from 'node:path'
import { getSetting, setSetting } from '../core/db.mjs'

/** 默认按 DeepSeek 的地址和模型，但只是为了「填了 key 就能用」，换哪家都行 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const DEFAULT_MODEL = 'deepseek-chat'

/** 单次调用的默认上限。比这个久说明对方不对劲，早断早降级 */
const DEFAULT_TIMEOUT_MS = 60000
const DEFAULT_MAX_TOKENS = 4000

/** 超时/限流时重试几次。0 表示不重试 */
const MAX_ATTEMPTS = 2

/* ------------------------------------------------------------------
   配置
   ------------------------------------------------------------------ */

const keyFromEnv = () => String(process.env.XFC_AI_API_KEY || '').trim()

/**
 * 解析出当前生效的配置。
 *
 * base_url / model 存在 settings 表里（不是秘密，界面上要能改）；
 * API key **优先环境变量**，其次 settings —— 环境变量优先是为了让
 * 「不想把 key 落盘」的人有个干净的选择。
 */
export function aiConfig() {
  const envKey = keyFromEnv()
  const storedKey = String(getSetting('ai_api_key', '') || '').trim()
  const key = envKey || storedKey
  const baseUrl = String(process.env.XFC_AI_BASE_URL || getSetting('ai_base_url', '') || DEFAULT_BASE_URL).replace(/\/+$/, '')
  const model = String(process.env.XFC_AI_MODEL || getSetting('ai_model', '') || DEFAULT_MODEL)
  const disabled = process.env.XFC_AI_DISABLED === '1'
  return {
    enabled: !disabled && Boolean(baseUrl && key),
    baseUrl,
    model,
    key,
    keySource: envKey ? 'env' : storedKey ? 'settings' : 'none',
    keyIsEnv: Boolean(envKey),
    timeoutMs: Math.max(3000, Number(process.env.XFC_AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS)),
    maxTokens: Math.max(256, Number(process.env.XFC_AI_MAX_TOKENS || DEFAULT_MAX_TOKENS)),
    disabled,
  }
}

/** 给接口用的状态：**不含密钥**，只有「配了没」和尾号 */
export function aiStatus() {
  const config = aiConfig()
  const tail = config.key ? config.key.slice(-4) : ''
  return {
    configured: config.enabled,
    base_url: config.baseUrl,
    model: config.model,
    key_set: Boolean(config.key),
    key_source: config.keySource,
    key_tail: tail,
    disabled: config.disabled,
    message: config.disabled
      ? 'AI 被 XFC_AI_DISABLED=1 关掉了'
      : !config.key
        ? '还没填 API key。填了之后比价会多一道「这行到底是不是价格」的甄别。'
        : `已配置（${config.model} @ ${config.baseUrl}，key 来自${config.keySource === 'env' ? '环境变量' : '设置'}，尾号 ${tail}）`,
  }
}

/**
 * 保存配置。
 *
 * `api_key` 传空字符串表示「不动」；要清掉得显式传 `clear_key: true` ——
 * 不然界面上「保存」一次就把 key 抹了，用户会莫名其妙地发现 AI 不工作了。
 */
export function saveAiConfig({ base_url, model, api_key, clear_key } = {}) {
  if (base_url !== undefined) setSetting('ai_base_url', String(base_url || '').trim())
  if (model !== undefined) setSetting('ai_model', String(model || '').trim())
  if (clear_key) setSetting('ai_api_key', '')
  else if (String(api_key || '').trim()) setSetting('ai_api_key', String(api_key).trim())
  return aiStatus()
}

/* ------------------------------------------------------------------
   调用
   ------------------------------------------------------------------ */

/**
 * 从模型回复里挖出 JSON。
 *
 * 不能假定对方听话：实测常见的三种回复是
 *   1. 干净的 `{"a":1}`
 *   2. 裹在 ```json 里
 *   3. 前面带一句「好的，以下是结果：」再给 JSON
 * 所以先剥围栏，再从第一个 `{`/`[` 扫到配对的收尾 —— 用括号计数而不是正则，
 * 因为正文里可能带 `}`。
 */
export function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const unfenced = raw.replace(/^\s*```(?:json|JSON)?\s*/m, '').replace(/```\s*$/m, '').trim()
  for (const candidate of [unfenced, raw]) {
    const direct = tryParse(candidate)
    if (direct !== undefined) return direct
  }
  // 括号计数扫一遍：从每个可能的起点试，取第一个能解析成功的
  for (let i = 0; i < unfenced.length; i += 1) {
    const open = unfenced[i]
    if (open !== '{' && open !== '[') continue
    const close = open === '{' ? '}' : ']'
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < unfenced.length; j += 1) {
      const ch = unfenced[j]
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === open) depth += 1
      else if (ch === close) {
        depth -= 1
        if (depth === 0) {
          const parsed = tryParse(unfenced.slice(i, j + 1))
          if (parsed !== undefined) return parsed
          break
        }
      }
    }
  }
  return null
}

function tryParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * 从回复里取正文。
 *
 * 各家的字段名不一样，而且**推理模型会把内容放在 `reasoning_content` 里**：
 * 实测 `deepseek-v4.1-flash` 这类模型是 `content` 放答案、`reasoning_content` 放思考，
 * 但思考把额度吃光时 `content` 就是空的。所以取正文要按顺序试几个字段，
 * 取不到再让调用方去报「为什么空」。
 */
export function readMessageText(payload) {
  const choice = payload?.choices?.[0]
  const message = choice?.message || {}
  const candidates = [
    ['content', message.content],
    ['reasoning_content', message.reasoning_content],
    ['text', choice?.text],
    ['response', payload?.response],
  ]
  for (const [field, value] of candidates) {
    let text = ''
    if (typeof value === 'string') text = value
    // 新版 OpenAI 的 content 是分片数组：[{type:'text', text:'…'}]
    else if (Array.isArray(value)) text = value.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('')
    if (text.trim()) return { text, field }
  }
  return { text: '', field: '' }
}

/**
 * 说不出「为什么没 JSON」的错误信息等于没说。
 *
 * 这条是被一次真实故障逼出来的：探活只给 32 个 token，推理模型把额度花在思考上，
 * 返回 `content: ""` + `finish_reason: "length"`，而我当时的报错是
 * 「模型没给出能解析的 JSON：」—— 冒号后面空的，用户完全无从下手。
 */
export function explainNoJson({ payload, content, finish }) {
  const choice = payload?.choices?.[0]
  const reasoning = String(choice?.message?.reasoning_content || '')
  const parts = []

  if (!choice) {
    const keys = Object.keys(payload || {}).join('、')
    return `返回里没有 choices 字段（顶层只有：${keys || '空'}）—— 这个地址可能不是 OpenAI 兼容的 /chat/completions`
  }
  if (finish === 'length') {
    parts.push('模型话没说完就被 max_tokens 截断了')
    if (reasoning) parts.push('它把额度花在「思考」上了，这是推理模型的常见毛病')
    parts.push('把 max_tokens 调大，或换一个非推理模型')
  }
  if (!content && reasoning) parts.push(`正文是空的，内容全在 reasoning_content 里（${reasoning.length} 字）`)
  if (!content && !reasoning) parts.push('正文和思考过程都是空的')
  if (content) parts.push(`正文（${content.length} 字）：${redact(content).slice(0, 160)}`)
  parts.push(`finish_reason=${finish || '无'}`)
  return parts.join('；')
}

/**
 * 关掉「思考」的参数。
 *
 * **这是被一次真实故障逼出来的。** 用户配的 `deepseek-v4.1-flash` 是推理模型，
 * 甄别一个视频时它把 2500 个 token 全花在思考上（`reasoning_tokens: 2500`），
 * 正文返回空字符串、`finish_reason: "length"`，整批判断作废。那段思考还是散文式的
 * 逐行纠结，甚至开始揣测「出题人想看到什么」—— 对结构化抽取这种任务，思考纯粹是负担。
 *
 * 各家关思考的叫法不一样，所以**一起发**：
 *   - OpenAI 系：`reasoning_effort: 'none'`
 *   - 火山 / Anthropic 系：`thinking: {type:'disabled'}`
 *   - vLLM / SGLang 系：`chat_template_kwargs: {enable_thinking:false}`
 * 认得的会照做，不认的通常直接忽略；哪个网关不认到 400 的，会被下面按报错里的
 * 字段名剔掉再试一次。实测这三种在本机那个网关上都能把推理 token 压到 0。
 */
const THINKING_OFF_PARAMS = Object.freeze({
  reasoning_effort: 'none',
  thinking: Object.freeze({ type: 'disabled' }),
  chat_template_kwargs: Object.freeze({ enable_thinking: false }),
})

/** 这几个是请求的骨架，报错里提到它们不代表「这个字段该删」 */
const NEVER_DROP = new Set(['model', 'messages', 'temperature'])

/**
 * 从网关的 400 正文里认出「是哪个字段不被接受」，好把它剔掉重试。
 *
 * 认字段名就够了：实测这类报错都会点名，比如
 * `Extra inputs are not permitted, field: 'enable_thinking'`。
 */
export function findRejectedField(detail, body) {
  for (const key of Object.keys(body)) {
    if (NEVER_DROP.has(key)) continue
    if (new RegExp(`['"\`]?${key}['"\`]?`, 'i').test(detail)) return key
  }
  return ''
}

/**
 * 发一次对话请求，要求模型返回 JSON。
 *
 * `schemaHint` 只是一段说明文字，**不做真正的 schema 校验** ——
 * 各家对 `response_format` 的支持程度差太多（有的不认，有的认了也不保证），
 * 所以统一「要 JSON + 自己挖 + 自己校验」。
 */
export async function aiChatJson({ system, user, schemaHint = '', maxTokens = null, timeoutMs = null, temperature = 0 }) {
  const config = aiConfig()
  if (!config.enabled) return { ok: false, error: config.disabled ? 'AI 已关闭' : 'AI 没配置（缺 API key）', skipped: true }

  let tokensField = 'max_tokens'
  let body = {
    model: config.model,
    temperature,
    [tokensField]: maxTokens || config.maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: schemaHint ? `${user}\n\n${schemaHint}` : user },
    ],
    // 认这个参数的会照做，不认的会忽略（忽略也不会报错，所以是安全的加分项）
    response_format: { type: 'json_object' },
    ...THINKING_OFF_PARAMS,
  }

  let lastError = ''
  let swappedTokensField = false
  let bumpedBudget = false
  const dropped = new Set()
  // 除了重试，还要留出「换参数名 / 剔掉不认的参数 / 加大额度」的额度
  const maxCalls = MAX_ATTEMPTS + 6
  for (let attempt = 1; attempt <= maxCalls; attempt += 1) {
    const started = Date.now()
    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs || config.timeoutMs),
      })
      const text = await res.text()
      if (!res.ok) {
        const detail = redact(text)
        lastError = `HTTP ${res.status}：${detail.slice(0, 200)}`
        /**
         * 400 大多是「参数写法对不上」，不是配置错。逐条降级：
         *   1. `max_tokens` 在新版 OpenAI 上被 `max_completion_tokens` 取代 —— 换名
         *   2. 其余不认的参数（`response_format`、关思考的那几个）—— 剔掉
         */
        if (res.status === 400) {
          if (!swappedTokensField && /max_completion_tokens/i.test(detail)) {
            swappedTokensField = true
            body = { ...body, max_completion_tokens: body[tokensField] }
            delete body[tokensField]
            tokensField = 'max_completion_tokens'
            continue
          }
          const rejected = findRejectedField(detail, body)
          if (rejected && !dropped.has(rejected)) {
            dropped.add(rejected)
            body = { ...body }
            delete body[rejected]
            continue
          }
        }
        // 4xx 里只有 429 值得重试，其它（401 key 错、400 参数错）重试没意义
        if (res.status !== 429 && res.status < 500) break
        continue
      }

      let payload
      try {
        payload = JSON.parse(text)
      } catch {
        lastError = `返回的不是 JSON：${redact(text).slice(0, 200)}`
        continue
      }
      const finish = payload?.choices?.[0]?.finish_reason || ''
      const { text: content } = readMessageText(payload)
      let data = extractJson(content)
      /**
       * 正文挖不出 JSON 时，去 `reasoning_content` 里再挖一次。
       *
       * 有的模型（或有的网关）会把答案只写在思考过程里，正文留空。
       * 这是白捡的一次机会，挖到了就用；挖不到才报错。
       */
      if (data === null) {
        const reasoning = String(payload?.choices?.[0]?.message?.reasoning_content || '')
        if (reasoning && reasoning !== content) data = extractJson(reasoning)
      }
      /**
       * 被额度截断了：**加大额度再来一次**，别直接放弃。
       *
       * 关思考的参数多数网关认，但万一不认（被剔掉了），推理模型就会把额度吃掉。
       * 这种时候失败一次太可惜 —— 重跑一次的代价远小于「整批判断作废」。
       */
      if (data === null && finish === 'length' && !bumpedBudget) {
        bumpedBudget = true
        body = { ...body, [tokensField]: Math.min(32000, (Number(body[tokensField]) || 4000) * 3) }
        continue
      }
      if (data === null) {
        lastError = `模型没给出能解析的 JSON：${explainNoJson({ payload, content, finish })}`
        if (finish === 'length') break
        continue
      }
      return {
        ok: true,
        data,
        ms: Date.now() - started,
        usage: payload?.usage || null,
        model: payload?.model || config.model,
        // 哪个参数被网关拒了 —— 这个信息对排查「为什么这台机器上不一样」很有用
        dropped_params: [...dropped],
      }
    } catch (err) {
      lastError = err?.name === 'TimeoutError' ? `超时（${timeoutMs || config.timeoutMs}ms）` : redact(err?.message || String(err))
    }
  }
  return { ok: false, error: lastError || '调用失败' }
}

/**
 * 探活：发一个最小请求，确认地址 / 模型 / key 都对得上。
 *
 * `max_tokens` **不能给小**。这里踩过一次坑：原来给 32，而推理模型光「想」就要
 * 13～32 个 token，想多一点就整个额度用光、`content` 返回空字符串，
 * 于是探活偶发失败，报错还是一句没有信息量的「没给出能解析的 JSON」。
 * 探活只花一次调用，给宽点不心疼。
 */
export async function aiProbe() {
  const config = aiConfig()
  if (!config.enabled) return { ok: false, error: aiStatus().message }
  const result = await aiChatJson({
    system: '你是一个只输出 JSON 的助手。',
    user: '返回 {"ok":true}',
    maxTokens: Math.max(1024, Math.min(config.maxTokens, 2048)),
    timeoutMs: Math.min(config.timeoutMs, 30000),
  })
  if (!result.ok) return { ok: false, error: result.error }
  return { ok: true, ms: result.ms, model: result.model, reply: result.data }
}

/**
 * 密钥可能出现在对方的错误正文里（有的网关会把 Authorization 回显出来）。
 * 所有对外/对日志的文本都过一遍这个。
 */
function redact(text) {
  let out = String(text || '')
  const key = aiConfig().key
  if (key && key.length >= 8) out = out.split(key).join('***')
  // 顺手挡掉最常见的两种 key 形状
  out = out.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
  return out
}

export const __testing = { extractJson, redact, readMessageText, explainNoJson, findRejectedField, THINKING_OFF_PARAMS, DEFAULT_BASE_URL, DEFAULT_MODEL }

/* ------------------------------------------------------------------
   落盘位置说明（给「key 到底存哪了」留个线索）
   ------------------------------------------------------------------ */

/** settings 表所在的文件路径，界面上提示用户「key 落在这个库里」时用 */
export const SETTINGS_DB_HINT = path.join('data', 'console.db')

/** 只是为了让 fs 的 import 不被摇掉（配置检查会读文件是否存在） */
export function settingsFileExists() {
  try {
    return fs.existsSync(SETTINGS_DB_HINT)
  } catch {
    return false
  }
}
