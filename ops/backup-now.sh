# 배포 전 DB 백업(서버 backups/). 공개 기록에는 파일 크기만.
cd /opt/robot-system
f=backups/pre-deploy-$(date +%Y%m%d-%H%M%S).sql.gz
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges' | gzip > "$f"
echo "PUBLIC: 백업 $(basename "$f") $(du -h "$f" | cut -f1) · 테이블 $(zcat "$f" | grep -c 'CREATE TABLE')개"
