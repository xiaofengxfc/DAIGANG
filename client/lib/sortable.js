/**
 * 拖拽排序里**纯计算**的那部分。
 *
 * 单独放一个文件是因为这两段最容易写错，而且写错了**看不出来**：
 * 拖完顺序不对，用户只会觉得「没拖准」，不会想到是代码算错了。
 * 放在这里就能被 Node 直接 import 进冒烟测试（没有 React、没有 JSX）。
 */

/**
 * 把 `id` 挪到 `targetId` 的前面或后面，返回新的 id 数组。
 *
 * **坑在「先删后插」的下标位移上**：把 `id` 从数组里拿掉之后，`targetId` 的
 * 下标可能已经变了（它原来在 `id` 后面的话就前移了一位）。所以必须先删，
 * 再**重新找** targetId 的位置，不能沿用删除前的下标 —— 沿用的话往右拖永远
 * 差一格。
 *
 * @param {Array<string|number>} ids
 * @param {string|number} id        被拖的那个
 * @param {string|number} targetId  落在谁身上
 * @param {boolean} after           true = 插到它后面，false = 插到它前面
 * @returns {Array} 新数组；id 或 targetId 找不到时原样返回
 */
export function moveId(ids, id, targetId, after) {
  const list = Array.isArray(ids) ? [...ids] : []
  const from = list.findIndex((item) => String(item) === String(id))
  if (from < 0) return ids
  list.splice(from, 1)
  const to = list.findIndex((item) => String(item) === String(targetId))
  if (to < 0) return ids
  list.splice(after ? to + 1 : to, 0, id)
  return list
}

/** 挪一格（键盘 ↑ ↓ 用）。已经在头 / 尾就原样返回 */
export function nudgeId(ids, id, delta) {
  const list = Array.isArray(ids) ? [...ids] : []
  const from = list.findIndex((item) => String(item) === String(id))
  const to = from + delta
  if (from < 0 || to < 0 || to >= list.length) return ids
  list.splice(from, 1)
  list.splice(to, 0, id)
  return list
}

/**
 * 把 `list` 里符合 `match` 的那些元素，按 `orderedIds` 的顺序填回**原来的位置**。
 *
 * 为什么不能直接重排整个数组：`/api/pricebook` 的 `categories` 是**所有游戏混在
 * 一起**的扁平数组（服务端按 sort_order 出，界面再按游戏分组）。重排某个游戏的
 * 大类时，只能挑出这个游戏占的那几个位置填回去，别的游戏一动不能动 ——
 * 直接 `map` 一遍整个数组会把别的游戏的大类顺序也搅了。
 *
 * `orderedIds` 里的条数跟匹配到的位置数对不上时**原样返回**：那说明拖的过程中
 * 数据被刷新过（少了一条 / 多了一条），这时不动比乱动好。
 */
export function reorderInPlace(list, match, orderedIds) {
  const source = Array.isArray(list) ? list : []
  const slots = []
  source.forEach((item, index) => { if (match(item)) slots.push(index) })
  const byId = new Map(source.map((item) => [String(item.id), item]))
  const ordered = (orderedIds || []).map((id) => byId.get(String(id))).filter(Boolean)
  if (ordered.length !== slots.length) return list
  const next = [...source]
  slots.forEach((slot, index) => { next[slot] = ordered[index] })
  return next
}
