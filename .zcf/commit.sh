set -e
git add README.md client/forms/resource-field.jsx scripts/checks/smoke.mjs src/routes/system.mjs
printf '%s\n' '修复: 切窗口漏传 flow，识别画面每次都死在第一步' '' '服务端要求 /focus 属于某条流程（23dae4a），前端这一行没跟上，' '于是每次点「识别画面」都报「上一条还没结束，这次没有切窗口」。' '顺带把「没带 flow」与「别人占着」分开报（400 screen_flow_missing / 409 screen_busy），' '并加一条源码级守门，防止服务端约定再和前端脱节。' '已验证：npm run test 657 通过 / 0 失败，npm run test:ui 584 通过 / 0 失败。' > /tmp/xfc-commit-msg.txt
git commit -F /tmp/xfc-commit-msg.txt
echo '--- log ---'
git log -1 --stat --format='%h %s'
echo '--- status ---'
git status --porcelain