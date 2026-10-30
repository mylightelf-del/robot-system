# 청소로봇 통합관제 시스템

포스코와이드의 여러 사업장 청소로봇(PUDU MT1·CC1·BG1, CenoBots L4)을 본사·현장·고객사가 권한별로 관리하는 웹 시스템입니다.
**2026-10-29 운영 배포 완료: https://widebot.kro.kr (AWS Lightsail 시드니, `docs/09` 7장).** 현재 **3단계(PUDU 연동)·운영 준비** 까지 구현: 7개 화면(1단계) + PostgreSQL 영속 저장 · 로그인(초대 링크) · 서버 세션 · 사업장별 인가 · 감사 이력 · 백그라운드 워커 · Docker 배포 구성(2단계) + **PUDU Cloud API 연동**(서명 인증, 상태·보고서·장애·작업·예약·소모품 동기화, 명령 전송, 콜백 수신, 관리 화면 연결·로봇 등록).

> PUDU 연동은 모의 서버 시험 후 **실서버에 읽기 전용으로 확인**해 응답 차이를 반영했습니다(상태·보고서·장애·작업·예약·소모품 적재 확인). 실제 로봇에 **명령은 아직 보내지 않았습니다**(`docs/07` 3-3·4장). 키를 서버 `.env` 에 넣고 `VENDOR_MODE=live`(또는 `PUDU_MODE=live`)로 켜면 PUDU API 에서 등록한 로봇만 실제로 동작하고, 샘플 적재 로봇은 계속 시뮬레이션으로 남습니다. CenoBots 는 아직 샘플입니다. `VENDOR_MODE=sample`(기본) 에서는 가상 사업장 5곳·로봇 20대 샘플과 시뮬레이션 어댑터가 동작하며, 화면 상단에 표시됩니다.

## 문서
| 문서 | 내용 |
|---|---|
| `docs/HANDOFF.md` | 인수인계 기준 문서(요구사항·제조사 문서 검토·단계 계획) |
| `docs/01-요구사항-정리.md` | 요구사항 이해, 구현 구조, 확정 사항, 미확인 사항 |
| `docs/02-1단계-시제품-보고.md` | 1단계 구현·테스트 보고 |
| `docs/03-2단계-기술선택.md` | DB 비교(PostgreSQL 선택), 클라우드 비교·무료 플랜 검토, 호스팅 결정(AWS Lightsail + Cloudflare) |
| `docs/04-2단계-기반-보고.md` | 2단계 구현·테스트 보고, 완료/미완료, 다음 단계 |
| `docs/05-배포-운영-가이드.md` | Lightsail 설치, Cloudflare, 백업·복구, 감시, 키 교체, PUDU 연동 켜기 |
| `docs/06-PUDU-API-검토.md` | PUDU Cloud API 공식 문서 검토: 인증·클러스터·endpoint·상태 코드·콜백, 설계 결정, 실기 검증 체크리스트 |
| `docs/07-PUDU-연동-보고.md` | PUDU 연동 구현·시험 보고(모의 서버·실서버·명령 실기), 미확인 항목 |
| `docs/08-운영준비-보고.md` | 사업장·층 관리, PUDU 지도 가져오기·로봇 위치 변환, 장애 묶음, 지도 이미지 보관, 콜백 등록 준비 |
| `docs/09-배포전-점검.md` | 배포 전 점검(preflight)·워커 하트비트·보관 정책·배포 당일 체크리스트·서버 생성·배포 완료 기록 |
| `docs/10-세션-인계.md` | **새 세션 시작점**: 현재 상태, 비밀값·접근 수단이 있는 곳, 서버 작업 명령, 남은 일 |
| `src/lib/vendors/cenobots/README.md` | CenoBots 어댑터 구현 전 메모 |

## 로컬 실행
요구사항: Node.js 22, PostgreSQL 16(또는 Docker).

```bash
npm install
cp .env.example .env.local        # DATABASE_URL 등을 로컬에 맞게
npm run db:migrate                # 스키마 적용
npm run db:seed                   # 샘플 데이터 + 샘플 사용자(비밀번호: .env 의 SAMPLE_USER_PASSWORD, 기본 sample1234!)
npm run dev                       # 웹: http://localhost:3000
npm run worker                    # 별도 터미널: 워커(시뮬레이션·세션 정리)
```
PostgreSQL 이 없다면 `.env` 에 `POSTGRES_PASSWORD` 를 넣고 `docker compose up -d db` 로 DB 만 띄운 뒤 `DATABASE_URL=postgresql://robot:<비밀번호>@127.0.0.1:5432/robot_control` 로 접속합니다(compose 의 db 포트를 외부로 열려면 `ports` 를 추가).

