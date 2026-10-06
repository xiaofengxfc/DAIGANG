"""RapidOCR(ONNX) 的薄封装：只做「图 → 词框」这一件事。

为什么是 RapidOCR(ONNX) 而不是 PaddlePaddle：
  · 用的是**同一套 PP-OCR 模型**，而本仓 `tools/ocr/rapidocr/models/` 里
    已经有现成的 det/rec/cls onnx（用户点过「自动安装 RapidOCR-json」就有了），
    所以这条路通常是**零额外下载**的；
  · onnxruntime 的 wheel 小、Python 3.13/3.14 上也有；不需要 AVX。

实测（本机 Python 3.14.8 / rapidocr 3.9.2 / onnxruntime 1.30.0，
样本 shots/samples/weapon-list.png 2559×1599）：

    构造引擎（载模型）           0.6 ~ 0.8s
    预热首帧（onnxruntime 图优化） 3.8s   ← 必须在启动时做掉，不能留给用户那一帧
    顶栏带 det+cls+rec（2559×223） 765ms
    顶栏带 det+rec（use_cls=False） 718ms  ← 默认关 cls，见下面 use_cls 的注释
    数字块 rec-only（放大 3 倍）    15ms   ← P2 复核数字走这条，快 50 倍
    整图 det+rec（2559×1599）     1890ms  ← 所以永远只喂顶栏那条带

两个踩过的坑，别再踩：
  1. **cv2.imread 读不了中文路径**（Windows 上直接返回 None，不抛异常）。
     本仓的路径就是中文（D:\\github_xm\\代肝价格查询），所以一律走
     `np.fromfile + cv2.imdecode`，见 load_image()。
  2. rapidocr 3.x 不把 onnxruntime 写进必装依赖，requirements.txt 里必须显式写，
     漏了就是「装完了但一跑就 ImportError」。
"""

from __future__ import annotations

import base64
import binascii
import logging
import os
import time
from pathlib import Path

import cv2
import numpy as np
from rapidocr import RapidOCR

ENGINE_ID = "rapidocr-onnx"

# rapidocr 的 INFO 日志默认打到 stderr，Node 那边会把 stderr 收进日志文件；
# 每帧都刷几行会把有用的信息淹掉，所以压到 error。
logging.getLogger("RapidOCR").setLevel(logging.ERROR)

# ---------------------------------------------------------------- 模型发现

# 按「先 v4 后 v3」的顺序找。文件名是 RapidOCR-json 官方包里那套，
# 和 RapidOCR(python) 要的是同一批 onnx，所以能直接复用。
DET_NAMES = ("ch_PP-OCRv4_det_infer.onnx", "ch_PP-OCRv3_det_infer.onnx")
REC_NAMES = ("rec_ch_PP-OCRv4_infer.onnx", "ch_PP-OCRv4_rec_infer.onnx", "ch_PP-OCRv3_rec_infer.onnx")
CLS_NAMES = ("ch_ppocr_mobile_v2.0_cls_infer.onnx",)
KEYS_NAMES = ("ppocr_keys_v1.txt", "dict_chinese.txt")


def _model_dirs(root: Path) -> list[Path]:
    """候选模型目录，按优先级排。

    用户的机器上模型可能来自三处：自动安装的 RapidOCR-json（tools\\ocr\\rapidocr\\models）、
    以前留下的 tools\\vision\\models、或者环境变量指的地方。都找不到就返回空 ——
    那种情况交给 rapidocr 自己按默认逻辑处理（它可能会联网下，见 VisionOCR 的注释）。
    """
    dirs: list[Path] = []
    env = os.environ.get("XFC_VISION_MODELS", "").strip()
    if env:
        dirs.append(Path(env))
    dirs.append(root / "tools" / "ocr" / "rapidocr" / "models")
    dirs.append(root / "tools" / "vision" / "models")
    dirs.append(Path(__file__).resolve().parent / "models")
    # 自动安装器会把包解到 tools\ocr\rapidocr\<包名>\models\ 这种更深一层的位置
    for pattern in ("tools/ocr/rapidocr/*/models", "tools/ocr/*/models", "tools/vision/*/models"):
        dirs.extend(sorted(root.glob(pattern)))
    return dirs


