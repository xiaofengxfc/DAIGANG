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
   暂存着，等提交时才去取（见 src/vision/screen-stash.mjs 和 /api/ocr/screen/frame）。
   ============================================================ */

/**
 * orderId -> Map<游戏名, { side: token }>。
 *
 * 两层而不是一层，是因为**一单可能有两个游戏**（见 resource-field.jsx 的
 * MultiGameField）：它给每个游戏各渲染一块 SingleGameField，而传下去的
 * orderId 是**同一个**。以前桶只有一层 `{ before, after }`，于是鸣潮识别完
 * 记下 before，异环识别完又把同一个 before 覆盖掉 —— 先识别的那个游戏的
 * 截图静默消失（复现：peek 只剩后一个 token）。
 *
 * 用游戏名而不是 profile id 当键，是因为 ResourceField 传下来的是 gameName
 * （订单上那个游戏名），没别的东西可传；同一份配置下两者是一一对应的。
 */
const buckets = new Map()

const gameKeyOf = (game) => String(game ?? '').trim()

function bucketOf(orderId, game) {
  const key = String(orderId ?? '')
  let games = buckets.get(key)
  if (!games) {
    games = new Map()
    buckets.set(key, games)
  }
  const g = gameKeyOf(game)
  let slot = games.get(g)
  if (!slot) {
    slot = { before: '', after: '' }
    games.set(g, slot)
  }
  return slot
}

/**
 * ResourceField 认完一屏就记一下：哪个游戏、哪一侧、这一阶段最终采纳的那一帧。
 * game 不传时落进 '' 这一格（老调用方的行为不变）。
 */
export function rememberFrameToken(orderId, side, token, game = '') {
  if (!orderId || !token) return
  bucketOf(orderId, game)[side] = String(token)
}

/** 一个 orderId 下所有游戏的 token，按 before / after 展开（去重、保序） */
function tokensOf(orderId) {
  const games = buckets.get(String(orderId ?? ''))
  if (!games) return []
  const out = []
  for (const slot of games.values()) {
    for (const token of [slot.before, slot.after]) {
      if (token && !out.includes(token)) out.push(token)
    }
  }
  return out
}

/** 提交时取走：返回 token 数组，并清掉这条单下所有游戏的桶 */
export function takeFrameTokens(orderId) {
  const tokens = tokensOf(orderId)
  buckets.delete(String(orderId ?? ''))
  return tokens
}

/**
 * 只看一眼，**不删桶**。
 *
 * 为什么要多这一个：提交进度是「先上传截屏、再 POST 进度」两步。
 * 以前用 takeFrameTokens：只要后面 POST 失败（校验没过、后端 500、断网），
 * token 已经被清掉、服务端原图也已经没了 —— 用户点重试时截图就永久丢了，
 * 而且没有任何提示（saveScreenshots 吞掉所有失败）。
 *
 * 所以改成：提交前 peek，**提交成功之后**才 drop。
 * 重试时桶还在，配合进度表单里缓存的已上传 URL，不会重复上传也不会丢。
 * （服务端那边现在也是「读不删 + 上传成功后显式释放」，两级都留着退路。）
 */
export function peekFrameTokens(orderId) {
  return tokensOf(orderId)
}

/** 用户取消、或者换了另一条单：把寄存的凭据丢掉，别让它挂到别人的进度上 */
export function dropFrameTokens(orderId) {
  buckets.delete(String(orderId ?? ''))
}

/** 清空（测试用） */
export function clearFrameTokens() {
  buckets.clear()
}
