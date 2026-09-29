# PORT-CANDIDATES.md

对着现在这份代码，逐个功能组件过一遍：哪些能从 GitHub 上移植现成的，哪些移植了反而更糟。
结论按「值不值得动手」分四级，每条都写了现状、候选、代价和落点。

评估时间：2026-09-29 · 本机 Node v24.9.0 · `node:sqlite` 3.50.4

---

## 0. 先明确「移植」在这份项目里有三种形态

`PRODUCT.md` 的硬约束是**零依赖**：最终用户的机器上不跑 `npm install`。
所以「移植」不等于「加 npm 依赖」，实际上有三条互不相同的路：

| 形态 | 做法 | 是否守住零依赖 | 适用 |
| --- | --- | --- | --- |
| **A. 单文件 vendor** | 把库的单个 `.js`/`.mjs` 放进 `public/vendor/`，`<script type="module">` 直接引 | ✅ 守住 | 前端库 |
| **B. 外部本地程序** | 像现在的 `restic` 一样：检测有没有装，装了就用，没装就降级 | ✅ 守住 | OCR、截屏、备份、服务守护 |
| **C. 真 npm 依赖** | `package.json` 里加 `dependencies` | ❌ 破坏 | 只有在收益大到值得改约束时才用 |

**能走 A 或 B 的优先，C 级要单独论证。** 下面每条都标了走哪条路。

---

## 1. 现有功能组件清单

| # | 组件 | 现在的实现 | 代码量 | 有成熟替代吗 |
| --- | --- | --- | --- | --- |
| 1 | HTTP 服务 + 路由 | 手写 | `server.mjs` + `src/http.mjs` (~400 行) | 有，但不建议 |
| 2 | SQLite 访问 + 迁移 | `node:sqlite` | `src/db.mjs` (~430 行) | 有，但不建议 |
| 3 | 登录 / 会话 / 限速 | 手写 scrypt + 会话表 | `src/auth.mjs` (~110 行) | 有，但过重 |
| 4 | 凭证保险箱 | 手写 AES-256-GCM + 内存密钥 + 审计 | `src/vault.mjs` (~215 行) | 有，但不匹配 |
| 5 | 计价引擎 | 手写 | `src/pricing.mjs` | ❌ 业务专有 |
| 6 | 导出模型 | 手写 | `src/priceexport.mjs` | ❌ 业务专有 |
| 7 | **Word 文档导出** | 手写 ZIP + OOXML | `src/docx.mjs` (308 行) | ✅ 有 |
| 8 | **价格表图片（canvas）** | 手写排版画布 | `public/js/pricecard.js` (328 行) | ✅ 有 |
| 9 | 进度对比图（canvas） | 手写 | `public/js/progresscard.js` | ✅ 有（同上） |
| 10 | **OCR** | PowerShell 调 Windows.Media.Ocr | `src/ocr.mjs` + `scripts/ocr.ps1` | ✅ **强烈有** |
| 11 | 图标模板匹配 | 手写 PNG 解码 + NCC | `src/imgmatch.mjs` (322 行) | 有，但不建议 |
| 12 | **屏幕截图** | PowerShell + System.Drawing | `src/screen.mjs` + `scripts/grab.ps1` | ✅ 有 |
| 13 | ERPNext 同步 | 手写 REST + outbox | `src/erpnext*.mjs` (~700 行) | ❌ 业务专有 |
| 14 | 备份 | restic 包装 + JSON 导出 | `src/restic.mjs` | ✅ 有（增量式） |
| 15 | **Windows 启动器** | 手写 C#，`csc` 编译 | `launcher/DaiganLauncher.cs` (36KB) | ✅ 有 |
| 16 | **无头截图工具** | 手写 CDP + WebSocket | `scripts/shot.mjs` (289 行) | ✅ **强烈有** |
| 17 | **接口冒烟测试** | 手写 | `scripts/smoke.mjs` (**52KB**) | ✅ **强烈有** |
| 18 | 前端框架 | 原生 ESM + 原生 CSS，无构建 | `public/js/**` | ❌ 换框架等于重写 |
| 19 | Excel / PDF 导出 | **不存在** | — | ✅ 有（纯新增能力） |
| 20 | 手机端「装到桌面」 | 不存在（无 manifest） | — | ✅ 有 |