def find_models(root: Path) -> dict:
    """在候选目录里凑齐 det/rec/cls/keys。返回 {ok, dir, det, rec, cls, keys, missing}。

    det 和 rec 是必需的（没有它们就没法认字）；cls 和 keys 缺了也能跑
    （cls 只负责判断 180° 翻转，我们默认关掉；keys 用 rapidocr 自带的也行）。
    """
    for d in _model_dirs(root):
        if not d.is_dir():
            continue
        found: dict[str, str] = {}
        for key, names in (("det", DET_NAMES), ("rec", REC_NAMES), ("cls", CLS_NAMES), ("keys", KEYS_NAMES)):
            for name in names:
                candidate = d / name
                if candidate.is_file():
                    found[key] = str(candidate)
                    break
        if "det" in found and "rec" in found:
            return {"ok": True, "dir": str(d), "missing": [k for k in ("cls", "keys") if k not in found], **found}
    return {"ok": False, "dir": "", "missing": ["det", "rec"]}


# ---------------------------------------------------------------- 读图


def load_image(path: str) -> np.ndarray:
    """从磁盘读一张图（BGR）。

    不用 cv2.imread：它在 Windows 上遇到非 ASCII 路径会静默返回 None。
    实测本仓路径（含中文）就是这种情况，而报错会是一句莫名其妙的
    "'NoneType' object has no attribute 'shape'"。
    """
    buf = np.fromfile(path, dtype=np.uint8)
    if buf.size == 0:
        raise FileNotFoundError(f"图片是空的：{path}")
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"解不了这张图（不是 PNG/JPEG？）：{path}")
    return img


def decode_data_url(data_url: str) -> np.ndarray:
    """data:image/png;base64,... → BGR 图（给「上传一张截图」那条路用）"""
    text = str(data_url or "")
    if "," in text and text.strip().lower().startswith("data:"):
        text = text.split(",", 1)[1]
    try:
        raw = base64.b64decode(text, validate=False)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"base64 解不开：{exc}") from exc
    img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("解不了这张图（不是 PNG/JPEG？）")
    return img


def warmup_image(width: int = 2560, height: int = 224) -> np.ndarray:
    """造一张「像顶栏」的合成图，用来在启动时把 det+rec 两条路都跑热。

    为什么要造图而不是等第一帧：onnxruntime 第一次推理要做图优化，
    实测 3.8s。这笔钱要么在启动时付（用户看不到），要么在用户点「识别画面」
    的第一帧付（用户干等 4 秒）。所以启动时预热，/health 里用 warm 标出来。

    **尺寸要照着真实的顶栏带来**（默认 2560×224），这是量出来的：
    换一个新形状的第一帧要额外花 0.15~1.0s（det 的输入尺寸被 max_side_len=2000
    钳住，所以 ≥2000 宽的带其实是同一个形状 —— 实测 3840 宽的带首帧就是 698ms，
    而 2559 宽的首帧是 1710ms、稳态 714ms）。用 1200×160 预热的话，
    用户点「识别画面」的第一帧就要多等 1 秒，白等。
    """
    img = np.full((height, width, 3), 32, dtype=np.uint8)
    scale = max(0.6, height / 224.0)
    size = 2.6 * scale
    thick = max(2, int(round(5 * scale)))
    cv2.putText(img, "2174", (60, int(height * 0.68)), cv2.FONT_HERSHEY_SIMPLEX, size, (255, 255, 255), thick, cv2.LINE_AA)
    cv2.putText(img, "2508319", (int(width * 0.59), int(height * 0.68)), cv2.FONT_HERSHEY_SIMPLEX, size, (240, 240, 240), thick, cv2.LINE_AA)
    cv2.putText(img, "129/2000", (int(width * 0.05), int(height * 0.68)), cv2.FONT_HERSHEY_SIMPLEX, size, (230, 230, 230), thick, cv2.LINE_AA)
    return img


# ---------------------------------------------------------------- 引擎


