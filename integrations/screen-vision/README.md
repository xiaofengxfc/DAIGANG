# Python 视觉后端（屏幕识别的「认字」那一层）

这是**可选**的一层。不装也能用屏幕识别（会退回 `src/ocr.mjs` 里的旧引擎链：
Umi-OCR → PaddleOCR-json → RapidOCR-json → Tesseract → Windows 自带），
装了就用它 —— 它排在最前面。

## 它是什么

一个**长驻的本地 HTTP 服务**，跑在 `127.0.0.1:5410`，用 PP-OCR（PaddleOCR 的模型）
+ ONNX Runtime 认图里的字。Node 那边负责它的生死：探测解释器 → 建 venv →
装依赖 → 起进程 → 探活 → 崩了重启 → 退出时收掉（`src/vision-python.mjs`）。

为什么是「长驻进程」而不是「每帧起一个 exe」：

- 模型载一次就一直热着。每帧起进程的话，光载模型就要几百毫秒；
- 有**置信度**（`score`）和词框坐标，和 Umi-OCR 那条路一个口径；
- 有一条 **rec-only** 的路：给一个数字块的小矩形，只识别不检测，**实测 13ms**。
  这是后面把整帧从 ~600ms 压下去的关键（见下面「它现在有多快」）。

## 文件

| 文件 | 干什么 |
| --- | --- |
| `server.py` | HTTP 服务本身。只用标准库 `http.server`（`ThreadingHTTPServer`），不引 Flask —— 为了一个 OCR 服务多装一个 Web 框架不值 |
| `ocr_engine.py` | 模型加载、参数、推理、词框转换。所有「为什么这么写」的实测记录都在这 |
| `requirements.txt` | 依赖清单（有注释说明为什么是这几个） |

## 接口

所有接口都要 `Authorization: Bearer <token>`（token 由 Node 每次启动随机生成，
通过环境变量传给子进程；外部自己起服务时可以设 `XFC_VISION_TOKEN` 或留空不校验）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 是否就绪。`ok` + `warm` 都为 true 才算能用；还带模型目录、载模型/预热耗时、`det_ok`/`rec_ok`（预热自检） |
| `POST` | `/ocr` | `{image_path \| data_url, use_cls?}` → `{ok, engine, words, size, ms}`。整图/整带走 det + rec |
| `POST` | `/ocr/crop` | `{image_path \| data_url, box:[x,y,w,h], upscale?}` → `{ok, text, score, ms}`。只走 rec，**13ms** |

`words` 的形状和仓里另外几条 OCR 路一致：`{x, y, w, h, text, score, cx, cy}`。

## 支持哪些 Python 版本（**重要**）

**3.10 ~ 3.14（win_amd64）。3.15 目前装不上。**

原因不是这个后端写得挑版本，而是绕不开的 `onnxruntime`（OCR 的推理引擎）还没为
3.15 发布预编译包 —— 没有轮子就只能现编，而现编要 C++ 工具链，普通机器上装不了。

各版本的实际覆盖（PyPI 实测，`onnxruntime` 每个大版本都不一样）：

| onnxruntime | 提供的 cp 轮子 |
| --- | --- |
| 1.20 ~ 1.23 | cp310 ~ cp313 |
| 1.24 ~ 1.29 | cp311 ~ **cp314** |

所以 `requirements.txt` 里写的是区间 `>=1.20,<2`：3.10 会落到 1.23.x、3.14 会落到
1.24+。**钉死任何一头都会让另一端掉进源码编译。**

这张表不是手抄的，是 `node scripts\vision-python-matrix.mjs` 去 PyPI 现查的：

```powershell
node scripts\vision-python-matrix.mjs           # 打一张 包 × Python版本 的轮子表
node scripts\vision-python-matrix.mjs --check   # 顺带断言「声明的范围」和事实一致
```

`--check` 里有一条断言专门写「**3.15 应该被认成不支持**」。等 onnxruntime 哪天发了
cp315，那条会红 —— 那就是该把支持范围扩上去的信号，而不是让人凭印象改。

程序侧的配套动作（都在 `src/vision-deps.mjs`）：

