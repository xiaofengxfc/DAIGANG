import React, { useEffect, useState } from 'react'
import { toastErr } from '../lib/legacy-ui.js'

export default function LegacyPage({ route, item, setActions, onReload, counts, settings, vaultgate, navigate }) {
  const hostRef = React.useRef(null)
  const [, rerender] = useState(0)

  useEffect(() => {
    let active = true
    const host = hostRef.current
    if (!host) return undefined
    host.replaceChildren()
    setActions([])
    const skeleton = document.createElement('div')
    skeleton.className = 'refactor-loading'
    skeleton.innerHTML = '<span></span><span></span><span></span>'
    host.appendChild(skeleton)
    if (!item?.view) return undefined

    const app = {
      state: { counts, settings },
      navigate,
      get route() {
        return route
      },
      reload: async () => {
        await onReload()
        rerender((value) => value + 1)
      },
      refreshCounts: onReload,
      setActions,
      openOrder: (id) => navigate(`/orders/${id}`),
      openCustomer: (id) => navigate(`/customers/${id}`),
      openQuoteComposer: null,
      vault: () => Promise.resolve(vaultgate),
    }
    const ctx = {
      route,
      seg: route.seg,
      sub: route.sub,
      query: route.query,
      app,
      navigate,
      setActions,
      reload: onReload,
    }
    Promise.resolve(item.view.render(ctx))
      .then((node) => {
        if (active) {
          host.replaceChildren()
          if (node) host.appendChild(node)
        }
      })
      .catch((err) => {
        if (!active) return
        toastErr(err)
        host.replaceChildren()
        const fallback = document.createElement('div')
        fallback.className = 'refactor-error'
        fallback.textContent = err.message || '这一页没打开'
        host.appendChild(fallback)
      })
    return () => {
      active = false
      setActions([])
    }
  }, [route.seg, route.sub, route.query.toString(), counts, settings, onReload, setActions, item, vaultgate, navigate])

  return <div className="legacy-host" ref={hostRef} />
}
