# 06. PUDU Cloud API 검토 — 청소로봇(CC1·MT1 계열) 연동 전

검토일: 2026-10-28 · 출처: PUDU 개방 플랫폼 공식 문서(https://open.pudutech.com/en/cloud-api, 문서 API 로 각 글 원문 확인) 와 PUDU 공식 GitHub `pudu-robotics/skills` 의 OpenAPI 명세(JSON)
원칙: 아래 내용은 **문서 기준**이며 실제 계정·실기에서 검증 전이다. 구현은 문서에 있는 경로·필드만 사용하고, 추측한 항목은 "미확인"으로 표시했다.

## 1. 접근 조건
- **ApiAppKey / ApiAppSecret** 발급: PUDU 대리점(Distributor) 또는 자영 가맹점(Self-operated merchant) 플랫폼에서 신청 → PUDU 지역 기술지원 책임자 승인. 개인은 공식 연락처로 문의.
- 콜백 수신: 신청 시 **Callback URL** 을 등록하면 PUDU 가 **CallbackCode**(32바이트 비밀 문자열)를 발급. 기본은 알림 미발송이며 신청·설정 후 수신 가능.
- 호출 전 **Health Check** 로 인증 확인(`/data-open-platform-service/v1/api/healthCheck`, 인증 가이드 예제 경로).
- → 포스코와이드가 PUDU 대리점/가맹점 계정을 보유하는지, 아니면 구매처(대리점)를 통해 신청해야 하는지 **확인 필요**.

## 2. 서버 주소(클러스터)와 인증
| 클러스터 | 지역 | 고정 도메인 |
|---|---|---|
| cn | 중국 | https://open-platform.pudutech.com/pudu-entry |
| **sea** | **해외(일본·한국·싱가포르)** | https://css-open-platform.pudutech.com/pudu-entry |
| de | 독일 | https://csg-open-platform.pudutech.com/pudu-entry |
| us | 미국 | https://csu-open-platform.pudutech.com/pudu-entry |
- 한국 계정은 문서상 `sea` 가 해당하지만 **실제 발급 계정의 클러스터를 확인한 뒤 환경변수로 지정**한다(기본값 없음, 공식 스킬도 임의 기본값 금지).
- 테스트 환경 도메인(`open-platform-test.pudutech.com`)이 예제 주석에 있으나 접근 조건은 미확인.
- 인증: 요청마다 **HMAC-SHA1 서명**.
  - 헤더: `Accept: application/json`, `Content-Type: application/json`, `x-date: <RFC1123 GMT>`, `Content-MD5`(POST: body 의 md5 hex → base64), `Authorization: hmac id="<ApiAppKey>", algorithm="hmac-sha1", headers="x-date", signature="<base64>"`
  - 서명 문자열: `x-date: {date}\n{METHOD}\n{Accept}\n{Content-Type}\n{Content-MD5}\n{path?sortedQuery}` — 쿼리는 키 사전순 정렬, 배열은 쉼표 연결, 값은 URL 디코딩된 형태, `/release|/test|/prepub` 접두사는 서명 경로에서 제거.
  - x-date 유효 기간 기본 900초. 지원 알고리즘 hmac-sha1/256/384/512(예제는 sha1).
  - 응답: HTTP 200 + `message == "SUCCESS"`(일부 통계 API 는 `"ok"`) 가 성공. `trace_id` 는 추적 ID 로 감사 기록에 보관.

## 3. 지원 모델 (문서의 모델 카테고리)
청소 전용 API 의 Supported Models: **CC1, CC1 Pro, MT1, MT1 Vac, MT1 Max**. 제품 코드(product_code): `CC1`, `CC1Pro`, `MT1`, `MT1Vac`, `MT1Max`, (`PuduSH1` 등).
- **BG1**: 문서에 모델 카테고리·제품 코드가 없다. CleanCommands 의 `clean_mode` 설명에 "BG1 1.1.0" 이 한 번 언급될 뿐이다. → **BG1 의 Cloud API 지원 여부는 미확인**. 실제 SN 으로 로봇 목록·상태 조회를 시험해 product_code 를 확인해야 한다.
- 인수인계 문서의 "BG1·CC1 을 유사 모델과 혼동하지 않는다" 원칙에 따라, 로봇 등록 시 PUDU 가 보고하는 product_code 를 그대로 저장하고 사람이 모델을 지정하지 않는다.

## 4. 사용할 API (문서 확인 완료)
| 용도 | Method · Path | 핵심 파라미터 | 핵심 응답 |
|---|---|---|---|
| 인증 확인 | GET `/data-open-platform-service/v1/api/healthCheck` | — | 200 |
| 매장(사업장) 목록 | GET `/data-open-platform-service/v1/api/shop` | limit, offset | shop list |
| 로봇 목록 | GET `/data-open-platform-service/v1/api/robot` | limit, offset, shop_id, product_code[] | sn, mac, shop_id, shop_name, product_code, nickname |
| 공통 상태 V2 | GET `/open-platform-service/v2/status/get_by_sn` | sn | run_state(OFFLINE/DISABLE/BUSY/IDLE), battery, is_charging, timestamp |
| **청소로봇 상세** | GET `/cleanbot-service/v1/api/open/robot/detail` | sn | battery, map{name,lv,floor}, position{x,y,z}, cleanbot{task(상태코드), rising(청수), sewage(오수), clean{report_id, result{status,percentage,area,time,cost_water…}, task{task_id,version,name}}}, last_task_start/end |
| **등록 작업 목록** | GET `/cleanbot-service/v1/api/open/task/list` | sn 또는 shop_id, mode[], product[] | task_id, version, name, config{mode(1 washing/2 sweeping)…}, floor_list, pre_clean_time |
| **예약 목록** | GET `/cleanbot-service/v1/api/open/cron/list` | sn, limit, offset | cron_id, hour, minute, weeks(1=월…7=일), cron_status(open/close), task_list |
| **명령** | POST `/cleanbot-service/v1/api/open/task/exec` | sn, type(1 충전, 3 청소, 4 보급, 5 원클릭 복귀, 6 복귀점, 9 지도 전환, 10 예약 on/off), clean{status(1 시작, 3 일시정지, 4 취소(먼저 일시정지)), task_id, version, point_id, map_name, cron_id} | data.task_id |
| 소모품 | GET `/cleanbot-service/v1/api/open/component/list` | sn | type, name, cost_time, life_time |
| **청소 보고서 목록** | GET `/data-board/v1/log/clean_task/query_list` | start_time, end_time(초), shop_id, timezone_offset, limit(≤20), offset | report_id, sn, task_name, mode, start/end_time, clean_time(초), clean_area(㎡), status |
| 청소 보고서 상세 | GET `/data-board/v1/log/clean_task/query` | sn, report_id, start/end_time | + task_id, task_version, cost_water(**ml**), cost_battery(%), break_count, floor_list(JSON 문자열), status(0~6) |
| 장애·이벤트 로그 | GET `/data-board/v1/log/error/query_list` | start/end_time, shop_id, error_levels(Fatal/Error/Warning/Event), limit, offset | id, sn, product_code, error_level, error_type, error_detail, error_id, task_time |
| 현재 지도 | GET `/map-service/v1/open/current` | sn | name, floor, elements |

주의(문서 명시):
- 통계/로그 API(`/data-board/...`)는 업로드 후 **약 10분 지연**, 최근 **180일**만 조회, 한 번에 **7일 이하** 권장, 페이지 limit 1~20, **동일 카테고리 동시 호출 1건·전체 3건 제한**(초과 시 거부).
- `timezone_offset` 기본값이 글마다 다르게 적혀 있다(UTC+8 또는 UTC+0). 구현은 항상 명시(한국 9)하고 실기에서 경계를 확인한다.
- 청소 보고서의 `cost_water` 단위는 **ml**(상세 글), 면적은 ㎡. 상태 0 미시작, 1 청소 중, 2 일시정지, 3 중단, 4 종료, 5 예외, 6 취소.
- `v1/status/get_by_sn` 은 deprecated → V2 사용. `/open-platform-service/v2/recharge`, `cancel_task`, `task/state/get` 은 배송/Flashbot 계열 전용이라 청소로봇에 쓰지 않는다.
- **임시 영역 지정 청소 API 는 없다.** 청소는 로봇/앱에서 만든 등록 작업(task_id+version)을 실행하는 방식. → 우리 시스템의 "영역 청소" 명령은 PUDU 에서 미지원으로 표시.
- STOP(취소)은 "먼저 일시정지" 조건이 있다. 어댑터는 청소 중이면 일시정지 → 취소 순으로 보낸다(실기 검증 필요).

## 5. 청소로봇 상태 코드 → 공통 상태 매핑(안)
| PUDU `cleanbot.task` | 공통 상태 |
|---|---|
| -100 Error | ERROR |
| -200 LostLocalization, -300 Notice | ERROR(위치 이상) / IDLE+경고(Notice) |
| 300~315 Vacuum* (302 Vacuuming, 304 VacuumWay 등) | CLEANING |
| 301 VacuumPause, 402 ReturnPause, 101 GotoPilePause, 502 DockPilePause | PAUSED |
| 100~107 GotoPile*, 400~406 Return*, 500~505 DockPile* | RETURNING |
| 201 ChargingLine, 202 ChargingPile, 203 WaterSupply | CHARGING |
| 305~310 Finishing*(물 회수), 410/411, 600~604, 7xx(수동·OTA·매핑) | IDLE(원시 상태 보존, 화면에 설명 표시) |
| run_state OFFLINE(V2) / robotStatus offline 콜백 | OFFLINE |
| 값 없음·수신 실패 | UNKNOWN |
원시 코드·설명은 raw_payload 와 `raw` 열에 그대로 보관한다. 매핑은 실기에서 코드별로 재확인한다.

## 6. 콜백(Webhook)
- 등록된 Callback URL 로 `POST`, 헤더 `Content-Type: application/json`, `TraceId`, **`CallbackCode`**(발급받은 32바이트 비밀 → 우리 서버가 저장한 값과 비교해 위조 차단). 본문 `{ callback_type, data }`. 5초 안에 200 응답, 실패 시 최대 3회 재시도 → **중복 수신 전제**.
- 청소로봇에 유효한 콜백:
  - `notifyCleanStatus`(CleanTaskStatus): task_id, task_name, status(BEGIN/END/INTERRUP/CANCEL/START_FAILED/LONG_TERM_USED_*/GO_MAINTENANCE/ARRIVE_MAINTENANCE/WEATHER_*), task_time(초), remark, sn, timestamp, notify_timestamp(ms)
  - `TASK_STATUS`(CleanCronStatus, 예약 작업): task_id, task_name, status(BEGIN/INTERRUP/END/START_FAILED), task_time, remark, sn
  - `notifyRobotStatus`(RobotWorkStatus, ALL): battery, is_charging, run_state, notify_timestamp
  - `robotStatus`(OnlineOffline, ALL): run_status online/offline(끊김 감지는 3~5분 지연)
  - `robotErrorNotice`(실시간 장애, CC1·MT1 계열 포함): error_type(CleanWaterEmpty, CleanSewageFull, CleanAgentEmpty, TrashFull, LostLocalization, LowBatteryLevel, EmergencyStop, PlanFailOverTime …), error_level(Fatal/Error), error_detail, error_id, extend_info{map_name, floor, battery, position}
  - `robotErrorWarning`(10분 지연 집계, ALL): error_type, error_level(Fatal/Error/Warning/Event), error_id
  - `notifyRobotPose` 는 배송 계열 전용(청소로봇 미지원) → 위치는 상세 조회(polling)로 받는다.
- 콜백에는 서명이 없고 CallbackCode 만 있다. HTTPS + CallbackCode 비교 + 중복 제거(callback_type+sn+notify_timestamp/timestamp)로 처리한다.

## 7. 우리 시스템 설계 결정
1. **읽기(폴링)**: 워커가 로봇별 상세(`robot/detail`)를 주기 조회(기본 60초, 설정값)해 상태·위치·배터리·청수/오수·진행률을 갱신. 보고서·장애 로그는 10분 주기로 최근 2일 창을 조회해 중복 키(제조사+SN+report_id / error id)로 적재. 등록 작업·예약·소모품은 1시간 주기로 동기화.
2. **콜백**: `POST /api/webhooks/pudu` — CallbackCode 검증 → `vendor_events` 테이블에 원문 저장 → 즉시 200 → 워커가 비동기 처리(중복·역순 방어). 콜백만으로 누락 복구를 보장하지 않고 폴링과 대조.
3. **명령**: START_TASK→type 3/status 1(+task_id, version), PAUSE→type 3/status 3, RESUME→type 3/status 1, STOP→(청소 중이면 3 후) 4, GO_HOME→type 5/status 1. AREA_CLEAN 미지원. 접수(HTTP SUCCESS) 후 상세 조회/콜백으로 실행 확인 → 완료.
4. **예약 실행 주체**: PUDU 자체 예약(cron)을 단일 실행 주체로 두고 우리 시스템은 읽기 전용으로 표시한다(on/off 는 type 10 으로 가능하나 1차에서는 미사용).
5. **모델**: product_code 그대로 저장(`CC1`,`CC1Pro`,`MT1`,`MT1Vac`,`MT1Max`), BG1 은 조회 결과로 확인.
6. **실제/샘플 분리**: PUDU API 에서 등록한 로봇만 `vendorMeta.source="api"` 로 표시하고 실제 API 로 조회·명령한다. 샘플 적재 로봇은 live 모드에서도 시뮬레이션으로 남는다.
7. 시험 전까지 `PUDU_MODE=sample` 로 시뮬레이션 유지. 실제 연결은 `.env` 의 키·클러스터 입력 후 `scripts/pudu-check.ts` 로 Health Check → 매장·로봇 목록 → 상태 조회 순으로 확인.

구현·시험 결과는 `docs/07-PUDU-연동-보고.md` 에 있다.

## 8. 실기 검증 체크리스트 (키 발급 후)
- [ ] Health Check 200 (클러스터 확인)
- [ ] 매장·로봇 목록에서 보유 로봇 SN 과 product_code 확인(BG1 포함 여부)
- [ ] `robot/detail` 응답의 position 좌표계·단위, map name/floor 와 우리 층 매핑
- [ ] 청소 보고서 clean_area·clean_time·cost_water 값이 본체 보고서와 일치하는지
- [ ] 콜백 수신(CallbackCode, 재시도 중복, 순서)
- [ ] 명령 시험(지정 로봇·시간): 시작→일시정지→재개→취소→복귀, 접수 후 상세 조회로 실행 확인까지 걸리는 시간
- [ ] 동시 호출 제한(통계 API 1건)에 맞춘 폴링 주기 확정

## 9. 실기 확인 결과 (2026-10-28, 발급 키로 읽기 전용 호출)

사용자가 전달한 ApiAppKey/ApiAppSecret 으로 `sea` 클러스터(css-open-platform.pudutech.com)에 접속해 **읽기 API 만** 호출했다. 명령(exec)은 보내지 않았다. 문서와 다른 점은 모두 코드에 반영했다(괄호 안이 반영 위치).

| 항목 | 문서 | 실제 응답 | 반영 |
|---|---|---|---|
| 인증 | HMAC-SHA1 | 첫 호출부터 통과. 클러스터는 `sea` 가 맞음 | - |
| 키의 범위 | (언급 없음) | **대리점(VD ROBOTICS) 전체 키** — 매장 4,154곳, 로봇 6,724대(다른 고객사 포함)가 보임 | 허용 매장 `PUDU_SHOP_IDS` 없이는 live 로 켜지지 않음. 조회·등록·동기화 모두 허용 매장 안에서만(`vendors/index.ts`, `services/admin.ts`, `worker/pudu.ts`) |
| 성공 message | `SUCCESS` | 대부분 `SUCCESS`, 기초 API 는 `success`, healthCheck 는 `GetHealthCheck Success！request={}` | `/success/i` 로 판정(`client.ts`) |
| 매장 목록 필드 | `id`, `name` | `shop_id`(문자열), `shop_name`, `company_id`, `company_name` | 타입·스크립트 수정(`api.ts`, `pudu-check.ts`) |
| 로봇 목록 | - | `shop_id` 문자열(미배정은 `"0"`), `first_active_time` 있음. **`shop_id` 로 걸러짐** | 매장별 조회 |
| 값 없는 쿼리 키 | 빈 값은 키만 | 키만 보내면(`product_code`) 빈 값 필터로 해석돼 0건 | undefined 는 아예 보내지 않음(`signing.ts buildQuery`) |
| 보고서·장애 로그 필터 | `sn` 가능 | **`sn`·`mac` 무시**(전체 로봇 보고서 6,749건/장애 65만 건이 나옴), **`shop_id` 로만 걸러짐** | 허용 매장별 조회 후 등록 로봇 SN 만 적재(`worker/pudu.ts`, `puduAdapter.fetchRuns`) |
| task/list | `sn` | **`product` 필수**(없으면 `PARAM_ERROR`). 값은 소모품/예약 응답의 `product` 와 같고 대소문자 무관: CC1→`cc1`(또는 `cleanbot`), CC1Pro→`cc1Pro`, MT1→`mt1`, **MT1Vac→`mt1Pro`**, MT1Max→`mt1Max` | 등록 시 소모품 응답의 product 를 `vendorMeta.product` 에 저장, 없으면 표(`mapping.productParamFor`) |
| task/list 결과 | - | 일부 로봇은 비어 있고 예약(cron)의 `task_list` 에만 작업이 있음 | 예약 항목으로도 등록 작업 생성 |
| error_level | `Fatal/Error/Warning/Event` | 대문자 `ERROR`, `WARNING` | 대소문자 무시 |
| statusV2.timestamp | 숫자 | 문자열 `"1793208176"` | `Number()` |
| 상세 응답 | - | `online`(boolean), `last_task_start/end`(ms), `cleanbot.clean.result` 에 `percentage/remaining_time/cost_water/cost_battery/task_area` 포함, `detail` 문구는 Language 헤더대로 한국어("위치를 잃어버렸습니다") | `online=false` 도 오프라인으로 판정 |
| product_code | 표의 5종 | `BG1`, `BG1Pro` 존재(각 1대, 매장 미배정), `PuduSH1`(476대) 도 있음 | `BG1_PRO` 모델 추가. SH1 은 범위 밖(보류) |
| 상태 코드 | - | 충전 중 `202`, 대기 `0`, 오프라인 로봇은 `-200`·`400` 등 마지막 값이 남음 | 오프라인 우선 규칙으로 처리 |
| 위치 | 단위 미기재 | 미터로 보임(1,229㎡ 층에서 x≈-68, y≈-34) | 샘플 지도와의 매핑은 미해결(10장) |
| 소모품 | - | CC1Pro 5종, MT1 6종(한국어 이름), `cost_time/life_time` 초 | 잔여 % = 1 - cost/life |
| 장애 유형 | 문서 목록 | 실기에서 `LostLocalization(OdomSlip)`, `FullOfSewage`, `CoverPlate`, `Costmap` 확인 | 고객 문구 추가 |

### 포스코와이드 매장 (매장 검색 `--shops 포스코와이드` 결과)
| shop_id | 매장명 | 로봇 |
|---|---|---|
| 602550006 | 2604_포스코와이드(선릉센터) | CC1Pro 3대 |
| 641450007 | 2610_포스코와이드(포스코이앤씨 단기) | MT1 3대 |
| 637250014 | 2609_포스코와이드(성남분당) | MT1 1대 |
| 611150001 | 2603_포스코광양포항POC | CC1 2대 (매장명에 '와이드' 없음, 로봇 닉네임으로 확인) |
| 604450015 / 605250015 / 606450001 | 2601_포스코와이드, _room, (세윤)_remote | 배달로봇(BellaBot) 또는 로봇 없음 — 범위 밖 |

## 10. 남은 확인 사항 (명령 시험·지도)
- 명령(exec) 전 과정: 접수 → 상세 폴링/콜백으로 실행 확인 → 완료까지의 시간. 지정 로봇·시간에 시험.
- 중단(STOP)의 "일시정지 후 취소" 순서가 실제로 필요한지.
- 콜백: URL·CallbackCode 등록 후 수신 확인.
- 지도: 상세의 `map.name`("1#2#포스코센터1층_")·position(m)을 우리 층·샘플 지도 좌표와 맞추는 규칙. 현재는 샘플 지도 위에 미터 좌표를 그대로 찍는다.
- BG1/BG1Pro 의 청소 API 응답(현재 매장 미배정이라 상세 조회 불가).

## 11. 명령(exec) 실기 결과 (2026-10-29 05:47~06:21 KST, 선릉센터 1층 CC1Pro `8880T5B27070005`)

사용자 조건 "충전 중일 때만"을 지켜 세 차례 시험했다. 모든 명령은 우리 시스템의 명령 경로(`issueCommand` → `PuduAdapter` → 폴링 확인)로 보냈고 명령 이력·감사 이력에 남아 있다.

| 명령 | 본문 | 결과 | 걸린 시간 |
|---|---|---|---|
| 작업 실행 | type 3 / status 1 + task_id·version·name | 접수 → 23초 뒤 상세 코드 302(청소) 확인 | 23초 |
| 일시정지 | type 3 / status 3 **+ task_id·version** | 301(일시정지) | 8초 |
| 재개 | type 3 / status 1 + task | 302 | 10초 |
| 중단 | status 3 → status 4 (+ task) | 303(취소 처리) → 약 20초 뒤 0(대기) | 10초 |
| 복귀 | type 5 / status 1 **+ task** | 102(복귀 이동) → 501·504(도킹) → 203/202(충전) | 접수 3초, 충전 도달 약 3분 30초 |

문서와 다르거나 문서에 없던 규칙(모두 코드에 반영):
1. **모든 명령에 `clean.task_id`(+version)가 필요하다.** 없으면 일시정지·취소·복귀 모두 `HTTP 500 CLEANBOT_TASK_IS_EMPTY`. 진행 중 작업(상세의 `cleanbot.clean.task`) 또는 마지막 작업(`last_task`)의 ID 를 붙인다. 상세 조회가 안 될 때를 위해 마지막 작업 ID 를 로봇에 기억한다.
2. **시작 직후 코드 304 = 청소 지점으로 이동 중.** 이때 일시정지·중단은 `CLEANBOT_NOT_IN_THE_CLEANING_STATE`, 복귀는 `CLEANBOT_CLEANING_EN_ROUTE` 로 거부된다. 302 + 진행률이 보고된 뒤에야 받는다(두 번째 시험은 이 때문에 실패 → 시험 스크립트가 302+진행률까지 기다리도록 수정).
3. **취소 직후 약 15~20초(코드 303)에는 복귀가 `CLEANBOT_CLEANING_CANCELED` 로 거부된다.** 어댑터가 303 이 풀릴 때까지(최대 40초) 기다렸다가 보낸다.
4. 중단은 "일시정지 → 취소" 두 번 호출이 실제로 동작했다(청소 중 바로 취소는 시험하지 않음).
5. `trace_id` 는 `<ApiAppKey>_<uuid>` 꼴로 키가 그대로 들어 있다 → 저장·표시 전에 접두사를 뗀다.
6. 도킹 직후에는 상세 `task=202` 인데 V2 `is_charging=-1`, `run_state=BUSY` 가 몇 분 남는다 → "충전 중" 판정은 둘 중 하나로.

관찰된 상태 코드(실기): 0 대기 · 102 복귀 이동 · 202/203 충전 · 301 일시정지 · 302 청소 · 303 취소 처리 중 · 304 청소 지점 이동 · 400(오프라인 MT1 의 마지막 값) · 501/504 도킹 · -200 위치 상실(오프라인 로봇의 마지막 값).
