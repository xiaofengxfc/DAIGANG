/* ============================================================
   「识别画面」抓到的帧 —— 临时暂存
   ============================================================

   要解决的问题：以前 recognizeScreenOnce() 抓完帧、认完数字就在 finally 里把
   PNG 删了。于是「这一屏当时长什么样」没有任何留档 —— 数字认错了没法复盘，
   用户想要一张截图留在进度时间线上也无从谈起。

   为什么不直接写进 data/uploads：
     识别一轮最多要看 3 帧 × 2 个界面 = 6 张 2K 截图。用户很可能看完数字就
     走掉了（不保存进度），那些图就成了永远没人引用的孤儿文件，只增不减。
     所以这里先放内存，等用户**真的保存这条进度**时再来取；没来取就过期丢掉。

   取和删是分开的（peekFrame / releaseFrame）：
     取帧之后前端还要在浏览器里压缩、再 POST /api/uploads。中间任何一步失败
     都不该让这一帧消失 —— 否则用户点重试时只能拿到 404，进度记下了、截图
     永久没了。所以「读」不改状态，「释放」由调用方在上传成功之后显式发起；
     不来释放的帧照样会被 TTL 和总量上限收掉，内存不会越攒越多。

   为什么放内存而不是落盘：
     一张 2K PNG 约 1~3MB，6 张也就十几兆，本地单机工具完全吃得下。
     落盘反而要处理「写了一半崩了」的残留。

   TTL 之后必须能自己消失：Map 里存时间戳，每次写入顺手清理一遍过期的，
   不依赖定时器（没请求时不该有东西在跑）。
   ============================================================ */

/**
 * 一个会话最多留几帧。识别一轮 3 帧，给到 4 够用，多出来的是异常情况。
 * 「只截图」那条路（manual-shot）每按一次就是新的一帧，用户可能连按好几下，
 * 所以它靠 XFC_SCREEN_FRAME_LIMIT 放宽 —— 松手前那一张不能被自己挤掉。
 * 默认值不改：识别路径的行为不能因为多了个功能就变。
 */
const MAX_PER_SESSION = Math.max(1, Math.min(32, Number(process.env.XFC_SCREEN_FRAME_LIMIT || 4) || 4))
/** 帧多久没人取就丢掉。用户从识别到点保存通常不到一分钟，10 分钟很宽松 */
const TTL_MS = 10 * 60 * 1000
/** 所有会话加起来最多占多少字节，超了从最旧的开始丢 —— 防止长时间不重启攒满内存 */
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

/** token -> { session, stage, buf, width, height, at } */
const frames = new Map()
let totalBytes = 0
let seq = 0

function sweep(now = Date.now()) {
  for (const [token, entry] of frames) {
    if (now - entry.at > TTL_MS) {
      totalBytes -= entry.buf.length
      frames.delete(token)
    }
  }
  // 还超上限就从最旧的开始砍（Map 保持插入顺序，第一个就是最旧写入的）
  while (totalBytes > MAX_TOTAL_BYTES && frames.size) {
    const [token, entry] = frames.entries().next().value
    totalBytes -= entry.buf.length
    frames.delete(token)
  }
}

/**
 * 存一帧，返回 token。
 * token 里带会话名是为了能按会话做「只留最近 N 帧」的裁剪。
 */
export function stashFrame({ session, stage = '', buf, width = 0, height = 0 }) {
  if (!buf || !buf.length) return null
  const now = Date.now()
  sweep(now)

  const token = `f${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`
  frames.set(token, { session: String(session || 'default'), stage: String(stage || ''), buf, width, height, at: now })
  totalBytes += buf.length

  // 同一会话只留最近几帧：用户连着看第 4 帧时，第 1 帧已经没有意义了
  const mine = [...frames.entries()].filter(([, e]) => e.session === String(session || 'default'))
  while (mine.length > MAX_PER_SESSION) {
    const [oldToken, entry] = mine.shift()
    totalBytes -= entry.buf.length
    frames.delete(oldToken)
  }
  return token
}

/**
 * 读一帧，**不删除**。
 *
 * 以前这里是「取走即删除」，调用方拿到字节就没了。但取帧和「上传成功」是
 * 两件不同的事：前端取回 → 在浏览器里压缩 → POST /api/uploads。中间任何一步
 * 失败（压缩抛错、上传断网、后端 500），帧就已经被删掉，用户点重试只会得到
 * 404 —— 进度记下了、截图永久没了，而且没有任何提示（saveScreenshot 吞异常）。
 *
 * 所以改成：读不改状态，由调用方在**真正用完之后**调 releaseFrame。
 * 没来释放的照样会被 TTL 和总量上限收掉，不会在内存里越攒越多。
 */
export function peekFrame(token) {
  sweep()
  // token 先归一成字符串再用：传进来可能是 null、数字，get 和 delete 必须是
  // 同一个 key，否则删不掉（这个坑踩过）。
  const key = String(token || '')
  const entry = frames.get(key)
  if (!entry) return null
  return { buf: entry.buf, width: entry.width, height: entry.height, stage: entry.stage }
}

/**
 * 释放一帧（上传成功之后调用）。
 * 返回 true 表示确实删掉了一帧，false 表示它已经过期/被释放过了 ——
 * 后者不是错误：重试提交时重复释放很正常。
 */
export function releaseFrame(token) {
  sweep()
  const key = String(token || '')
  const entry = frames.get(key)
  if (!entry) return false
  frames.delete(key)
  totalBytes -= entry.buf.length
  return true
}

/** 看一眼有多少帧 / 占多少内存（给测试和排查用） */
export function frameStashStats() {
  sweep()
  return { count: frames.size, bytes: totalBytes }
}

/** 清空（测试收尾用；进程退出时也顺手调一下） */
export function clearFrameStash() {
  frames.clear()
  totalBytes = 0
}
