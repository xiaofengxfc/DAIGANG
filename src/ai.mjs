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
import { getSetting, setSetting } from './db.mjs'

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
 * 发一次对话请求，要求模型返回 JSON。
 *
 * `schemaHint` 只是一段说明文字，**不做真正的 schema 校验** ——
 * 各家对 `response_format` 的支持程度差太多（有的不认，有的认了也不保证），
 * 所以统一「要 JSON + 自己挖 + 自己校验」。
 */
export async function aiChatJson({ system, user, schemaHint = '', maxTokens = null, timeoutMs = null, temperature = 0 }) {
  const config = aiConfig()
  if (!config.enabled) return { ok: false, error: config.disabled ? 'AI 已关闭' : 'AI 没配置（缺 API key）', skipped: true }

  const body = {
    model: config.model,
    temperature,
    max_tokens: maxTokens || config.maxTokens,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: schemaHint ? `${user}\n\n${schemaHint}` : user },
    ],
    // 认这个参数的会照做，不认的会忽略（忽略也不会报错，所以是安全的加分项）
    response_format: { type: 'json_object' },
  }

  let lastError = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
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
        lastError = `HTTP ${res.status}：${redact(text).slice(0, 200)}`
        // 4xx 里只有 429 值得重试，其它（401 key 错、400 参数错）重试没意义
        if (res.status !== 429 && res.status < 500) break
      } else {
        let payload
        try {
          payload = JSON.parse(text)
        } catch {
          lastError = `返回的不是 JSON：${redact(text).slice(0, 200)}`
          continue
        }
        const content = payload?.choices?.[0]?.message?.content
        const data = extractJson(content)
        if (data === null) {
          lastError = `模型没给出能解析的 JSON：${redact(String(content || '')).slice(0, 200)}`
          continue
        }
        return {
          ok: true,
          data,
          ms: Date.now() - started,
          usage: payload?.usage || null,
          model: payload?.model || config.model,
        }
      }
    } catch (err) {
      lastError = err?.name === 'TimeoutError' ? `超时（${timeoutMs || config.timeoutMs}ms）` : redact(err?.message || String(err))
    }
  }
  return { ok: false, error: lastError || '调用失败' }
}

/** 探活：发一个最小请求，确认地址 / 模型 / key 都对得上 */
export async function aiProbe() {
  const config = aiConfig()
  if (!config.enabled) return { ok: false, error: aiStatus().message }
  const result = await aiChatJson({
    system: '你是一个只输出 JSON 的助手。',
    user: '返回 {"ok":true}',
    maxTokens: 32,
    timeoutMs: Math.min(config.timeoutMs, 20000),
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

export const __testing = { extractJson, redact, DEFAULT_BASE_URL, DEFAULT_MODEL }

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
