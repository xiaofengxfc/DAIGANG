/* ============================================================
   「识别画面」抓到的帧 —— 临时暂存
   ============================================================

   要解决的问题：以前 recognizeScreenOnce() 抓完帧、认完数字就在 finally 里把
   PNG 删了。于是「这一屏当时长什么样」没有任何留档 —— 数字认错了没法复盘，
   用户想要一张截图留在进度时间线上也无从谈起。

   为什么不直接写进 data/uploads：
     识别一轮最多要看 3 帧 × 2 个界面 = 6 张 2K 截图。用户很可能看完数字就
     走掉了（不保存进度），那些图就成了永远没人引用的孤儿文件，只增不减。
     所以这里先放内存，等用户**真的保存这条进度**时再来取走；没来取就过期丢掉。

   为什么放内存而不是落盘：
     一张 2K PNG 约 1~3MB，6 张也就十几兆，本地单机工具完全吃得下。
     落盘反而要处理「写了一半崩了」的残留。

   TTL 之后必须能自己消失：Map 里存时间戳，每次写入顺手清理一遍过期的，
   不依赖定时器（没请求时不该有东西在跑）。
   ============================================================ */

/** 一个会话最多留几帧。识别一轮 3 帧，给到 4 够用，多出来的是异常情况 */
const MAX_PER_SESSION = 4
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

/** 取一帧。**取走即删除** —— 调用方拿去压缩上传，留着只会占内存 */
export function takeFrame(token) {
  sweep()
  const entry = frames.get(String(token || ''))
  if (!entry) return null
  frames.delete(token)
  totalBytes -= entry.buf.length
  return { buf: entry.buf, width: entry.width, height: entry.height, stage: entry.stage }
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
