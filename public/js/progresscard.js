/* ============================================================
   订单进度分享卡
   这张图给客户看：先看订单状态，再顺着时间线看每一次做了什么。
   ============================================================ */

const BG = '#F4F6F8'
const PAPER = '#FFFFFF'
const PAPER_EDGE = '#DCE3EA'
const INK = '#1E2732'
const INK_2 = '#5D6A78'
const INK_3 = '#8793A0'
const ACCENT = '#3F6F8F'
const ACCENT_DARK = '#294C65'
const ACCENT_PALE = '#E8F0F5'
const JADE = '#287B63'
const AMBER = '#A66A18'
const AMBER_PALE = '#FFF2D9'
const RULE = '#E3E8ED'
const FONT_UI = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif'
const FONT_FIG = 'ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace'

const W = 1080
const PAD = 64
const CW = W - PAD * 2
const R = 14

const font = (size, weight = 400, fig = false) => `${weight} ${size}px ${fig ? FONT_FIG : FONT_UI}`

function makeMeasurer() {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  return (text, f) => {
    ctx.font = f
    return ctx.measureText(String(text)).width
  }
}

function fitText(measure, text, f, maxWidth) {
  const s = String(text || '')
  if (!s || measure(s, f) <= maxWidth) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measure(s.slice(0, mid) + '…', f) <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, Math.max(1, lo)) + '…'
}

function wrap(measure, text, f, maxWidth, maxLines = 99) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (!s) return []
  const out = []
  let line = ''
  for (const ch of s) {
    if (measure(line + ch, f) > maxWidth && line) {
      out.push(line)
      line = ch
      if (out.length >= maxLines) break
    } else line += ch
  }
  if (out.length < maxLines && line) out.push(line)
  if (out.length >= maxLines) out[maxLines - 1] = fitText(measure, out[maxLines - 1], f, maxWidth)
  return out
}

function pairs(raw) {
  const out = []
  const re = /([^\s\d,，./·、]+)\s*([\d][\d,，]*(?:\.\d+)?(?:\s*\/\s*[\d][\d,，]*)?)/g
  let m
  while ((m = re.exec(String(raw || '')))) out.push({ key: m[1], value: m[2].replace(/[，,]/g, '') })
  return out
}

function resourceRows(before, after) {
  const b = new Map(pairs(before).map((x) => [x.key, x.value]))
  const a = new Map(pairs(after).map((x) => [x.key, x.value]))
  const keys = [...new Set([...b.keys(), ...a.keys()])]
  return keys.map((key) => ({ key, before: b.get(key) || '—', after: a.get(key) || '—' }))
}

function roundPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