class VisionOCR:
    """RapidOCR 的封装。线程安全：rapidocr 的 session 可以并发调，
    但这里仍然用一把锁串行化 —— 识别是「用户点了才跑一次」的量级，
    串行化换来的是耗时可预测（不会几个请求抢 CPU 把每帧都拖长）。"""

    def __init__(self, repo_root: Path, *, use_cls: bool = False, text_score: float = 0.5, max_side_len: int = 2000):
        self.repo_root = repo_root
        self.use_cls = bool(use_cls)
        self.models = find_models(repo_root)
        self.load_ms = 0.0
        self.warm_ms = 0.0
        self.warm = False
        self.det_ok = False
        self.rec_ok = False
        self.last_ms = 0.0
        self.calls = 0

        params: dict[str, object] = {
            # 日志压到 error：默认 info 每帧刷好几行，Node 的日志文件会被淹掉
            "Global.log_level": "error",
            # cls 判断的是「整行是不是 180° 翻转」。游戏 HUD 的字永远是正的，
            # 关掉它实测省 ~50ms（765ms → 718ms）而且不影响结果。
            "Global.use_cls": bool(use_cls),
            "Global.text_score": float(text_score),
            # 2000 是 rapidocr 的默认值。顶栏带最宽也就 2600，放宽到 2600
            # 会让 det 的算力按面积涨（实测 ~1.1s），所以维持 2000。
            # 反方向（调小）**没有用**，别白试：实测 2000 / 1600 / 1280 / 1024 /
            # 960 / 736 在真实顶栏带上都是 586~596ms，一模一样 —— 因为这条路上
            # 花钱的是 rec（按检测出来的小框逐个识别），不是 det。
            # 真要把这一帧压下去，得走 /ocr/crop：只认已知位置的那几个数字块（实测 13ms）。
            "Global.max_side_len": int(max_side_len),
        }
        if self.models["ok"]:
            params["Det.model_path"] = self.models["det"]
            params["Rec.model_path"] = self.models["rec"]
            if self.models.get("cls"):
                params["Cls.model_path"] = self.models["cls"]
            if self.models.get("keys"):
                params["Rec.rec_keys_path"] = self.models["keys"]
        # 找不到本地模型时不传 model_path：rapidocr 会按自己的默认逻辑去
        # model_root_dir 找，找不到就可能联网下。这条**不是**静默的 ——
        # /health 里 models.ok=false 会明说，Node 的状态页也会显示。
        t0 = time.time()
        self.engine = RapidOCR(params=params)
        self.load_ms = (time.time() - t0) * 1000

    # ------------------------------------------------------------ 预热

    def warm_up(self) -> None:
        """把 det+rec 两条路各跑一遍。失败不抛（预热失败只说明这一帧要慢，
        不该让整个服务起不来）。

        顺序有讲究：**det 那条先跑**，因为 rec-only 会把实例上的 use_det 改成
        False（见 run() 的注释），跑完再回头验一次 det 还通不通。
        """
        t0 = time.time()
        try:
            full = self.run(warmup_image())
            self.det_ok = len(full["words"]) > 0
            # rec-only 是另一条独立的路（不经过 det），也得单独跑热
            strip = np.full((48, 160, 3), 32, dtype=np.uint8)
            cv2.putText(strip, "2174", (6, 38), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (255, 255, 255), 2, cv2.LINE_AA)
            rec = self.run_rec(strip)
            self.rec_ok = bool(rec["text"])
            # 小屏（1280×800 那种）的带是另一个形状，顺手也热一下，
            # 不然它那一档的第一帧要多花 ~0.15s
            self.run(warmup_image(1280, 112))
            # 再验一次「大带」：开关要是漏在实例上，这里会当场现原形
            again = self.run(warmup_image())
            if self.det_ok and not again["words"]:
                logging.getLogger("vision").error("预热自检失败：第二次 det 一个词都没认到（调用开关漏在实例上了）")
                self.det_ok = False
            self.warm = bool(self.det_ok and self.rec_ok)
        except Exception as exc:  # noqa: BLE001 —— 预热失败不该让服务起不来
            logging.getLogger("vision").warning("预热失败：%s", exc)
        finally:
            self.warm_ms = (time.time() - t0) * 1000

    # ------------------------------------------------------------ 识别

    def run(self, img: np.ndarray, *, use_cls: bool | None = None) -> dict:
        """整图/整带：det + (cls) + rec。返回 {words, ms, size}。

        **三个开关每次都显式传**，这是踩出来的：rapidocr 的 `update_params()`
        是 `setattr(self, ...)`，也就是说 `engine(img, use_det=False)` 会把
        use_det 永久改成 False。预热里跑过一次 rec-only 之后，后面所有
        「整图识别」都会静默跳过 det —— 表现是**返回 0 个词、耗时只有 13ms**
        （因为只跑了识别分支，而识别分支没有输入框）。不显式传就等着查半天。
        """
        t0 = time.time()
        out = self.engine(img, use_det=True, use_cls=bool(self.use_cls if use_cls is None else use_cls), use_rec=True)
        ms = (time.time() - t0) * 1000
        self.last_ms = ms
        self.calls += 1
        h, w = img.shape[:2]
        return {"words": output_to_words(out), "ms": ms, "size": [int(w), int(h)]}

    def run_rec(self, crop: np.ndarray) -> dict:
        """只跑识别分支（不 det、不 cls），给「已经知道数字在哪」的场景用。

        这是 P2 复核数字块的接口：实测同一个数字块，整图 det+rec 在
        2560×1080 上读成 `TE`、3440×1440 上读成 `E`，而把那一小块裁出来
        放大 3 倍走 rec-only 就稳定读回 `2174`，而且只要 15ms。
        """
        t0 = time.time()
        out = self.engine(crop, use_det=False, use_cls=False, use_rec=True)
        ms = (time.time() - t0) * 1000
        self.last_ms = ms
        self.calls += 1
        texts = [str(t) for t in (getattr(out, "txts", None) or ())]
        scores = [float(s) for s in (getattr(out, "scores", None) or ())]
        text = texts[0] if texts else ""
        score = scores[0] if scores else 0.0
        return {"text": text, "score": score, "ms": ms}

    def info(self) -> dict:
        return {
            "engine": ENGINE_ID,
            "models": {
                "ok": bool(self.models["ok"]),
                "dir": self.models.get("dir", ""),
                "det": self.models.get("det", ""),
                "rec": self.models.get("rec", ""),
                "cls": self.models.get("cls", ""),
                "keys": self.models.get("keys", ""),
                "missing": self.models.get("missing", []),
            },
            "load_ms": round(self.load_ms, 1),
            "warm": bool(self.warm),
            "warm_ms": round(self.warm_ms, 1),
            "det_ok": bool(self.det_ok),
            "rec_ok": bool(self.rec_ok),
            "last_ms": round(self.last_ms, 1),
            "calls": int(self.calls),
        }


