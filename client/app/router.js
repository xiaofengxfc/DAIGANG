export function parseRoute(hash = window.location.hash) {
  const raw = String(hash || '#/').replace(/^#/, '')
  const [path, queryString] = raw.split('?')
  const parts = path.split('/').filter(Boolean)
  return {
    seg: parts[0] || '',
    sub: parts[1] || '',
    rest: parts.slice(2),
    query: new URLSearchParams(queryString || ''),
  }
}

export function navigate(to) {
  const target = String(to).startsWith('#') ? String(to) : `#${to}`
  if (window.location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'))
  else window.location.hash = target
}
