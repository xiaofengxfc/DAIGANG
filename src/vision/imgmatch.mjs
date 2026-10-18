/* ============================================================
   图像匹配：自己解 PNG，靠图标认出资源。

   为什么必须认图标：鸣潮界面里 星声 / 体力 / 贝币 **只有图标没有文字**
   （实测两张真截图，OCR 一个标签都没认到，只有裸数字）。
   所以只能拿图标去对：先在画面里找到图标，再取它右边的数字。

   用**彩色**而不是灰度：星声是蓝白星、贝币是银币，灰度上很像，
   颜色上一眼分得开。实测灰度会把星声认成贝币/绿色晶体。

   PNG 解码靠 node:zlib，不引任何依赖。
   ============================================================ */

import zlib from 'node:zlib'

/** 解 PNG → { width, height, px }（RGB 三通道） */
export function decodePNG(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG')
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let palette = null
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('不支持隔行扫描的 PNG')
    } else if (type === 'PLTE') {
      palette = data
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (!width || !height) throw new Error('PNG 头读不出来')
  if (bitDepth !== 8) throw new Error(`只支持 8 位深的 PNG（这张是 ${bitDepth} 位）`)
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的 PNG 颜色类型 ${colorType}`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
      let v = line[i]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
  }

  const px = new Uint8Array(width * height * 3)
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    let r, g, b
    if (colorType === 3) {
      const idx = out[p] * 3
      r = palette ? palette[idx] : out[p]
      g = palette ? palette[idx + 1] : out[p]
      b = palette ? palette[idx + 2] : out[p]
    } else if (colorType === 0 || colorType === 4) {
      r = g = b = out[p]
    } else {
      r = out[p]
      g = out[p + 1]
      b = out[p + 2]
    }
    px[i * 3] = r
    px[i * 3 + 1] = g
    px[i * 3 + 2] = b
  }
  return { width, height, px }
}

export function crop(img, x, y, w, h) {
  const px = new Uint8Array(w * h * 3)
  for (let j = 0; j < h; j++) {
    const sy = y + j
    if (sy < 0 || sy >= img.height) continue
    for (let i = 0; i < w; i++) {
      const sx = x + i
      if (sx < 0 || sx >= img.width) continue
      const s = (sy * img.width + sx) * 3
      const d = (j * w + i) * 3
      px[d] = img.px[s]
      px[d + 1] = img.px[s + 1]
      px[d + 2] = img.px[s + 2]
    }
  }
  return { width: w, height: h, px }
}

/** 框平均缩放 */
export function resize(img, nw, nh) {
  const px = new Uint8Array(nw * nh * 3)
  for (let j = 0; j < nh; j++) {
    const y0 = Math.floor((j * img.height) / nh)
    const y1 = Math.max(y0 + 1, Math.floor(((j + 1) * img.height) / nh))
    for (let i = 0; i < nw; i++) {
      const x0 = Math.floor((i * img.width) / nw)
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * img.width) / nw))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const s = (y * img.width + x) * 3
          r += img.px[s]
          g += img.px[s + 1]
          b += img.px[s + 2]
          n++
        }
      }
      const d = (j * nw + i) * 3
      px[d] = n ? r / n : 0
      px[d + 1] = n ? g / n : 0
      px[d + 2] = n ? b / n : 0
    }
  }
  return { width: nw, height: nh, px }
}

/** 三通道各自去均值归一化，再拼起来；对整体亮度变化不敏感 */
function normalized(img) {
  const n = img.width * img.height
  const out = new Float32Array(n * 3)
  let norm = 0
  for (let ch = 0; ch < 3; ch++) {
    let mean = 0
    for (let i = 0; i < n; i++) mean += img.px[i * 3 + ch]
    mean /= n
    for (let i = 0; i < n; i++) {
      const v = img.px[i * 3 + ch] - mean
      out[i * 3 + ch] = v
      norm += v * v
    }
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

function ncc(a, b) {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

/** 在 region 里找 template，返回 { score, x, y, scale } */
export function findTemplate(screen, region, template, { step = 2, scales = [1], useMask = true } = {}) {
  let best = { score: -1, x: 0, y: 0, scale: 1 }
  const sx0 = Math.max(0, region.x)
  const sy0 = Math.max(0, region.y)
  const sx1 = Math.min(screen.width, region.x + region.w)
  const sy1 = Math.min(screen.height, region.y + region.h)
  for (const sc of scales) {
    const tw = Math.max(6, Math.round(template.width * sc))
    const th = Math.max(6, Math.round(template.height * sc))
    if (tw >= sx1 - sx0 || th >= sy1 - sy0) continue
    const tSmall = resize(template, tw, th)
    const mask = useMask ? buildMask(tSmall) : null
    const t = mask ? maskedVec(tSmall, mask) : normalized(tSmall)
    for (let y = sy0; y <= sy1 - th; y += step) {
      for (let x = sx0; x <= sx1 - tw; x += step) {
        const patch = crop(screen, x, y, tw, th)
        const score = ncc(t, mask ? maskedVec(patch, mask) : normalized(patch))
        if (score > best.score) best = { score, x, y, scale: sc }
      }
    }
  }
  return best
}

/**
 * 从模板里抠出「图标本体」的蒙版：亮于平均亮度的像素算本体，其余是背景。
 * 星声那种「暗底一颗细亮星」，一张图九成是背景 —— 不加蒙版的话，
 * 两个模板会比谁跟背景更像，直接认错。
 */
function buildMask(img, factor = 1.15) {
  const n = img.width * img.height
  let mean = 0
  for (let i = 0; i < n; i++) mean += (img.px[i * 3] + img.px[i * 3 + 1] + img.px[i * 3 + 2]) / 3
  mean /= n
  const thr = mean * factor
  const m = new Uint8Array(n)
  let cnt = 0
  for (let i = 0; i < n; i++) {
    if ((img.px[i * 3] + img.px[i * 3 + 1] + img.px[i * 3 + 2]) / 3 > thr) {
      m[i] = 1
      cnt++
    }
  }
  // 亮部太少（几乎全黑）就别蒙版了，不然只剩几个点，容易乱匹配
  return cnt >= n * 0.04 ? m : null
}

/**
 * 只在蒙版范围内比「颜色比例」（r = R/总，g = G/总），不比亮度。
 * 比亮度的话「暗底一颗亮星」和「暗底一块亮晶体」长得很像；
 * 比颜色比例就分得开：星声偏蓝白，体力偏青绿。
 * 蒙版外的像素留 0，点积时自然不参与。
 */
function maskedVec(img, mask) {
  const n = img.width * img.height
  const out = new Float32Array(n * 3)
  let mr = 0
  let mg = 0
  let cnt = 0
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    const R = img.px[i * 3]
    const G = img.px[i * 3 + 1]
    const B = img.px[i * 3 + 2]
    const s = R + G + B || 1
    mr += R / s
    mg += G / s
    cnt++
  }
  mr /= cnt || 1
  mg /= cnt || 1
  let norm = 0
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue
    const R = img.px[i * 3]
    const G = img.px[i * 3 + 1]
    const B = img.px[i * 3 + 2]
    const s = R + G + B || 1
    const vr = R / s - mr
    const vg = G / s - mg
    out[i * 3] = vr
    out[i * 3 + 1] = vg
    norm += vr * vr + vg * vg
  }
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < out.length; i++) out[i] /= norm
  return out
}

/** 用一组参考图标认出区域里出现的是哪一个 */
export function classifyIcon(screen, region, refs, opts) {
  let best = { key: null, score: -1 }
  for (const r of refs) {
    const hit = findTemplate(screen, region, r.img, opts)
    if (hit.score > best.score) best = { key: r.key, score: hit.score, x: hit.x, y: hit.y, scale: hit.scale }
  }
  return best
}

/* ---------------- 写出 PNG（存抠出来的图标模板用） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/** { width, height, px(RGB) } → PNG Buffer */
export function encodePNG(img) {
  const stride = img.width * 3
  const raw = Buffer.alloc((stride + 1) * img.height)
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0 // filter: none
    for (let i = 0; i < stride; i++) raw[y * (stride + 1) + 1 + i] = img.px[y * stride + i]
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr[8] = 8
  ihdr[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
