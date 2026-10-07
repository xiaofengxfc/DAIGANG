import { db, stamp } from '../db.mjs'
import { enqueueERPNextChange } from '../outbox.mjs'
import { get, post, patch, del } from '../http.mjs'
import {
  bad,
  notFound,
  num,
  int,
  bool01,
  clampStr,
  parseJSON,
  stringifyJSON,
  toStringArray,
  likeTerm,
  money,
} from '../util.mjs'

/**
 * 把表结构写成声明，通用增删改查就不用每个模块抄一遍。
 * type: string | text | money | number | int | bool | ref | strarray | json
 */
export function makeDef(spec) {
  return { listOrder: 'id DESC', searchColumns: [], limit: 300, ...spec }
}

/** 「没填」的几种写法：null / undefined / '' / 只有空格 */
const isBlank = (raw) => raw === null || raw === undefined || String(raw).trim() === ''

/**
 * 数字列收到空白时该存什么。
 * 声明了默认值就存默认值（min_qty 的默认值是 1，存成 0 会把「起订 1」变成「起订 0」，
 * 导出里的起订提示也就没了）；没声明就还是 0。
 */
function blankNumber(col) {
  return col.default !== undefined ? col.default : 0
}

function coerceValue(col, raw, isCreate) {
  const t = col.type || 'string'
  if (raw === undefined) {
    if (isCreate) {
      if (col.default !== undefined) return col.default
      // 引用列没给值必须是 NULL。以前这里会落到最后的 ''，
      // 而 '' 写进 INTEGER 外键列就成了空字符串，SQLite 直接报
      // FOREIGN KEY constraint failed —— 表单总是显式传 null 才一直没暴露。
      if (t === 'ref') return null
      return t === 'bool' ? 0 : t === 'strarray' || t === 'json' ? (t === 'json' ? {} : []) : ''
    }
    return undefined
  }
  if (col.nullable && (raw === null || raw === '' || raw === undefined)) return null
  switch (t) {
    case 'money':
      // 只敲了空格也算没填：Number(' ') === 0，会把「上限 / 起订量」悄悄存成 0
      return isBlank(raw) ? blankNumber(col) : money(raw)
    case 'number':
      return isBlank(raw) ? blankNumber(col) : num(raw)
    case 'int':
      return isBlank(raw) ? blankNumber(col) : int(raw)
    case 'bool':
      return bool01(raw)
    case 'ref': {
      if (raw === null || raw === '' || raw === undefined) return null
      const n = int(raw, 0)
      return n > 0 ? n : null
    }
    case 'strarray':
      return toStringArray(raw, col.max || 60)
    case 'json':
      // '' 不是「一个空对象」，是「没填」：直接存下去会变成字符串 '""'，
      // 读回来 parseJSON 得到 ''，Array.isArray 不成立 —— 套餐内容就这样静默消失。
      return isBlank(raw) ? (col.default ?? {}) : raw
    case 'text':
      return clampStr(raw, col.max || 4000)
    default: {
      let s = clampStr(raw, col.max || 300)
      if (col.trim !== false) s = s.trim()
      if (col.enum && !col.enum.includes(s)) {
        bad(`${col.label || '字段'} 只能是：${col.enum.join(' / ')}`, 'bad_enum')
      }
      return s
    }
  }
}

function toDB(col, value) {
  const t = col.type || 'string'
  if (t === 'strarray' || t === 'json') return stringifyJSON(value)
  // 可空的 bool 要保住 NULL（「跟随大类」和「否」是两回事，
  // 把 NULL 压成 0 会让「跟随」被永久改成「否」）
  if (t === 'bool') return value === null || value === undefined ? null : value ? 1 : 0
  return value
}

function fromDB(col, value) {
  const t = col.type || 'string'
  if (t === 'strarray') return parseJSON(value, [])
  if (t === 'json') return parseJSON(value, {})
  // 可空 bool 的 NULL 要原样传出去，前端才能显示「跟随大类」
  if (t === 'bool') return value === null || value === undefined ? (col.nullable ? null : false) : Boolean(value)
  return value
}

