/* ============================================================
   迷你 hyperscript + 格式化工具
   没有框架：这个后台要能在任何浏览器里直接打开，不加构建步骤。
   ============================================================ */

const SVG_NS = 'http://www.w3.org/2000/svg'

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true || c === '') continue
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)))
  }
}

export function h(spec, props, ...children) {
  const parts = String(spec).split('.')
  const tag = parts[0] || 'div'
  const el = document.createElement(tag)
  if (parts.length > 1) el.className = parts.slice(1).join(' ')

  if (props !== null && props !== undefined) {
    const isProps =
      typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props) && !(props instanceof Date)
    if (!isProps) children.unshift(props)
    else {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue
        if (k === 'class' || k === 'className') {
          el.className = [el.className, v].filter(Boolean).join(' ')
        } else if (k === 'text') {
          el.textContent = String(v)
        } else if (k === 'html') {
          el.innerHTML = String(v)
        } else if (k === 'style' && typeof v === 'object') {
          Object.assign(el.style, v)
        } else if (k === 'dataset') {
          Object.assign(el.dataset, v)
        } else if (k === 'for') {
          el.htmlFor = v
        } else if (k.startsWith('on') && typeof v === 'function') {
          el.addEventListener(k.slice(2).toLowerCase(), v)
        } else if (k === 'value') {
          el.value = v
        } else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'selected' || k === 'multiple') {
          el[k] = Boolean(v)
        } else if (k in el && typeof v !== 'object') {
          try {
            el[k] = v
          } catch {
            el.setAttribute(k, String(v))
          }
        } else {
          el.setAttribute(k, v === true ? '' : String(v))
        }
      }
    }
  }
  appendChildren(el, children)
  return el
}

export function frag(...children) {
  const f = document.createDocumentFragment()
  appendChildren(f, children)
  return f
}

export function svg(paths, { size = 18, fill = 'none' } = {}) {
  const el = document.createElementNS(SVG_NS, 'svg')
  el.setAttribute('viewBox', '0 0 24 24')
  el.setAttribute('width', size)
  el.setAttribute('height', size)
  el.setAttribute('fill', fill)
  el.setAttribute('stroke', 'currentColor')
  el.setAttribute('stroke-width', '1.7')
  el.setAttribute('stroke-linecap', 'round')
  el.setAttribute('stroke-linejoin', 'round')
  el.setAttribute('aria-hidden', 'true')
  el.innerHTML = paths
  return el
}

const ICONS = {
  dashboard:
    '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  orders:
    '<path d="M5.5 3h13v18l-3.2-2-3.3 2-3.3-2-3.2 2z"/><path d="M9 8.5h6M9 12.5h6"/>',
  customers:
    '<circle cx="9.5" cy="8" r="3.3"/><path d="M3.5 20c0-3.4 2.7-5.6 6-5.6s6 2.2 6 5.6"/><path d="M16.2 5.6a3.2 3.2 0 0 1 0 6.1M18 14.9c2 .9 3.3 2.6 3.3 5.1"/>',
  price:
    '<path d="M3 12.6V4.2A1.2 1.2 0 0 1 4.2 3h8.4L21 11.4 12.6 20z"/><circle cx="7.6" cy="7.6" r="1.4"/>',
  games:
    '<rect x="2" y="7" width="20" height="10.5" rx="4.2"/><path d="M7 9.8v4.4M4.8 12h4.4M15.6 11h.01M18.2 13.4h.01"/>',
  vault:
    '<rect x="4" y="10" width="16" height="10.5" rx="2.2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14.2v2.4"/>',
  finance:
    '<path d="M4.5 20.5V4"/><path d="M4.5 20.5h15.5"/><path d="M8.5 20.5v-6M12.5 20.5v-10.5M16.5 20.5v-4"/>',
  quotes:
    '<path d="M6 3h8l4.5 4.5V21H6z"/><path d="M14 3v4.5h4.5"/><path d="M9 13h6M9 16.5h4"/>',
  settings:
    '<path d="M4 7.5h8M17 7.5h3M4 16.5h3M12 16.5h8"/><circle cx="14.5" cy="7.5" r="2.3"/><circle cx="9.5" cy="16.5" r="2.3"/>',
  search: '<circle cx="11" cy="11" r="6.6"/><path d="M16.2 16.2 20.5 20.5"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  close: '<path d="M6.2 6.2 17.8 17.8M17.8 6.2 6.2 17.8"/>',
  check: '<path d="M5 12.6 9.4 17 19 6.8"/>',
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.2"/><path d="M5.5 15.5V6.2A1.7 1.7 0 0 1 7.2 4.5h9.3"/>',
  eye: '<path d="M2.5 12S6 6.4 12 6.4 21.5 12 21.5 12 18 17.6 12 17.6 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.7"/>',
  edit: '<path d="M4 20.2h4.2L20.4 8 16.2 3.8 4 16z"/><path d="M14.4 5.6 18.6 9.8"/>',
  trash: '<path d="M4 7h16M9.5 7V4h5v3M6.5 7l1 13.2h9L17.5 7"/><path d="M10.5 10.5v6M13.5 10.5v6"/>',
  down: '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  right: '<path d="M9.5 6.5 15 12l-5.5 5.5"/>',
  more: '<circle cx="5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.5" fill="currentColor" stroke="none"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2 6.6 6.6M17.4 17.4l1.4 1.4M18.8 5.2 17.4 6.6M6.6 17.4 5.2 18.8"/>',
  moon: '<path d="M20.5 14.8A8.4 8.4 0 0 1 9.2 3.5 8.4 8.4 0 1 0 20.5 14.8z"/>',
  logout: '<path d="M15 4.5h2.8a1.7 1.7 0 0 1 1.7 1.7v11.6a1.7 1.7 0 0 1-1.7 1.7H15"/><path d="M10 8l-4 4 4 4M6 12h9"/>',
  download: '<path d="M12 3.5v11.5M7.4 10.6 12 15.2l4.6-4.6M4 20.5h16"/>',
  upload: '<path d="M12 16.5V5M7.4 9.4 12 4.8l4.6 4.6M4 20.5h16"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.2"/><path d="M3.5 10h17M8.5 3v4M15.5 3v4"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.5 4v4.5H16"/>',
  shield: '<path d="M12 3 20 6v5.6c0 5-3.4 8.2-8 9.4-4.6-1.2-8-4.4-8-9.4V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  warn: '<path d="M12 3.5 21 20H3z"/><path d="M12 9.5v4.5M12 17h.01"/>',
  link: '<path d="M10.2 13.8a3.8 3.8 0 0 0 5.4 0l2.9-2.9a3.8 3.8 0 0 0-5.4-5.4l-1.3 1.3"/><path d="M13.8 10.2a3.8 3.8 0 0 0-5.4 0l-2.9 2.9a3.8 3.8 0 0 0 5.4 5.4l1.3-1.3"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.4"/><path d="M3 10.5h18"/><circle cx="17" cy="14.6" r="1.2" fill="currentColor" stroke="none"/>',
  chat: '<path d="M20.5 12c0 3.9-3.8 7-8.5 7-1 0-2-.14-2.9-.4L4.5 20l1.2-3.3A6.5 6.5 0 0 1 3.5 12c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7z"/>',
  phone:
    '<path d="M7.5 3.5h9a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M10.5 17.5h3"/>',
  filter: '<path d="M3.5 5.5h17l-6.5 7.6V20l-4-2.2v-4.7z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.2V12l3.2 2"/>',
  drag: '<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>',
}

