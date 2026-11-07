#!/usr/bin/env bash
# Google Play 업로드용 AAB 빌드(내부 테스트·정식 출시 공통).
# 서명: 업로드 키(사용자 보관). Play 앱 서명을 쓰므로 실제 배포 서명은 Google 이 관리하고, 이 키는 '업로드' 용이다(분실 시 Play Console 에서 재설정 신청 가능).
# 환경변수(모두 필요): UPLOAD_KEYSTORE=경로 UPLOAD_KEYSTORE_PASSWORD=… UPLOAD_KEY_ALIAS=… UPLOAD_KEY_PASSWORD=…
# 비밀값은 명령줄이 아니라 환경변수 파일(예: ~/.widebot-upload.env, 권한 600)에서 `set -a; . 파일; set +a` 로 읽어 온다.
# 사용: cd mobile && ./scripts/build-aab.sh   → mobile/dist/widebot-<버전>-<versionCode>.aab
# 업로드할 때마다 app.json 의 android.versionCode 를 1 올려야 한다(Play 는 같은 versionCode 를 두 번 받지 않는다).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${UPLOAD_KEYSTORE:?업로드 키 저장소 경로}" "${UPLOAD_KEYSTORE_PASSWORD:?}" "${UPLOAD_KEY_ALIAS:?}" "${UPLOAD_KEY_PASSWORD:?}"
[ -f "$UPLOAD_KEYSTORE" ] || { echo "키 저장소 파일이 없습니다: $UPLOAD_KEYSTORE"; exit 2; }
export ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}" ANDROID_SDK_ROOT="${ANDROID_HOME:-/opt/android-sdk}"
[ -d node_modules ] || npm install --no-audit --no-fund
npx tsc --noEmit
CI=1 npx expo prebuild --platform android --no-install --clean
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
cp "$UPLOAD_KEYSTORE" android/app/upload.keystore
# 생성된 build.gradle 의 release 서명을 업로드 키로 바꾼다(네이티브 폴더는 생성물이므로 매번 여기서 고친다). 비밀값은 gradle.properties 가 아니라 환경변수로 넘긴다.
python3 - <<'PY'
import re
p = "android/app/build.gradle"
s = open(p, encoding="utf-8").read()
s = s.replace("""    signingConfigs {
        debug {""", """    signingConfigs {
        upload {
            storeFile file('upload.keystore')
            storePassword System.getenv('UPLOAD_KEYSTORE_PASSWORD')
            keyAlias System.getenv('UPLOAD_KEY_ALIAS')
            keyPassword System.getenv('UPLOAD_KEY_PASSWORD')
        }
        debug {""", 1)
s, n = re.subn(r"(release \{\n(?:.*\n)*?\s*)signingConfig signingConfigs\.debug", r"\1signingConfig signingConfigs.upload", s, count=1)
assert n == 1, "release signingConfig 를 찾지 못했습니다"
open(p, "w", encoding="utf-8").write(s)
print("release 서명 → upload 키")
PY
( cd android && ./gradlew bundleRelease --no-daemon --console=plain --max-workers=2 )
ver="$(node -p "require('./app.json').expo.version")"
code="$(node -p "require('./app.json').expo.android.versionCode")"
mkdir -p dist
out="dist/widebot-${ver}-${code}.aab"
cp android/app/build/outputs/bundle/release/app-release.aab "$out"
rm -f android/app/upload.keystore
echo "AAB: $out ($(du -h "$out" | cut -f1)) — Play Console 내부 테스트에 업로드"
