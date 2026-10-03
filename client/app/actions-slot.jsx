import React, { useEffect, useRef } from 'react'

export default function ActionsSlot({ nodes }) {
  const ref = useRef(null)

  useEffect(() => {
    const host = ref.current
    if (!host) return undefined
    host.replaceChildren()
    for (const node of nodes) {
      if (node instanceof Node) host.appendChild(node)
    }
    return () => host.replaceChildren()
  }, [nodes])

  return <div className="refactor-actions" ref={ref} />
}
