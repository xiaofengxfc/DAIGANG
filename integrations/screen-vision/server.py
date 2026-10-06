"""屏幕识别的 Python 视觉进程（本地 sidecar）。

它只干一件事：**把一张图认成词框**。截屏、图标匹配、跨帧投票都还在 Node 那边
（P1 的范围），所以这个服务是无状态的、可以被随时杀掉重启的。

为什么是「长驻进程 + 本地 HTTP」而不是「每次识别起一个 python 脚本」：
  · 载模型 0.6~0.8s、onnxruntime 首帧图优化 3.8s —— 每次调用都付这笔钱的话，
    一次「识别画面」要点 16 帧（2 个页面 × 最多 8 帧），用户要干等一分钟；
  · 长驻之后每帧就是纯推理（顶栏带 det+rec 实测 ~720ms）；
  · 这和本仓 integrations/media-publish 的执行器是同一个形态（探测 → 装依赖 →
  自启 → 本地 HTTP → token 鉴权），不发明新范式。

安全边界（和媒体执行器一致）：
  · 只绑 127.0.0.1，局域网访问不到；
  · 校验 Authorization: Bearer <XFC_VISION_TOKEN>，token 由 Node 随机生成、
    经环境变量传给子进程 —— 同一台机器上的其它进程不该能随便驱动它。

为什么用标准库的 http.server 而不是 Flask：这里只有 3 个端点、纯 loopback、
无模板无静态文件。少一个依赖，就少一种「装完了但起不来」的可能。
（本仓的媒体执行器用 Flask 是因为它要跑 Playwright 那一整套，情况不同。）

接口：
  GET  /health      → 引擎/模型/预热状态
  POST /ocr         → {image_path|data_url, use_cls?, text_score?} → {words, ms, size}
  POST /ocr/crop    → {image_path|data_url, box:[x,y,w,h], upscale?} → {text, score, ms}
                      （P2 复核数字块用的接口，已经能用，但 P1 还没接进识别流程）
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from ocr_engine import ENGINE_ID, VisionOCR, decode_data_url, load_image  # noqa: E402

SCHEMA = 1
ROOT = Path(os.environ.get("XFC_VISION_ROOT", "").strip() or HERE.parents[1]).resolve()
HOST = os.environ.get("XFC_VISION_HOST", "127.0.0.1").strip() or "127.0.0.1"
PORT = int(os.environ.get("XFC_VISION_PORT", "5410"))
TOKEN = os.environ.get("XFC_VISION_TOKEN", "")
MAX_BODY = 24 * 1024 * 1024
DEFAULT_UPSCALE = 3.0

_state = {
    "engine": None,
    "error": "",
    "loading": True,
    "started_at": time.time(),
}
_engine_lock = threading.Lock()
_call_lock = threading.Lock()


def log(message: str) -> None:
    """日志走 stderr —— Node 把它收进 data/vision-sidecar.log，设置页能看。"""
    sys.stderr.write(f"[vision] {message}\n")
    sys.stderr.flush()


def load_engine() -> None:
    """后台线程里建引擎 + 预热。

    建引擎（0.6~0.8s）和预热（3.8s）加起来 4~5 秒。这段时间 /health 会
    老老实实报 loading=true，Node 就等着；等不了就退回旧引擎链 —— 不能让
    用户在「识别画面」上干等，也不能让服务假报就绪。
    """
    try:
        t0 = time.time()
        engine = VisionOCR(ROOT)
        log(f"引擎就绪 {ENGINE_ID} 载模型 {engine.load_ms:.0f}ms 模型目录={engine.models.get('dir') or '(用 rapidocr 默认)'}")
        if not engine.models["ok"]:
            log("警告：没找到本地 ONNX 模型，交给 rapidocr 默认逻辑（可能会联网下载）")
        with _engine_lock:
            _state["engine"] = engine
        engine.warm_up()
        with _engine_lock:
            _state["loading"] = False
        log(f"预热完成 {engine.warm_ms:.0f}ms 总启动 {time.time() - t0:.1f}s")
    except Exception as exc:  # noqa: BLE001 —— 起不来就把原因留在 /health 里
        with _engine_lock:
            _state["error"] = f"{type(exc).__name__}: {exc}"
            _state["loading"] = False
        log(f"引擎起不来：{_state['error']}")


def current_engine() -> VisionOCR | None:
    with _engine_lock:
        return _state["engine"]


def health_payload() -> tuple[int, dict]:
    with _engine_lock:
        engine: VisionOCR | None = _state["engine"]
        error = _state["error"]
        loading = _state["loading"]
    payload = {
        "ok": bool(engine) and not error,
        "schema": SCHEMA,
        "engine": ENGINE_ID,
        "python": sys.version.split()[0],
        "root": str(ROOT),
        "pid": os.getpid(),
        "uptime_s": round(time.time() - _state["started_at"], 1),
        "loading": bool(loading),
        "warm": bool(engine.warm) if engine else False,
        "crop": True,
        "error": error,
    }
    if engine:
        payload.update(engine.info())
    if error:
        return 503, payload
    if loading:
        # 还没预热完：让调用方知道「再等等」，而不是「不行」
        return 503, payload
    return 200, payload


class Handler(BaseHTTPRequestHandler):
    server_version = "xfc-vision/1"
    protocol_version = "HTTP/1.1"

    # 默认实现会把每个请求打一行到 stderr，太吵
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        return

    # ------------------------------------------------------------ 工具

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            # Node 那边超时放弃了，不是错误
            pass

    def authorized(self) -> bool:
        if not TOKEN:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {TOKEN}"

    def read_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError(f"请求体太大（{length} 字节，上限 {MAX_BODY}）")
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"请求体不是合法 JSON：{exc}") from exc
        return body if isinstance(body, dict) else {}

    @staticmethod
    def body_image(body: dict) -> np.ndarray:
        path = str(body.get("image_path") or "").strip()
        if path:
            return load_image(path)
        data_url = str(body.get("data_url") or "").strip()
        if data_url:
            return decode_data_url(data_url)
        raise ValueError("要么给 image_path，要么给 data_url")

    # ------------------------------------------------------------ 路由

    def do_GET(self) -> None:  # noqa: N802
        if not self.authorized():
            return self.send_json(401, {"ok": False, "error": "token 不对"})
        if self.path.split("?")[0].rstrip("/") in ("/health", ""):
            status, payload = health_payload()
            return self.send_json(status, payload)
        return self.send_json(404, {"ok": False, "error": "没有这个接口"})

    def do_POST(self) -> None:  # noqa: N802
        if not self.authorized():
            return self.send_json(401, {"ok": False, "error": "token 不对"})
        route = self.path.split("?")[0].rstrip("/")
        try:
            body = self.read_body()
        except ValueError as exc:
            return self.send_json(400, {"ok": False, "error": str(exc)})

        engine = current_engine()
        if engine is None:
            status, payload = health_payload()
            payload["error"] = payload.get("error") or "引擎还没就绪"
            return self.send_json(status, payload)

        try:
            if route == "/ocr":
                return self.handle_ocr(engine, body)
            if route == "/ocr/crop":
                return self.handle_crop(engine, body)
        except (FileNotFoundError, ValueError) as exc:
            return self.send_json(400, {"ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001 —— 推理出错要说清楚，别让 Node 干等超时
            log(f"识别出错：{type(exc).__name__}: {exc}")
            return self.send_json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})
        return self.send_json(404, {"ok": False, "error": "没有这个接口"})

    def handle_ocr(self, engine: VisionOCR, body: dict) -> None:
        img = self.body_image(body)
        use_cls = body.get("use_cls")
        # 串行化：识别是用户点了才跑一次的量级，串行换来的是耗时可预测
        with _call_lock:
            result = engine.run(img, use_cls=None if use_cls is None else bool(use_cls))
        return self.send_json(
            200,
            {
                "ok": True,
                "schema": SCHEMA,
                "engine": ENGINE_ID,
                "words": result["words"],
                "size": result["size"],
                "ms": round(result["ms"], 1),
            },
        )

    def handle_crop(self, engine: VisionOCR, body: dict) -> None:
        """按矩形裁一小块 → 放大 → 只跑识别分支。

        这是「超宽分辨率下 2174 被读成 21/TE」的正解：det 在小字上会漏检，
        但我们已经知道数字在哪（图标位置是算出来的），把那一块放大到接近
        PP-OCR 识别分支的输入高度（48px）再喂，实测三档超宽全对。
        """
        img = self.body_image(body)
        box = body.get("box") or []
        if not isinstance(box, (list, tuple)) or len(box) != 4:
            raise ValueError("box 要是 [x, y, w, h]")
        h, w = img.shape[:2]
        x = max(0, int(round(float(box[0]))))
        y = max(0, int(round(float(box[1]))))
        bw = max(1, int(round(float(box[2]))))
        bh = max(1, int(round(float(box[3]))))
        x2, y2 = min(w, x + bw), min(h, y + bh)
        if x >= x2 or y >= y2:
            raise ValueError(f"这个框在图片外面（图是 {w}×{h}，框是 {box}）")
        crop = img[y:y2, x:x2]
        try:
            upscale = float(body.get("upscale") or DEFAULT_UPSCALE)
        except (TypeError, ValueError):
            upscale = DEFAULT_UPSCALE
        upscale = min(8.0, max(1.0, upscale))
        if abs(upscale - 1.0) > 0.01:
            crop = cv2.resize(crop, None, fx=upscale, fy=upscale, interpolation=cv2.INTER_CUBIC)
        with _call_lock:
            result = engine.run_rec(crop)
        return self.send_json(
            200,
            {
                "ok": True,
                "schema": SCHEMA,
                "engine": ENGINE_ID,
                "text": result["text"],
                "score": round(result["score"], 4),
                "crop": [x, y, x2 - x, y2 - y],
                "upscale": upscale,
                "ms": round(result["ms"], 1),
            },
        )


def watch_parent_stdin() -> None:
    """父进程（Node）一死就退出。

    Node 那边把 stdin 接成了一个管道。父进程无论是正常退出还是被强杀，
    管道都会关掉，这里 read() 就拿到 EOF。少了这道保险，程序被强杀之后
    会留下一个占着 5410 端口的 python，下次启动就抢不到端口 ——
    这种「端口被一个看不见的旧进程占着」的故障最难查，所以宁可多这十行。
    """
    try:
        while True:
            chunk = sys.stdin.buffer.read(1)
            if not chunk:
                break
    except Exception:  # noqa: BLE001
        pass
    log("父进程的管道关了，跟着退出")
    os._exit(0)


def main() -> int:
    log(f"启动 {ENGINE_ID} python={sys.version.split()[0]} root={ROOT} 监听={HOST}:{PORT} token={'有' if TOKEN else '无'}")
    threading.Thread(target=load_engine, name="load", daemon=True).start()
    # 只在 Node 起我们的时候盯 stdin。手动在终端里跑（调试）时不能盯 ——
    # 那会把你在控制台敲的字吃掉。
    if os.environ.get("XFC_VISION_WATCH_STDIN"):
        threading.Thread(target=watch_parent_stdin, name="parent", daemon=True).start()

    try:
        server = ThreadingHTTPServer((HOST, PORT), Handler)
    except OSError as exc:
        # 端口被占（多半是上一次被强杀留下的 sidecar）。说清楚，别丢一串 traceback
        log(f"起不来：{HOST}:{PORT} 绑不上（{exc}）。多半是上一次留下的 sidecar 还占着这个端口；"
            f"在任务管理器里结束那个 python.exe，或者换个端口（XFC_VISION_PORT）")
        return 1
    server.daemon_threads = True

    def shutdown(signum, _frame):
        log(f"收到信号 {signum}，退出")
        threading.Thread(target=server.shutdown, daemon=True).start()

    try:
        signal.signal(signal.SIGINT, shutdown)
        signal.signal(signal.SIGTERM, shutdown)
    except (ValueError, AttributeError):
        # 非主线程/不支持的平台：忽略，Node 会用 taskkill 收掉
        pass

    try:
        server.serve_forever(poll_interval=0.3)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
