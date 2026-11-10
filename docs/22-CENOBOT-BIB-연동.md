# 22. CENOBOT L4 · BIB J40 연동 (조회 전용)

요청: 포스코와이드 담당 「Wide Bot에 BIB J40 / CENOBOT L4 연동 요청」(2026-11-10), 첨부 프롬프트 0~4단계.
범위: **조회 전용**(상태·작업 이력·장애·소모품·예약·웹훅). 로봇에 명령이 가는 기능(시작/중지/일시정지/복귀/예약 생성·수정·삭제/설정·오디오·지도 변경/즐겨찾기 실행)은 구현하지 않는다.
진행 순서: CENOBOT 먼저(문서 확보, 키 없이 mock 개발) → 키 수령 후 live → BIB 는 문서·키 수령 후 같은 방식.

업체 문서: `docs/vendors/cenobots/openapi_v1.0.18.txt`(CZ Robots Open API V1.0.18, 2026-10-10). BIB 문서는 받는 대로 `docs/vendors/bib/`.

---

## 1. 0단계 — 현황 조사 결과 (코드 수정 전 조사)

### 1-1. 현재 구조 요약
| 항목 | 위치 · 내용 |
|---|---|
| 어댑터 인터페이스 | `src/lib/vendors/adapter.ts` — `sendCommand / fetchStatus / fetchRuns / fetchMaintenance`. 서비스 계층은 `getAdapter(robot)` 만 쓴다 |
| 모드 결정 | `src/lib/vendors/index.ts` `vendorMode()` — `VENDOR_MODE`(전역) + `<VENDOR>_MODE`(제조사별). 결과 `sample / live / unconfigured`. PUDU 는 키·클러스터·허용 매장이 모두 있어야 live. CENOBOTS·BIB 는 항상 `unconfigured`(자리만 있음) |
| 실제 로봇 판별 | `isLiveRobot()` = 모드 live + `vendorMeta.source="api"`. 샘플 적재 로봇은 live 에서도 외부 호출 안 함. 시뮬레이션 틱도 이 함수로 실제 로봇을 뺀다 |
| PUDU 클라이언트 | `src/lib/vendors/pudu/client.ts`(HMAC-SHA1 서명, 통계 API 직렬화, trace_id 의 키 접두사 마스킹), `api.ts`(엔드포인트), `mapping.ts`(상태·결과·장애 매핑), `puduAdapter.ts` |
| 워커 잡 | `src/worker/main.ts` 루프 + `src/worker/pudu.ts`: `PUDU:status`(60s) · `reports`/`errors`/`plan`(10m) · `catalog`(60m) · `events`(5s) · `reports-backfill`/`errors-backfill`(스크립트). 결과는 `vendor_sync_state`(id `PUDU:<job>`) |
| 콜백 | `POST /api/webhooks/pudu`(헤더 CallbackCode 확인) → `vendor_events` 원문 저장(이벤트 키 중복 제거) → 워커 `events` 가 비동기 처리(발생 시각이 기존 상태보다 오래되면 덮지 않음) |
| 공통 모델 | `robots`(관리번호 PK, vendor, vendorRobotId, vendorMeta), `robot_status`, `actual_runs`(중복 키 vendor+vendorRobotId+vendorRunId), `incidents`(vendorEventId 중복 차단, 같은 코드 6시간 묶음), `maintenance_items`·소모품 일별 이력, `registered_tasks`·`schedules`(executor VENDOR=제조사 예약, 읽기 전용)·`planned_runs` |
| 결과 라벨 | `RunResult` 3값: `COMPLETED`(정상 완료) · `INCOMPLETE`(미완료) · `ABORTED`(중단). PUDU 숫자: 4→정상 완료, 6→중단(작업 취소), 3·5→미완료(작업 중단·예외) — `pudu/mapping.ts` `mapReportStatus` |
| 장애 등급 | `severity_overrides`(코드별 등급, 관리 설정 → 장애 등급 설정). 없으면 제조사 등급(PUDU Fatal→긴급, Error→높음, Warning→보통, Event→낮음). 고객 문구는 코드별 상수(`PUDU_ERROR_MESSAGES`, 없으면 일반 문구) |
| 원격 제어 | `issueCommand` — 사용 중지 로봇·사업장 스위치(꺼짐 기본)·권한·지원 명령·상태 전이 순으로 거부, 모든 거부는 감사 기록 |
| 화면 | 고급 설정(`/admin/advanced`) 의 PUDU 카드·동기화 상태표·콜백 목록, 로봇 상세(상태·원격 작업 지시·작업 이력 30건·유지관리·장애), 상단 배너 「실제 연동 중: …」 |
| 환경변수·배포 | 서버 `/opt/robot-system/.env`(비밀값은 여기만), `scripts/remote-env.sh`(S3 presigned 로 .env 키 추가·교체), `scripts/deploy-remote.sh`(git archive → S3 → SSM Run Command → docker compose). 시험: `npx vitest run`(로컬 Postgres), 빌드 `npx next build` |

