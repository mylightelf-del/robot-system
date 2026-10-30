#!/usr/bin/env bash
# 운영 서버 /opt/robot-system/.env 의 값을 바꾸고 web·worker·caddy 를 다시 띄운다(SSH 불필요, SSM Run Command).
# 값은 비공개 S3 배포 버킷에 올려 서버가 presigned URL 로 받는다 → 명령 이력·화면에 비밀값이 남지 않는다.
# 사용: ./scripts/remote-env.sh KEY=VALUE [KEY=VALUE ...]
#   예: ./scripts/remote-env.sh ACME_EMAIL=ops@example.com
#       ./scripts/remote-env.sh PUDU_CALLBACK_CODE=xxxx            # 콜백 등록 뒤
#   옵션: REMOTE_ENV_SERVICES="caddy" ./scripts/remote-env.sh ...   # 다시 띄울 서비스 지정(기본 web worker caddy)
# 바뀐 키 이름만 출력하고 값은 출력하지 않는다. 바꾼 뒤 /api/health 와 콜백 endpoint 응답을 확인한다.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
cd "$(dirname "$0")/.."
REGION="${AWS_REGION_DEPLOY:-ap-southeast-2}"
PROFILE="${AWS_PROFILE_DEPLOY:-default}"
BUCKET="${DEPLOY_BUCKET:-widebot-deploy-315899575985}"
SERVICES="${REMOTE_ENV_SERVICES:-web worker caddy}"
DOMAIN_CHECK="${REMOTE_DOMAIN:-widebot.kro.kr}"
[ $# -ge 1 ] || { echo "사용: $0 KEY=VALUE [KEY=VALUE ...]"; exit 2; }
for kv in "$@"; do
  case "$kv" in
    [A-Za-z_]*=*) ;;
    *) echo "형식 오류: $kv (KEY=VALUE)"; exit 2;;
  esac
done

STAMP="$(date +%Y%m%d-%H%M%S)"
FRAG="$(mktemp)"
trap 'rm -f "$FRAG"' EXIT
printf '%s\n' "$@" >"$FRAG"
KEY="release/envfrag-${STAMP}"
aws s3 cp "$FRAG" "s3://$BUCKET/$KEY" --region "$REGION" --profile "$PROFILE" --only-show-errors
F_URL="$(aws s3 presign "s3://$BUCKET/$KEY" --expires-in 900 --region "$REGION" --profile "$PROFILE")"

./scripts/remote-run.sh <<EOS
set -e
cd /opt/robot-system
curl -fsSL -o /tmp/envfrag '$F_URL'
python3 - <<'PY'
env_path = '/opt/robot-system/.env'
lines = open(env_path, encoding='utf-8').read().splitlines()
changed = []
for frag in open('/tmp/envfrag', encoding='utf-8').read().splitlines():
    if not frag or frag.startswith('#') or '=' not in frag:
        continue
    key = frag.split('=', 1)[0]
    hit = False
    for i, line in enumerate(lines):
        if line.startswith(key + '='):
            lines[i] = frag
            hit = True
    if not hit:
        lines.append(frag)
    changed.append(key + (' (갱신)' if hit else ' (추가)'))
open(env_path, 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('변경:', ', '.join(changed))
PY
rm -f /tmp/envfrag
chmod 600 .env
docker compose up -d --force-recreate $SERVICES 2>&1 | tail -5
sleep 15
echo '--- ps'; docker compose ps --format 'table {{.Service}}\t{{.Status}}'
echo '--- health'; curl -s https://$DOMAIN_CHECK/api/health || curl -s http://127.0.0.1:3000/api/health || true; echo
echo '--- callback endpoint (PUDU_CALLBACK_CODE 미설정이면 503, 설정 뒤 코드 없는 요청은 401)'
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' https://$DOMAIN_CHECK/api/webhooks/pudu || true
EOS
aws s3 rm "s3://$BUCKET/$KEY" --region "$REGION" --profile "$PROFILE" --only-show-errors || true
