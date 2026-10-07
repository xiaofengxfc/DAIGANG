/* ============================================================
   价格表 → 一张可以直接发微信的图片
   用 canvas 画，不依赖任何库。

   配色只有黑白灰：近黑 + 三档灰，一个彩色都没有。
   层级靠字重、字号和留白表达，不靠颜色 —— 所以也不再有
   顶部色条、大类色块、彩色底纹和点线这些装饰。
   ============================================================ */

const PAPER = '#FFFFFF'
const INK = '#1F2328'
const GRAY = '#5C6166'
const FAINT = '#8B9096'
const RULE = '#E7E9EB'
const RULE_STRONG = '#CACDD1'

const FONT_UI = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif'
const FONT_FIG = 'ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace'

const W = 1080
const PAD = 72
const CW = W - PAD * 2

/** 只用这几档字号，层级才不会花 */
const SZ = {
  shop: 44,
  game: 32,
  strong: 24,
  body: 22,
  small: 20,
  tiny: 18,
}

const font = (size, weight = 400, fig = false) => `${weight} ${size}px ${fig ? FONT_FIG : FONT_UI}`

/** 拿一个离屏 canvas 量文字宽度 */
function makeMeasurer() {
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')
  return (text, f) => {
    ctx.font = f
    return ctx.measureText(String(text)).width
  }
}

/** 一行放不下就截断加省略号 */
function fitText(measure, text, f, maxWidth) {
  const s = String(text || '')
  if (!s) return ''
  if (measure(s, f) <= maxWidth) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(s.slice(0, mid) + '…', f) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, Math.max(1, lo)) + '…'
}

/**
 * 折行：先按用户敲的换行断开，再按宽度贪心折。
 * 公告是手打的，可能有好几行，也可能一行很长。
 * 超过 maxLines 就把最后一行收成省略号，免得一张价目表被公告撑爆。
 */
function wrapText(measure, text, f, maxWidth, maxLines = 8) {
  const out = []
  for (const para of String(text || '').split(/\r?\n/)) {
    let rest = para.trim()
    if (!rest) continue
    while (rest) {
      if (out.length >= maxLines) {
        out[out.length - 1] = fitText(measure, out[out.length - 1] + '…', f, maxWidth)
        return out
      }
      if (measure(rest, f) <= maxWidth) {
        out.push(rest)
        break
      }
      let lo = 1
      let hi = rest.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        if (measure(rest.slice(0, mid), f) <= maxWidth) lo = mid
        else hi = mid - 1
      }
      out.push(rest.slice(0, lo))
      rest = rest.slice(lo)
    }
  }
  return out
}

/**
 * 把导出模型排成一张竖版长图。
 * 只画内容，不做交互；返回值就是 canvas，调用方自己 toBlob 下载。
 */
