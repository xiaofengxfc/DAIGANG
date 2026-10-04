import os
from pathlib import Path

# BASE_DIR 指向项目根目录
base_dir = Path(__file__).parent.resolve()
# 适配器可把素材和 Cookie 放在主项目 data/ 下；直接运行原项目时仍使用自身目录。
BASE_DIR = Path(os.environ.get('XFC_MEDIA_SOURCE_ROOT', base_dir.parent)).resolve()

XHS_SERVER = "http://127.0.0.1:11901"
LOCAL_CHROME_PATH = os.environ.get('XFC_MEDIA_CHROME_PATH', "C:/Program Files/Google/Chrome/Application/chrome.exe")
if not Path(LOCAL_CHROME_PATH).is_file():
    try:
        from playwright.sync_api import sync_playwright
        _playwright = sync_playwright().start()
        _managed_chrome = _playwright.chromium.executable_path
        _playwright.stop()
        if Path(_managed_chrome).is_file():
            LOCAL_CHROME_PATH = _managed_chrome
    except Exception:
        pass
LOCAL_CHROME_HEADLESS = os.environ.get('XFC_MEDIA_HEADLESS', '0') == '1'
