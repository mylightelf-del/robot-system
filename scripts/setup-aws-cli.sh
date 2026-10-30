#!/usr/bin/env bash
# 새 작업 세션(클라우드 컨테이너)에서 AWS CLI v2 를 사용자 폴더에 설치하고 프로젝트 리전(ap-southeast-2)을 설정한다.
# 관리자 권한이 필요 없다. 이미 설치돼 있으면 건너뛴다. 설치 뒤 로그인은 scripts/aws-login-remote.sh (docs/10 2장).
# 사용: ./scripts/setup-aws-cli.sh
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
if ! command -v aws >/dev/null 2>&1; then
  TMP="$(mktemp -d)"
  curl -fsSL -o "$TMP/awscliv2.zip" https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip
  (cd "$TMP" && unzip -q awscliv2.zip && ./aws/install --install-dir "$HOME/.local/share/aws-cli" --bin-dir "$HOME/.local/bin" >/dev/null)
  rm -rf "$TMP"
  echo "AWS CLI 설치: $HOME/.local/bin/aws"
fi
aws --version
aws configure set region ap-southeast-2 --profile default
if aws sts get-caller-identity --profile default --query Arn --output text 2>/dev/null; then
  echo "로그인 상태: 유효"
else
  echo "로그인 필요 → ./scripts/aws-login-remote.sh start"
fi
echo '셸마다 PATH 에 추가: export PATH="$HOME/.local/bin:$PATH"'