/**
 * 只透出声明过的列，外加 id / 时间戳 / def.extra 里点名的联表字段。
 * 表里其余列（比如 credentials.payload_enc 这种密文）绝不出现在接口响应里。
 */
export function shapeRow(def, row) {
  if (!row) return null
  const out = {}
  if ('id' in row) out.id = row.id
  for (const [name, col] of Object.entries(def.columns)) out[name] = fromDB(col, row[name])
  if ('created_at' in row) out.created_at = row.created_at
  if ('updated_at' in row) out.updated_at = row.updated_at
  for (const k of def.extra || []) if (k in row) out[k] = row[k]
  return out
}

/**
 * 表里实际有哪些列 —— service_tiers 这种纯子表没有 created_at/updated_at，
 * 写库前先问一下，免得 INSERT 撞上不存在的列。
 */
const columnCache = new Map()
export function tableColumns(table) {
  if (!columnCache.has(table)) {
    const set = new Set()
    try {
      for (const r of db.prepare(`PRAGMA table_info(${table})`).all()) set.add(r.name)
    } catch {
      /* 表不存在时留空，交给真正的报错去暴露 */
    }
    columnCache.set(table, set)
  }
  return columnCache.get(table)
}

export function createRow(def, body = {}) {
  const cols = []
  const marks = []
  const values = []
  for (const [name, col] of Object.entries(def.columns)) {
    if (col.readonly) continue
    let value = coerceValue(col, body[name], true)
    if (col.required && (value === '' || value === null || value === undefined)) {
      bad(`请填写${col.label || name}`, 'missing_field')
    }
    if (col.validate) value = col.validate(value, body)
    if (col.unique && value !== '' && value !== null && value !== undefined) {
      const dup = db.prepare(`SELECT id FROM ${def.table} WHERE ${name} = ?`).get(toDB(col, value))
      if (dup) bad(`${col.label || name}「${value}」已经存在了`, 'duplicate')
    }
    cols.push(name)
    marks.push('?')
    values.push(toDB(col, value))
  }
  const present = tableColumns(def.table)
  const ts = stamp()
  if (present.has('created_at')) {
    cols.push('created_at')
    marks.push('?')
    values.push(ts)
  }
  if (present.has('updated_at')) {
    cols.push('updated_at')
    marks.push('?')
    values.push(ts)
  }
  const info = db
    .prepare(`INSERT INTO ${def.table} (${cols.join(', ')}) VALUES (${marks.join(', ')})`)
    .run(...values)
  const id = Number(info.lastInsertRowid)
  enqueueERPNextChange(def.table, id, 'upsert')
  return getRow(def, id)
}

export function updateRow(def, id, body = {}) {
  const existing = getRow(def, id)
  if (!existing) notFound()
  const sets = []
  const values = []
  for (const [name, col] of Object.entries(def.columns)) {
    if (col.readonly) continue
    if (!(name in body)) continue
    let value = coerceValue(col, body[name], false)
    if (col.required && (value === '' || value === null || value === undefined)) {
      bad(`请填写${col.label || name}`, 'missing_field')
    }
    if (col.validate) value = col.validate(value, { ...existing, ...body })
    if (col.unique && value !== '' && value !== null && value !== undefined) {
      const dup = db.prepare(`SELECT id FROM ${def.table} WHERE ${name} = ? AND id <> ?`).get(toDB(col, value), int(id))
      if (dup) bad(`${col.label || name}「${value}」已经存在了`, 'duplicate')
    }
    sets.push(`${name} = ?`)
    values.push(toDB(col, value))
  }
  if (!sets.length) return existing
  if (tableColumns(def.table).has('updated_at')) {
    sets.push('updated_at = ?')
    values.push(stamp())
  }
  values.push(int(id))
  db.prepare(`UPDATE ${def.table} SET ${sets.join(', ')} WHERE id = ?`).run(...values)
  enqueueERPNextChange(def.table, int(id), 'upsert')
  return getRow(def, id)
}

