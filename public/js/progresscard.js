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
const SHOT_EDGE = '#D7DEE6'
const FONT_UI = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans SC",sans-serif'
const FONT_FIG = 'ui-monospace,"SF Mono","Cascadia Mono",Consolas,monospace'

const W = 1080
const PAD = 64
const CW = W - PAD * 2
const R = 14

/** 截图缩略图的高度。挑 132 是因为 2K 截图缩到这个高度后，资源数字仍然看得清 */
const SHOT_H = 132
/** 一条进度里最多画几张缩略图（时间线上可能有更多，卡片只做示意，多了会喧宾夺主） */
const SHOT_MAX = 3
/** 缩略图之间、以及和卡片内边距的间隔 */
const SHOT_GAP = 10

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

/** 这张 media 项是不是图片（和 order-detail.jsx 的时间线用同一个判别口径） */
export function isShotUrl(url) {
  return /\.(png|jpe?g|webp|gif|svg)(\?|$)/i.test(String(url || ''))
}

/**
 * 预加载全部截图。
 *
 * 为什么要先全加载再画：canvas 是「画完就没法补」的 —— 如果边画边等图，
 * 画到那一行时图还没 onload，就只能空着，等图回来也没机会补上（除非整张重画）。
 * 所以先把所有用到的图和解码出来，再开始算高度和绘制。
 *
 * 加载失败**不抛**：截图可能是外链、可能已经删了，少一张图不该让整张卡看不出来。
 */
async function loadImages(urls) {
  const wanted = [...new Set((urls || []).filter(isShotUrl))]
  const out = new Map()
  await Promise.all(
    wanted.map(
      (url) =>
        new Promise((resolve) => {
          const img = new Image()
          let done = false
          const finish = (value) => {
            if (done) return
            done = true
            if (value) out.set(url, value)
            resolve()
          }
          // 外链图跨域时 canvas 会被污染（toDataURL 抛异常），加这个至少能试一次
          img.crossOrigin = 'anonymous'
          img.onload = () => finish(img)
          img.onerror = () => finish(null)
          // 兜底：网络卡住时不能让「生成图片」一直转圈
          setTimeout(() => finish(null), 8000)
          img.src = url
        })
    )
  )
  return out
}

/**
 * 按原始比例把图铺进一个 w×h 的框里（contain），返回实际绘制矩形。
 * 不做 cover：游戏截图裁掉两边可能正好裁掉资源数字，那这张图就没用了。
 */
function fitInto(img, w, h) {
  const ratio = img.naturalHeight ? img.naturalWidth / img.naturalHeight : 16 / 9
  let dw = w
  let dh = w / ratio
  if (dh > h) {
    dh = h
    dw = h * ratio
  }
  return { dw, dh, dx: (w - dw) / 2, dy: (h - dh) / 2 }
}

/**
 * 画一张缩略图（等比缩放 + 细边框）。
 * 图没加载出来就画一个占位框 —— 空着会让人以为卡片漏画了。
 */
function drawShot(ctx, img, x, y, w, h) {
  ctx.save()
  roundPath(ctx, x, y, w, h, 8)
  ctx.clip()
  ctx.fillStyle = '#F1F4F8'
  ctx.fillRect(x, y, w, h)
  if (img) {
    const { dw, dh, dx, dy } = fitInto(img, w, h)
    ctx.drawImage(img, x + dx, y + dy, dw, dh)
  } else {
    ctx.fillStyle = INK_3
    ctx.font = font(16, 500)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('截图加载失败', x + w / 2, y + h / 2)
  }
  ctx.restore()
  ctx.strokeStyle = SHOT_EDGE
  ctx.lineWidth = 1
  roundPath(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 8)
  ctx.stroke()
}

/**
 * 把一条进度里的截图排成一行缩略图，返回这一行占的高度。
 *
 * 宽度按**原始比例**算，不按张数等分：一张 16:9 的 2K 截图如果只分到半行宽，
 * 缩出来就是个窄条，资源数字根本看不清（实测过）。按比例摊开，一张就占满整行、
 * 两张各占一半，既不浪费宽度也不会变形。
 *
 * 只往 ops 里塞「图片要画在哪」，不在这里真画 —— 绘制阶段统一在最后
 * （那时 canvas / ctx 才存在，而且 scale 已经套好）。
 */
function layoutShotRow(ops, images, urls, x, y, maxW) {
  const list = (urls || []).filter(isShotUrl).slice(0, SHOT_MAX)
  if (!list.length) return 0

  // 先按比例算出每张想占多宽（都以 SHOT_H 为高）
  const sized = list.map((url) => {
    const img = images.get(url)
    const ratio = img && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 16 / 9
    // 太窄的图（竖屏截图）限一下，不然一行塞不下第二张
    return { url, w: Math.max(120, SHOT_H * ratio) }
  })

  // 只画这一行放得下的那些，剩下的丢掉（卡片是摘要，不做瀑布流）
  const row = []
  let used = 0
  for (const item of sized) {
    const extra = (row.length ? SHOT_GAP : 0) + item.w
    if (row.length && used + extra > maxW) break
    row.push(item)
    used += extra
  }
  if (!row.length) return 0

  // 一行没占满就整体居中，别全都挤在左边留一大块空白
  let cx = x + Math.max(0, (maxW - used) / 2)
  for (const item of row) {
    ops.push({ t: 'shot', url: item.url, x: cx, y, w: item.w, h: SHOT_H })
    cx += item.w + SHOT_GAP
  }
  return SHOT_H
}

