#!/usr/bin/env bash
# DB 복구: 백업 파일로 DB 를 되돌린다. 기존 데이터는 모두 지워진다.
# 사용: ./scripts/restore.sh backups/robot_control-YYYYMMDD-HHMMSS.sql.gz
set -euo pipefail
cd "$(dirname "$0")/.."
FILE="${1:?백업 파일 경로를 지정하세요}"
read -r -p "현재 DB 를 지우고 '$FILE' 로 복구합니다. 계속하려면 yes 입력: " ANSWER
[ "$ANSWER" = "yes" ] || { echo "취소"; exit 1; }
docker compose stop web worker
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\";" -c "CREATE DATABASE \"$POSTGRES_DB\";"'
gunzip -c "$FILE" | docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q'
docker compose start web worker
echo "$(date -Is) 복구 완료: $FILE"
