#!/usr/bin/env bash
# 一键安装到 DSH profile（macOS / Linux）
#   bash install.sh            # 装到 web profile
#   bash install.sh desktop    # 装到 desktop profile
set -euo pipefail
PROFILE="${1:-web}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if ! command -v dsh >/dev/null 2>&1; then
  echo "没找到 dsh 命令。请手动执行："
  echo "  dsh plugin --profile $PROFILE add link:$HERE"
  exit 1
fi

dsh plugin --profile "$PROFILE" add "link:$HERE"
echo
echo "装好了。验证： dsh --profile $PROFILE --dump-config | grep web-reader"
echo "然后重启 DSH，在新会话里就能看到 web_read 工具。"
echo "命令行版： node \"$HERE/bin/webread.mjs\" <url>"
