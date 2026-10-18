/* ============================================================
   「识别画面」留下的帧凭据 —— 跨组件的短期寄存处
   ============================================================

   为什么需要这么一个模块：

   识别画面是 ResourceField 干的，保存进度是 ProgressForm 干的，两者是
   父子组件但**只靠 onChange 传数值**（resources_before / resources_after 两个
   文本）。要让截图跟着这条进度一起存下去，就得把「帧凭据」从子传到父。

   为什么不用 props 加一个回调：
     多游戏那一支（MultiGameField）是每个游戏一个 ResourceField，回调要一层层
     往上并、还要处理哪个游戏的帧对应哪一段资源。为了传一个字符串搞这么一套，
     耦合得没必要。

   为什么不用模块级裸变量：
     这个表单可能同时开着两个（新建一条 + 编辑另一条），裸变量会串。所以按
     orderId 分桶，用完就清。

   注意这里**只存 token（一个短字符串）**，不存图片数据。真正的图还在服务端
   暂存着，等提交时才去取（见 src/screen-stash.mjs 和 /api/ocr/screen/frame）。
   ============================================================ */

/** orderId -> { side: token }。side 是 'before' / 'after' */
const buckets = new Map()

const bucketOf = (orderId) => {
  const key = String(orderId ?? '')
  if (!buckets.has(key)) buckets.set(key, { before: '', after: '' })
  return buckets.get(key)
}

/** ResourceField 认完一屏就记一下：哪一侧、这一阶段最终采纳的那一帧 */
export function rememberFrameToken(orderId, side, token) {
  if (!orderId || !token) return
  bucketOf(orderId)[side] = String(token)
}

/** 提交时取走：返回 token 数组（按 before / after 顺序），并清掉这个桶 */
export function takeFrameTokens(orderId) {
  const key = String(orderId ?? '')
  const bucket = buckets.get(key)
  buckets.delete(key)
  if (!bucket) return []
  return [bucket.before, bucket.after].filter(Boolean)
}

/**
 * 只看一眼，**不删桶**。
 *
 * 为什么要多这一个：提交进度是「先上传截屏、再 POST 进度」两步，而
 * `/api/ocr/screen/frame` 是取走即删。以前直接用 takeFrameTokens，
 * 只要后面 POST 失败（校验没过、后端 500、断网），token 已经被清掉、
 * 服务端原图也已经被取走 —— 用户点重试时截图就永久没了，
 * 而且没有任何提示（saveScreenshots 吞掉所有失败）。
 *
 * 所以改成：提交前 peek，**提交成功之后**才 drop。
 * 重试时桶还在，配合进度表单里缓存的已上传 URL，不会重复上传也不会丢。
 */
export function peekFrameTokens(orderId) {
  const bucket = buckets.get(String(orderId ?? ''))
  if (!bucket) return []
  return [bucket.before, bucket.after].filter(Boolean)
}

/** 用户取消、或者换了另一条单：把寄存的凭据丢掉，别让它挂到别人的进度上 */
export function dropFrameTokens(orderId) {
  buckets.delete(String(orderId ?? ''))
}

/** 清空（测试用） */
export function clearFrameTokens() {
  buckets.clear()
}
