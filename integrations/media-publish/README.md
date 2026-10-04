# MediaPublishPlatform 执行器

这份目录保留了目标项目的 Flask / Playwright 上传核心和平台配置。主项目的 Node 服务负责统一登录、素材和任务数据，`media_executor.py` 只负责把任务转给原项目的 `post_multiple_files_to_multiple_platforms`。

## 安装与启动

在项目根目录执行：

```powershell
python -m venv .venv-media
.\.venv-media\Scripts\python.exe -m pip install -r integrations\media-publish\requirements.txt
.\.venv-media\Scripts\python.exe -m playwright install chromium
$env:XFC_MEDIA_SOURCE_ROOT = (Resolve-Path .).Path
$env:XFC_MEDIA_CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
$env:XFC_MEDIA_EXECUTOR_TOKEN = 'change-me'
.\.venv-media\Scripts\python.exe integrations\media-publish\media_executor.py
```

Node 侧设置同一个 `XFC_MEDIA_EXECUTOR_URL=http://127.0.0.1:5409` 和 `XFC_MEDIA_EXECUTOR_TOKEN`，然后在“自媒体 / 发布记录”点击“发布”。

执行器使用原项目的九个平台配置和 Playwright 上传器。每个账号必须提供 Playwright `storage_state` JSON 登录态，账号状态和 Cookie 上传由主项目管理。
