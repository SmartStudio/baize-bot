#!/bin/sh
# 把 backup-db.sh 导出的文件恢复成一个库。先灌进 <目标库>_restoring，整份灌成了才改名换上，灌失败原库不动。
# 用法：deploy/remote/restore-db.sh [--replace] <备份文件> <目标库>
#   目标库已存在时要带 --replace，原库改名成 <目标库>_before_<时刻> 留着，确认无误后自己删。
#   PG_CONTAINER  设了就直接对这个 Postgres 容器恢复，不经这份 compose
# 不用 pg_restore --clean：它只删备份里有的对象，备份之后的迁移建的表会留下来，下次升级就撞上。
set -eu

replace=0
if [ "${1:-}" = "--replace" ]; then
  replace=1
  shift
fi
if [ $# -ne 2 ]; then
  echo "用法：$0 [--replace] <备份文件> <目标库>" >&2
  exit 1
fi
dump=$1
target=$2
case $target in
  '' | *[!a-z0-9_]*)
    echo "目标库只认小写字母、数字和下划线，现在是「${target}」" >&2
    exit 1
    ;;
esac
# Postgres 的库名最长 63 字节，还要给后缀留位置。
if [ ${#target} -gt 40 ]; then
  echo "目标库名超过 40 个字符：$target" >&2
  exit 1
fi
if [ ! -s "$dump" ]; then
  echo "备份文件不存在或是空的：$dump" >&2
  exit 1
fi
dump="$(cd "$(dirname "$dump")" && pwd)/$(basename "$dump")"
cd "$(dirname "$0")"

pg() {
  if [ -n "${PG_CONTAINER:-}" ]; then
    docker exec -i "$PG_CONTAINER" "$@"
  else
    docker compose exec -T postgres "$@"
  fi
}

query() {
  pg psql -U baize -d postgres -v ON_ERROR_STOP=1 -tA -c "$1"
}

exists() {
  [ "$(query "SELECT count(*) FROM pg_database WHERE datname = '$1'")" = 1 ]
}

# 控制面、migrate 或别人的 psql 连着时改不了名，先拦下来说清楚。
assert_idle() {
  connections=$(query "SELECT count(*) FROM pg_stat_activity WHERE datname = '$1'")
  if [ "$connections" != 0 ]; then
    echo "还有 $connections 条连接连着库 $1。先停控制面：docker compose stop control-plane" >&2
    exit 1
  fi
}

staging="${target}_restoring"
if exists "$target" && [ "$replace" = 0 ]; then
  echo "库 $target 已经存在。要整库换成这份备份，加 --replace" >&2
  exit 1
fi
if exists "$staging"; then
  echo "库 $staging 已经存在，可能是上次恢复留下的。看过后删掉再来：docker compose exec postgres dropdb -U baize $staging" >&2
  exit 1
fi
if exists "$target"; then assert_idle "$target"; fi

drop_staging() {
  if pg dropdb -U baize --if-exists --force "$staging"; then
    echo "恢复没完成，临时库 $staging 已删，$target 没动" >&2
  else
    echo "恢复没完成，$target 没动，临时库 $staging 没删掉，手动删：docker compose exec postgres dropdb -U baize --force $staging" >&2
  fi
}

pg createdb -U baize "$staging"
# 原库改名之前哪一步失败都删掉临时库，不然下次恢复会被「临时库已经存在」拦住。
trap 'if [ $? != 0 ]; then drop_staging; fi' EXIT
if ! pg pg_restore -U baize -d "$staging" --no-owner --single-transaction --exit-on-error <"$dump"; then
  echo "pg_restore 失败" >&2
  exit 1
fi

if exists "$target"; then
  assert_idle "$target"
  before="${target}_before_$(date +%Y%m%d%H%M%S)"
  query "ALTER DATABASE $target RENAME TO $before" >/dev/null
  echo "原来的 $target 改名成了 ${before}，确认恢复无误后删掉：docker compose exec postgres dropdb -U baize $before"
fi
# 原库已经让开，临时库就是恢复好的那一份，之后再失败也不能删它。
trap - EXIT
query "ALTER DATABASE $staging RENAME TO $target" >/dev/null

counts=$(pg psql -U baize -d "$target" -v ON_ERROR_STOP=1 -tA -F ' ' -c "
  SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
         (SELECT count(*) FROM _migrations),
         (SELECT max(name) FROM _migrations)")
read -r tables migrations last <<EOF
$counts
EOF
echo "已恢复到 ${target}：$tables 张表，迁移 $migrations 条，最后一条 $last"