export function getRow(def, id) {
  const row = db.prepare(`SELECT * FROM ${def.table} WHERE id = ?`).get(int(id))
  return shapeRow(def, row)
}

export function listRows(def, query = {}) {
  const where = []
  const values = []

  const q = clampStr(query.q, 120).trim()
  if (q && def.searchColumns.length) {
    where.push(`(${def.searchColumns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
    for (const _ of def.searchColumns) values.push(likeTerm(q))
  }
  for (const [key, col] of Object.entries(def.columns)) {
    if (!col.filter) continue
    const raw = query[key]
    if (raw === undefined || raw === '') continue
    if (raw === '__none__') {
      where.push(`${key} IS NULL`)
      continue
    }
    where.push(`${key} = ?`)
    // bool 列在库里是 0 / 1：不过一遍 bool01 的话，?is_daily=false 拿字符串去比
    // 整数列，SQLite 的亲和性会让它一条都匹配不上（看着像「没有这样的数据」）。
    values.push(
      col.type === 'ref' || col.type === 'int'
        ? int(raw)
        : col.type === 'bool'
          ? bool01(raw)
          : String(raw)
    )
  }
  const sql = `SELECT * FROM ${def.table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${
    def.listOrder
  } LIMIT ?`
  const limit = Math.min(1000, Math.max(1, int(query.limit, def.limit)))
  values.push(limit)
  return db.prepare(sql).all(...values).map((r) => shapeRow(def, r))
}

/**
 * 删除。默认沿用「归档」策略（游戏、大类、客户这些都不真删，老订单才不会断）。
 * 但用户确实需要能真正删掉建错的记录，所以支持显式 hard：
 *   DELETE /api/xxx/:id?hard=1   →  真删
 * 不传 hard 时行为和以前完全一样，老调用方不受影响。
 */
export function removeRow(def, id, { hard = false } = {}) {
  const existing = getRow(def, id)
  if (!existing) notFound()
  if (def.archiveInstead && !hard) {
    db.prepare(`UPDATE ${def.table} SET status = 'archived', updated_at = ? WHERE id = ?`).run(stamp(), int(id))
    enqueueERPNextChange(def.table, int(id), 'upsert')
    return { archived: true, id: int(id) }
  }
  db.prepare(`DELETE FROM ${def.table} WHERE id = ?`).run(int(id))
  enqueueERPNextChange(def.table, int(id), 'delete')
  return { deleted: true, id: int(id) }
}

/** 通用 REST 五件套 */
export function registerCrud(prefix, def, { afterList, onDelete, afterCreate, afterUpdate, afterDelete } = {}) {
  get(`${prefix}`, (ctx) => {
    let rows = listRows(def, ctx.query)
    if (afterList) rows = afterList(rows, ctx)
    return { items: rows }
  })
  get(`${prefix}/:id`, (ctx) => {
    const row = getRow(def, ctx.params.id)
    if (!row) notFound()
    return row
  })
  post(`${prefix}`, (ctx) => {
    const result = createRow(def, ctx.body)
    if (afterCreate) afterCreate(result, ctx)
    return result
  })
  patch(`${prefix}/:id`, (ctx) => {
    const before = getRow(def, ctx.params.id)
    const result = updateRow(def, ctx.params.id, ctx.body)
    if (afterUpdate) afterUpdate(result, before, ctx)
    return result
  })
  del(`${prefix}/:id`, (ctx) => {
    const before = getRow(def, ctx.params.id)
    const result = onDelete ? onDelete(ctx, def) : removeRow(def, ctx.params.id, { hard: ctx.query.hard === '1' })
    if (afterDelete) afterDelete(result, before, ctx)
    return result
  })
}

export { coerceValue, toDB, fromDB }
