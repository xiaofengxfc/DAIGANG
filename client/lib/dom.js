export { fmtDate, fmtDay, fmtDayFull, fmtMoney, fmtQty, monthStart, remainInfo, todayStr } from './formatters.js'

function appendChildren(element, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true || child === '') continue
    element.appendChild(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

export function h(spec, props, ...children) {
  const parts = String(spec).split('.')
  const element = document.createElement(parts[0] || 'div')
  if (parts.length > 1) element.className = parts.slice(1).join(' ')

  if (props !== null && props !== undefined) {
    const isProps = typeof props === 'object' && !(props instanceof Node) && !Array.isArray(props) && !(props instanceof Date)
    if (!isProps) children.unshift(props)
    else {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue
        if (key === 'class' || key === 'className') element.className = [element.className, value].filter(Boolean).join(' ')
        else if (key === 'text') element.textContent = String(value)
        else if (key === 'html') element.innerHTML = String(value)
        else if (key === 'style' && typeof value === 'object') Object.assign(element.style, value)
        else if (key === 'dataset') Object.assign(element.dataset, value)
        else if (key === 'for') element.htmlFor = value
        else if (key.startsWith('on') && typeof value === 'function') element.addEventListener(key.slice(2).toLowerCase(), value)
        else if (key === 'value') element.value = value
        else if (['checked', 'disabled', 'hidden', 'selected', 'multiple'].includes(key)) element[key] = Boolean(value)
        else if (key in element && typeof value !== 'object') {
          try { element[key] = value } catch { element.setAttribute(key, String(value)) }
        } else element.setAttribute(key, value === true ? '' : String(value))
      }
    }
  }

  appendChildren(element, children)
  return element
}

export async function copyText(text) {
  const value = String(text ?? '')
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {}
  try {
    const textarea = document.createElement('textarea')
    textarea.value = value
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.top = '-1000px'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    textarea.setSelectionRange(0, value.length)
    const ok = document.execCommand('copy')
    textarea.remove()
    return ok
  } catch {
    return false
  }
}
