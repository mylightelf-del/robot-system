#!/usr/bin/env bash
# 운영 서버(widebot-web)에서 bash 스크립트를 실행한다. SSH 없이 AWS Systems Manager Run Command 를 쓴다.
# 스크립트는 표준 입력 또는 -f 파일로 받는다. 서버의 기본 셸이 dash 라 bash -c 로 감싼다.
# 사용: ./scripts/remote-run.sh <<'EOS'
#       cd /opt/robot-system && docker compose ps
#       EOS
#       ./scripts/remote-run.sh -f 파일.sh
# 사전 조건: scripts/setup-aws-cli.sh + scripts/aws-login-remote.sh (docs/10 2장)
# 주의: 명령 본문은 AWS 콘솔의 Run Command 이력에 남는다. 비밀값은 본문에 쓰지 말고 scripts/remote-env.sh 처럼 S3 presigned URL 로 전달한다.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
REGION="${AWS_REGION_DEPLOY:-ap-southeast-2}"
PROFILE="${AWS_PROFILE_DEPLOY:-default}"
INSTANCE="${DEPLOY_INSTANCE_ID:-mi-0d6dbe7bc429007bf}"
TIMEOUT="${REMOTE_TIMEOUT_SECONDS:-600}"
if [ "${1:-}" = "-f" ]; then SCRIPT="$(cat "${2:?스크립트 파일}")"; else SCRIPT="$(cat)"; fi
[ -n "$SCRIPT" ] || { echo "실행할 스크립트가 비어 있습니다"; exit 2; }

PARAMS="$(python3 -c 'import json,shlex,sys; print(json.dumps({"commands":["bash -c " + shlex.quote(sys.stdin.read())],"executionTimeout":[sys.argv[1]]}))' "$TIMEOUT" <<<"$SCRIPT")"
CID="$(aws ssm send-command --region "$REGION" --profile "$PROFILE" --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --comment "robot-system remote-run $(date +%Y%m%d-%H%M%S)" --timeout-seconds 600 --parameters "$PARAMS" --query Command.CommandId --output text)"
echo "원격 명령: $CID"
ST=Pending
for _ in $(seq 1 "$((TIMEOUT / 5 + 6))"); do
  ST="$(aws ssm get-command-invocation --region "$REGION" --profile "$PROFILE" --command-id "$CID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null || echo Pending)"
  case "$ST" in Success|Failed|TimedOut|Cancelled) break;; esac
  sleep 5
done
echo "결과: $ST"
# presigned URL 의 서명 파라미터는 출력에서 지운다
aws ssm get-command-invocation --region "$REGION" --profile "$PROFILE" --command-id "$CID" --instance-id "$INSTANCE" \
  --query "[StandardOutputContent,StandardErrorContent]" --output text | sed -E 's/X-Amz-[A-Za-z-]+=[^& ]*//g'
[ "$ST" = "Success" ]