export function icon(name, size = 18) {
  return svg(ICONS[name] || ICONS.dashboard, { size })
}

/* ============================================================
   格式化
   ============================================================ */

export function fmtMoney(n) {
  const v = Number(n) || 0
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
}

export function fmtMoney2(n) {
  const v = Number(n) || 0
  return v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtQty(n) {
  const v = Number(n) || 0
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

/** 后端存的是 UTC ISO，这里按本机时区显示 */
export function fmtDate(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function fmtDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fmtShort(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 纯日期字符串（YYYY-MM-DD）按字面显示，不要过 Date 以免时区偏移 */
export function fmtDay(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''))
  if (!m) return String(dateStr || '')
  return `${Number(m[2])}月${Number(m[3])}日`
}

export function fmtDayFull(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''))
  if (!m) return String(dateStr || '')
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return `${m[1]}-${m[2]}-${m[3]} ${WEEK[d.getDay()]}`
}

export function weekdayOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''))
  if (!m) return ''
  return WEEK[new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay()]
}

export function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function monthStart() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`
}

/* ---------- 交付日期还剩几天 ----------
   下单台和订单列表/详情共用这一份，算法保证一致。 */

/** 两个日期相差几天（to - from）；读不出来返回 null */
export function dayDiff(from, to) {
  if (!from || !to) return null
  const f = new Date(`${String(from).slice(0, 10)}T00:00:00`)
  const t = new Date(`${String(to).slice(0, 10)}T00:00:00`)
  if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) return null
  return Math.round((t - f) / 86400000)
}

/**
 * 交付日期的情况。
 * kind: 'none' 没填 / 'ok' 还早 / 'soon' ≤2 天 / 'bad' 已逾期 / 'invalid' 交付早于下单
 * text: 「剩余 7 天」「今天到期」「已逾期 3 天」
 * span: 下单到交付跨了几天（null = 算不出来）
 */
export function remainInfo(orderedAt, dueAt) {
  if (!dueAt) return { kind: 'none', text: '', span: null }
  const span = dayDiff(orderedAt, dueAt)
  if (span !== null && span < 0) return { kind: 'invalid', text: '', span }
  const left = dayDiff(todayStr(), dueAt)
  if (left === null) return { kind: 'none', text: '', span }
  const text = left > 0 ? `剩余 ${left} 天` : left === 0 ? '今天到期' : `已逾期 ${Math.abs(left)} 天`
  const kind = left < 0 ? 'bad' : left <= 2 ? 'soon' : 'ok'
  return { kind, text, span }
}

export function relTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  return fmtDate(iso)
}

export function daysSince(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''))
  if (!m) return null
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.round((now - then) / 86400000)
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/* ============================================================
   小工具
   ============================================================ */

export const cls = (...xs) => xs.filter(Boolean).join(' ')

export function debounce(fn, ms = 220) {
  let t
  return (...args) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
  return node
}

export function mount(node, ...children) {
  clear(node)
  appendChildren(node, children)
  return node
}

/**
 * 复制文本。局域网走 http 时 navigator.clipboard 不可用，
 * 所以留一条 execCommand 的老路，保证手机上一定能复制。
 */
export async function copyText(text) {
  const value = String(text ?? '')
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    /* 落到下面 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '-1000px'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    ta.setSelectionRange(0, value.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** 生成一个确定性的短编号，用来给 DOM 元素挂 id */
let uidCounter = 0
export const uid = (p = 'x') => `${p}-${++uidCounter}`