### 1-2. BIB / CENOBOTS 가 이미 언급된 곳
- 타입: `Vendor = "PUDU" | "CENOBOTS" | "BIB"`, 모델 `L4`(CENOBOTS)·`J40`(BIB) — `src/lib/domain/types.ts`, `commands.ts`(`MODEL_VENDOR`, 명령 의미표)
- 어댑터 스텁: `src/lib/vendors/cenobots/cenobotsAdapter.ts`(모두 UNSUPPORTED), `README.md`(구현 전 메모 — 문서 위치·주의점)
- 샘플 데이터: `src/lib/sample/seed.ts`(가상 L4 로봇, `vc-cenobots` 연결 카드 「미설정」)
- 화면 문구: 배너 「나머지 제조사 로봇은 샘플/미설정입니다」, 로봇 상세의 L4 소모품 안내, 작업 패널의 Favorite 안내
- `.env.example`: `CENOBOTS_API_HOST / ACCESS_KEY / SECRET_KEY / WEBHOOK_SECRET`(이름만)
- 워커 heartbeat `modes` 에 세 제조사 모두 나옴(현재 운영: PUDU live, 나머지 unconfigured)

### 1-3. 장비·사업장 확인
| 장비 | 업체 식별 | Wide Bot 배치(제안) | 관리번호(제안) | 확인 필요 |
|---|---|---|---|---|
| CENOBOT L4 「포스코센터 1호기」 | L4-05590 / SN E260227010A / 지도 POSCO B3F | 포스코센터 · **지하3층** | PW-R-010 | 1호기가 B3F 맞는지(번호 순서와 층 순서가 반대) |
| CENOBOT L4 「포스코센터 2호기 (지하2층 전용)」 | L4-05408 / SN E250918008A / 지도 POSCO B2F | 포스코센터 · **지하2층** | PW-R-011 | — |
| BIB J40 CG_1 (습식) | J40-20-CP-SZ342740-0006 | 포항 플레이그라운드 · 2F(3F 도 운행) | PW-R-012 | 기본 층 2F 로 둠 |
| BIB J40 CG_2 (건식) | J40-23-CP-352935-2584 | 포항 플레이그라운드 · 4F(6F 도 운행) | PW-R-013 | 기본 층 4F 로 둠 |

- 포스코센터는 운영 중인 사업장(1층·2층 PUDU)이다. 지하2층·지하3층을 층으로 추가한다.
- 포항 플레이그라운드는 새 사업장(Asia/Seoul), 층 2F·3F·4F·6F. 주소·설치일은 받으면 고급 설정에서 입력.
- 관리번호는 운영 DB 의 마지막 번호 다음이어야 한다 — 운영 반영 때 실제 마지막 번호를 확인하고, 이미 쓰였으면 다음 빈 번호를 쓴다(스크립트 인자로 바꿀 수 있음).
- 키가 오기 전에는 네 대 모두 **사용 중지** 상태로 등록한다(대시보드 대수·무실적 알림·보고서에 빠짐). CENOBOT 은 번호판(L4-05408 등)으로 등록해 두고, 키를 받으면 `deviceOpenIds` 응답의 번호판으로 deviceOpenId 를 자동 연결한 뒤 다시 사용으로 바꾼다.

