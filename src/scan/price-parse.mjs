/**
 * 从 OCR 结果里认出「服务名 + 价格」——自动比价链路的准确率命门。
 *
 * 这个模块是**纯函数**，不碰网络也不碰磁盘，方便拿真实帧反复调。
 *
 * 代肝价格表的画面排版，实拍帧里见过的有这几种：
 *
 *   1. 价格跟在名字后面
 *        蒙德、璃月、稻妻主线25/幕
 *        森林书140
 *        须弥、枫丹、纳塔、挪德卡莱、至冬主线：30/幕
 *   2. 一行里塞好几对（很常见，一列排不下就横着写）
 *        风神瞳40r 岩神瞳60r 采集材料
 *        版本大活动50r 小活动15r 活动包月80r
 *        尘歌壶1-10级100r 七圣召唤1-10级200r
 *   3. 表格两列，名字一列价格一列（OCR 会当成同一行的两个词）
 *        传说任务/邀约全结局        20/个
 *   4. 价格在前（少数）
 *        0.1r：柔灯铃、青蜜莓、矿物等
 *
 * 所以核心做法是**按价格切段**：把一行里所有「像价格」的数字找出来，
 * 每个数字前面那一段文字就是它的名字，上一个价格之后到它之前为界。
 * 这样 1、2、3、4 四种排版用的是同一套逻辑，不用分别写分支。
 *
 * 真正难的不是找到数字，而是**认出哪些数字不是价格**。实拍帧里踩过的坑：
 *
 *   · 沙地书80《比勒琪丝的哀歌+4个后续》—— 括号里的 4 是数量
 *   · 尘歌壶1-10级100r —— 1 和 10 是等级区间，100 才是价
 *   · 赞信誉图首单减20% —— 折扣
 *   · UID:206695281 / QQ 群号 / 手机号 —— 联系方式
 *   · 7.1至冬最新价格表 —— 版本号
 *   · 《白夜国晨昏记》30 《76只活爹（兰那罗）》40 —— 76 只是数量
 *   · 《森林会记住一切》+30r包后续《16石锁机关+静态风景10照片》—— 加价项和数量
 */

/* ============================================================
   常量
   ============================================================ */

/** 紧跟在数字后面、说明「这是一笔钱」的词 */
const CURRENCY_TAIL = /^(?:元|块钱|块|米|人民币|r|R|¥|￥|Y\b)/
/**
 * 斜杠单位：/幕 /个 /期。价格表里最强的信号 —— 数量不会写成 25/幕 这种形式。
 *
 * 只认一份固定的量词表，不贪心抓后面的汉字。原因：`白色0.1r/绿色0.25r/蓝色0.5r`
 * 里的 `/` 是列表分隔符，贪心抓就会把下一项的名字（「绿色」）当成单位。
 * 再加一道「单位后面不能紧跟数字」的保险。
 *
 * 允许前面先跟一个货币符（`15r/个`：r 是钱、个 是单位，单位更该留下）。
 */
const SLASH_UNIT_WORDS = '幕|个|期|天|图|单|次|周|月|张|本|颗|只|把|套|份|条|局|段|人|队|遍|轮|章|节|版|小时|分钟|号|层|星|命|级'
/**
 * `/单位` 形式的单价：`15/期`、`0.2r/个`、`320/月`。
 *
 * 单位限定在这个固定词表里，不能放宽成「斜杠后面任意短词」——
 * 实拍里 `0.1r/绿色0.25r` 的「绿色」是颜色不是单位，放宽就会把 `0.25` 的名字切坏。
 *
 * 这里**不加** `(?!\d)` 之类的边界断言：`周常：25r/周90r/月` 里 `/周` 后面
 * 紧跟着下一个数字 `90`，加了断言就会漏掉 `周` 而退回把 `r` 当单位（`25/元`）。
 * 词表本身已经足够严，不需要再加边界。
 */
const SLASH_UNIT = new RegExp(`^(?:[rR元块米¥￥])?\\s*\\/\\s*(${SLASH_UNIT_WORDS})`)
/** 加价项/补差价的尾巴。这类数字是「另加」的钱，不是这个服务项的本价 */
const ADDON_TAIL = /^(?:[rR元块米¥￥])?\s*(?:包)?(?:后续|前置|加购|补差|升级)/
/** 数字紧跟着的时间/计数单位：几乎不可能是价格 */
const COUNT_TAIL = /^(?:年|月|日|号|点|分|秒|小时|分钟|天|星|命|层|级|折|只|名|位|个|张|颗|份|条|把|支|枚|套|本|袋|组|批|局|场|次|轮|章|节|页|首|曲|图|%|％)/
/** 数字后面跟着这些，说明这个数在描述内容物而不是价 */
const CONTENT_TAIL = /^(?:个后续|个前置|张照片|照片|个宝箱|个任务|个角色|个版本|个材料|个神瞳|个兰那罗|个锚点|个传送)/
/**
 * 整行噪声：命中就整行丢掉。
 *
 * 最后几条是**剪辑/设计软件的界面文字**：不少「怎么定价」的视频会顺手录一段
 * 自己用可画/剪映排版的过程，OCR 会把工具栏的字也认出来（`格式刷`、`拼写检查`、
 * `字数`…），这些配上旁边的数字就成了「服务项 = 1 元」这种垃圾候选。
 */