export function renderPriceCard(model, { scale = 2 } = {}) {
  const measure = makeMeasurer()
  const ops = []
  let y = 0

  const text = (x, baseline, str, f, color, align = 'left') => {
    if (!str) return
    ops.push({ t: 'text', x, y: baseline, str, f, color, align })
  }
  const line = (x1, y1, x2, y2, color, width = 1) => ops.push({ t: 'line', x1, y1, x2, y2, color, width })
  const rect = (x, y0, w, h, color) => ops.push({ t: 'rect', x, y: y0, w, h, color })

  /* ---------- 提示条 ---------- */
  // 没有底纹，只在左边留一道细灰竖线 —— 一眼看得出是提示，又不抢价格。
  // 顺序要紧：竖线要先推入 ops，文字后推，画的时候才是「先线后字」。
  // 参数千万别叫 text —— 会把外面那个画字的 text() 遮住，
  // 结果就是「预览画不出来：text is not a function」。
  // label 默认空着：价目表是发给客户的，提示块自己就说明白了，
  // 不用在上面再压一个「公告」的标题。
  // indent / size 是给「大类提示」用的：缩进一格、字小一号，层级低一级。
  const noticeBlock = (notice, label = '', { indent = 0, size = SZ.small } = {}) => {
    const raw = String(notice || '').trim()
    if (!raw) return
    const barW = 3
    const inner = 24
    const textX = PAD + indent + barW + inner
    const bodyFont = font(size)
    const labelFont = font(Math.max(15, size - 2), 700)
    const boxW = CW - indent
    const lines = wrapText(measure, raw, bodyFont, boxW - barW - inner - 6, 8)
    if (!lines.length) return

    // 高度先算好再画竖线 —— ops 是按顺序画的，线必须先推入，否则会盖住文字
    const lead = 26
    const labelStep = label ? size + 7 : 0
    const lineStep = Math.round(size * 1.48)
    const h = lead + labelStep + lines.length * lineStep + 14

    y += size >= SZ.small ? 42 : 30
    const top = y
    rect(PAD + indent, top, barW, h, RULE_STRONG)

    let base = top + lead
    if (label) {
      text(textX, base, label, labelFont, INK)
      base += labelStep
    }
    for (const ln of lines) {
      base += lineStep
      text(textX, base, ln, bodyFont, GRAY)
    }
    y = top + h
  }

  /* ---------- 抬头 ---------- */
  y += 64
  text(PAD, y, fitText(measure, model.shopName, font(SZ.shop, 700), CW), font(SZ.shop, 700), INK)

  y += 42
  text(PAD, y, model.title, font(SZ.small, 500), GRAY)
  if (model.date) text(W - PAD, y, model.date, font(SZ.tiny, 400, true), FAINT, 'right')

  if (model.subtitle) {
    y += 32
    text(PAD, y, fitText(measure, model.subtitle, font(SZ.small), CW), font(SZ.small), GRAY)
  }

  y += 26
  line(PAD, y, W - PAD, y, RULE_STRONG, 1)

  // 公告放在价格正文最上方（抬头下面、第一个大类上面）
  noticeBlock(model.notice)

  /* ---------- 大类与服务项 ---------- */
  const nameFont = font(SZ.body, 500)
  const priceFont = font(SZ.strong, 700, true)
  const descFont = font(SZ.tiny)
  const tierFont = font(SZ.tiny)
  const gainFont = font(SZ.small, 500)
  const catFont = font(SZ.strong, 700)
  const gameFont = font(SZ.game, 700)
  const moreFont = font(SZ.tiny)

  if (!model.groups.length) {
    y += 64
    text(PAD, y, '这张价格表还没有在架的服务项。', font(SZ.strong), FAINT)
    y += 40
  }

  let lastGame = null
  for (const g of model.groups) {
    // 导出了多个游戏时，插一条游戏小标题（比大类高一级）
    const gameHead = Boolean(model.multiGame && g.gameName && g.gameName !== lastGame)
    if (gameHead) {
      lastGame = g.gameName
      y += 76
      text(PAD, y, fitText(measure, g.gameName, gameFont, CW), gameFont, INK)
      y += 16
      line(PAD, y, W - PAD, y, RULE_STRONG, 2)
    }

    // 合并导出时，游戏的提示跟在它的第一个大类上面。
    // 小标题里已经写了游戏名就不重复；没写标题的才用游戏名当标签 —— 但不再出现「公告」两个字。
    if (g.gameNotice) noticeBlock(g.gameNotice, gameHead || !g.gameName ? '' : g.gameName)

    y += 60
    text(PAD + 18, y, fitText(measure, g.name, catFont, CW - 18), catFont, g.isOrphan ? GRAY : INK)
    y += 14
    line(PAD, y, W - PAD, y, RULE, 1)

    // 大类自己的提示：排在名字下面、服务项上面，缩进一格、字小一号
    if (g.catNotice) noticeBlock(g.catNotice, '', { indent: 22, size: SZ.tiny })

    for (const it of g.items) {
      y += 46
      const priceStr = it.price
      const priceW = measure(priceStr, priceFont)
      const nameX = PAD + 18
      const nameMax = CW - priceW - 60
      text(nameX, y, fitText(measure, it.name, nameFont, nameMax), nameFont, INK)
      text(W - PAD, y, priceStr, priceFont, INK, 'right')

      // 阶梯价逐档列出；旧模型没有 tierLines 时仍显示原来的摘要。
      const tierLines = Array.isArray(it.tierLines) ? it.tierLines.filter(Boolean) : []
      if (tierLines.length > 1) {
        for (const tier of tierLines) {
          y += 27
          text(nameX, y, fitText(measure, tier, tierFont, CW - 18), tierFont, GRAY)
        }
      } else if (it.hint) {
        y += 27
        text(nameX, y, fitText(measure, it.hint, tierFont, CW - 18), tierFont, GRAY)
      }

      // 可得货币：客户最关心的是「花这个钱能拿到多少」，
      // 所以单独一行、比说明重一档，也不能被 notes 的截断挤掉
      if (it.gain) {
        y += 29
        text(nameX, y, fitText(measure, it.gain, gainFont, CW - 18), gainFont, INK)
      }

      // 说明 / 含… / 增项…，最多两行
      const notes = (it.notes || []).filter(Boolean).slice(0, 2)
      for (const n of notes) {
        y += 29
        text(nameX, y, fitText(measure, n, descFont, CW - 18), descFont, FAINT)
      }
    }

    if (g.more > 0) {
      y += 34
      text(PAD + 18, y, `…… 这个大类还有 ${g.more} 项`, moreFont, FAINT)
    }
  }

  if (model.hiddenCategories > 0) {
    y += 44
    text(PAD, y, `…… 还有 ${model.hiddenCategories} 个大类没有列出`, moreFont, FAINT)
  }

  /* ---------- 页脚 ---------- */
  y += 44
  line(PAD, y, W - PAD, y, RULE_STRONG, 1)

  if (model.contact) {
    y += 40
    text(PAD, y, fitText(measure, `联系：${model.contact}`, font(SZ.small, 500), CW), font(SZ.small, 500), INK)
  }
  if (model.footer) {
    y += 34
    text(PAD, y, fitText(measure, model.footer, font(SZ.tiny), CW), font(SZ.tiny), FAINT)
  }
  y += PAD

  /* ---------- 落笔 ---------- */
  const H = Math.round(y)
  const canvas = document.createElement('canvas')
  canvas.width = W * scale
  canvas.height = H * scale
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.textBaseline = 'alphabetic'

  ctx.fillStyle = PAPER
  ctx.fillRect(0, 0, W, H)

  for (const op of ops) {
    if (op.t === 'rect') {
      ctx.fillStyle = op.color
      ctx.fillRect(op.x, op.y, op.w, op.h)
    } else if (op.t === 'line') {
      ctx.strokeStyle = op.color
      ctx.lineWidth = op.width
      ctx.beginPath()
      ctx.moveTo(op.x1, op.y1)
      ctx.lineTo(op.x2, op.y2)
      ctx.stroke()
    } else {
      ctx.font = op.f
      ctx.fillStyle = op.color
      ctx.textAlign = op.align
      ctx.fillText(op.str, op.x, op.y)
    }
  }

  canvas.dataset.width = String(W)
  canvas.dataset.height = String(H)
  return canvas
}

/**
 * 保留复数接口兼容旧调用，但图片始终输出为一张完整长图。
 * maxHeight 仅为兼容旧参数保留，不再参与裁切。
 */
export function renderPriceCards(model, { scale = 2, maxHeight: _maxHeight = 3000 } = {}) {
  return [renderPriceCard(model, { scale })]
}

export function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    if (canvas.toBlob) canvas.toBlob((b) => resolve(b), 'image/png')
    else resolve(null)
  })
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
    a.remove()
  }, 1500)
}
