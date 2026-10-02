/* ============================================================
   vision.mjs —— 屏幕识别的「眼睛」：把界面元素当锚点，不认分辨率。

   这个文件把几套成熟做法移植进纯 Node（零依赖），来源逐条记在下面，
   以后回查得动：

   1) 归一化互相关（NCC）模板匹配 —— OpenCV `matchTemplate` 的
      TM_CCOEFF_NORMED 口径（github.com/opencv/opencv, Apache-2.0）：
        R = Σ[T'·I'] / sqrt(ΣT'² · ΣI'²)
      原来 imgmatch.mjs 已经是这个口径，但每个窗口都重算均值方差 ——
      2559 宽的顶栏上就是几千万次多余加法（实测 21 秒）。
      这里换掉两处：
        · 用**积分图**（summed-area table，OpenCV `integral` 的思路）
          让任意窗口的和 / 平方和变成 4 次查表；
        · 跨项只对模板里亮度达标的像素（core）做点积，暗背景跳过。
      实测同样的活从 21 秒降到几十毫秒，分数还更高。

   2) 由粗到细的多尺度搜索（image pyramid / coarse-to-fine）——
      先在缩到 ~720px 宽的「条带」上用大步长粗筛，定出大概位置和缩放，
      再回原图 ± 几像素精修。这是「任意分辨率 + 实时」的唯一现实路子。

   3) 模板按**浮点比例**双线性重采样（不是整数倍缩放）。
      分辨率是连续的：2559/1600 = 1.599，不可能只试整数档。
      缩小前先做方块均值预滤波，免得出摩尔纹把图标糊掉
      （这就是 OpenCV pyrDown 里那一步低通）。

   4) 相对布局 / 锚点定标 —— 不是某个库，是 UI 自动化里公认的稳妥做法：
      先认出**同一个美术资源**（图标本体），由它的像素尺寸反推整屏缩放，
      再按「图标右边就是数字」这种相对关系读数。所以这里没有 y≈54、
      150px 这种写死坐标，换分辨率不会散架。

   这一层只负责「看」，不负责猜：分数不够就明说不够，
   绝不返回一个编出来的数字（这是整个识别的底线）。
   ============================================================ */

/* ---------------- 重采样 ---------------- */

/** 单通道方块均值滤波（积分图实现，一个像素 O(1)） */
function boxFilter(img, kw, kh) {
  if (kw <= 1 && kh <= 1) return img
  const { width: w, height: h, px } = img
  const rx = Math.floor(kw / 2)
  const ry = Math.floor(kh / 2)
  const out = new Uint8Array(w * h * 3)
  const stride = w + 1
  for (let c = 0; c < 3; c++) {
    const sat = new Float64Array(stride * (h + 1))
    for (let y = 0; y < h; y++) {
      let row = 0
      for (let x = 0; x < w; x++) {
        row += px[(y * w + x) * 3 + c]
        sat[(y + 1) * stride + (x + 1)] = sat[y * stride + (x + 1)] + row
      }
    }
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - ry)
      const y1 = Math.min(h, y + ry + 1)
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - rx)
        const x1 = Math.min(w, x + rx + 1)
        const s = sat[y1 * stride + x1] - sat[y0 * stride + x1] - sat[y1 * stride + x0] + sat[y0 * stride + x0]
        out[(y * w + x) * 3 + c] = s / ((x1 - x0) * (y1 - y0))
      }
    }
  }
  return { width: w, height: h, px: out }
}

/**
 * 双线性重采样到任意浮点比例。这是「任何分辨率」的地基：
 * 模板要缩到 0.63 倍、1.37 倍都得能缩，不能只试整数档。
 */