### 1-4. 어댑터 인터페이스(초안 → 구현)
기존 `VendorAdapter` 는 그대로 둔다(PUDU 영향 없음). 조회 전용 제조사는 아래를 지킨다.
- `sendCommand` → 항상 `REJECTED`("이 제조사는 조회 전용") — 외부 호출 없음.
- 동기화는 제조사별 워커 모듈(`src/worker/cenobots.ts`)이 직접 API 를 부른다(PUDU 와 같은 패턴). 결과는 `vendor_sync_state` 에 `CENOBOTS:<job>`.
- 모드에 `mock` 추가(CENOBOTS 전용): 업체 응답 형식 그대로의 내부 픽스처로 전체 파이프라인(서명 → 응답 봉투 → 매핑 → DB)을 돈다.

### 1-5. 바꿔야 할 파일(CENOBOTS)
신규: `src/lib/vendors/cenobots/{client,api,mapping,mock,webhook}.ts`, `src/worker/cenobots.ts`, `src/app/api/webhooks/cenobots/route.ts`, `src/components/CenobotsPanel.tsx`, `scripts/cenobots-backfill.ts`, `scripts/register-cenobot-bib.ts`, `tests/cenobots.test.ts`.
수정: `vendors/index.ts`(모드), `cenobotsAdapter.ts`, `worker/main.ts`, `services/commands.ts`(조회 전용 차단), `services/admin.ts`(연결 확인·등록·상태), `services/incidents.ts`(CZ 코드 문구·등급 목록), `app/actions.ts`, `app/admin/advanced/page.tsx`, `app/robots/[robotId]/page.tsx`, `app/layout.tsx`(배너), `.env.example`. PUDU 코드는 공통화가 필요한 두 곳만(동기화 기록 함수의 제조사 인자, 관리번호 발급 — 아래 위험 4).

### 1-6. 위험 요소
1. **mock 데이터가 운영 보고서에 섞일 위험** → 운영(`APP_ENV=production`)에서 mock 은 연결·매핑만 시험하고 DB 에 적재하지 않는다(dry-run). 로컬·개발에서만 적재.
2. **명령 오발송** → 조회 전용 제조사(CENOBOTS·BIB)는 운영 사업장에서 원격 제어 스위치가 켜져 있어도 명령 단계 0 에서 거부·감사 기록. 어댑터도 외부 호출 없이 거부(이중). 지원 명령 목록도 비움(삼중).
3. **서명·시각** → 서명은 `METHOD + timestamp(ms) + path`. 경로에 쿼리 포함 여부는 문서 예제(쿼리 없음)를 따르고 `CENOBOTS_SIGN_WITH_QUERY=true` 로 바꿀 수 있게 한다. 서버 시계가 틀리면 실패 → 오류 문구에 「서버 시계 확인」 힌트.
4. **관리번호 충돌** → PUDU 로봇 가져오기가 「로봇 수+1」 로 번호를 만들어, 중간 번호(PW-R-010~013)를 먼저 쓰면 다음 PUDU 가져오기가 충돌한다 → 「가장 큰 번호+1」 로 바꾼다(PUDU 동작은 같음).
5. **문서 불일치** → mission/list 의 status 설명은 `DONE/STOP/ABEND`, 예제 값은 `success/canceled/error` → 둘 다 매핑. 페이지 번호가 0 또는 1 시작(예제마다 다름) → `CENOBOTS_PAGE_INDEX_BASE`(기본 1) + missionId 중복 제거. `duration`·`cleaningTime` 단위 미표기 → `totalTime`(분) 우선, 없으면 시작·종료 시각 차.
6. **sys-error 목록은 현재 활성 오류만**(발생 시각 없음) → 폴링에서 새로 보인 코드만 장애로 만들고, 같은 코드의 미해결 장애가 있으면 만들지 않는다. 시각은 조회 시각(웹훅을 켜면 웹훅 occurredAt 이 정확).
7. **웹훅 구독 생성은 쓰기 API** → 코드로 만들지 않는다. 화면에 등록할 URL·시크릿 설정 여부·최근 수신·자가 점검만.

