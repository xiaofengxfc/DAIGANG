/**
 * 「待添加的服务项」的接口。
 *
 * 这是比价和价格表之间的中转站：
 *
 *   B站比价 → 整理 → 勾选 → **存成待添加**（这里）
 *                              ↓
 *   价格表 → 大类下面看到它们 → 逐个「添加」或「删掉」
 *
 * 为什么不一步到位建进价格表：比价面板里看不到「这个大类现在已经有什么」。
 * 而「这一项要不要建」恰恰要看这个 —— 原神的「主线」下面已经有 7.0、7.1 了，
 * 视频里那个「主线」是重复的还是新版本？得回价格表里看才知道。
 */
import { del, get, patch, post } from '../http.mjs'
import { int, clampStr } from '../util.mjs'
import { acceptDraft, clearDrafts, deleteDraft, listDrafts, updateDraft } from '../service-drafts.mjs'

export function register() {
  /**
   * 列待添加。
   *
   * 价格表那边是跟着 `/api/pricebook` 一起拿的（`drafts` 字段），这个接口是给
   * 「只看待添加」和别的地方用的。
   */
  get('/api/service-drafts', (ctx) => ({
    items: listDrafts({ gameId: ctx.query.game_id ? int(ctx.query.game_id) : null }),
  }))

  /** 改名字 / 改价 / 换大类 —— 都是在真正落库之前调整 */
  patch('/api/service-drafts/:id', (ctx) => updateDraft(ctx.params.id, {
    name: ctx.body?.name === undefined ? undefined : clampStr(ctx.body.name, 120),
    price: ctx.body?.price,
    category_id: ctx.body?.category_id,
  }))

  /**
   * 真正建进价格表。
   *
   * 走的是**和手工「添加服务」完全一样的落库路径**，所以建出来的东西和手工建的
   * 没有区别 —— 比价那边下次扫描就能匹上（别名会带过去）。
   */
  post('/api/service-drafts/:id/accept', (ctx) => acceptDraft(ctx.params.id))

  /** 不要这一条 */
  del('/api/service-drafts/:id', (ctx) => deleteDraft(ctx.params.id))

  /** 这个游戏下的待添加全不要了 */
  post('/api/service-drafts/clear', (ctx) => clearDrafts({ gameId: ctx.body?.game_id ? int(ctx.body.game_id) : null }))
}
