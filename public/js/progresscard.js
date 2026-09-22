/* ============================================================
   订单进度 → 一张可以直接发微信的图
   和价格表那张图同一套视觉：暖纸底 + 朱砂 + 栏线。
   ============================================================ */

const PAPER = '#FBF8F2'
const PAPER_EDGE = '#EDE5D6'
const INK = '#221E18'
const INK_GRAY = '#6F6759'
const INK_FAINT = '#948A7A'
const CINNABAR = '#B33A22'
const RULE = '#E2DACB'
const RULE_STRONG = '#C9BFAB'

const FONT_UI = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif'
const FONT_FIG = 'ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace'

const W = 1080
const PAD = 72
const CW = W - PAD * 2

const font = (size, weight = 400, fig = false) => `${weight} ${size}px ${fig ? FONT_FIG : FONT_UI}`

function makeMeasurer() {
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')
  return (text, f) => {
    ctx.font = f
    return ctx.measureText(String(text)).width
  }
}

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

/** 把一段长文本按宽度折行 */
function wrap(measure, text, f, maxWidth, maxLines = 99) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return []
  const out = []
  let line = ''
  for (const ch of s) {
    if (measure(line + ch, f) > maxWidth) {
      out.push(line)
      line = ch
      if (out.length >= maxLines) break
    } else {
      line += ch
    }
  }
  if (out.length < maxLines && line) out.push(line)
  if (out.length >= maxLines) {
    const last = out[maxLines - 1]
    out[maxLines - 1] = fitText(measure, last, f, maxWidth)
  }
  return out
}

export function renderProgressCard(report, { scale = 2 } = {}) {
  const measure = makeMeasurer()
  const ops = []
  let y = 0

  const text = (x, baseline, str, f, color, align = 'left') => {
    if (!str) return
    ops.push({ t: 'text', x, y: baseline, str, f, color, align })
  }
  const line = (x1, y1, x2, y2, color, width = 1) => ops.push({ t: 'line', x1, y1, x2, y2, color, width })
  const rect = (x, y0, w, hh, color) => ops.push({ t: 'rect', x, y: y0, w, h: hh, color })

  /* ---------- 抬头 ---------- */
  rect(0, 0, W, 7, CINNABAR)
  y = 7

  y += 62
  text(PAD, y, fitText(measure, report.shopName, font(44, 700), CW), font(44, 700), INK)

  y += 42
  text(PAD, y, report.title || '订单进度', font(23, 500), INK_GRAY)
  if (report.date) text(W - PAD, y, report.date, font(21, 400, true), INK_FAINT, 'right')

  y += 34
  const meta = [report.orderNo, report.gameName, report.statusLabel].filter(Boolean).join('　·　')
  text(PAD, y, fitText(measure, meta, font(21), CW), font(21), INK_GRAY)

  y += 30
  const moneyLine =
    report.due > 0
      ? `已收 ¥${report.paid} / 共 ¥${report.total}　还差 ¥${report.due}`
      : `已收 ¥${report.paid} / 共 ¥${report.total}　已结清`
  text(PAD, y, moneyLine, font(21, 500, true), report.due > 0 ? CINNABAR : INK_GRAY)

  y += 26
  line(PAD, y, W - PAD, y, RULE_STRONG, 1)

  /* ---------- 进度条目 ---------- */
  const dateFont = font(23, 600, true)
  const resFont = font(20, 500, true)
  const bodyFont = font(24)
  const noteFont = font(20)
  const attachFont = font(19, 400)

  const entries = report.entries || []
  if (!entries.length) {
    y += 60
    text(PAD, y, '还没有进度记录。', font(24), INK_FAINT)
  }

  entries.forEach((e, i) => {
    y += i === 0 ? 58 : 46
    rect(PAD, y - 20, 5, 24, CINNABAR)
    text(PAD + 16, y, e.date, dateFont, INK)
    if (e.before || e.after) {
      text(W - PAD, y, `${e.before || '—'} → ${e.after || '—'}`, resFont, CINNABAR, 'right')
    }
    // 算好的差单独一行 —— 客户看「动了多少」比看两串原始数字快得多。
    // 这一行是服务端算的，跟「复制文字」里那行完全一致。
    if (e.delta) {
      y += 30
      text(PAD + 16, y, `本次消耗：${e.delta}`, resFont, INK)
    }

    const bodyLines = wrap(measure, e.content, bodyFont, CW - 16, 8)
    for (const ln of bodyLines) {
      y += 36
      text(PAD + 16, y, ln, bodyFont, INK)
    }

    if (e.note) {
      for (const ln of wrap(measure, `备注：${e.note}`, noteFont, CW - 16, 3)) {
        y += 30
        text(PAD + 16, y, ln, noteFont, INK_FAINT)
      }
    }
    if (e.shots) {
      y += 30
      text(PAD + 16, y, `（附 ${e.shots} 张截图）`, attachFont, INK_FAINT)
    }
  })

  /* ---------- 页脚 ---------- */
  y += 46
  line(PAD, y, W - PAD, y, RULE_STRONG, 1)
  y += 38
  text(PAD, y, `客户：${report.customerName}`, font(21, 500), INK)
  if (report.contact) {
    y += 32
    text(PAD, y, fitText(measure, `联系：${report.contact}`, font(20), CW), font(20), INK_FAINT)
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
  ctx.strokeStyle = PAPER_EDGE
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, W - 2, H - 2)

  for (const op of ops) {
    if (op.t === 'rect') {
      ctx.fillStyle = op.color
      ctx.fillRect(op.x, op.y, op.w, op.h)
    } else if (op.t === 'line') {
      ctx.strokeStyle = op.color
      ctx.lineWidth = op.width
      ctx.setLineDash([])
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