### 1-7. 질문·TODO (업체·요청자 확인)
- CENOBOT: 키 발급 리전이 APAC 맞는지(로봇 등록 서버 기준). deviceOpenId 2대. 웹훅용 회사 관리자 권한.
- CENOBOT: `mission/list` 의 pageIndex 시작값, `duration` 단위, `coverage` 형식(“95%” 또는 0.95), 실제 status 값 — 키 수령 후 첫 호출로 확정.
- CENOBOT: sys-error 코드별 등급 기본값(지금은 모두 「높음」, 관리 설정에서 코드별로 바꿀 수 있음).
- CENOBOT: 지도 가져오기(pic-with-points)로 지하층 지도 위에 위치 표시 — 키 수령 후 진행(지금은 위치를 그리지 않고 지도 이름·좌표만 원시값에 남김).
- 포항 플레이그라운드 주소·설치일. PW-R 번호 배정 순서(위 표) 확정.
- BIB: Open API 문서·키·연동 전용 계정, 인증 방식, 부분 성공 값, 층 정보가 작업 이력에 있는지.

---

## 2. 1단계 — CENOBOT 구현 (조회 전용, 2026-11-10)

### 2-1. 구성
| 파일 | 역할 |
|---|---|
| `src/lib/vendors/cenobots/client.ts` | 서명(HMAC-SHA256, METHOD+timestamp+path, 쿼리 제외 기본), 응답 봉투 해석, 직렬화·최소 간격 150ms, 429·5xx·네트워크 지수 백오프 재시도, 쓰기 경로 차단(조회용 POST 는 mission/list·summary 만), 실패 문구에 rid·「서버 시계 확인」 힌트(키 값은 넣지 않음) |
| `api.ts` | 조회 API: deviceOpenIds · device/status · device/info · maintenance-detail · sys-error/list · schedule/list · map · mission/list(페이지 끝까지, missionId 중복 제거) |
| `mapping.ts` | 매핑 표 한 곳: 작업 결과·종료 이유·비정상 세부 원인(한국어)·디바이스 상태·예약 시각/요일·커버리지·소모품·CZ 오류 코드 문구/조치 안내 |
| `mock.ts` | mock 전송 계층: 서명 검사, 문서 형식 그대로의 픽스처(L4-05408·L4-05590 + 허용 밖 L4-09999), 일일 작업·예약·소모품·활성 오류 |
| `cenobotsAdapter.ts` | 어댑터. `sendCommand` 는 외부 호출 없이 항상 거부 |
| `webhook.ts`, `app/api/webhooks/cenobots/route.ts` | AES-256-GCM 복호화(fail closed), 시각 5분, challenge 응답, data.id 중복 제거 저장 후 즉시 200, 위치 이벤트는 저장 안 함 |
| `src/worker/cenobots.ts` | 잡: `CENOBOTS:catalog`(번호판→deviceOpenId 연결·장비 정보·예약·소모품, 60m) · `status`(60s) · `reports`(48시간 창, 10m) · `errors`(활성 오류, 10m) · `plan`(예약→계획 회차, 10m) · `events`(웹훅, 5s) · `reports-backfill`(스크립트). heartbeat modes 에 CENOBOTS 반영 |
| `src/lib/services/cenobotsAdmin.ts`, `components/CenobotsPanel.tsx` | 고급 설정 카드: 모드·호스트·키 설정 여부·허용 장비·등록 로봇·[연결 확인 + 로봇 조회]·[지금 동기화 4종]·등록/연결·웹훅 URL·시크릿 여부·최근 수신·자가 점검 |
| `scripts/register-cenobot-bib.ts` | 사업장·층·로봇 4대 사전 등록(멱등, 사용 중지) |
| `scripts/cenobots-backfill.ts` | 과거 작업 이력 적재(7일 구간, 기본 90일 또는 --from) |