export function renderProgressCard(report, { scale = 2 } = {}) {
  const measure = makeMeasurer()
  const ops = []
  const text = (x, y, str, f, color, align = 'left') => str && ops.push({ t: 'text', x, y, str, f, color, align })
  const line = (x1, y1, x2, y2, color, width = 1) => ops.push({ t: 'line', x1, y1, x2, y2, color, width })
  const rect = (x, y, w, h, color) => ops.push({ t: 'rect', x, y, w, h, color })
  const round = (x, y, w, h, color, radius = R, stroke = '') => ops.push({ t: 'round', x, y, w, h, color, radius, stroke })
  const circle = (x, y, radius, color, stroke = '') => ops.push({ t: 'circle', x, y, radius, color, stroke })

  const entries = Array.isArray(report.entries) ? report.entries : []
  const dateFont = font(22, 700, true)
  const bodyFont = font(24, 500)
  const smallFont = font(18, 400)
  const chipFont = font(18, 600, true)
  const metaFont = font(19, 500)
  const entryLayouts = []
  let y = 304

  /* ---------- 页面头部 ---------- */
  rect(0, 0, W, 16, ACCENT)
  text(PAD, 68, fitText(measure, report.shopName || '代肝工作室', font(36, 700), 620), font(36, 700), INK)
  const status = String(report.statusLabel || '进行中')
  const statusW = Math.max(116, measure(status, font(18, 600)) + 32)
  round(W - PAD - statusW, 43, statusW, 38, ACCENT_PALE, 19)
  text(W - PAD - statusW / 2, 69, status, font(18, 600), ACCENT_DARK, 'center')

  const title = report.orderTitle || report.title || '订单进度'
  text(PAD, 112, fitText(measure, title, font(30, 600), CW), font(30, 600), INK)
  const meta = [report.orderNo, report.gameName, report.customerName].filter(Boolean).join('  ·  ')
  text(PAD, 143, fitText(measure, meta, metaFont, CW - 160), metaFont, INK_2)
  text(W - PAD, 143, report.date || '', font(18, 400, true), INK_3, 'right')

  /* ---------- 摘要 ---------- */
  round(PAD, 176, CW, 96, PAPER, R, PAPER_EDGE)
  const cols = [PAD + 28, PAD + CW / 3 + 10, PAD + (CW * 2) / 3 - 8]
  text(cols[0], 207, '进度记录', smallFont, INK_3)
  text(cols[0], 244, `${entries.length} 条`, font(27, 700, true), INK)
  text(cols[1], 207, '收款状态', smallFont, INK_3)
  const moneyLine = report.due > 0 ? `已收 ¥${report.paid} · 待收 ¥${report.due}` : `已收 ¥${report.paid} · 已结清`
  text(cols[1], 244, fitText(measure, moneyLine, font(22, 600, true), CW / 3 - 42), font(22, 600, true), report.due > 0 ? AMBER : JADE)
  text(cols[2], 207, '客户', smallFont, INK_3)
  text(cols[2], 244, fitText(measure, report.customerName || '散客', font(23, 600), CW / 3 - 42), font(23, 600), INK)

  text(PAD, y, '进度记录', font(22, 700), INK)
  text(W - PAD, y, entries.length ? '从早到晚' : '等待第一条记录', smallFont, INK_3, 'right')
  y += 26

  /* ---------- 时间线 ---------- */
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const body = wrap(measure, e.content, bodyFont, CW - 124, 4)
    const note = wrap(measure, e.note ? `备注：${e.note}` : '', smallFont, CW - 124, 2)
    const resources = resourceRows(e.before, e.after)
    const delta = e.delta ? wrap(measure, `本次变化  ${e.delta}`, chipFont, CW - 124, 2) : []
    const attachText = e.shots && e.links ? `附 ${e.shots} 张截图 · ${e.links} 个链接` : e.shots ? `附 ${e.shots} 张截图` : e.links ? `附 ${e.links} 个链接` : ''
    const h = 66 + body.length * 34 + (resources.length ? 46 : 0) + delta.length * 27 + (note.length ? note.length * 27 + 8 : 0) + (attachText ? 28 : 0) + 24
    const top = y + 12
    const nodeY = top + 28
    entryLayouts.push({ e, i, top, h, nodeY, body, note, resources, delta, attachText })
    y = top + h + 18
  }

  if (!entries.length) {
    round(PAD, y + 12, CW, 88, PAPER, R, PAPER_EDGE)
    text(PAD + 28, y + 64, '还没有进度记录', bodyFont, INK_2)
    y += 118
  }

  for (const item of entryLayouts) {
    const { e, i, top, h, nodeY, body, note, resources, delta, attachText } = item
    if (i < entryLayouts.length - 1) {
      const next = entryLayouts[i + 1]
      line(PAD + 20, nodeY + 10, PAD + 20, next.nodeY - 10, RULE, 3)
    }
    circle(PAD + 20, nodeY, 11, i === entryLayouts.length - 1 ? ACCENT : PAPER, ACCENT)
    if (i === entryLayouts.length - 1) circle(PAD + 20, nodeY, 4, ACCENT)

    const x = PAD + 50
    const w = CW - 50
    round(x, top, w, h, PAPER, R, PAPER_EDGE)
    const rel = i === entryLayouts.length - 1 ? '最新进度' : `第 ${i + 1} 条`
    text(x + 22, top + 31, e.date || '', dateFont, INK)
    text(x + w - 22, top + 31, rel, smallFont, i === entryLayouts.length - 1 ? ACCENT : INK_3, 'right')

    let cy = top + 70
    for (const ln of body) {
      text(x + 22, cy, ln, bodyFont, INK)
      cy += 34
    }
    if (resources.length) {
      cy += 3
      let rx = x + 22
      for (const r of resources) {
        const label = `${r.key}  ${r.before} → ${r.after}`
        const rw = Math.min(270, measure(label, chipFont) + 24)
        if (rx + rw > x + w - 22) {
          cy += 32
          rx = x + 22
        }
        round(rx, cy - 22, rw, 30, ACCENT_PALE, 15)
        text(rx + rw / 2, cy - 1, fitText(measure, label, chipFont, rw - 16), chipFont, ACCENT_DARK, 'center')
        rx += rw + 8
      }
      cy += 26
    }
    for (const ln of delta) {
      text(x + 22, cy, ln, chipFont, ln.includes('+') ? JADE : INK_2)
      cy += 27
    }
    for (const ln of note) {
      text(x + 22, cy, ln, smallFont, INK_3)
      cy += 27
    }
    if (attachText) {
      round(x + 18, cy - 17, measure(attachText, smallFont) + 18, 26, AMBER_PALE, 13)
      text(x + 27, cy, attachText, smallFont, AMBER)
    }
  }

  y += 10
  line(PAD, y, W - PAD, y, RULE, 1)
  y += 34
  text(PAD, y, `由 ${report.shopName || '代肝工作室'} 整理`, smallFont, INK_3)
  if (report.contact) text(W - PAD, y, fitText(measure, `联系：${report.contact}`, smallFont, 420), smallFont, INK_3, 'right')
  y += 40

  const H = Math.max(520, Math.round(y + 20))
  const canvas = document.createElement('canvas')
  canvas.width = W * scale
  canvas.height = H * scale
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, W, H)
  for (const op of ops) {
    if (op.t === 'rect') {
      ctx.fillStyle = op.color
      ctx.fillRect(op.x, op.y, op.w, op.h)
    } else if (op.t === 'round') {
      roundPath(ctx, op.x, op.y, op.w, op.h, op.radius)
      ctx.fillStyle = op.color
      ctx.fill()
      if (op.stroke) {
        ctx.strokeStyle = op.stroke
        ctx.lineWidth = 1
        ctx.stroke()
      }
    } else if (op.t === 'circle') {
      ctx.beginPath()
      ctx.arc(op.x, op.y, op.radius, 0, Math.PI * 2)
      ctx.fillStyle = op.color
      ctx.fill()
      if (op.stroke) {
        ctx.strokeStyle = op.stroke
        ctx.lineWidth = 2
        ctx.stroke()
      }
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
