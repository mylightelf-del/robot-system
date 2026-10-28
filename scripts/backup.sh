#!/usr/bin/env bash
# DB 백업: docker compose 의 db 컨테이너에서 pg_dump 를 받아 압축 저장하고 오래된 파일을 지운다.
# 사용: ./scripts/backup.sh [보관일수(기본 14)]
# cron 예: 0 3 * * * cd /opt/robot-system && ./scripts/backup.sh >> backups/backup.log 2>&1
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP_DAYS="${1:-14}"
mkdir -p backups
STAMP="$(date +%Y%m%d-%H%M%S)"
FILE="backups/robot_control-${STAMP}.sql.gz"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' | gzip > "$FILE"
echo "$(date -Is) 백업 완료: $FILE ($(du -h "$FILE" | cut -f1))"
find backups -name 'robot_control-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
# 선택: 오브젝트 스토리지로 복사 (AWS CLI 설정 후 BACKUP_S3_URI=s3://bucket/path)
if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp "$FILE" "${BACKUP_S3_URI%/}/$(basename "$FILE")" && echo "$(date -Is) S3 업로드 완료"
fi
