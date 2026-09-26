#!/bin/sh
set -eu
# 容器原地重启时 /tmp 还在，上一次 Xvfb 的锁和 socket 会让这次起不来。
display_number=${DISPLAY#:}
rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp &
exec node --import tsx src/supervise.ts /run/baize/launch.json