const NOISE_LINE = [
  /(?:^|\s)uid\b/i,
  /\buid\s*[:：]/i,
  /(?:qq|vx|wx|微信|企鹅)\s*[:：]?\s*\d{5,}/i,
  /(?:\+?86)?1[3-9]\d{9}/,
  /(?:群|群号|加群)\s*[:：]?\s*\d{5,}/,
  /(?:关注|点赞|投币|收藏|转发|一键三连)/,
  /(?:直播间|开播|每晚|每周[一二三四五六日天])/,
  /(?:免责声明|版权|侵权|素材来源|侵删)/,
  /(?:B站|bilibili|哔哩哔哩)\s*[:：]?\s*$/i,
  /(?:格式刷|格式剧|拼写检查|字数统计|校对|撤销|重做|剪贴板|快捷键|工具栏|菜单栏|字号|行距)/,
  // Word / WPS 的界面元素：字体预览那一串 AaBbCc 是最 unmistakable 的特征，
  // 「怎么定价」类视频常录一段自己在文档里排版的画面
  /AaBb/i,
  /(?:宋体|黑体|微软雅黑|楷体|仿宋|等线|思源)/,
  /(?:五号|小四|三号|四号|小五)\s*(?:字|号)?/,
  /(?:页面布局|插入|引用|审阅|视图|开始)\s*(?:选项卡|菜单|工具)/,
  // WPS / Office 功能区那一行独有的词。价格表视频常录一段自己在文档里排版的画面，
  // 功能区整行会被认出来，配上旁边的数字就变成「套餐=1」这种垃圾候选。
  /(?:会员专享|WPSAI|公文模式|样式集|查找替换|AI排版|格式刷|格式剧)/i,
  /(?:等线|仿宋|思源|微软雅黑)\s*[（(]?\s*正文/,
  /**
   * 字体名 + 括号 + 正文。上面那条按「等线」等正确写法挡，但 OCR 经常把它认成
   * 别的字（实测把 `等线（正文）` 认成 `尊线正文`），所以这里退一步：
   * 只要行里出现「正文」这个排版用词，就认为这是文档界面而不是价格表。
   * 「正文」当服务名的一部分基本不可能（`正文` = 文档正文，不是代肝项目）。
   */
  /正文/,
  /**
   * WPS 样式行：`Aa 正文 标题1 标题2 标题3 标题4 页眉 样式集`。
   * `AaBb` 那条挡的是 Word 的字体预览，WPS 这边只显示一个 `Aa`，所以另外认
   * 「标题 + 数字」这种编号 —— 服务名里不会长这样。
   */
  /标题\s*\d/,
  // 评论区/买家秀截图的痕迹：`得吃` 是鸣潮圈里「打到了/拿到了」的黑话，
  // 只在买家评价里出现；`个人资料` 是 B站 个人主页的界面文字。
  // 这类截图里满是 `【某代肝】360贝币冰原全收集得吃炭`，认出来的全是垃圾候选。
  /(?:得吃|个人资料|粉丝数|获赞|播放数)/,
]
/**
 * 这些词单独当服务名没有意义（全是界面/排版用词）。
 * 只在「整个名字就等于它」时才挡 —— 名字里含这些字但更长的不受影响
 * （`标题党挑战` 之类不会因为含「标题」被误伤）。
 */
const GENERIC_NAMES = new Set([
  '标题', '正文', '页面', '字数', '字体', '颜色', '模板', '素材', '导出', '保存',
  '设置', '帮助', '关于', '首页', '登录', '注册', '搜索', '评论', '分享', '订阅',
  '格式', '粘贴', '复制', '删除', '编辑', '文本', '图片', '音乐', '特效', '滤镜',
  '封面', '字幕', '配音', '转场', '动画', '画布', '图层', '组件', '元素', '对齐',
  // 价格表里「套餐1/套餐2」是分档的标题，不是服务项本身
  '套餐', '页眉', '页脚', '页码', '样式', '查找', '替换', '选择', '排列', '工具',
  // 播放器 / 网站 / 编辑器的按钮。这些词也是「没价 + 后面跟着价格表」，
  // 光看长度和汉字占比会认成大类标题（实测 `退出` 就是这么混进来的）。
  '退出', '返回', '关闭', '打开', '更多', '全部', '确定', '取消', '刷新', '重置',
  '上传', '下载', '导入', '新建', '添加', '全选', '开始', '暂停', '继续', '播放',
  '详情', '简介', '弹幕', '倍速', '全屏', '画质', '清晰度', '投币', '点赞', '关注',
  '转发', '收藏', '充电', '追番', '投稿', '动态', '直播', '录屏', '倍速播放',
])
/** 行里出现这些词，价格候选要扣分（多半是折扣/优惠说明） */
const DISCOUNT_WORDS = /(?:减|折|优惠|立减|返现|券|首单|活动价|特价)/
/** 数字前后出现这些，说明是版本号/日期 */
const VERSION_LIKE = /^\d{1,2}\.\d{1,2}$/
/**
 * 这些词做名字明显是上一句的尾巴（「…包后续」），不是服务名。
 * 不挡掉的话，一段加价说明会被当成一个新服务项。
 */
const CONTINUATION_NAMES = /^(?:后续|前置|包后续|包前置|等|包含|说明|注|其它|其他|备注|以上|如下|以及|并且)$/

/* ============================================================
   文本归一化
   ============================================================ */

/**
 * 全角数字 → 半角。
 *
 * 只转数字和全角空格，**不转标点**：标点要原样留着显示（`渔获/竭泽/灰河渡手：本体+满精`
 * 里的「：」是给人看的，转成半角虽然不影响匹配但看着别扭）。
 * 正则那边本来就把全角半角两种标点都写进字符类了，所以不转也不会漏匹配。
 */
export function toHalfWidth(text) {
  return String(text || '')
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
}

/** 清掉价格表里常见的排版噪声字符，留下可比较的名字 */
export function cleanName(raw) {
  const name = toHalfWidth(raw)
    .replace(/\s+/g, ' ')
    // 上一段价格留下的单位残渣：`r 岩神瞳` 里的 `r `
    .replace(/^[\s:：,，、/\\|+*·\-—–]*[rR元块米¥￥]?\s*/, '')
    .replace(/^[\s:：,，、/\\|+*·\-—–]+/, '')
    .replace(/[\s:：\-—–+*·、,，.。|/\\<《【\[(]+$/, '')
    .replace(/[《》【】\[\]()（）]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  // `《76只活爹（兰那罗）》` 这种名字前面的数量不是名字的一部分，
  // 去掉才能和库里的「活爹兰那罗 / 兰那罗」对上。
  const noLead = name.replace(/^\d+\s*(?:只|个|张|名|位|种|类|条|把|颗|份|套)\s*/, '')
  if (cjkCount(noLead) >= 2) return trimTrailingCount(noLead)
  return trimTrailingCount(name)
}

/**
 * 去掉名字**末尾**的数量词：`满级突破材料168个` → `满级突破材料`。
 *
 * 只认容器/件数这类量词，**不含「级」**：`尘歌壶1-10级`、`雪山玉髓8级` 里的
 * 「级」是名字的一部分，切掉就把服务名毁了。去掉之后还得剩 ≥2 个汉字才算数，
 * 否则宁可原样留着（总比切出一个认不出的名字强）。
 */
function trimTrailingCount(name) {
  const trimmed = name.replace(/\s*\d+\s*(?:个|张|颗|只|份|条|把|支|枚|袋|组|批)\s*$/, '').trim()
  return cjkCount(trimmed) >= 2 ? trimmed : name
}

/** 名字里有多少个汉字 —— 少于 2 个基本可以断定不是服务名 */
export function cjkCount(text) {
  const m = String(text || '').match(/[\u4e00-\u9fa5]/g)
  return m ? m.length : 0
}

/* ============================================================
   行分组（保留坐标，价格解析要用）
   ============================================================ */

/**
 * 把 OCR 的词按 y 聚成行。
 *
 * 和 ocr.mjs 里的 textLines 不同：那个只返回拼好的字符串，这里要留住每个词和它的
 * 坐标 —— 判断「这是表格右列的价格」得看名字和价格之间的横向间隙。
 */
export function groupLines(words, { tolerance = null } = {}) {
  const rows = []
  for (const word of words || []) {
    if (!word || !String(word.text || '').trim()) continue
    const tol = tolerance ?? Math.max(8, (word.h || 20) * 0.6)
    let row = null
    for (const candidate of rows) {
      if (Math.abs(candidate.cy - word.cy) <= Math.max(tol, candidate.tol)) {
        row = candidate
        break
      }
    }
    if (row) {
      row.items.push(word)
      row.cy = (row.cy * (row.items.length - 1) + word.cy) / row.items.length
      row.tol = Math.max(row.tol, tol)
    } else {
      rows.push({ cy: word.cy, tol, items: [word] })
    }
  }
  return rows
    .sort((a, b) => a.cy - b.cy)
    .map((row) => buildLine(row.items.slice().sort((a, b) => a.x - b.x), row.cy))
}

/**
 * 把一行的词拼成文本，同时记住「第 i 个字符来自第几个词」。
 * 有了这张映射表，正则匹配到的位置就能反查回坐标（算横向间隙、画高亮框）。
 */
function buildLine(items, cy) {
  let text = ''
  const owner = []
  items.forEach((item, index) => {
    if (index > 0) {
      text += ' '
      owner.push(index - 1)
    }
    const raw = String(item.text || '')
    for (let k = 0; k < raw.length; k++) {
      text += raw[k]
      owner.push(index)
    }
  })
  return {
    cy,
    items,
    text,
    owner,
    x0: items.length ? Math.min(...items.map((i) => i.x)) : 0,
    x1: items.length ? Math.max(...items.map((i) => i.x + i.w)) : 0,
  }
}

/* ============================================================
   单个数字：打分与硬性排除
   ============================================================ */

/** 第一个左括号的位置：价格优先在这个位置之前找（括号里是说明，说明里的数字是数量）*/
function firstBracketIndex(text) {
  const m = String(text).match(/[（(《【\[<]/)
  return m ? m.index : -1
}

function scoreNumber(ctx) {
  const { tail, before, atLineEnd, columnGap, lineText, matched } = ctx
  let score = 0
  const slash = tail.match(SLASH_UNIT)
  if (slash) score += 4
  else if (CURRENCY_TAIL.test(tail)) score += 3
  if (/[:：]\s*$/.test(before)) score += 2
  if (/[¥￥]\s*$/.test(before)) score += 3
  if (atLineEnd) score += 1
  // 名字和价格之间隔了一大段空白 = 表格的右列，很强的「这是个价格」信号
  if (columnGap >= 40) score += 2
  if (CONTENT_TAIL.test(tail)) score -= 5
  if (COUNT_TAIL.test(tail)) score -= 6
  if (VERSION_LIKE.test(matched) && !slash && !CURRENCY_TAIL.test(tail)) score -= 6
  if (ctx.digitCount >= 6) score -= 8
  if (DISCOUNT_WORDS.test(lineText)) score -= 3
  return score
}

/**
 * 硬性排除：返回排除原因（null = 这个数字可以当价格）。
 * 返回原因而不是布尔，是因为「加价项」要连带跳过它后面那一整段说明，
 * 光把数字本身扔掉的话，说明括号里的数量会顶上来当价格（踩过这个坑）。
 */
function hardRejectReason(ctx) {
  const { tail, before, matched, digitCount } = ctx
  if (/^[%％]/.test(tail)) return 'percent' // 折扣
  if (COUNT_TAIL.test(tail)) return 'count' // 日期/时间/星级/等级
  if (CONTENT_TAIL.test(tail)) return 'content' // 数量说明
  if (ADDON_TAIL.test(tail)) return 'addon' // 「+30r包后续」这类加价项，不是基准价
  if (digitCount >= 6) return 'long' // UID / QQ / 手机号
  if (/^(?:19|20)\d{2}$/.test(matched)) return 'year'
  // 等级/数量区间：`1-10级` 里的 1 和 10 都不是价格
  if (/[-~—～]\s*$/.test(before)) return 'range'
  if (/^[-~—～]\s*\d/.test(tail)) return 'range'
  if (VERSION_LIKE.test(matched)) {
    const slash = tail.match(SLASH_UNIT)
    if (!slash && !CURRENCY_TAIL.test(tail)) return 'version'
  }
  // 数字前面紧贴着别的数字或字母：说明是长串被切开了（206695281）
  if (/[\dA-Za-z]$/.test(before)) return 'glued'
  /**
   * 配置代码，不是价格。
   *
   * 鸣潮玩家把声骸词条写成 `43311` / `44111` 这种五位数字，价格表里到处都是
   * 「一套43311主词条正确声骸100r」——不挡的话 `43311` 会被当成价格，
   * 而它后面紧跟着的 `小毕业800/月` 才是真价。
   *
   * 判据只用「位数 ≥4 + 后面紧跟汉字 + 没跟货币或 /单位」。
   *
   * **不能**加「两边都贴汉字」这条：价格表里 `黎乔利群岛20下层金库20 阿维纽林25`
   * 这种紧排版到处都是，每个价都正好夹在汉字中间，加了就把真价格全杀了。
   * 位数那条已经够用 —— 真价格四位以上时几乎总会带 `r`/`元`/`/月` 里的一个。
   */
  const tailHasUnit = SLASH_UNIT.test(tail) || CURRENCY_TAIL.test(tail)
  if (!tailHasUnit && digitCount >= 4 && /^[\u4e00-\u9fa5]/.test(tail)) return 'notation'
  /**
   * 加价项：`黎乔利群岛前置钓鱼解除风暴需+15`。
   *
   * 和 `《森林会记住一切》+30r包后续` 要分开：后者 30 是那一项自己的价，
   * 前者 15 是「满足前置条件再加 15」的附加费，不是基准价。
   * 区别在 `+` 前面的字 —— 「…需」「…前置」引出的是附加条件。
   */
  if (/(?:需|前置|另加|额外|再加)\s*[+＋]\s*$/.test(before)) return 'addon'
  return null
}

function isHardRejected(ctx) {
  return hardRejectReason(ctx) !== null
}

/**
 * 加价子句要跳过到哪里。
 * `+30r包后续《16石锁机关+静态风景10照片》` 里 30 是加价，后面那个括号整段是它的说明，
 * 里面的 16 和 10 都是数量。找到紧跟的括号就跳过配对的那个右括号，没有就跳过这一行。
 */
function addonSkipUntil(searchText, hit) {
  const after = searchText.slice(hit.end)
  const open = after.search(/[（(《【\[]/)
  if (open < 0) return searchText.length
  const openChar = after[open]
  const closeChar = { '（': '）', '(': ')', '《': '》', '【': '】', '[': ']' }[openChar]
  const close = after.indexOf(closeChar, open + 1)
  return close < 0 ? searchText.length : hit.end + close + 1
}

/* ============================================================
   一行 → 若干价格候选
   ============================================================ */

/**
 * 解析一行，返回 0~N 个价格候选。
 *
 * 按价格切段：每个通过筛选的数字，前面那一段文字就是它的名字，
 * 起点是上一个数字的结尾。这样「一行多对」和「一对一行」用同一套逻辑。
 */
export function parseLineCandidates(line) {
  const rawText = line.text
  if (!rawText) return []

  // 先转全角再判有没有数字：OCR 偶尔吐全角（`深塔１５/期`），
  // 拿原始文本判 `\d` 会漏掉整行。
  const text = toHalfWidth(rawText)
  if (!/\d/.test(text)) return []
  for (const re of NOISE_LINE) {
    if (re.test(text)) return []
  }

  // 价格优先在第一个左括号之前找；前缀里没数字才退回整行
  // （`森林书140《森林会记住一切》` 取前缀拿到 140，
  //   `《远吕羽氏遗事》20 《沉玉祝珑》40` 前缀没数字，就退回整行拿到 20 和 40）
  const bracket = firstBracketIndex(text)
  let searchText = text
  if (bracket > 0) {
    const head = text.slice(0, bracket)
    if (/\d/.test(head)) searchText = head
  }

  const re = /\d+(?:\.\d+)?/g
  const hits = []
  let m
  // 加价子句会连带跳过它后面那一段说明，这个变量记着「跳过到哪」
  let skipUntil = -1
  while ((m = re.exec(searchText)) !== null) {
    const matched = m[0]
    const start = m.index
    const end = start + matched.length
    if (start < skipUntil) continue
    const before = searchText.slice(0, start)
    const after = searchText.slice(end)
    const tail = after.slice(0, 14)
    const ownerIndex = line.owner[start]
    const prevItem = ownerIndex > 0 ? line.items[ownerIndex - 1] : null
    const item = line.items[ownerIndex]
    const columnGap = prevItem && item ? Math.max(0, item.x - (prevItem.x + prevItem.w)) : 0
    const ctx = {
      matched,
      before,
      tail,
      atLineEnd: after.trim() === '',
      columnGap,
      lineText: text,
      digitCount: matched.replace('.', '').length,
    }
    const reason = hardRejectReason(ctx)
    /**
     * `包后续 / 包前置` 后面那个括号里全是数量（`《16石锁机关+静态风景10照片》`），
     * 不管这个价本身收不收，括号都要整段跳过。
     *
     * 挂在拒绝分支里是不够的：那样只有「恰好因为 addon 被拒」才会跳，
     * 一旦这个数因为别的原因被拒（或者将来改成收下它），括号里的 16 和 10
     * 就会漏出来变成两个价格。跳过是独立于「收不收」的动作。
     */
    if (ADDON_TAIL.test(tail)) skipUntil = Math.max(skipUntil, addonSkipUntil(searchText, { end }))
    if (reason) continue
    const value = Number(matched)
    if (!Number.isFinite(value) || value <= 0 || value > 100000) continue
    hits.push({ value, matched, start, end, tail, score: scoreNumber(ctx), columnGap, ownerIndex })
  }
  if (!hits.length) return []

  hits.sort((a, b) => a.start - b.start)

  const out = []
  let cursor = 0
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]
    const next = hits[i + 1]
    const slash = hit.tail.match(SLASH_UNIT)
    const currencyMatch = hit.tail.match(CURRENCY_TAIL)

    // 名字的起点：上一个价格之后
    const nameStart = cursor

    let nameRaw = searchText.slice(nameStart, hit.start)
    let layout = 'name-first'
    if (!cleanName(nameRaw)) {
      /**
       * 这一段没有名字。两种可能，要分开处理：
       *
       * · **前面已经有价格了** → 这是同一项的另一个计价口径，沿用前一个名字。
       *   `日体： 5R/天，150/月` 里 150 前面只剩一个逗号，但它说的还是日体；
       *   归给「日体」之后，库内单位是 30天 的日体才能拿 150/月 去比，
       *   而 5/天 会被单位口径挡掉。不这么做的话 150 会变成一条没人认领的
       *   「可指定任意副本」垃圾候选，日体反而没样本。
       *
       * · **前面没有价格** → 真的是价格在前、名字在后（`25 本体`），走 price-first。
       */
      const previous = out[out.length - 1]
      if (previous) {
        nameRaw = previous.name
        layout = 'reuse-name'
      } else {
        nameRaw = searchText.slice(hit.end, next ? next.start : searchText.length)
        layout = 'price-first'
      }
    }
    // 光标越过「价格 + 它的单位」：只越过数字的话，`25/幕 传说任务` 里的「幕」
    // 会粘到下一个名字上，变成「幕 传说任务」。
    cursor = hit.end + (slash ? slash[0].length : currencyMatch ? currencyMatch[0].length : 0)

    const name = cleanName(nameRaw)
    if (cjkCount(name) < 2) continue
    if (CONTINUATION_NAMES.test(name)) continue
    if (GENERIC_NAMES.has(name)) continue

    out.push({
      name,
      price: Math.round(hit.value * 100) / 100,
      unit: slash ? slash[1] : currencyMatch ? '元' : '',
      unitKind: slash ? 'slash' : currencyMatch ? 'currency' : 'bare',
      score: hit.score,
      layout,
      priceText: hit.matched,
      line: rawText.trim(),
      columnGap: hit.columnGap,
      ownerIndex: hit.ownerIndex,
    })
  }

  // 同一行里同名同价的只留一条
  const seen = new Set()
  return out.filter((c) => {
    const key = `${c.name}\u0000${c.price}\u0000${c.unit}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 只取一行里分最高的那个（给「一行一对」的场景用，也方便测试）*/
export function parseLine(line) {
  const list = parseLineCandidates(line)
  if (!list.length) return null
  return list.slice().sort((a, b) => b.score - a.score)[0]
}

/**
 * 从整页 OCR 结果里抽出所有价格候选。
 * 同一页里重复的（同名同价）合并成一条，并记录出现次数。
 */
export function extractPriceCandidates(words, { minScore = null } = {}) {
  const lines = groupLines(words)
  const out = []
  const seen = new Map()
  for (const line of lines) {
    for (const hit of parseLineCandidates(line)) {
      if (minScore !== null && hit.score < minScore) continue
      const key = `${hit.name}\u0000${hit.price}\u0000${hit.unit}`
      const existing = seen.get(key)
      if (existing) {
        existing.hits += 1
        continue
      }
      const record = { ...hit, hits: 1 }
      seen.set(key, record)
      out.push(record)
    }
  }
  return out
}

/* ============================================================
   分节标题 → 大类候选
   ============================================================ */

/**
 * 一句话/一段说明的特征词。价格表视频里到处都是这种行，它们和分节标题一样
 * 「没有价格」，但它们是句子不是标签。实测踩过的：
 *   `包含危行任务+探图活动`   —— 紧跟 3 条有价行，光看「后面有价」会认成标题
 *   `不做危行任务探索度满不了，仅打满探索的话，需要带危行一起做`
 *   `有需求的板板看主页或评论区置顶`
 *   `半年个人全职小代直播/录屏价格良心退号视频`
 */
const NOTE_WORDS = /(?:包含|需要|需|仅|的话|如果|可以|请|联系|咨询|注意|说明|备注|如下|以上|主页|评论|置顶|同名|直播|录屏|价格|代肝|板板|欢迎|详情|免费|送|退号|良心|已结|百单|全职|小代|接单|下单|秒回|在线)/

/**
 * 分节标题最多几个字。
 *
 * 这个上限是「标题」和「说明」之间最有效的一刀：实测标题是
 * `地图探索`(4)、`主线`(2)、`世界任务`(4)、`蒙德总贴`(4)、`梦州地图`(4)，
 * 而说明行是 `包含危行任务+探图活动`(11)、
 * `有需求的板板看主页或评论区置顶`(14)、`半年个人全职小代直播/录屏价格良心退号视频`(20)。
 */
const SECTION_MAX_CHARS = 10

/**
 * 一行像不像分节标题。
 *
 * 判据（都要满足）：
 *   1. 这一行**没有被认出价格** —— 标题下面才是价格；
 *   2. 长度 2~10、八成以上是汉字 —— 标题是标签，不是句子；
 *   3. 冒号只能出现在**结尾**。中间带冒号的是「第二幕：为了没有眼泪的明天」
 *      这种换行了的服务项（名字太长折到下一行，价在再下一行），
 *      它后面同样跟着有价行，是这里最容易误判的一类；
 *   4. 不像说明句（NOTE_WORDS）；
 *   5. 不是文档界面噪音（NOISE_LINE）。
 *
 * 允许三种装饰，都先剥掉再判：
 *   · 版本前缀  `3.5版本梦州地图` → `梦州地图`（实测这类标题很多）
 *   · 序号前缀  `一：托管类：`   → `托管类`
 *   · 结尾箭头  `3.5版本梦州地图←` → 去掉 `←`
 */
function looksLikeSection(text) {
  let raw = toHalfWidth(String(text || '')).trim()
  if (!raw) return null
  for (const re of NOISE_LINE) {
    if (re.test(raw)) return null
  }

  /**
   * 版本前缀：只剥「开头那一段不含汉字的、里面有数字的、不超过 12 个字符」的前缀。
   * 要求里面有数字，是为了不动 `【鸣潮代肝】…` 这种以符号开头的行。
   */
  const lead = raw.match(/^[^\u4e00-\u9fa5]*/)
  if (lead[0] && /\d/.test(lead[0]) && lead[0].length <= 12) {
    raw = raw.slice(lead[0].length).replace(/^(?:版本|版)\s*/, '')
  }
  // 序号前缀
  raw = raw.replace(/^[一二三四五六七八九十\d]+\s*[：:、.．]\s*/, '')
  // 结尾的箭头、括号、标点（`梦州地图←`、`主线：`）。
  // 只剥标点和符号，**不剥字母数字** —— `充电烫TA` 是 B站 的充电按钮，
  // 把 `TA` 当装饰剥掉会剩个 `充电烫`，长度和汉字占比就都合格了，凭空多一个假标题。
  raw = raw.replace(/[\s\p{P}\p{S}]+$/u, '')
  if (!raw) return null

  // 冒号只允许在结尾 —— 剥掉结尾标点后这里就不该再有冒号了
  if (/[：:]/.test(raw)) return null

  const name = cleanName(raw)
  if (!name) return null
  const chars = [...name]
  if (chars.length < 2 || chars.length > SECTION_MAX_CHARS) return null

  const han = chars.filter((c) => /[\u4e00-\u9fa5]/.test(c)).length
  if (han / chars.length < 0.8) return null
  if (han < 2) return null

  /**
   * 关键词列表不是标题。实测 `探索度 锄地 声骸 地图任务深渊等` 折行后
   * 下半截 `声骸地图任务深渊等` 长度刚好 9、全汉字、后面紧跟着价格表 ——
   * 判据 1~3 全部通过，只有结尾这个「等」能把它认出来。
   */
  if (/等$/.test(name)) return null
  // 单独一个界面按钮/排版词没有意义（`退出`、`工具`）—— 和价格候选共用一张表
  if (GENERIC_NAMES.has(name)) return null
  // 「套餐一」「套餐1」这种分档编号是标题行的一部分，不是大类
  if (/^(?:套餐|方案|档位|档)\s*[一二三四五六七八九十\d]?$/.test(name)) return null
  if (NOTE_WORDS.test(name)) return null
  return name
}

/**
 * 从一页 OCR 里找出分节标题，并把它下面（到下一个标题为止）的有价行当它的子项。
 *
 * 「后面要跟着有价行」是核心判据，但**不能要求紧邻**：价格表的服务项名字长了
 * 会折行，于是标题和它下面第一个价之间可能隔着别的行。实测：
 *   `主线：` / `第一幕：捕风的异乡人15r` / `第二幕：为了没有眼泪的明天` / `15r`
 * `主线：` 后面紧跟的第一行有价、第二行没有 —— 严格「连续两行有价」会漏掉它。
 * 所以改成「往后看 4 行里有 ≥2 个有价行」。
 *
 * 代价是 `谷75/区` 这种折行的续行也会落进窗口，靠汉字占比（它只有 2/5）挡掉。
 */
export function extractSections(words, candidates = null, { lookahead = 4, minPriced = 2, maxItems = 14 } = {}) {
  const lines = groupLines(words)
  if (!lines.length) return []

  const hits = candidates || extractPriceCandidates(words)
  const priced = new Set(hits.map((h) => String(h.line || '').trim()))

  const sections = []
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].text
    if (priced.has(text.trim())) continue
    const name = looksLikeSection(text)
    if (!name) continue

    let pricedCount = 0
    for (let j = i + 1; j < Math.min(lines.length, i + 1 + lookahead); j += 1) {
      if (priced.has(lines[j].text.trim())) pricedCount += 1
    }
    if (pricedCount < minPriced) continue

    sections.push({ name, line: text.trim(), y: lines[i].cy, index: i })
  }

  // 每个标题的子项：它之后、下一个标题之前的有价行
  for (let k = 0; k < sections.length; k += 1) {
    const from = sections[k].index + 1
    const to = k + 1 < sections.length ? sections[k + 1].index : lines.length
    const items = []
    for (let j = from; j < to && items.length < maxItems; j += 1) {
      const t = lines[j].text.trim()
      if (!priced.has(t)) continue
      for (const hit of hits) {
        if (String(hit.line || '').trim() === t) items.push(hit.name)
      }
    }
    sections[k].items = [...new Set(items)]
  }

  return sections
}

/* ============================================================
   跨帧 / 跨视频聚合
   ============================================================ */

/** 中位数。偶数个取中间两个的平均 —— 和用户选的算法一致 */
export function median(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (!nums.length) return null
  const mid = nums.length >> 1
  return nums.length % 2 ? nums[mid] : Math.round(((nums[mid - 1] + nums[mid]) / 2) * 100) / 100
}

/** 四分位距，用来判断一批价格散不散（散说明大家口径不一致，要提醒用户）*/
export function spread(values) {
  const nums = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b)
  if (nums.length < 4) return null
  const q = (p) => {
    const pos = (nums.length - 1) * p
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return lo === hi ? nums[lo] : nums[lo] + (nums[hi] - nums[lo]) * (pos - lo)
  }
  const iqr = q(0.75) - q(0.25)
  const med = median(nums)
  return { iqr: Math.round(iqr * 100) / 100, ratio: med ? Math.round((iqr / med) * 1000) / 1000 : null }
}

/**
 * 同一个视频里同名服务可能因为滚动/多张表出现多次。
 * 取出现次数最多的那个价（并列时取分高的）—— 一个视频里反复出现说明是它的主推价。
 */
export function collapseWithinVideo(candidates) {
  const byName = new Map()
  for (const item of candidates) {
    if (!byName.has(item.name)) byName.set(item.name, new Map())
    const prices = byName.get(item.name)
    const priceKey = String(item.price)
    const existing = prices.get(priceKey)
    if (existing) {
      existing.hits += item.hits || 1
    } else {
      prices.set(priceKey, {
        price: item.price,
        unit: item.unit,
        unitKind: item.unitKind,
        hits: item.hits || 1,
        line: item.line,
        score: item.score,
      })
    }
  }
  const out = []
  for (const [name, prices] of byName) {
    const ranked = [...prices.values()].sort((a, b) => b.hits - a.hits || b.score - a.score)
    out.push({ name, ...ranked[0], alternatives: ranked.slice(1) })
  }
  return out
}

export const __testing = {
  CURRENCY_TAIL,
  SLASH_UNIT,
  SLASH_UNIT_WORDS,
  ADDON_TAIL,
  COUNT_TAIL,
  CONTENT_TAIL,
  NOISE_LINE,
  GENERIC_NAMES,
  NOTE_WORDS,
  SECTION_MAX_CHARS,
  looksLikeSection,
  CONTINUATION_NAMES,
  firstBracketIndex,
  buildLine,
  isHardRejected,
  scoreNumber,
  addonSkipUntil,
  hardRejectReason,
}