def output_to_words(out) -> list[dict]:
    """rapidocr 的 RapidOCROutput → 本仓统一的词框。

    统一形状（和 src/ocr.mjs 里 Windows/Umi/控制台三条路一致）：
        {x, y, w, h, text, score, cx, cy}
    det 给的是**四角**（可能是斜的），这里取外接矩形 —— 识别层只用到
    「同一行 + 左右顺序」，外接矩形够用，而且和另外几个引擎的口径一样。
    """
    words: list[dict] = []
    boxes = getattr(out, "boxes", None)
    texts = getattr(out, "txts", None) or ()
    scores = getattr(out, "scores", None) or ()
    if boxes is None:
        return words
    for i, box in enumerate(np.asarray(boxes)):
        text = str(texts[i]) if i < len(texts) else ""
        if not text:
            continue
        score = float(scores[i]) if i < len(scores) else 0.0
        arr = np.asarray(box, dtype=float).reshape(-1, 2)
        x0, y0 = float(arr[:, 0].min()), float(arr[:, 1].min())
        x1, y1 = float(arr[:, 0].max()), float(arr[:, 1].max())
        words.append(
            {
                "x": round(x0, 1),
                "y": round(y0, 1),
                "w": round(x1 - x0, 1),
                "h": round(y1 - y0, 1),
                "cx": round((x0 + x1) / 2, 1),
                "cy": round((y0 + y1) / 2, 1),
                "text": text,
                "score": round(score, 4),
            }
        )
    return words
