import { db, stamp } from '../db.mjs'
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

function coerceValue(col, raw, isCreate) {
  const t = col.type || 'string'
  if (raw === undefined) {
    if (isCreate) return col.default !== undefined ? col.default : t === 'bool' ? 0 : t === 'strarray' || t === 'json' ? (t === 'json' ? {} : []) : ''
    return undefined
  }
  if (col.nullable && (raw === null || raw === '' || raw === undefined)) return null
  switch (t) {
    case 'money':
      return money(raw)
    case 'number':
      return num(raw)
    case 'int':
      return int(raw)
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
      return raw === null || raw === undefined ? (col.default ?? {}) : raw
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
  if (t === 'bool') return value ? 1 : 0
  return value
}

function fromDB(col, value) {
  const t = col.type || 'string'
  if (t === 'strarray') return parseJSON(value, [])
  if (t === 'json') return parseJSON(value, {})
  if (t === 'bool') return Boolean(value)
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
  return getRow(def, Number(info.lastInsertRowid))
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
    values.push(col.type === 'ref' || col.type === 'int' ? int(raw) : String(raw))
  }
  const sql = `SELECT * FROM ${def.table} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${
    def.listOrder
  } LIMIT ?`
  const limit = Math.min(1000, Math.max(1, int(query.limit, def.limit)))
  values.push(limit)
  return db.prepare(sql).all(...values).map((r) => shapeRow(def, r))
}

export function removeRow(def, id) {
  const existing = getRow(def, id)
  if (!existing) notFound()
  if (def.archiveInstead) {
    db.prepare(`UPDATE ${def.table} SET status = 'archived', updated_at = ? WHERE id = ?`).run(stamp(), int(id))
    return { archived: true, id: int(id) }
  }
  db.prepare(`DELETE FROM ${def.table} WHERE id = ?`).run(int(id))
  return { deleted: true, id: int(id) }
}

/** 通用 REST 五件套 */
export function registerCrud(prefix, def, { afterList, onDelete } = {}) {
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
  post(`${prefix}`, (ctx) => createRow(def, ctx.body))
  patch(`${prefix}/:id`, (ctx) => updateRow(def, ctx.params.id, ctx.body))
  del(`${prefix}/:id`, (ctx) => (onDelete ? onDelete(ctx, def) : removeRow(def, ctx.params.id)))
}

export { coerceValue, toDB, fromDB }
