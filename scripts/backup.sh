#!/usr/bin/env bash
# DB 백업: docker compose 의 db 컨테이너에서 pg_dump 를 받아 압축 저장하고 오래된 파일을 지운다.
# 사용: ./scripts/backup.sh [일일 백업 보관일수(기본 14)] — 월별 보관본(backups/monthly)은 지우지 않는다
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
# 월별 영구 보관본: 매달 첫 백업을 monthly/ 에 복사하고 지우지 않는다(보고서·실적은 보존 기한 없음, 1건 수백 KB)
mkdir -p backups/monthly
MONTHLY="backups/monthly/robot_control-$(date +%Y%m).sql.gz"
[ -f "$MONTHLY" ] || { cp "$FILE" "$MONTHLY" && echo "$(date -Is) 월별 보관본: $MONTHLY"; }
# 선택: 오브젝트 스토리지로 복사 (AWS CLI 설정 후 BACKUP_S3_URI=s3://bucket/path)
if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp "$FILE" "${BACKUP_S3_URI%/}/$(basename "$FILE")" && echo "$(date -Is) S3 업로드 완료"
fi