- **找得到不在 PATH 里的 Python**：官方安装器默认不勾「Add python.exe to PATH」，
  所以只查 PATH 等于「用户装了 Python 但程序说没装」。现在会先查注册表
  （`HKCU\SOFTWARE\Python\PythonCore`）、再查常见安装目录，最后才看 PATH。
- **优先挑版本合适的那个**：不是「PATH 里第一个 Python 3」，而是先找装得上依赖的版本。
  机器上同时有 3.15 和 3.12 时，会选 3.12。
- **版本不合适就提前拦**：界面上直接说「Python 3.15 太新了…支持 3.10~3.14」，
  并把「一键安装依赖」置灰。以前不拦，用户会走到 pip，然后面对一长串
  「找不到匹配的分发」—— 那看不出是版本的事。

## 它现在有多快（这台机器实测，Python 3.14.8）

| 场景 | 耗时 |
| --- | --- |
| 起进程 → 载模型 → 预热完成 | **3.2~4.9s**（Node 在启动时就做掉，用户看不到） |
| 顶栏带（2559×223）det + rec | **586~650ms**（稳态；换 `max_side_len` 没用，见下） |
| 顶栏带**第一帧**（新形状） | 900~1700ms（多出来的是新输入形状的开销） |
| 数字块 rec-only（放大 3 倍） | **13~18ms** |
| 整张截图（2559×1599）det + rec | ~1.8s |

几条踩出来的坑，都写在代码注释里了，这里点一下：

- **`max_side_len` 调小没用**：实测 2000 / 1600 / 1280 / 1024 / 960 / 736 在真实顶栏带上
  都是 586~596ms。这条路上花钱的是 rec（按检测出来的小框逐个识别），不是 det。
- **预热要用真实形状**：用 1200×160 的合成图预热，第一帧真实带（2559×223）要多花 1s。
  现在预热图就是按顶栏带的形状造的。
- **`engine(img, use_det=False)` 会把开关永久改在实例上**：rapidocr 的
  `update_params()` 是 `setattr`。所以每次调用都显式传 `use_det` / `use_cls` / `use_rec`，
  并且预热最后会再跑一次 det 自检（`/health` 里的 `det_ok`）。
- **`cv2.imread` 读不了中文路径**（这个仓库的路径就是中文的），一律用
  `np.fromfile` + `cv2.imdecode`。

## 模型从哪来

复用仓库里已有的 `tools/ocr/rapidocr/models/`（`ch_PP-OCRv4_det_infer.onnx`、
`rec_ch_PP-OCRv4_infer.onnx`、`ch_ppocr_mobile_v2.0_cls_infer.onnx`、`ppocr_keys_v1.txt`），
**不额外下载**。找不到会按 `XFC_VISION_MODELS` → `tools/ocr/rapidocr/models` →
`tools/vision/models` → 包内 `models/` → 几个 glob 依次找；
再找不到 `/health` 里会明说 `models.ok=false`（可能触发联网下载，不是静默的）。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `XFC_VISION_PORT` | `5410` | 监听端口 |
| `XFC_VISION_TOKEN` | 空 | 设了就要求 Bearer；Node 起它时会自己生成一个 |
| `XFC_VISION_HOST` | `127.0.0.1` | 只监听本机 |
| `XFC_VISION_MODELS` | 空 | 指定模型目录 |
| `XFC_VISION_ROOT` | 空 | 仓库根（找模型用） |
| `XFC_VISION_WATCH_STDIN` | 空 | 设了才盯 stdin（父进程一死就退出）。手动在终端里跑时**不要**设 |

## 手动跑（调试用）

```powershell
data\vision-venv\Scripts\python.exe integrations\screen-vision\server.py
# 另开一个窗口：
curl http://127.0.0.1:5410/health
```

手动跑时不要设 `XFC_VISION_WATCH_STDIN`，否则它会把你在控制台敲的字吃掉。

## 自己写客户端时注意

- 服务是 HTTP/1.1 + keep-alive，`Content-Length` 一定准（不然客户端会挂在那儿等）；
- 请求体上限 24MB（整张 4K 截图的 base64 大约 3~6MB）；
- 推理是**串行**的（一个锁），别指望并发能更快 —— 一个模型实例本来就跑不满；
- 大图请走 `image_path` 而不是 `data_url`（少一次 base64 编解码）。
