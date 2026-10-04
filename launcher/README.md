# Windows 启动器

`DaiganLauncher.exe` 是项目的 Windows 图形启动器，和 `server.mjs`、`data/` 放在同一目录。

从源码首次部署时先在项目根目录执行 `npm run setup`，它会安装锁定版本的前端依赖并生成 `public/dist/`；之后启动器可以直接运行 `server.mjs`。

支持：

- 启动、停止、重启后台
- `--local`、`--port`、`--host` 和附加参数
- `XFC_PORT`、`XFC_LOCAL`、`XFC_HOST`、`XFC_DATA_DIR` 环境变量
- `XFC_NODE_PATH` 可指定 Node.js 完整路径；也会自动识别 nvm-windows、scoop 和常见安装目录
- 当前用户开机自启动（不需要管理员权限）
- 打开后台、日志和数据目录

命令行示例：

```text
DaiganLauncher.exe
DaiganLauncher.exe --local
DaiganLauncher.exe --port 8888 --local
DaiganLauncher.exe --host 0.0.0.0 --port 8888
```

启动器不会复制、移动或重建 `data/console.db` 和 `data/uploads/`。运行日志和 PID 文件放在 `launcher-data/`。
开机启动使用当前用户的注册表 `Run` 项，并写入当前 EXE 的绝对路径；启动失败时窗口会保持可见，方便查看错误。

重新编译：

```powershell
powershell -ExecutionPolicy Bypass -File .\launcher\generate-icon.ps1
powershell -ExecutionPolicy Bypass -File .\launcher\build.ps1
```

`generate-icon.ps1` 会直接渲染 `public/favicon.svg`，生成包含多个尺寸的 `launcher/daigan.ico`。网页 favicon 或其视觉内容变更后，先重新生成 ICO，再重新编译启动器。
