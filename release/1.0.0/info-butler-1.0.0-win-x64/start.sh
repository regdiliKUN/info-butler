#!/usr/bin/env bash
# 信息管家 · 本地包体启动器（构建生成，请勿手改）
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-4173}"
URL="http://127.0.0.1:${PORT}"
ONLINE_URL="https://info-butler-35240.app.workbuddy.host/?sharecode=2BKLJOXX4H"
open_url() {
  [ "${INFO_BUTLER_NO_BROWSER:-0}" = "1" ] && return 0
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1"
  else echo "请手动打开：$1"
  fi
}
cd "$ROOT" || exit 1
if command -v node >/dev/null 2>&1; then
  echo "启动本地服务（node）：${URL}"
  node "$ROOT/scripts/serve.js" --root "$ROOT" --port "$PORT" &
  SERVER_PID=$!
elif command -v python3 >/dev/null 2>&1; then
  echo "启动本地服务（python3）：${URL}"
  python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
  SERVER_PID=$!
else
  echo "未检测到 node / python3，改为打开在线版"
  open_url "$ONLINE_URL"
  exit 0
fi
sleep 1
open_url "$URL"
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT
wait "$SERVER_PID"
