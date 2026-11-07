# 와이드봇 관제 — 모바일 앱(Expo / React Native, TypeScript)

웹(`../src`)과 같은 서버의 `/api/app` 을 쓰는 현장용 앱. 설계·결정·절차는 `../docs/21-안드로이드-앱-설계.md`.

## 구조
- `src/app/` 화면(Expo Router, 파일 = 화면). `(tabs)/` 홈·사업장·장애·보고서·내 계정, `sites/[siteId]` 지도, `robots/[robotId]` 상세·명령, `incidents/[incidentId]` 조치, `reports/[reportId]`, `notifications` 알림함, `login`.
- `src/lib/` api(Bearer 호출)·auth(토큰 암호 저장)·push(FCM 등록·딥링크)·useFetch(화면 갱신)·format·config.
- `src/components/` 공용 UI. 상태·명령·등급 라벨은 서버의 `src/lib/domain/*` 를 **그대로 import** 한다(metro.config.js watchFolders).
- `google-services.json` Firebase 안드로이드 앱 설정(비밀값 아님). 서버용 서비스 계정 키는 서버 `.env` 에만.
- `android/`, `ios/` 는 생성물(커밋 안 함). 네이티브 설정은 `app.json` 과 config plugin 으로만 바꾼다.

## 명령
```bash
npm install
npx tsc --noEmit && npx expo lint      # 검사
./scripts/setup-android-sdk.sh        # 처음 한 번(컨테이너)
./scripts/build-apk.sh                # 시험용 APK → dist/
```
서버 주소는 `app.json` `extra.apiBaseUrl`(운영). 로그인 화면 아래 "서버" 를 눌러 시험 서버로 바꿀 수 있다.

## 지키는 것
- 비밀값(토큰·키)을 로그·화면·저장소에 남기지 않는다. 토큰은 `expo-secure-store` 에만.
- 명령은 확인 대화상자 → 멱등 키 → 서버 판정. HTTP 접수를 완료로 표시하지 않는다.
- 고객 계정에 보이는 것은 서버가 걸러서 준 것만 보여 준다. 앱에서 따로 숨기지 않는다(숨기는 것으로 권한을 대신하지 않는다).
