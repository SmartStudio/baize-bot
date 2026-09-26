#!/bin/sh
set -eu
# 容器原地重启时 /tmp 还在，上一次 Xvfb 的锁和 socket 会让这次起不来。
display_number=${DISPLAY#:}
rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"
# 批准了 network 的 bash 和容器共用网络命名空间，连得上抽象 socket @/tmp/.X11-unix/X*；只留文件 socket，沙箱的 /tmp 是 tmpfs，看不到它。
Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp -nolisten local &
exec node --import tsx src/supervise.ts /run/baize/launch.json