| 샘플 계정(이메일) | 역할 | 범위 |
|---|---|---|
| hq-admin@example.invalid | 본사 관리자 | 전체 사업장, 관리 설정, 보고서 확정 |
| site-a@example.invalid | 현장 담당자 | 가상 사업장 1·2 |
| site-b@example.invalid | 현장 담당자 | 가상 사업장 3·4·5 |
| customer1@example.invalid | 고객 기본 | 가상 사업장 1 조회만 |
| customer2@example.invalid | 고객 제어 | 가상 사업장 2, 실행·일시정지·재개·중단만 |
| former@example.invalid | 비활성 | 로그인 차단 |

## 검증
```bash
npm run typecheck
npm run lint
npm test            # vitest, 실제 PostgreSQL(DATABASE_URL_TEST) 사용 — 64건(PUDU 모의 서버 포함)
npm run preflight   # 배포 전 점검: 환경변수 규칙·DB·마이그레이션·관리자·워커 (오류면 종료 코드 1)
npm run build       # standalone 빌드
```
브라우저 자동 조작(선택, Playwright 필요): 웹·워커 실행 중에
```bash
npm i -D playwright && npx playwright install chromium
BASE_URL=http://localhost:3000 node scripts/e2e-flows.js     # 로그인·명령·장애·보고서·초대·권한 흐름 22항목
BASE_URL=http://localhost:3000 node scripts/screenshots.js   # 화면 스크린샷 → docs/screenshots/
```
PUDU 키 발급 후 첫 확인(DB 를 건드리지 않음, 비밀값 출력 없음):
```bash
npm run pudu:check                      # Health Check → 허용 매장(PUDU_SHOP_IDS)별 로봇 목록(product_code → 모델)
npm run pudu:check -- --shops 포스코    # 매장 이름으로 shop_id 찾기(PUDU_SHOP_IDS 에 넣을 값)
npm run pudu:check -- <SN>              # 해당 로봇의 상태·소모품·등록 작업·예약
VENDOR_MODE=live npm run pudu:command-test -- <관리번호> <등록작업ID> --yes   # 실제 로봇 명령 시험(충전 중일 때만 시작, 실패 시 자동 복귀)
```

## 운영 배포 (요약)
`docs/05-배포-운영-가이드.md` 참고. Lightsail 서버에서:
```bash
cp .env.example .env   # APP_ENV=production, DOMAIN, POSTGRES_PASSWORD, ALLOW_SAMPLE_RESET=false
docker compose up -d --build   # migrate → preflight 통과 후 web/worker 기동
docker compose run --rm worker npx tsx scripts/bootstrap-admin.ts "이름" admin@company.example   # 첫 관리자 초대 링크
```

## 환경변수
`.env.example` 참고. 제조사 API 키·DB 비밀번호는 서버의 `.env` 에만 두고 저장소·대화에 붙여 넣지 않습니다.
PUDU: `PUDU_API_CLUSTER`(한국 계정은 `sea`) · `PUDU_API_APP_KEY` · `PUDU_API_APP_SECRET` · **`PUDU_SHOP_IDS`**(허용 매장 shop_id, 콤마 구분 — 대리점 키는 다른 고객사 로봇까지 보이므로 필수) · `PUDU_CALLBACK_CODE`(콜백 URL `https://<도메인>/api/webhooks/pudu` 등록 시 발급) · 폴링 주기(`PUDU_POLL_*`).

## 단계 계획 (인수인계 문서 9장)
원래 순서는 3·4단계 CenoBots → 6단계 PUDU 였으나, 사용자 결정으로 **PUDU 를 먼저** 연동했다.
1. 시제품 ✅  2. 기반 ✅  3. PUDU 읽기·제어·콜백 ✅  4. PUDU 실기 검증(읽기 ✅ · 명령 ✅ CC1Pro 1대 · 지도 ✅ · 콜백 등록 대기)  4-1. 운영 준비(사업장·층·지도 관리, 지도 이미지 보관, 장애 묶음, 콜백 등록 준비, 배포 전 점검) ✅  4-2. 서버 배포(Lightsail 시드니 + Caddy HTTPS, SSM 원격 배포) ✅ — 콜백 등록은 대리점 요청 대기  5. CenoBots 읽기·제어  6. 이벤트·알림·보고서 고도화 · 시범 운영 (BIB 는 후속)