---

## 2. A 级：建议移植

### A1. OCR → Umi-OCR（形态 B，守住零依赖）★ 最值得做

**现状的痛**（`src/ocr.mjs` 注释里你自己也记了）：

- 只认 Windows，且**依赖系统装了 `zh-Hans-CN` 语言包**，没装就报「识别没有输出」；
- 认不出只有图标没有文字的资源（所以被迫写了 `imgmatch.mjs` 一整套模板匹配）；
- **拿不到置信度**。`parseNumber()` 只能靠「有没有非法字符」猜，认糊了只好返回 `null` 让你手填；
- 每次识别 spawn 一个 `powershell.exe`，还要处理 `stdio` 不能给 `ignore` 的坑。

**候选项：**

- **[hiroi-sora/Umi-OCR](https://github.com/hiroi-sora/Umi-OCR)** — MIT（LICENSE 已核对），PaddleOCR 内核，完全离线。
  **关键点：它带一个本地 HTTP 服务**，默认 `http://127.0.0.1:1224`：

  ```
  POST /api/ocr
  { "base64": "<不带 data: 前缀的 base64>",
    "options": { "ocr.language": "models/config_chinese.txt", "data.format": "dict" } }
  ```

  成功返回 `code: 100`，`data` 是数组，每项 `{ text, score, box: [[x,y]×4], end }`
  —— **置信度、四角坐标全都有**。这正好补上现在缺的两样东西。
  （[接口文档](https://cdn.jsdelivr.net/gh/hiroi-sora/Umi-OCR@main/docs/http/api_ocr.md)）

- **[siva-sub/client-ocr](https://github.com/siva-sub/client-ocr)**（`client-side-ocr`，MIT）—— 浏览器内 ONNX Runtime + PP-OCR。
  同样离线、免费。**但这份项目用不了**，理由在下面 C4 里说（CSP + 模型体积）。

- **[naptha/tesseract.js](https://github.com/naptha/tesseract.js)**（Apache-2.0）—— 能跑，但中文模型 60MB+、速度慢于系统引擎，
  识别质量也不如 PaddleOCR。**不如 Umi-OCR。**

**怎么落：**

1. `src/ocr.mjs` 里加一个 `ocrViaUmi(imagePath)`，先探 `http://127.0.0.1:1224/api/ocr/get_options` 通不通；
2. 通 → 用 Umi-OCR，把 `score` 和 `box` 一并返回；不通 → 回落到现在的 `ocr.ps1`。
   `ocrAvailable()` 改成「Umi-OCR 在线 **或** ocr.ps1 存在」，`/api/ocr/status` 多返回一个 `engine` 字段。
3. `src/screen.mjs` 收益最大：有了 `box` 就不用靠 `parseWords` 猜行，`TOP_BAND = 150` 这种硬编码的
   「资源数字永远在 y≈54 / 顶栏 150px 以内」可以换成「识别到标签行再往下看」。
   `RESOURCE_ALIASES` 那个「结晶波片」别名表大概率也不用维护了。
4. 前端 `vaultgate.js` 之外，`views/orders.js` 里贴截图识别那两个入口照旧调 `/api/ocr`，不用改。

**代价：** 用户要多装一个软件（可选，不装就降级成现状）。这是**唯一**的代价。

---

### A2. 价格表图片导出 → snapdom 或 modern-screenshot（形态 A）

**现状的痛**：`public/js/pricecard.js` 用 canvas 手写排版，自己做 `measureText` 二分截断、贪心折行、
点线引导符——**328 行**。而同一份版式在 `src/docx.mjs` 里又用 OOXML 手写了一遍（`rightTab('dot')`、
`noticeParas()` 的浅色底 + 左侧靛蓝竖线）。**同一套设计，两份实现，改一处忘一处。**

**候选项：**

- **[zumerlab/snapdom](https://github.com/zumerlab/snapdom)** — MIT，v3，**核心零依赖**，纯浏览器 Web API。
  `await snapdom.toPng(el)` 直接把 DOM 拍成图。支持 `width`/`dpr`、字体自动内嵌、超长图分块编码。
- **[qq15725/modern-screenshot](https://github.com/qq15725/modern-screenshot)** — MIT，html-to-image 的 fork，
  同为单文件、零依赖，有 web worker 复用。

**收益：**

- 价格表版式改成**一段 HTML + 现有 CSS**（`--cinnabar`、`--line`、`tabular-nums` 直接复用），
  以后改版式是改 CSS，不是改 328 行 canvas 几何计算；
- 和 `docx.mjs` 的版式能真正对齐，甚至可以先出 HTML 再决定导图还是导 Word；
- **顺带拿到 PDF**（snapdom 有 `pdf-image` 插件），`报价单` 发客户比 `.docx` 通用得多；
- 进度对比图 `progresscard.js` 同样受益。

**怎么落：** 库文件放 `public/vendor/snapdom.mjs`（形态 A，守住零依赖）。
注意 http.mjs 的 MIME 表已经有 `.mjs`，静态服务不用改。

---

### A3. 屏幕截图 → node-screenshots（形态 B 或 C）

**现状的痛**（`scripts/grab.ps1`）：

- 只截 `PrimaryScreen`，多显示器只能截主屏；
- **没有 DPI 感知**——在 125%/150% 缩放的屏上，抓到的像素尺寸和坐标是错的，
  而这正好会喂给 `imgmatch.mjs` 做模板匹配（模板按「数字高度的 1.7 倍」算缩放档位）；
- 每次截屏 spawn 一个 PowerShell。

**候选项：[nashaofu/node-screenshots](https://github.com/nashaofu/node-screenshots)**
（`napi-rs` 预编译二进制，底层是 Rust 的 [XCap](https://github.com/nashaofu/xcap)）

- 跨平台：Windows / macOS / Linux（含 arm64、loongarch64）；
- **`Monitor.all()` / `Window.all()`**，每个显示器带 `scaleFactor()`、`rotation()`、`isPrimary()`；
- `captureImageSync()`、`crop()`、`toPng()/toJpeg()`；
- JS 侧零依赖（native 部分走预编译包）。

**怎么落：** `src/screen.mjs` 的 `grabScreen()` 加一个 native 分支，失败回落 `grab.ps1`。
按 `scaleFactor()` 把坐标从逻辑像素换算到物理像素再交给 `matchScreen()`。
（许可请以仓库 LICENSE 为准，动手前核一眼。）

---

### A4. 测试与截图工具 → Playwright（形态 C，仅 devDependency）

**现状的痛：**

- `scripts/smoke.mjs` **52KB** 手写；
- `scripts/shot.mjs` 289 行手写 CDP over WebSocket，**硬编码了**
  `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`——换台机器就废。

**候选项：[microsoft/playwright](https://github.com/microsoft/playwright)**（Apache-2.0）

- 自带浏览器，不依赖机器上装没装 Edge；
- `page.screenshot({ fullPage: true })` 替代整个 `shot.mjs`；
- **`devices['iPhone 13']` 之类的真机视口**——这个项目 DESIGN.md 里反复强调手机版是结构性重排
  （底部标签由 JS 决定、表格折成卡片行），现在没有任何自动化能验证这些断点；
- trace / video / 断言，`smoke.mjs` 能瘦掉一大半。

**关键：它是 devDependency，不进运行时**，`npm start` 依然是零依赖。**这是性价比最高的一条。**

---

### A5. Excel 导出（纯新增能力）→ exceljs

**现状**：全仓库 `grep pdf|xlsx|excel|csv` **零命中**。财务模块只有 `GET /api/backup/export`（JSON）
和 Word 价目表。报税、对账、给会计看一眼，JSON 是最难用的格式。

**候选项：[exceljs/exceljs](https://github.com/exceljs/exceljs)**（MIT，README 明写）

- 写 xlsx 带样式、冻结首行、列宽、数字格式；`worksheet.columns` + `addRow` 就够用；
- 顺便能写 CSV；
- 服务器端用，走形态 C（加 npm 依赖）——**这条会破坏零依赖，要单独权衡**。
  如果不想破坏：用 `xlsx` 之外的思路，先出 CSV（纯文本，自己拼 20 行就能写），
  只有确实要样式和公式时才上 exceljs。

**怎么落：** `src/xlsdexport.mjs`，和 `priceexport.mjs` 同一套「导出模型」——`buildExportModel()`
已经把所有内容算好了，加个渲染器就行。路由挂 `GET /api/export/xlsx`。

---

### A6. SQLite 备份一致性 → `VACUUM INTO` + Litestream

**现状的隐患**：`src/restic.mjs` 的 `createResticBackup()` 直接 `restic backup DATA_DIR`，
而 `db.mjs` 开了 **WAL**。备份过程中数据库正在写，抓到的可能是「主库 + 半截 WAL」的组合。

**方案一（零依赖，立刻能做，我已实测通过）：**

`node:sqlite` 支持 `VACUUM INTO`——产出一个**事务一致**的单文件快照：

```js
db.exec(`VACUUM INTO '${snapshotPath}'`)   // 实测 OK
```

备份前先 `VACUUM INTO` 到一个临时文件，再让 restic 备份那个文件。**不用加任何依赖。**

**方案二（可选）：[benbjohnson/litestream](https://github.com/benbjohnson/litestream)**（Apache-2.0）

- v0.5.0（2025-10）重写了存储格式，**LTX + 三级 compaction**，恢复一个库平均只要十几个文件；
- 持续把 WAL 页增量复制到本地目录 / S3 / B2；
- 可以恢复到**任意时间点**——比「每天一次全量」强得多；
- 形态 B：单二进制，装了就启用，和现在的 restic 是一个套路（`src/restic.mjs` 直接照抄一份 `src/litestream.mjs`）。

（[v0.5.0 说明](https://fly.io/blog/litestream-v050-is-here/)）

---

## 3. B 级：有具体需求再上

| 候选 | 用途 | 说明 |
| --- | --- | --- |
| [WinSW](https://github.com/winsw/winsw) / nssm | 替代手写 `DaiganLauncher.cs` | 单 exe + XML，支持崩溃自动重启、日志滚动。**但装成 Windows 服务通常要管理员权限**，而现在的启动器卖点正是「当前用户开机自启、不要管理员」——所以是**换**不是**升级**，想清楚再动 |
| Node SEA / `pkg` | 同上，另一种分发方式 | Node 24 已内置单可执行文件打包。可以和启动器并存 |
| [zod](https://github.com/colinhacks/zod) | 接口入参校验 | `src/routes/*.mjs` 现在是一堆手写 `clampStr` / 类型判断。单人项目收益中等 |
| [Chart.js](https://github.com/chartjs/Chart.js) / [ECharts](https://github.com/apache/echarts) | 财务图表 | 现在 `views/finance.js` 是纯数字表。注意 DESIGN.md 明令禁止「大数字 + 小标签」英雄指标卡，加图要克制 |
| [pdf-lib](https://github.com/Hopding/pdf-lib) / pdfkit | 报价单 PDF | 如果 A2 选了 snapdom，PDF 插件已经顺带解决，这条就不用了 |
| [bwip-js](https://github.com/metafloor/bwip-js) / `qrcode` | 二维码生成 | 报价单里嵌一张收款码，或给客户一个「扫码看价目表」的入口 |
| PWA（manifest + Workbox） | 手机装到桌面 | `public/index.html` 现在没有 manifest。手机用户占了 PRODUCT.md 里的一半场景，加到桌面能省掉每次翻浏览器 |
| [pixelmatch](https://github.com/mapbox/pixelmatch) | 视觉回归 | 配合 A4 的 Playwright，改 CSS 时自动发现哪一屏歪了 |
| Server 酱 / PushPlus / WxPusher | 新订单推微信 | 「一个人 + 微信接单」这个画像下，比什么都实用；但那些是第三方服务不是"移植" |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 替代 `node:sqlite` | 更成熟，但**是 native 模块，直接破坏零依赖**。而且实测 `node:sqlite` 已经够用（见下）。**不建议** |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes) | 单文件版备份 | 已审计、可单文件 vendor。但**服务端 `node:crypto` 更快**，没必要 |

---

## 4. C 级：看过，不建议移植（附理由）

### C1. Web 框架（express / hono / fastify）—— 不划算

`src/http.mjs` 的路由表只有 **40 行**，还带「后注册覆盖先注册」这个专门为项目做的语义。
换框架要重新实现静态文件、`resolveSafe` 路径穿越防护、Cookie、`sendJSON`、
ETag/304（`serveFile` 里那段），而且会把零依赖打破。**现在这份是对的。**

### C2. FTS5 全文检索 —— 实测不可用

全局搜索（`/api/search`）现在是 `LIKE '%q%'`。我在这台机器上实测了 `node:sqlite`（SQLite 3.50.4）：

```
fts5 建表              → OK
tokenize='unicode61'   → "代肝" 能匹配，但只在词之间有空格时才成立
tokenize='trigram'     → 搜 "代肝"（2 个字）返回空
```

中文没有词间空格，`unicode61` 会把整句当一个 token；`trigram` 又**要求查询至少 3 个字符**，
而「代肝」「鸣潮」这类 2 字查询才是常态。**结论：继续用 LIKE。** 等数据量真的大到 LIKE 卡了再说
（那时该上的是 jieba 分词或 `simple` 分词器，不是裸 FTS5）。

### C3. 保险箱换 argon2 —— 反而更弱

`@noble/hashes` 自己的 README 写着：

> **Argon2 can't be fast in JS**, because there is no fast Uint64Array. It is suggested to use **Scrypt** instead.
> Being 5x slower than native code means brute-forcing attackers have bigger advantage.

而 `src/vault.mjs` 用的 `node:crypto` scrypt（`N=32768`）是**原生 C 实现**，比任何纯 JS 实现都快。
换成 JS 版 argon2 只是纸面上算法更"现代"，实际抗爆破能力下降。**保持不动。**

同理，Vaultwarden / Bitwarden 那类项目是「服务端 + 多客户端 + 多用户」的模型，
和「一个 SQLite 文件、一个老板、密钥只在内存里」的立场不是一回事。**不要引。**

### C4. 浏览器内 OCR（client-side-ocr / tesseract.js）—— 被自己的 CSP 挡住

`src/http.mjs` 的 `securityHeaders()` 里有一条：

```js
"script-src 'self'",
"connect-src 'self'",
```

WebAssembly 实例化需要 `script-src 'wasm-unsafe-eval'`（或 `'unsafe-eval'`）；
模型文件（15–30MB）要么放本地、要么放开 `connect-src` 到 CDN。**两条都和现在这份「本地、自给自足」的 CSP 立场冲突。**
而且这些库要求的模型体积对「打开网页就能用」是负担。
**想提高识别率，走 A1 的服务端 Umi-OCR；不要往浏览器里塞 OCR。**

### C5. OpenCV.js 做模板匹配 —— 为 150 行代码引 10MB WASM

`src/imgmatch.mjs` 的 `findTemplate` 是手写 NCC + 亮度蒙版 + 颜色比例匹配。
`src/screen.mjs` 的注释记录：**三个真样本都是 1.000 命中**，
而且那段「比颜色比例而不是比亮度」的推理（星声偏蓝白 / 体力偏青绿）是**针对鸣潮界面调出来的**，
换成通用的 `matchTemplate` 未必更好。

值得移植的是它背后的**思路**（多尺度 + 蒙版），不是那个库。
**除非**以后要认旋转过的、被遮挡的、或者几十个图标——那时再上
[`@techstark/opencv-js`](https://github.com/TechStark/opencv-js)（Apache-2.0）。

### C6. `src/docx.mjs` 换 `docx` npm 包 —— 收益不明确

手写 ZIP + OOXML 308 行确实重，但：

- 它现在**零依赖**，而且 `zip()` + `crc32()` 是自洽的、能用的；
- `docx` 包会引入一串传递依赖，破坏零依赖；
- 真正的痛是「版式写了两遍」（见 A2），**换 docx 包只换掉第二遍的写法，没消除重复**。

**先做 A2**（图片走 DOM），Word 那份是留是换到时候再定。

### C7. 数据表格库（TanStack Table / AG Grid）—— 和 DESIGN.md 冲突

`views/price.js`（82KB）、`views/orders.js`（60KB）里的表格是**按 DESIGN.md 定制的**：
栏目线表格、无外框、行间发丝线、`tabular-nums` 右对齐金额、≤720px 折成卡片行、
`.col-opt` 整列隐藏。通用数据网格的外观和交互要一路对着 CSS 打回来，得不偿失。

---

## 5. D 级：不用移植，Node 标准库已经有了（本机实测）

顺手做的验证，避免白折腾：

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| `node:sqlite` FTS5 | ✅ 可用 | 但见 C2，对中文搜索没用 |
| `node:sqlite` JSON1 | ✅ 可用 | `json_extract` 正常 |
| `VACUUM INTO` | ✅ 可用 | **A6 直接用，零依赖拿到一致性快照** |
| SQLite 版本 | 3.50.4 | 相当新 |
| `node:sqlite` 成熟度 | ⚠️ 仍打印 `ExperimentalWarning` | Node v24.9.0 上仍是实验特性。生产单人项目可以接受，但**升级 Node 前先跑 `npm run check`** |

---

## 6. 移植时要守住的三条纪律

这份项目的价值有一半在「不需要 npm install」，所以：

1. **前端库一律 vendor 成单个 `.mjs` 放 `public/vendor/`**，别引 CDN。
   `script-src 'self'` 会挡掉一切外部脚本，这是设计而不是限制。
2. **服务端能用外部本地程序就别加 npm 依赖**。现在 `restic`（`src/restic.mjs` 里
   `resolveBinary()` 用 `where.exe`/`which` 探测）已经是这个模式的标准样板，照抄。
3. **所有新能力必须能降级**。`ocrAvailable()`、`resticStatus().installed` 都做对了：
   没装 → 接口明确说清楚为什么不能用，而不是 500。新加的每一个都用同一套。

---

## 7. 建议的动手顺序

| 顺序 | 做什么 | 为什么是这个顺序 | 形态 |
| --- | --- | --- | --- |
| 1 | **A4 Playwright 顶上 `smoke.mjs` + `shot.mjs`** | 先有网再动别的。之后每一步改动都有自动化兜底 | C（仅 dev） |
| 2 | **A6 备份前加 `VACUUM INTO`** | 几行代码，消掉一个真实的数据风险。做任何大改之前都该先做 | 标准库 |
| 3 | **A1 Umi-OCR 双引擎** | 收益最大、痛点最真，且能降级 | B |
| 4 | **A2 图片导出换 DOM 渲染** | 消除 double implementation，顺带拿 PDF | A |
| 5 | **A3 node-screenshots** | 和 A1 配套，解决 DPI/多屏 | B/C |
| 6 | **A5 Excel 导出** | 纯新增，随时可插 | C |

**不建议动的：** HTTP/路由、`node:sqlite`、保险箱加密、计价引擎、`imgmatch.mjs`、
前端框架、数据表格。这几块要么已经对了，要么换掉只会更差。
