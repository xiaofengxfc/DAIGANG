#!/usr/bin/env sh
# macOS / Linux： ./start.sh     只允许本机： ./start.sh --local
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  没找到 Node.js。这个后台需要 Node.js 22.12 或更高版本。"
  echo "  装一个：https://nodejs.org  或者 brew install node"
  echo ""
  exit 1
fi

echo ""
echo "  Node $(node -v)"
echo ""

if [ ! -f "public/dist/app.js" ]; then
  if ! command -v npm >/dev/null 2>&1; then
    echo "  首次运行需要 npm 来安装前端依赖。"
    exit 1
  fi
  echo "  首次运行：安装依赖并构建前端…"
  npm run setup || exit 1
fi

exec node server.mjs "$@"
