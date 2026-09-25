#!/usr/bin/env bash
# 起、查、停白泽 Bot 的两套验证环境。每个服务放进自己的进程组，停的时候只杀记下来的组。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
RUN="$ROOT/.audit/verify-run"
ENV_FILE="$ROOT/.env"
SELF="$ROOT/.claude/skills/verify/scripts/stack.sh"

usage() {
  cat <<'EOF'
用法：
  stack.sh entry1 up|doctor|down          假控制面 3317 + Web 5377
  stack.sh entry2 up [--agent]|doctor|down 真控制面（.env 的 PORT）+ Web 5173 + 可选电脑代理
EOF
  exit 2
}

# 和 scripts/dev.mjs 同一种解析：只认 KEY=value，去掉一层引号。
env_get() {
  local key="$1" fallback="${2-}" line value
  [[ -f "$ENV_FILE" ]] || { printf '%s' "$fallback"; return; }
  line="$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$ENV_FILE" | tail -1 || true)"
  [[ -n "$line" ]] || { printf '%s' "$fallback"; return; }
  value="${line#*=}"
  value="$(printf '%s' "$value" | sed -E "s/^[[:space:]]+//; s/[[:space:]]+$//; s/^[\"']//; s/[\"']$//")"
  printf '%s' "${value:-$fallback}"
}

env_keys() {
  [[ -f "$ENV_FILE" ]] || return 0
  sed -nE 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\1/p' "$ENV_FILE"
}

# 控制面拿整份 .env，shell 里已有的变量优先，和 dev.mjs 一致。
export_env_file() {
  local key
  for key in $(env_keys); do
    if [[ -z "${!key+x}" ]]; then export "$key=$(env_get "$key")"; fi
  done
}

listener_pid() {
  lsof -nP -t -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -1 || true
}

describe_port() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | sed -n '2,$p' || true
}

require_free() {
  local port="$1" pid
  pid="$(listener_pid "$port")"
  if [[ -n "$pid" ]]; then
    echo "端口 $port 已被占用，不起第二份，也不动别人的进程："
    describe_port "$port"
    exit 1
  fi
}

http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$1" || true
}

wait_code() {
  local url="$1" want="$2" name="$3" log="$4" tries=0
  until [[ "$(http_code "$url")" == "$want" ]]; do
    tries=$((tries + 1))
    if [[ $tries -gt 120 ]]; then
      echo "等了 60 秒 $url 还不是 ${want}，$name 的日志尾巴："
      tail -30 "$log"
      exit 1
    fi
    sleep 0.5
  done
  echo "$name 就绪：$url → $want"
}

start() {
  local entry="$1" name="$2"
  shift 2
  mkdir -p "$RUN/$entry"
  local log="$RUN/$entry/$name.log"
  set -m
  (cd "$ROOT" && exec "$@") >"$log" 2>&1 &
  echo $! >"$RUN/$entry/$name.pgid"
  set +m
  echo "起 ${name}，进程组 $(cat "$RUN/$entry/$name.pgid")，日志 $log"
}

group_alive() {
  kill -0 -- "-$1" 2>/dev/null
}

