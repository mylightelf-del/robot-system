# 청소로봇 통합관제 시스템

포스코와이드의 여러 사업장 청소로봇(PUDU MT1·CC1·BG1, CenoBots L4)을 본사·현장·고객사가 권한별로 관리하는 웹 시스템입니다.
현재 **2단계(기반)** 까지 구현: 7개 화면(1단계) + PostgreSQL 영속 저장 · 이메일/비밀번호 로그인(초대 링크) · 서버 세션 · 사업장별 인가 · 감사 이력 · 백그라운드 워커 · Docker 배포 구성.

> 제조사 실제 연동은 아직 없습니다(3단계~). `VENDOR_MODE=sample` 에서는 가상 사업장 5곳·로봇 20대 샘플과 시뮬레이션 어댑터가 동작하며, 화면 상단에 표시됩니다.

## 문서
| 문서 | 내용 |
|---|---|
| `docs/HANDOFF.md` | 인수인계 기준 문서(요구사항·제조사 문서 검토·단계 계획) |
| `docs/01-요구사항-정리.md` | 요구사항 이해, 구현 구조, 확정 사항, 미확인 사항 |
| `docs/02-1단계-시제품-보고.md` | 1단계 구현·테스트 보고 |
| `docs/03-2단계-기술선택.md` | DB 비교(PostgreSQL 선택), 클라우드 비교·무료 플랜 검토, 호스팅 결정(AWS Lightsail + Cloudflare) |
| `docs/04-2단계-기반-보고.md` | 2단계 구현·테스트 보고, 완료/미완료, 다음 단계 |
| `docs/05-배포-운영-가이드.md` | Lightsail 설치, Cloudflare, 백업·복구, 감시, 키 교체 |
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
npm test            # vitest, 실제 PostgreSQL(DATABASE_URL_TEST) 사용 — 38건
npm run build       # standalone 빌드
```
브라우저 자동 조작(선택, Playwright 필요): 웹·워커 실행 중에
```bash
npm i -D playwright && npx playwright install chromium
BASE_URL=http://localhost:3000 node scripts/e2e-flows.js     # 로그인·명령·장애·보고서·초대·권한 흐름 22항목
BASE_URL=http://localhost:3000 node scripts/screenshots.js   # 화면 스크린샷 → docs/screenshots/
```

## 운영 배포 (요약)
`docs/05-배포-운영-가이드.md` 참고. Lightsail 서버에서:
```bash
cp .env.example .env   # APP_ENV=production, DOMAIN, POSTGRES_PASSWORD, ALLOW_SAMPLE_RESET=false
docker compose up -d --build
docker compose run --rm worker npx tsx scripts/bootstrap-admin.ts "이름" admin@company.example   # 첫 관리자 초대 링크
```

## 환경변수
`.env.example` 참고. 제조사 API 키·DB 비밀번호는 서버의 `.env` 에만 두고 저장소·대화에 붙여 넣지 않습니다.

## 단계 계획 (인수인계 문서 9장)
1. 시제품 ✅  2. 기반 ✅  3. CenoBots 읽기  4. CenoBots 제어  5. 이벤트·알림·보고서  6. PUDU 확장·시범 운영 (BIB 는 후속)
