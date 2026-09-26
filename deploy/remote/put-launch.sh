#!/bin/sh
# 给远程电脑换一份新 token，写成启动文件放进容器。token 只过这个 shell 的变量和两条管道，不落宿主机磁盘。
# 用法：deploy/remote/put-launch.sh [账号邮箱]，不给邮箱就是 seed 的开发账号。
set -eu
cd "$(dirname "$0")"

agent_url=${AGENT_URL:-ws://control-plane:3001/agent}
# 看护进程只读第一份启动文件。在线时直接放新文件，旧 token 作废、新文件一直留在 tmpfs 里，
# 所以先重启容器：旧代理退出，tmpfs 清空，看护进程回到「等启动文件」。
docker compose restart remote-computer
issued=$(docker compose exec -T control-plane node --import tsx src/scripts/computer-token.ts remote "$@")
computer_id=$(printf '%s\n' "$issued" | sed -n 's/^COMPUTER_ID=//p')
token=$(printf '%s\n' "$issued" | sed -n 's/^AGENT_TOKEN=//p')
if [ -z "$computer_id" ] || [ -z "$token" ]; then
  echo "computer-token 没给出 COMPUTER_ID 和 AGENT_TOKEN，启动文件没放" >&2
  exit 1
fi

# 先写临时名再改名，看护进程不会读到写了一半的文件；umask 077 让文件生来就是 600。
printf '{"url":"%s","computerId":"%s","token":"%s","dataDir":"/home/node/.baize/bots"}\n' \
  "$agent_url" "$computer_id" "$token" |
  docker compose exec -T remote-computer sh -c \
    'umask 077 && cat > /run/baize/.launch.json.tmp && mv /run/baize/.launch.json.tmp /run/baize/launch.json'
echo "启动文件已放进 remote-computer:/run/baize/launch.json，看护进程读完会删掉它"
