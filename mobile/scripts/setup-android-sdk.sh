#!/usr/bin/env bash
# 안드로이드 SDK 명령줄 도구 설치(에뮬레이터 없이 APK 빌드용). Claude 작업 컨테이너·CI 에서 사용.
# 전제: JDK 17+ (컨테이너에는 21), 네트워크로 dl.google.com 접근.
# 사용: ./scripts/setup-android-sdk.sh   → 이후 export ANDROID_HOME=/opt/android-sdk
set -euo pipefail
SDK_ROOT="${ANDROID_HOME:-/opt/android-sdk}"
TOOLS_ZIP_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
if [ ! -x "$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager" ]; then
  mkdir -p "$SDK_ROOT/cmdline-tools"
  tmp="$(mktemp -d)"
  curl -sSL -o "$tmp/ct.zip" "$TOOLS_ZIP_URL"
  unzip -q "$tmp/ct.zip" -d "$tmp/ct"
  rm -rf "$SDK_ROOT/cmdline-tools/latest"
  mv "$tmp/ct/cmdline-tools" "$SDK_ROOT/cmdline-tools/latest"
  rm -rf "$tmp"
fi
SDKM="$SDK_ROOT/cmdline-tools/latest/bin/sdkmanager --sdk_root=$SDK_ROOT"
yes | $SDKM --licenses >/dev/null 2>&1 || true
$SDKM "platform-tools" >/dev/null
# 플랫폼·빌드 도구·NDK 는 Gradle(AGP)이 라이선스가 수락된 상태에서 필요한 버전을 스스로 내려받는다.
# Maven Central 이 이 환경의 프록시 출구 IP 에 요청 제한(HTTP 429)을 건다 → Google 호스팅 미러로 우회(init 스크립트) + 짧은 재시도.
mkdir -p "$HOME/.gradle/init.d"
cat > "$HOME/.gradle/init.d/central-mirror.gradle" <<'EOP'
// Maven Central(repo.maven.apache.org) → Google 호스팅 미러. 미러에 없는 것(404)은 Gradle 이 다음 저장소(Google·Plugin Portal)에서 찾는다.
def CENTRAL = "https://repo.maven.apache.org/maven2"
def MIRROR = "https://maven-central.storage-download.googleapis.com/maven2/"
def redirect = { handler ->
  handler.all { repo ->
    if (repo instanceof MavenArtifactRepository && repo.url.toString().startsWith(CENTRAL)) {
      repo.setUrl(MIRROR)
    }
  }
}
settingsEvaluated { settings ->
  redirect(settings.pluginManagement.repositories)
  redirect(settings.dependencyResolutionManagement.repositories)
}
allprojects {
  redirect(buildscript.repositories)
  redirect(repositories)
}
EOP
grep -q "repository.max.tentatives" "$HOME/.gradle/gradle.properties" 2>/dev/null || cat >> "$HOME/.gradle/gradle.properties" <<'EOP'
systemProp.org.gradle.internal.repository.max.tentatives=5
systemProp.org.gradle.internal.repository.initial.backoff=2000
org.gradle.parallel=false
EOP
echo "Android SDK 준비됨: $SDK_ROOT (export ANDROID_HOME=$SDK_ROOT)"
