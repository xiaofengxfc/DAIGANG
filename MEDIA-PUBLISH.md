# 自媒体发布模块

自媒体模块已经并入现有 React/Node/SQLite 工作台，入口是左侧导航的「自媒体」。模块包含：

- 素材库：上传、预览和删除图片 / 视频，文件保存到 `data/uploads/media/`。
- 账号管理：登记平台、账号名称、主页地址和账号状态。
- 发布任务：选择多个平台、账号和素材，填写标题、正文、话题，可设置定时发布时间。
- 发布记录：查看任务状态、取消任务、重试失败任务。

## 可选发布执行器

管理与排期功能不依赖 Python。未配置执行器时，任务会保存在本机队列中，发布记录会明确显示「管理模式」。

如果需要接入目标仓库的 Playwright 发布服务，在启动 Node 服务前设置：

```powershell
$env:XFC_MEDIA_EXECUTOR_URL = 'http://127.0.0.1:5409'
$env:XFC_MEDIA_EXECUTOR_TOKEN = '可选的执行器令牌'
node server.mjs
```

Node 会向 `POST {XFC_MEDIA_EXECUTOR_URL}/tasks` 发送以下 JSON：

```json
{
  "id": 12,
  "title": "标题",
  "content": "正文",
  "topics": ["话题"],
  "platforms": ["douyin"],
  "account_ids": [3],
  "material_ids": [8],
  "accounts": [{ "id": 3, "platform": "douyin", "account_name": "主账号", "auth_state": "ready" }],
  "materials": [{ "id": 8, "filename": "demo.mp4", "url": "/uploads/media/demo.mp4", "absolute_path": "D:/.../data/uploads/media/demo.mp4" }],
  "publish_at": null
}
```

执行器返回 JSON 时可以携带 `status`（`success` / `failed` / `publishing`）和任意结果字段，结果会写回发布记录。目标仓库原有的账号 Cookie、浏览器登录态和 Playwright 依赖仍由执行器管理，不写入本项目的普通业务表。

支持的平台标识：`xiaohongshu`、`wechat_channels`、`douyin`、`kuaishou`、`tiktok`、`instagram`、`facebook`、`bilibili`、`baijiahao`。
