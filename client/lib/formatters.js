export function fmtMoney(value) {
  const number = Number(value) || 0
  return number.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

export function fmtQty(value) {
  const number = Number(value) || 0
  return Number.isInteger(number) ? String(number) : String(Math.round(number * 100) / 100)
}

export function fmtDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function ymd(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(String(value || ''))
  return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function fmtDay(value) {
  const date = ymd(value)
  return date ? `${date.month}月${date.day}日` : String(value || '')
}

export function fmtDayFull(value) {
  const date = ymd(value)
  if (!date) return String(value || '')
  const local = new Date(date.year, date.month - 1, date.day)
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')} ${WEEK[local.getDay()]}`
}

export function todayStr() {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function monthStart() {
  return `${todayStr().slice(0, 7)}-01`
}

function dayDiff(from, to) {
  if (!from || !to) return null
  const start = new Date(`${String(from).slice(0, 10)}T00:00:00`)
  const end = new Date(`${String(to).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null
  return Math.round((end - start) / 86400000)
}

export function remainInfo(orderedAt, dueAt) {
  if (!dueAt) return { kind: 'none', text: '', span: null }
  const span = dayDiff(orderedAt, dueAt)
  if (span !== null && span < 0) return { kind: 'invalid', text: '', span }
  const left = dayDiff(todayStr(), dueAt)
  if (left === null) return { kind: 'none', text: '', span }
  const text = left > 0 ? `剩余 ${left} 天` : left === 0 ? '今天到期' : `已逾期 ${Math.abs(left)} 天`
  return { kind: left < 0 ? 'bad' : left <= 2 ? 'soon' : 'ok', text, span }
}