### 2-2. 매핑
| CZ 값 | Wide Bot |
|---|---|
| status DONE · success | 정상 완료 |
| status STOP · canceled | 중단(사용자 취소) — 종료 이유(예: PAD에서 수동 중지)를 함께 저장 |
| status ABEND · error | 미완료(작업 예외) — abendSubReasonEnum 한국어 또는 errDesc 를 사유로 저장(예: 진공 압력이 너무 높음) |
| 그 밖 | 미완료 + 「미분류(status=…)」, 워커 경고 로그 |
| taskSourceTypeEnum APP_TIMING·PAD_TIMING | 계획(PLANNED), 나머지 수시(ADHOC) |
| 소요 시간 | totalTime(분), 없으면 시작~종료 시각 차 |
| 디바이스 상태 | 오프라인 > 비상정지(오류) > 복귀(Homing·Charge·BACK_TO_STATION) > 작업 상태표(일시정지·이상·청소) > 충전 > 대기 |
| sys-error 코드 | 장애 코드 `CZ-<숫자>`, 기본 등급 높음(코드별 등급 설정 가능), 고객 문구 한국어 |
| 웹훅 door call | `CZ-DOOR_CALL` 보통 |
| 예약 | 등록 작업 + 제조사 예약(읽기 전용) → 계획 회차·미실행(±90분) 판정에 그대로 쓰임 |

### 2-3. 안전장치
- **조회 전용 3중 차단**: ① 명령 서비스 0단계에서 CENOBOTS·BIB 로봇은 운영 사업장이면 원격 제어 스위치와 무관하게 거부(감사 `DENIED 조회 전용 제조사`) ② 어댑터 거부 ③ 지원 명령 비움. 클라이언트는 쓰기 경로를 아예 보내지 않음.
- **운영 mock = dry-run**: `APP_ENV=production` + `CENOBOTS_MODE=mock` 이면 픽스처를 조회·매핑만 하고 로봇 연결·실적·장애·상태를 쓰지 않는다(동기화 상태표에 「모의(dry-run)」 결과만).
- **끄기**: `CENOBOTS_MODE=unconfigured` + 재시작 → 워커 잡 중지, 웹훅 503, 화면 버튼 비활성. 코드 롤백 불필요.
- **mock↔live 분리**: mock 으로 연결한 로봇(boundMode=mock)은 live 에서 조회하지 않고, live 첫 장비 동기화가 번호판으로 다시 연결한다.
- **관리번호**: 「가장 큰 번호 + 1」(PUDU 가져오기 포함).
- 위치는 층에 CZ 지도를 가져오기 전까지 그리지 않는다(원시값에 좌표·지도 이름만).

### 2-4. 마이그레이션
없음. 기존 테이블(robots.vendorMeta, actual_runs, incidents, vendor_events, vendor_sync_state, schedules, maintenance_items)만 쓴다. 롤백은 코드 이전 커밋 배포 또는 `CENOBOTS_MODE=unconfigured`. 사전 등록한 사업장·층·로봇은 고급 설정에서 사용 중지/삭제할 수 있다(실적이 없으므로 삭제 가능).

