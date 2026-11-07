#!/usr/bin/env bash
# 시험용 APK 빌드(폰에 직접 설치). 네이티브 폴더(android/)는 매번 app.json 에서 새로 만든다(수정 금지, Continuous Native Generation).
# 서명: Expo 기본 디버그 키(android/app/debug.keystore). 스토어 출시 전에는 Play 앱 서명용 업로드 키로 바꾼다(docs/19 11장).
# 사용: cd mobile && ./scripts/build-apk.sh   → mobile/dist/widebot-<버전>-<날짜>.apk
set -euo pipefail
cd "$(dirname "$0")/.."
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}" ANDROID_SDK_ROOT="${ANDROID_HOME:-/opt/android-sdk}"
[ -d node_modules ] || npm install --no-audit --no-fund
npx tsc --noEmit
CI=1 npx expo prebuild --platform android --no-install --clean
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
( cd android && ./gradlew assembleRelease --no-daemon --console=plain --max-workers=2 )
ver="$(node -p "require('./app.json').expo.version")"
mkdir -p dist
out="dist/widebot-${ver}-$(date +%Y%m%d-%H%M).apk"
cp android/app/build/outputs/apk/release/app-release.apk "$out"
echo "APK: $out ($(du -h "$out" | cut -f1))"
