#!/usr/bin/env bash
# 원격 배포(이 저장소 → 시드니 Lightsail widebot-web). SSH 없이 AWS Systems Manager Run Command 로 실행한다.
# 흐름: git archive(현재 HEAD) → S3 배포 버킷에 올림(비공개) → 서버가 presigned URL 로 받아 풀고 docker compose up -d --build.
# 사전 조건: aws login --profile default (AWS 프로젝트 자격 증명), 서버가 SSM 관리 인스턴스(mi-…)로 등록돼 있어야 한다(docs/05 2-2).
# 사용: ./scripts/deploy-remote.sh            # 코드만 갱신(.env 유지)
#       ./scripts/deploy-remote.sh --env 파일  # 지정한 .env 파일도 함께 올려 교체(비밀값은 서버 .env 에만 둔다)
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION_DEPLOY:-ap-southeast-2}"
PROFILE="${AWS_PROFILE_DEPLOY:-default}"
BUCKET="${DEPLOY_BUCKET:-widebot-deploy-315899575985}"
INSTANCE="${DEPLOY_INSTANCE_ID:-mi-0d6dbe7bc429007bf}"
ENV_FILE=""
if [ "${1:-}" = "--env" ]; then ENV_FILE="${2:?.env 파일 경로}"; fi

STAMP="$(date +%Y%m%d-%H%M%S)"
TARBALL="/tmp/robot-system-${STAMP}.tar.gz"
git archive --format=tar.gz -o "$TARBALL" HEAD
echo "번들: $TARBALL ($(du -h "$TARBALL" | cut -f1), $(git rev-parse --short HEAD))"

KEY="release/robot-system-${STAMP}.tar.gz"
aws s3 cp "$TARBALL" "s3://$BUCKET/$KEY" --region "$REGION" --profile "$PROFILE" --only-show-errors
T_URL="$(aws s3 presign "s3://$BUCKET/$KEY" --expires-in 900 --region "$REGION" --profile "$PROFILE")"
ENV_LINE=""
if [ -n "$ENV_FILE" ]; then
  EKEY="release/env-${STAMP}"
  aws s3 cp "$ENV_FILE" "s3://$BUCKET/$EKEY" --region "$REGION" --profile "$PROFILE" --only-show-errors
  E_URL="$(aws s3 presign "s3://$BUCKET/$EKEY" --expires-in 900 --region "$REGION" --profile "$PROFILE")"
  ENV_LINE="curl -fsSL -o /opt/robot-system/.env '$E_URL' && chmod 600 /opt/robot-system/.env"
fi

# SSM 의 기본 셸은 sh(dash) 라 pipefail 이 없다 → bash 로 감싼다
SCRIPT=$(cat <<EOS
set -e
mkdir -p /opt/robot-system && cd /opt/robot-system
curl -fsSL -o /tmp/release.tar.gz '$T_URL'
tar xzf /tmp/release.tar.gz -C /opt/robot-system && rm -f /tmp/release.tar.gz
$ENV_LINE
chown -R ubuntu:ubuntu /opt/robot-system
docker compose up -d --build 2>&1 | tail -30
echo '--- ps'; docker compose ps
echo '--- migrate'; docker compose logs migrate --no-color | tail -30
echo '--- health'; sleep 5; curl -s http://127.0.0.1:3000/api/health || true; echo
EOS
)
PARAMS="$(python3 -c 'import json,shlex,sys; print(json.dumps({"commands":["bash -c " + shlex.quote(sys.stdin.read())],"executionTimeout":["2400"]}))' <<<"$SCRIPT")"
CID="$(aws ssm send-command --region "$REGION" --profile "$PROFILE" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript --comment "robot-system deploy $STAMP" --timeout-seconds 600 --parameters "$PARAMS" --query Command.CommandId --output text)"
echo "원격 명령: $CID (빌드 5~10분)"
for _ in $(seq 1 240); do
  ST="$(aws ssm get-command-invocation --region "$REGION" --profile "$PROFILE" --command-id "$CID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)"
  case "$ST" in Success|Failed|TimedOut|Cancelled) break;; esac
  sleep 10
done
echo "결과: $ST"
aws ssm get-command-invocation --region "$REGION" --profile "$PROFILE" --command-id "$CID" --instance-id "$INSTANCE" --query "[StandardOutputContent,StandardErrorContent]" --output text | sed -E 's/X-Amz-[A-Za-z-]+=[^& ]*//g'
[ "$ST" = "Success" ]