## 3. 3단계 — 점검 결과 (2026-11-10)
| 점검 | 결과 |
|---|---|
| 혼합 집계(대시보드·관제·보고서·장애·작업) | 모든 화면이 공통 테이블(robot_status·actual_runs·incidents)을 제조사 구분 없이 집계 → CZ 로봇도 같은 규칙으로 들어간다. 사용 중지 로봇은 목록·대수·알림·보고서에서 빠짐(사전 등록 4대 영향 없음). 로컬 mock 으로 로봇 상세·작업 이력·장애·소모품 표시 확인 |
| 예정 작업 미실행(±90분) | CZ 예약(schedule/list) → 계획 회차 → 같은 판정 함수(`settlePlannedRuns`, PUDU 와 공용). BIB 는 문서 수령 전이라 예약 없음(계획 회차 없음) |
| 장애 등급 설정 | CZ 코드가 목록에 나오고(본 적 있는 코드 + 기본 문구가 있는 코드) 한국어 고객 문구 기본값이 들어감. 장애 화면 코드 말풍선도 CZ 안내 사용 |
| 명령 차단 | 시험: 원격 제어를 켠 운영 사업장 + 지원 명령을 억지로 넣은 CZ 로봇 → 4종 명령 모두 거부, 명령 기록 0건, 감사 DENIED 4건, 업체 호출 0건 |
| 비밀값 | grep: 로그·감사·오류 문구에 키·시크릿 값이 들어가는 경로 없음(변수 이름만). 실패 문구는 HTTP·code·info·rid 만 |
| PUDU | 기존 시험 전부 통과(전체 134개, 이번 추가 17개). PUDU 코드 변경은 동기화 기록 함수의 제조사 인자·장애 적재 함수의 선택 인자·계획 회차 함수 분리·관리번호 발급뿐(동작 동일) |

## 4. 4단계 — 운영 반영 절차
명령은 모두 이 저장소의 스크립트로 실행한다(SSH 없음, AWS Systems Manager). 사전 조건: `aws login`(12시간).

1. **현재 구조**: 서버 `/opt/robot-system`(docker compose: caddy·web·worker·db), 비밀값은 `/opt/robot-system/.env`(PUDU 키와 같은 곳), Caddy 는 `/api/*` 를 그대로 web 으로 넘긴다.
2. **백업**: `./scripts/remote-run.sh` 로 `pg_dump` → `/opt/robot-system/backups/pre-cenobots-<시각>.sql.gz`, 현재 커밋 기록.
3. **환경변수**(`scripts/remote-env.sh`, 값은 S3 presigned 로만 전달): 처음엔 `CENOBOTS_MODE=mock`, `CENOBOTS_HOST=https://app-server-apac.cz-robots.com`, `CENOBOTS_ALLOWED_DEVICE_OPEN_IDS=L4-05408,L4-05590`. 키·웹훅 시크릿은 받으면 추가.
4. **네트워크**: 서버에서 `curl https://app-server-apac.cz-robots.com/...` 가 응답(서명 없으므로 401 등 업무 오류가 정상). 웹훅: `curl -X POST https://widebot.kro.kr/api/webhooks/cenobots` 가 리다이렉트 없이 앱 응답(시크릿 전 503).
5. **시계**: `timedatectl`(NTP synchronized: yes)·`chronyc tracking`.
6. **배포**: `./scripts/deploy-remote.sh` → 헬스·heartbeat modes 에 `CENOBOTS: mock` → 등록 스크립트 → 고급 설정에서 [연결 확인] 이 「[모의]」 2대.
7. **키 수령 후(live)**: `.env` 에 `CENOBOTS_ACCESS_KEY`·`CENOBOTS_SECRET_KEY` 추가, `CENOBOTS_MODE=live`, 재시작 → [연결 확인 + 로봇 조회](실제 2대, deviceOpenId 표시) → [지금 동기화: 장비·예약·소모품](번호판으로 PW-R 연결) → 고급 설정에서 두 로봇 「다시 사용」 → 상태·작업 이력 확인 → `cenobots-backfill.ts --from <설치일>` → 하루 모니터링(동기화 상태표 오류 없음, 실적 수·결과가 업체 콘솔과 일치, 장애·소모품 값).
8. **웹훅(선택)**: 업체 콘솔에서 URL `https://widebot.kro.kr/api/webhooks/cenobots` 로 구독 생성 → 시크릿을 `.env` 에 → 재시작 → [자가 점검] 통과 → 업체 콘솔에서 verify → ACTIVE.
9. **롤백**: `.env` 의 `CENOBOTS_MODE=unconfigured` → `docker compose up -d web worker`. 코드 롤백 불필요. 로봇은 고급 설정에서 「사용 중지」.
10. **원격 제어**: 바꾸지 않는다(포스코센터 스위치는 PUDU 용 그대로, CZ 로봇은 코드에서 항상 차단).
