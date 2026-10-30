#!/usr/bin/env bash
# AWS 프로젝트 로그인(브라우저 인증)을 터미널 없이 두 단계로 나눈다. 자격 증명은 12시간 뒤 만료되므로 그때마다 다시 한다.
#   1) start : 로그인 URL 을 출력한다 → 사용자가 PC 브라우저에서 열어 AWS 에 로그인하면 인증 코드가 표시된다
#   2) code  : 사용자가 전달한 인증 코드를 넘긴다 → 로그인 완료 확인
#   status   : 현재 자격 증명이 유효한지
# 사용: ./scripts/aws-login-remote.sh start
#       ./scripts/aws-login-remote.sh code <인증코드>
#       ./scripts/aws-login-remote.sh status
# 인증 코드는 어디에도 기록하지 않는다(FIFO 로만 전달). 'aws login --remote' 는 표준 입력에서 코드를 읽는다.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
PROFILE="${AWS_PROFILE_DEPLOY:-default}"
REGION="${AWS_REGION_DEPLOY:-ap-southeast-2}"
DIR="${AWS_LOGIN_DIR:-${TMPDIR:-/tmp}/aws-login-$(id -u)}"
FIFO="$DIR/code.fifo"
LOG="$DIR/login.log"
mkdir -p "$DIR"

case "${1:-}" in
  start)
    # 이전 시도가 남아 있으면 정리
    for f in "$DIR/aws.pid" "$DIR/holder.pid"; do
      [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true
      rm -f "$f"
    done
    rm -f "$FIFO" "$LOG"
    mkfifo "$FIFO"
    # 쓰기 쪽을 열어 두어야 aws 가 표준 입력에서 EOF 를 받지 않고 코드를 기다린다(2시간)
    (sleep 7200 >"$FIFO") &
    echo $! >"$DIR/holder.pid"
    nohup aws login --remote --region "$REGION" --profile "$PROFILE" <"$FIFO" >"$LOG" 2>&1 &
    echo $! >"$DIR/aws.pid"
    for _ in $(seq 1 30); do
      grep -q 'https://' "$LOG" 2>/dev/null && break
      sleep 1
    done
    URL="$(grep -o 'https://[^[:space:]]*' "$LOG" | head -1 || true)"
    if [ -z "$URL" ]; then echo "URL 을 얻지 못했습니다. 로그: $LOG"; cat "$LOG"; exit 1; fi
    echo "아래 URL 을 PC 브라우저에서 열어 AWS 에 로그인한 뒤, 화면의 인증 코드를 전달하세요:"
    echo "$URL"
    ;;
  code)
    CODE="${2:?인증 코드}"
    [ -p "$FIFO" ] || { echo "start 를 먼저 실행하세요"; exit 1; }
    printf '%s\n' "$CODE" >"$FIFO"
    for _ in $(seq 1 30); do
      if aws sts get-caller-identity --profile "$PROFILE" --query Arn --output text >/dev/null 2>&1; then
        echo "로그인 성공: $(aws sts get-caller-identity --profile "$PROFILE" --query Arn --output text)"
        [ -f "$DIR/holder.pid" ] && kill "$(cat "$DIR/holder.pid")" 2>/dev/null || true
        exit 0
      fi
      sleep 2
    done
    echo "아직 로그인이 확인되지 않습니다. 로그(코드는 찍히지 않음):"
    tail -5 "$LOG"
    exit 1
    ;;
  status)
    aws sts get-caller-identity --profile "$PROFILE" --query Arn --output text && echo "유효" || { echo "만료 또는 미로그인 → start"; exit 1; }
    ;;
  *)
    echo "사용: $0 start | code <인증코드> | status"
    exit 2
    ;;
esac
