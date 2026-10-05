import React from 'react'
import { Compass } from 'lucide-react'

/**
 * 兜底页：地址里的 seg 没匹配上任何一页时用。
 *
 * 以前这里挂的是旧命令式视图（`legacy-page.jsx`），界面全部搬进 React 之后
 * 它只剩这一个用途了，所以干脆换成一个正常的空状态。
 */
export default function NotFound({ route, navigate }) {
  const where = route.seg ? `#/${route.seg}${route.sub ? `/${route.sub}` : ''}` : '(空地址)'
  return (
    <div className="react-panel-empty" style={{ padding: '56px 0' }}>
      <Compass size={22} />
      <b>没有这一页</b>
      <span>地址是 {where}，可能是链接过期了，回工作台看看吧。</span>
      <button className="refactor-button" type="button" onClick={() => navigate('/')}>
        回工作台
      </button>
    </div>
  )
}