/**
 * 把资源小标签排成若干行，返回 { rows, height }。
 *
 * 抽出来单独算是为了**让高度和绘制用同一份结果**：以前一个地方按「有没有资源」
 * 加 46px、另一个地方按实际换行累加，两边对不上，资源一多就叠字、卡底还会空一截。
 */
function layoutChips(measure, resources, f, maxW) {
  const rows = []
  if (!resources || !resources.length) return { rows, width: maxW }
  let row = []
  let used = 0
  for (const r of resources) {
    const label = `${r.key}  ${r.before} → ${r.after}`
    const w = Math.min(270, measure(label, f) + 24)
    // 只有「这一行已经有东西」时才要额外算那个 8px 间隔
    const extra = (row.length ? 8 : 0) + w
    if (row.length && used + extra > maxW) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push({ label: fitText(measure, label, f, w - 16), w })
    used += w + (row.length > 1 ? 8 : 0)
  }
  if (row.length) rows.push(row)
  return { rows, width: maxW }
}

export async function renderProgressCard(report, { scale = 2 } = {}) {
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

  /* 先把所有要画进卡片的截图加载完再排版。
     不能边排边等：高度要提前算出来才能建 canvas，而图没解码就没法知道画多高。 */
  const loaded = await loadImages(entries.flatMap((e) => e.shotUrls || e.media || []))

  /* ---------- 时间线 ---------- */
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    const innerW = CW - 50 - 44 // 卡片宽 - 左右各 22 内边距
    const body = wrap(measure, e.content, bodyFont, innerW, 4)
    const note = wrap(measure, e.note ? `备注：${e.note}` : '', smallFont, innerW, 2)
    const resources = resourceRows(e.before, e.after)
    const delta = e.delta ? wrap(measure, `本次变化  ${e.delta}`, chipFont, innerW, 2) : []
    const shots = (e.shotUrls || e.media || []).filter(isShotUrl).slice(0, SHOT_MAX)
    const attachText =
      e.shots && e.links ? `附 ${e.shots} 张截图 · ${e.links} 个链接`
        : e.shots ? `附 ${e.shots} 张截图`
          : e.links ? `附 ${e.links} 个链接`
            : ''

    // 资源小标签按实际排版量行数 —— 以前写死按一行算，三个资源换行后
    // 会顶到下面的「本次变化」上，两条文字叠在一起
    const chipRows = layoutChips(measure, resources, chipFont, innerW)

    // 高度按「从上到下依次累加」算出来，每一项都在下面画的时候用同一个变量推进，
    // 保证「留出来的空」和「真画上去的」永远一致（以前是两套算法，底部就空一截）
    let contentH = 0
    contentH += body.length * 34
    if (chipRows.rows.length) contentH += 6 + chipRows.rows.length * 32
    contentH += delta.length * 27
    if (note.length) contentH += 8 + note.length * 27
    if (shots.length) contentH += 10 + SHOT_H
    // 截图缩略图已经能看见了，就不再重复写「附 N 张截图」；只有链接（或图没画出来）时才写
    if (attachText && !shots.length) contentH += 10 + 26

    const h = 70 + contentH + 22
    const top = y + 12
    const nodeY = top + 28
    entryLayouts.push({ e, i, top, h, nodeY, body, note, resources, delta, attachText, shots, chipRows, images: loaded })
    y = top + h + 18
  }

  if (!entries.length) {
    round(PAD, y + 12, CW, 88, PAPER, R, PAPER_EDGE)
    text(PAD + 28, y + 64, '还没有进度记录', bodyFont, INK_2)
    y += 118
  }

  for (const item of entryLayouts) {
    const { e, i, top, h, nodeY, body, note, resources, delta, attachText, shots, chipRows, images } = item
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

    if (chipRows.rows.length) {
      cy += 6
      for (const row of chipRows.rows) {
        let rx = x + 22
        for (const chip of row) {
          round(rx, cy - 22, chip.w, 30, ACCENT_PALE, 15)
          text(rx + chip.w / 2, cy - 1, chip.label, chipFont, ACCENT_DARK, 'center')
          rx += chip.w + 8
        }
        cy += 32
      }
    }

    for (const ln of delta) {
      text(x + 22, cy, ln, chipFont, ln.includes('+') ? JADE : INK_2)
      cy += 27
    }
    for (const ln of note) {
      text(x + 22, cy, ln, smallFont, INK_3)
      cy += 27
    }

    // 截图缩略图：只登记位置，真正的 drawImage 在最后统一回放时做
    // （那时 ctx 才存在、scale 也已经套好）
    if (shots.length) {
      cy += 10
      layoutShotRow(ops, images, shots, x + 22, cy, w - 44)
      cy += SHOT_H
    }

    if (attachText && !shots.length) {
      cy += 10
      // 徽标宽度必须夹住：attachText 里有「附 N 张截图 · M 个链接」这种长文案，
      // 不夹就会画到卡片外面去
      const label = fitText(measure, attachText, smallFont, w - 44 - 18)
      const badgeW = Math.min(w - 44, measure(label, smallFont) + 18)
      round(x + 22, cy - 17, badgeW, 26, AMBER_PALE, 13)
      text(x + 31, cy, label, smallFont, AMBER)
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
    } else if (op.t === 'shot') {
      // 缩略图：裁圆角 → 铺图 → 描一圈细边（和 loadImages 预加载的图对应）
      drawShot(ctx, loaded.get(op.url) || null, op.x, op.y, op.w, op.h)
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