stop_all() {
  local entry="$1" file pgid name tries
  shopt -s nullglob
  for file in "$RUN/$entry"/*.pgid; do
    name="$(basename "$file" .pgid)"
    pgid="$(cat "$file")"
    if group_alive "$pgid"; then
      kill -TERM -- "-$pgid" 2>/dev/null || true
      tries=0
      while group_alive "$pgid" && [[ $tries -lt 20 ]]; do sleep 0.5; tries=$((tries + 1)); done
      if group_alive "$pgid"; then kill -KILL -- "-$pgid" 2>/dev/null || true; fi
      echo "停了 ${name}（进程组 ${pgid}）"
    else
      echo "$name 已不在（进程组 ${pgid}）"
    fi
    rm -f "$file"
  done
  shopt -u nullglob
}

# 端口上的监听者必须是我们起的那个进程组，否则是在驱动别人的实例。
check_owned() {
  local entry="$1" name="$2" port="$3" file pgid pid owner
  file="$RUN/$entry/$name.pgid"
  if [[ ! -f "$file" ]]; then echo "✗ $name 没有 pgid 文件，不是这个脚本起的"; return 1; fi
  pgid="$(cat "$file")"
  if ! group_alive "$pgid"; then echo "✗ $name 进程组 $pgid 已退出，看 $RUN/$entry/$name.log"; return 1; fi
  [[ -n "$port" ]] || { echo "✓ $name 进程组 $pgid 活着"; return 0; }
  pid="$(listener_pid "$port")"
  if [[ -z "$pid" ]]; then echo "✗ $name 端口 $port 没人监听"; return 1; fi
  owner="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  if [[ "$owner" != "$pgid" ]]; then
    echo "✗ 端口 $port 的监听者不在 $name 的进程组 $pgid 里："
    describe_port "$port"
    return 1
  fi
  echo "✓ $name 进程组 $pgid 持有端口 $port"
}

entry1() {
  local api=3317 web=5377
  case "${1-}" in
    up)
      require_free "$api"
      require_free "$web"
      start entry1 mock env API_PORT="$api" pnpm --filter @baize/web mock
      start entry1 web env API_PORT="$api" WEB_PORT="$web" pnpm --filter @baize/web dev
      wait_code "http://127.0.0.1:$api/api/health" 200 mock "$RUN/entry1/mock.log"
      wait_code "http://127.0.0.1:$web/" 200 web "$RUN/entry1/web.log"
      wait_code "http://127.0.0.1:$web/api/health" 200 "web→mock 代理" "$RUN/entry1/web.log"
      echo "打开 http://localhost:$web"
      ;;
    doctor)
      local ok=0
      check_owned entry1 mock "$api" || ok=1
      check_owned entry1 web "$web" || ok=1
      echo "代理 /api/health → $(http_code "http://127.0.0.1:$web/api/health")（要 200）"
      return $ok
      ;;
    down) stop_all entry1 ;;
    *) usage ;;
  esac
}

wait_postgres() {
  local tries=0
  until docker exec baize-postgres pg_isready -U baize -d baize >/dev/null 2>&1; do
    tries=$((tries + 1))
    [[ $tries -le 60 ]] || { echo "baize-postgres 30 秒没就绪"; exit 1; }
    sleep 0.5
  done
  echo "baize-postgres 就绪（compose 项目 $(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' baize-postgres)）"
}

# 只读对账：drizzle 目录里有、库里 _migrations 没记的迁移。缺了控制面照样起，但新接口会在运行时报错。
pending_migrations() {
  local applied file
  applied="$(docker exec baize-postgres psql -U baize -d baize -Atc "select name from public._migrations" 2>/dev/null || true)"
  for file in "$ROOT"/packages/control-plane/drizzle/*.sql; do
    grep -qx "$(basename "$file")" <<<"$applied" || basename "$file"
  done
}

report_migrations() {
  local missing
  missing="$(pending_migrations)"
  if [[ -z "$missing" ]]; then
    echo "迁移已全部应用"
  else
    echo "开发库缺迁移：$(echo "$missing" | tr '\n' ' ')。要应用跑 pnpm --filter @baize/control-plane migrate，这是写库，先问调用方"
  fi
}

entry2() {
  local cp web=5173 api
  cp="$(env_get PORT 3001)"
  api="$(env_get API_PORT "$cp")"
  case "${1-}" in
    up)
      local with_agent=0
      [[ "${2-}" == "--agent" ]] && with_agent=1
      require_free "$cp"
      require_free "$web"
      docker start baize-postgres >/dev/null
      wait_postgres
      report_migrations
      start entry2 control-plane "$SELF" _exec-control-plane
      start entry2 web env API_PORT="$api" WEB_PORT="$web" pnpm --filter @baize/web dev
      wait_code "http://127.0.0.1:$cp/api/bots" 401 control-plane "$RUN/entry2/control-plane.log"
      wait_code "http://127.0.0.1:$web/api/bots" 401 "web→控制面 代理" "$RUN/entry2/web.log"
      if [[ $with_agent -eq 1 ]]; then
        start entry2 computer-agent "$SELF" _exec-computer-agent "$cp"
        local tries=0
        until grep -q "收到 config" "$RUN/entry2/computer-agent.log" 2>/dev/null; do
          tries=$((tries + 1))
          [[ $tries -le 60 ]] || { echo "电脑代理 30 秒没收到 config："; tail -20 "$RUN/entry2/computer-agent.log"; exit 1; }
          sleep 0.5
        done
        grep "收到 config" "$RUN/entry2/computer-agent.log" | tail -1
      fi
      echo "打开 http://localhost:$web"
      ;;
    doctor)
      local ok=0
      report_migrations
      echo "baize-postgres：$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' baize-postgres 2>&1)"
      check_owned entry2 control-plane "$cp" || ok=1
      check_owned entry2 web "$web" || ok=1
      if [[ -f "$RUN/entry2/computer-agent.pgid" ]]; then
        check_owned entry2 computer-agent "" || ok=1
        grep -E "控制面已接纳|收到 config|重连" "$RUN/entry2/computer-agent.log" | tail -2 || true
      fi
      echo "控制面 /api/bots → $(http_code "http://127.0.0.1:$cp/api/bots")，经 Web 代理 → $(http_code "http://127.0.0.1:$web/api/bots")（都要 401）"
      return $ok
      ;;
    down) stop_all entry2 ;;
    *) usage ;;
  esac
}

exec_control_plane() {
  export_env_file
  exec pnpm --filter @baize/control-plane start
}

# 电脑代理只拿连控制面要的四个，上游密钥和库连接不进 Bot 的 bash，和 dev.mjs 的 agentEnvOf 一致。
exec_computer_agent() {
  local cp="$1" key value
  for key in $(env_keys); do unset "$key"; done
  export COMPUTER_ID AGENT_TOKEN CONTROL_PLANE_AGENT_URL
  COMPUTER_ID="$(env_get COMPUTER_ID)"
  AGENT_TOKEN="$(env_get AGENT_TOKEN)"
  CONTROL_PLANE_AGENT_URL="$(env_get CONTROL_PLANE_AGENT_URL "ws://127.0.0.1:$cp/agent")"
  value="$(env_get BAIZE_DATA_DIR)"
  if [[ -n "$value" ]]; then export BAIZE_DATA_DIR="$value"; fi
  exec pnpm --filter @baize/computer-agent exec tsx src/main.ts
}

case "${1-}" in
  _exec-control-plane) exec_control_plane ;;
  _exec-computer-agent) shift; exec_computer_agent "$@" ;;
  entry1) shift; entry1 "$@" ;;
  entry2) shift; entry2 "$@" ;;
  *) usage ;;
esac