export function resampleBilinear(img, nw, nh) {
  nw = Math.max(1, Math.round(nw))
  nh = Math.max(1, Math.round(nh))
  if (nw === img.width && nh === img.height) return img
  const sx = img.width / nw
  const sy = img.height / nh
  const pre = sx > 1.05 || sy > 1.05 ? boxFilter(img, Math.max(1, Math.round(sx)), Math.max(1, Math.round(sy))) : img
  const px = new Uint8Array(nw * nh * 3)
  const maxX = pre.width - 1
  const maxY = pre.height - 1
  const sxp = pre.width / nw
  const syp = pre.height / nh
  for (let j = 0; j < nh; j++) {
    const fy = Math.min(maxY, Math.max(0, (j + 0.5) * syp - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(maxY, y0 + 1)
    const wy = fy - y0
    for (let i = 0; i < nw; i++) {
      const fx = Math.min(maxX, Math.max(0, (i + 0.5) * sxp - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(maxX, x0 + 1)
      const wx = fx - x0
      const d = (j * nw + i) * 3
      for (let c = 0; c < 3; c++) {
        const a = pre.px[(y0 * pre.width + x0) * 3 + c]
        const b = pre.px[(y0 * pre.width + x1) * 3 + c]
        const e = pre.px[(y1 * pre.width + x0) * 3 + c]
        const f = pre.px[(y1 * pre.width + x1) * 3 + c]
        const top = a + (b - a) * wx
        const bot = e + (f - e) * wx
        px[d + c] = top + (bot - top) * wy
      }
    }
  }
  return { width: nw, height: nh, px }
}

/** 裁一块子图（越界补 0，和 imgmatch.crop 行为一致） */
export function subImage(img, x, y, w, h) {
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

/* ---------------- 积分图 ---------------- */

/**
 * 整图积分图：sum / sq 各 (w+1)×(h+1)，**不分通道**。
 * 打分只用「颜色比例」一个量，不需要按通道求和，所以一张就够
 * （RGB 各存一张要多占三倍内存，没必要）。
 */
export function buildIntegral(img) {
  const { width: w, height: h } = img
  const lum = new Float64Array(w * h) // 颜色比例用：(R-S/3)
  for (let i = 0, p = 0; i < w * h; i++, p += 3) {
    lum[i] = img.px[p] - (img.px[p] + img.px[p + 1] + img.px[p + 2]) / 3
  }
  return makeIntegral(w, h, lum)
}

/** 从已经算好的 lum 数组建积分图（省一次全图扫描） */
export function makeIntegral(w, h, lum) {
  const stride = w + 1
  const sum = new Float64Array(stride * (h + 1))
  const sq = new Float64Array(stride * (h + 1))
  for (let y = 0; y < h; y++) {
    let rowS = 0
    let rowQ = 0
    for (let x = 0; x < w; x++) {
      const v = lum[y * w + x]
      rowS += v
      rowQ += v * v
      sum[(y + 1) * stride + (x + 1)] = sum[y * stride + (x + 1)] + rowS
      sq[(y + 1) * stride + (x + 1)] = sq[y * stride + (x + 1)] + rowQ
    }
  }
  return { sum, sq, stride, lum, width: w, height: h }
}

/** 窗口的和 / 平方和（4 次查表） */
export function rectSum(ii, x0, y0, x1, y1) {
  const s = ii.stride
  return ii.sum[y1 * s + x1] - ii.sum[y0 * s + x1] - ii.sum[y1 * s + x0] + ii.sum[y0 * s + x0]
}
export function rectSqSum(ii, x0, y0, x1, y1) {
  const s = ii.stride
  return ii.sq[y1 * s + x1] - ii.sq[y0 * s + x1] - ii.sq[y1 * s + x0] + ii.sq[y0 * s + x0]
}

/* ---------------- 模板 ---------------- */

/**
 * 把一个图像块编译成可快速匹配的模板。
 *
 * 用什么当特征：**颜色比例**，不是亮度。
 * imgmatch.mjs 里已经踩过这个坑并写在注释里 —— 星声（暗底一颗蓝白星）
 * 和体力（暗底一块青绿晶体）在灰度上几乎一样，比亮度会认错；比
 * 「R/G/B 各占总亮度的比例」就分得开。这里沿用这个结论：
 * 每个像素取 (R-S/3, G-S/3)，S = R+G+B，正好是「颜色比例」的线性形式，
 * 而且亮度大的像素权重自然大，不用另外加权。
 */
export function compileTemplate(img, { brightFactor = 1.0, minCoreRatio = 0.03, name = '' } = {}) {
  const n = img.width * img.height
  const px = img.px
  // 每个像素的 (a, b) 特征
  const va = new Float32Array(n)
  const vb = new Float32Array(n)
  let lumSum = 0
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const R = px[p]
    const G = px[p + 1]
    const B = px[p + 2]
    const S = R + G + B
    va[i] = R - S / 3
    vb[i] = G - S / 3
    lumSum += S / 3
  }
  const lumMean = lumSum / n
  const thr = lumMean * brightFactor
  const core = []
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    if ((px[p] + px[p + 1] + px[p + 2]) / 3 > thr) core.push(i)
  }
  const useMask = core.length >= n * minCoreRatio
  const idx = useMask ? Int32Array.from(core) : null
  const count = useMask ? idx.length : n

  // 跨项用：模板在核心像素上的 (a,b)，已按核心均值去中心化并整体归一化
  const ta = new Float32Array(count)
  const tb = new Float32Array(count)
  let ma = 0
  let mb = 0
  for (let k = 0; k < count; k++) {
    const i = idx ? idx[k] : k
    ma += va[i]
    mb += vb[i]
  }
  ma /= count || 1
  mb /= count || 1
  let norm = 0
  for (let k = 0; k < count; k++) {
    const i = idx ? idx[k] : k
    ta[k] = va[i] - ma
    tb[k] = vb[i] - mb
    norm += ta[k] * ta[k] + tb[k] * tb[k]
  }
  norm = Math.sqrt(norm) || 1
  for (let k = 0; k < count; k++) {
    ta[k] /= norm
    tb[k] /= norm
  }
  // 核心像素的 (x, y) 偏移预先算好挂在模板上。
  // 这一条是性能上的大头：matchAt 每调一次都要用它们，如果放在函数里现算，
  // 一帧里上百次匹配 × 每次几千个元素 = 几十万次多余的取模和分配（实测占了大半时间）。
  const corePx = new Int32Array(count)
  const corePy = new Int32Array(count)
  for (let k = 0; k < count; k++) {
    const i = idx ? idx[k] : k
    corePx[k] = i % img.width
    corePy[k] = (i / img.width) | 0
  }
  return { name, img, width: img.width, height: img.height, count, idx, ta, tb, hasMask: useMask, lumMean, thr, corePx, corePy }
}

/* ---------------- 匹配 ---------------- */

/**
 * 在 region 里找一个编译好的模板，返回 { score, x, y }。
 *
 *   score = Σ_core[ T'·P' ] / sqrt( Σ_core T'²  ×  Σ_window (P-P̄)² )
 *           └── 模板已归一化，分子就是协方差项
 *
 * 分子按模板的 core 像素扫（暗背景跳过），窗口方差走积分图 —— 两者都便宜。
 * 分母里窗口那一项用**整个窗口**的方差（含背景）：这样分数对「图标周围
 * 背景明暗变化」不敏感，比只算 core 更稳。
 */
export function matchAt(img, ii, region, tpl, { step = 2, deadline = 0, exclude = null } = {}) {
  const tw = tpl.width
  const th = tpl.height
  const x0 = Math.max(0, Math.floor(region.x))
  const y0 = Math.max(0, Math.floor(region.y))
  const x1 = Math.min(img.width, Math.ceil(region.x + region.w))
  const y1 = Math.min(img.height, Math.ceil(region.y + region.h))
  const res = { score: -2, x: x0, y: y0 }
  if (x1 - x0 < tw || y1 - y0 < th) return res
  // 积分图和 img 必须同尺寸（粗筛阶段是缩过的图，精修阶段是条带）
  const lum = ii.lum
  const W = ii.width
  const n = tw * th
  const count = tpl.count
  const ta = tpl.ta
  const tb = tpl.tb
  const corePx = tpl.corePx
  const corePy = tpl.corePy
  let guard = 0

  for (let y = y0; y <= y1 - th; y += step) {
    for (let x = x0; x <= x1 - tw; x += step) {
      if (deadline && (++guard & 63) === 0 && Date.now() > deadline) return res
      if (exclude && excluded(exclude, x, y, tw, th)) continue
      const s = rectSum(ii, x, y, x + tw, y + th)
      const q = rectSqSum(ii, x, y, x + tw, y + th)
      const mean = s / n
      const varr = q - n * mean * mean
      if (varr <= 1e-6) continue
      let num = 0
      const base = y * W + x
      for (let k = 0; k < count; k++) {
        const v = lum[base + corePy[k] * W + corePx[k]]
        num += ta[k] * v + tb[k] * v
      }
      const score = num / Math.sqrt(varr)
      if (score > res.score) {
        res.score = score
        res.x = x
        res.y = y
      }
    }
  }
  return res
}

/** 这个位置是不是压在「已经找到的图标」上（找多个同款图标时用） */
function excluded(list, x, y, w, h) {
  const cx = x + w / 2
  const cy = y + h / 2
  for (const e of list) {
    if (Math.abs(cx - e.cx) < e.r && Math.abs(cy - e.cy) < e.r) return true
  }
  return false
}

/**
 * 多尺度找图标：先粗后细。
 *
 * coarse：把整屏缩到 ~coarseWidth 宽，在粗图上跑一遍所有候选缩放，
 *         步长大、便宜；拿到大概位置和大概缩放。
 * fine：  回原图，在粗命中的位置 ±refine 像素内、用更密的缩放档再跑一遍。
 *
 * @returns {{score:number,x:number,y:number,scale:number,coarse:object}|null}
 */
export function findIcon(screen, tplImg, {
  region = { x: 0, y: 0, w: screen.width, h: screen.height },
  scales = null,
  baseScale = null,
  scaleFactor = 1.4,
  scaleSteps = 9,
  work = null,
  coarseStep = 6,
  fineStep = 1,
  minScore = 0.5,
  refine = 8,
  exclude = null,
  timeBudgetMs = 0,
} = {}) {
  const list = scales && scales.length ? scales : sweepScales(baseScale, scaleFactor, scaleSteps)
  const t0 = Date.now()
  const deadline = timeBudgetMs > 0 ? t0 + timeBudgetMs : 0

  /* ---- 工作分辨率 ----
     整个搜索（粗筛 + 精修）都在**同一张缩过的图**上做。这样换分辨率不换耗时，
     位置精度永远是「工作图上 1 像素」—— 我们要的是图标的框，不是像素级对齐。
     缩小时必须先低通（resampleBilinear 里第一件事就是方块均值），
     不然摩尔纹会把分数打下来。

     `work` 可以让调用方传进来复用：识别顶栏时调用方会先把那条带裁出来缩好，
     一次搜索结果给所有图标用 —— 不然一张 4K 截图光缩放就要 200ms×N 次。
     注意比例必须以 work.scale 为准：调用方给的图可能是**裁过的条带**，
     用 wImg.height/screen.height 算出来的比例是错的（这个坑踩过：
     比例算错后搜索区被压扁，命中落到画面外面还给出很高的分）。 */
  if (!work || !work.img) {
    const workH = Math.max(200, Math.min(screen.height, 620))
    const s = Math.min(1, workH / screen.height)
    work = { img: s < 0.999 ? resampleBilinear(screen, Math.round(screen.width * s), Math.round(screen.height * s)) : screen, scale: s }
  }
  const wImg = work.img
  // scale = 工作图像素 / 截图像素（原图 4K、工作图 620 高时约 0.26）
  const scale = work.scale > 0 ? work.scale : wImg.height / screen.height
  const workII = buildIntegral(wImg)
  const wRegion = { x: region.x * scale, y: region.y * scale, w: region.w * scale, h: region.h * scale }
  const wExclude = exclude ? exclude.map((e) => ({ cx: e.cx * scale, cy: e.cy * scale, r: e.r * scale })) : null

  /* ---- 粗筛：大步长定出大概位置和大概缩放 ----
     大步长会漏掉真正的最优点（实测步长 6 时分数能掉 0.1），所以粗筛只用来
     「定位」，每个缩放档再把它附近 ±coarseStep 的范围用步长 1 复算一遍。
     复算范围只有 (2×coarseStep+模板)² 那么大，比整幅图便宜两三个数量级，
     于是「粗筛的大步长」换来的速度不会被精度吃掉。 */
  let bestCoarse = null
  for (const s of list) {
    const st = compileTemplate(resampleBilinear(tplImg, tplImg.width * s * scale, tplImg.height * s * scale))
    if (st.width < 4 || st.height < 4) continue
    const rough = matchAt(wImg, workII, wRegion, st, { step: coarseStep, deadline, exclude: wExclude })
    if (rough.score < -1) continue
    // 在粗命中的位置附近用步长 1 复算。
    // 直接在**工作图**上扫这一小块，而不是先 subImage 再为它单独建一张积分图 ——
    // 一帧里 9 档 × 3 轮 × 3 个图标，光建小积分图就要 700ms（实测），是主要开销。
    // 窗口贴着图边时内部会自动夹到图内，不用另外处理。
    const pad = coarseStep
    const scan = {
      x: rough.x - pad,
      y: rough.y - pad,
      w: st.width + pad * 2,
      h: st.height + pad * 2,
    }
    const fine = matchAt(wImg, workII, scan, st, { step: 1, exclude: wExclude })
    const hit = fine.score > rough.score ? { score: fine.score, x: fine.x, y: fine.y } : rough
    if (!bestCoarse || hit.score > bestCoarse.score) bestCoarse = { ...hit, scale: s }
    if (deadline && Date.now() > deadline) break
  }
  if (!bestCoarse || bestCoarse.score < -1) return null

  /* ---- 精修：±refine 像素内、更密的缩放档 ----
     同样直接在工作图上扫，理由和上面粗筛那段一样（不为小窗口单独建积分图）。 */
  const fineList = list.filter((s) => s >= bestCoarse.scale / 1.25 && s <= bestCoarse.scale * 1.25)
  if (!fineList.length) fineList.push(bestCoarse.scale)
  let bestFine = null
  for (const s of fineList) {
    const st = compileTemplate(resampleBilinear(tplImg, tplImg.width * s * scale, tplImg.height * s * scale))
    if (st.width < 4 || st.height < 4) continue
    const scan = {
      x: bestCoarse.x - refine,
      y: bestCoarse.y - refine,
      w: st.width + refine * 2,
      h: st.height + refine * 2,
    }
    const hit = matchAt(wImg, workII, scan, st, { step: fineStep, exclude: wExclude })
    if (!bestFine || hit.score > bestFine.score) bestFine = { score: hit.score, x: hit.x, y: hit.y, scale: s }
    if (deadline && Date.now() > deadline) break
  }
  // 精修和粗筛在同一张工作图上打分，是同一个量，可以直接比 —— 不会选错峰
  const useFine = bestFine && bestFine.score >= bestCoarse.score - 0.01
  const pick = useFine ? bestFine : bestCoarse
  const result = {
    score: pick.score,
    x: Math.round(pick.x / scale),
    y: Math.round(pick.y / scale),
    scale: pick.scale,
    coarse: { ...bestCoarse, x: Math.round(bestCoarse.x / scale), y: Math.round(bestCoarse.y / scale) },
    work: [wImg.width, wImg.height],
    ms: Date.now() - t0,
  }
  return result.score >= minScore ? result : { ...result, weak: true }
}

/** 缩放档位：以 baseScale 为中心按比例铺开（等比而不是等差，视觉尺寸是对数的） */
export function sweepScales(baseScale, factor = 1.4, steps = 9) {
  const base = baseScale && baseScale > 0 ? baseScale : 1
  const out = []
  const lo = Math.log(base / factor)
  const hi = Math.log(base * factor)
  const n = Math.max(3, steps)
  for (let i = 0; i < n; i++) out.push(+Math.exp(lo + ((hi - lo) * i) / (n - 1)).toFixed(4))
  return out
}

/**
 * 一屏里同一个图标可能有多个（比如顶栏两个货币 + 详情页那个），找前 N 个。
 *
 * `stopBelow`：第一个候选低于这条线就直接收手，不再找第 2、3 个。
 * 这个很有用：一帧里 9 档缩放 × 3 个候选 = 27 次全条带搜索，
 * 而「这个图标这一屏根本没有」时全都在白扫（实测占了一帧九成时间）。
 * 0.4 这条线远低于认得出的水平（真图标 0.7+），所以不会误伤。
 */
export function findIconTop(screen, tplImg, opts = {}, topN = 3, minSeparation = 0.7, stopBelow = 0.4) {
  const hits = []
  const holes = []
  // 挖洞用的是工作图坐标，所以要先知道工作图相对原图缩了多少（没传就是 1）
  const scale = opts.work && opts.work.img ? opts.work.img.height / screen.height : 1
  for (let i = 0; i < topN; i++) {
    const hit = findIcon(screen, tplImg, { ...opts, exclude: holes.length ? holes : null })
    if (!hit) break
    if (hit.weak || hit.score < stopBelow) {
      if (!hits.length) hits.push(hit)
      break
    }
    hits.push(hit)
    const size = Math.max(tplImg.width * hit.scale, tplImg.height * hit.scale)
    // 把已经找到的位置挖掉，避免同一个图标被重复找到。
    // 注意：hit.x/y 是**原图坐标**，而匹配是在工作图上做的，
    // 所以这里要按 scale 换算成工作图坐标（不换算就会挖错地方，
    // 于是第 2、3 个候选全是同一个图标的重复命中 —— 这个坑踩过）。
    holes.push({
      cx: (hit.x + (tplImg.width * hit.scale) / 2) * scale,
      cy: (hit.y + (tplImg.height * hit.scale) / 2) * scale,
      r: size * minSeparation * scale,
    })
  }
  return hits
}

/**
 * 打分接近的多个候选里，挑**最靠左**的那个。
 *
 * 为什么需要这一步：NCC 的分数量级和「图标好不好认」有关。实测同一张顶栏图上，
 * 星声（内部对比强）真实位置 0.88 分，而贝币（一枚银币，内部偏平）真实位置
 * 只有 0.72~0.75，偏偏界面里别的亮块能刷到 0.70 —— 只取最高分就会认到隔壁
 * 那个跟它毫无关系的数字上（实测：贝币认成了右边星声的 2174）。
 *
 * 规则：分数落在最高分 `margin` 以内的候选算「差不多好」，取最左的。
 * 顶栏的资源是从左往右排的，同分取左不会错；而真正的假阳性
 * （实测 0.699 vs 0.744）差得比 margin 远，会被挡在外面。
 */
export function pickStableCandidate(hits, { margin = 0.92, minScore = 0 } = {}) {
  const list = (hits || []).filter((h) => h && !h.weak && h.score >= minScore)
  if (!list.length) return null
  let best = list[0]
  for (const h of list) if (h.score > best.score) best = h
  const bar = best.score * margin
  const kept = list.filter((h) => h.score >= bar).sort((a, b) => a.x - b.x)
  const picked = kept[0]
  return { ...picked, margin_hits: kept.length, best_score: +best.score.toFixed(3), second_score: +Math.max(...list.map((h) => (h === best ? -1 : h.score))).toFixed(3) }
}

/* ---------------- 数字块（把 OCR 碎片拼回一个数） ---------------- */

const DIGITISH = /^[\dOoIlL|，,．.／/：:\s]+$/

/**
 * OCR 会把一个数字切成几块：1280 宽下 `2174` 会变成 `2174`，
 * 1600 宽下会变成 `21` + `74`，而 `129/2000` 会变成 `1` + `29` + `/` + `2000`。
 * 判断「两块是不是同一个数」只看几何，不看顺序：
 *   · 纵向重叠够多（同一行）；
 *   · 横向间距小于字高的 0.45 倍（数字之间不会有这么大空隙）；
 *   · 两块都是「像数字的内容」。
 * 拼起来之后再交给 parseNumber 验一遍，验不过就整块丢掉。
 */
export function groupNumberBlocks(words, { gapRatio = 0.45, lineRatio = 0.6 } = {}) {
  const items = (words || [])
    .filter((w) => w && w.text && DIGITISH.test(w.text))
    .map((w) => ({ ...w, h: w.h || 24 }))
    .sort((a, b) => a.cy - b.cy || a.x - b.x)
  const used = new Array(items.length).fill(false)
  const blocks = []
  for (let i = 0; i < items.length; i++) {
    if (used[i]) continue
    used[i] = true
    const group = [items[i]]
    let grew = true
    while (grew) {
      grew = false
      const gh = median(group.map((g) => g.h))
      const cy = group.reduce((s, g) => s + g.cy, 0) / group.length
      const left = Math.min(...group.map((g) => g.x))
      const right = Math.max(...group.map((g) => g.x + g.w))
      for (let j = 0; j < items.length; j++) {
        if (used[j]) continue
        const it = items[j]
        if (Math.abs(it.cy - cy) > Math.max(gh, it.h) * lineRatio) continue
        const gap = it.x > right ? it.x - right : left - (it.x + it.w)
        if (gap > Math.max(gh, it.h) * gapRatio) continue
        used[j] = true
        group.push(it)
        grew = true
      }
    }
    group.sort((a, b) => a.x - b.x)
    const text = group.map((g) => g.text).join('').replace(/\s+/g, '')
    const x = Math.min(...group.map((g) => g.x))
    const y = Math.min(...group.map((g) => g.y))
    const w = Math.max(...group.map((g) => g.x + g.w)) - x
    const h = Math.max(...group.map((g) => g.y + g.h)) - y
    blocks.push({ text, x, y, w, h, cx: x + w / 2, cy: y + h / 2, parts: group.length })
  }
  return blocks
}

function median(list) {
  if (!list.length) return 0
  const s = [...list].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
