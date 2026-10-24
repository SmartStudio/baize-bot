#!/bin/sh
# 用 pg_dump 把库导成一份按时刻命名的自定义格式文件，导完核一遍能读，只留最近 BACKUP_KEEP 份。
# 用法：deploy/remote/backup-db.sh
#   BACKUP_DIR    备份放哪，默认 ~/baize-backups
#   BACKUP_KEEP   留几份，默认 14
#   DB_NAME       导哪个库，默认 baize
#   PG_CONTAINER  设了就直接对这个 Postgres 容器导，不经这份 compose
# 恢复用同目录的 restore-db.sh，步骤见 docs/部署.md「备份和恢复」。
set -eu

backup_dir=${BACKUP_DIR:-$HOME/baize-backups}
keep=${BACKUP_KEEP:-14}
db=${DB_NAME:-baize}

# 拦前导零：00 过了数字检查却等于 0，会把刚导的这份也删掉；08 在算术展开里按八进制报错。
case $keep in
  '' | *[!0-9]* | 0*)
    echo "BACKUP_KEEP 要是不带前导零的正整数，现在是「${keep}」" >&2
    exit 1
    ;;
esac
case $db in
  '' | *[!a-z0-9_]*)
    echo "DB_NAME 只认小写字母、数字和下划线，现在是「${db}」" >&2
    exit 1
    ;;
esac

pg() {
  if [ -n "${PG_CONTAINER:-}" ]; then
    docker exec -i "$PG_CONTAINER" "$@"
  else
    docker compose exec -T postgres "$@"
  fi
}

summary() {
  pg psql -U baize -d "$1" -v ON_ERROR_STOP=1 -tA -F ' ' -c "
    SELECT (SELECT count(*) FROM pg_tables WHERE schemaname = 'public'),
           (SELECT count(*) FROM _migrations),
           (SELECT max(name) FROM _migrations)"
}

# 库里有密码哈希和加密过的凭据，备份只给自己读。
umask 077
mkdir -p "$backup_dir"
backup_dir=$(cd "$backup_dir" && pwd)
cd "$(dirname "$0")"
target="$backup_dir/$db-$(date +%Y%m%d-%H%M%S).dump"
partial="$target.part"
trap 'rm -f "$partial"' EXIT

pg pg_dump -U baize -d "$db" -Fc >"$partial"
# 写了一半或格式坏了的文件不能冒充一份备份，也不能挤掉旧的好备份。
if ! pg pg_restore --list <"$partial" >/dev/null; then
  echo "pg_restore 读不了刚导出的文件，这次备份作废，旧备份没动" >&2
  exit 1
fi
mv "$partial" "$target"
echo "已备份 $db 到 ${target}（$(wc -c <"$target" | tr -d ' ') 字节）"
counts=$(summary "$db")
read -r tables migrations last <<EOF
$counts
EOF
echo "库里现在：$tables 张表，迁移 $migrations 条，最后一条 $last"

find "$backup_dir" -maxdepth 1 -name "$db-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9].dump" |
  sort -r | tail -n +"$((keep + 1))" | while IFS= read -r old; do
  rm -f -- "$old"
  echo "删掉旧备份 $old"
done
