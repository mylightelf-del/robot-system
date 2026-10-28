# CenoBots 어댑터 — 구현 전 메모

상태: **미구현(3단계)**. 1단계 시제품은 `sample/` 어댑터만 동작한다.

## 공식 문서
- 진입점: https://operation.cz-robots.com/doc/open_api#robot-open-api
- 실제 로드 문서(2026-10-27 확인): https://operation.cz-robots.com/open_api_markdown/open_261022.html
- 변경 이력 V1.0.18(2026-10-10)과 본문 Version v1.0.8 표기가 섞여 있다. **구현 직전 현행 문서를 다시 확인한다.**

## 인수인계 문서에서 확인한 endpoint (요청·응답 형식은 원문 재확인 필요)
| 기능 | endpoint |
|---|---|
| 로봇 상태 | GET /app/openapi/v1/device/status/{deviceOpenId} |
| 로봇 정보 | GET /app/openapi/v1/device/info/{deviceOpenId} |
| 임시 청소 | POST /app/openapi/v1/mission |
| 집계 | POST /app/openapi/v1/mission/summary |
| 작업 이력 | POST /app/openapi/v1/mission/list |
| 지도 이미지·좌표 | GET /app/openapi/v1/map/pic-with-points |
| 유지관리 | GET /app/openapi/v1/device/maintenance-detail/{deviceOpenId} |
| 예약 / 등록 작업 / 작업 제어 / 지도·구역 / 오류·Webhook | 각 장의 원문 참조 |

## 구현 시 지켜야 할 것
- 인증 헤더 X-Api-Key / X-Api-timestamp / X-Api-signature, HMAC-SHA256(Secret Key) 서명. 쿼리 포함 여부 등 세부 규칙은 현행 문서·시험으로 확인.
- 지역 HOST(APAC/EU/US/기타)는 실제 계정 서버 지역으로 확인. 한국이라는 이유로 APAC 확정 금지.
- L 시리즈 임시 작업은 SWEEP 모드만. PATROL 예제를 L4 에 쓰지 않는다.
- 지도 모서리 좌표(좌하·좌상·우상·우하)가 null 이면 영역 명령 전송 금지.
- pose 는 온라인 시 현재 위치, 오프라인 시 마지막 보고 위치. 화면에서 구분.
- consumablesStatistics 는 SP50 전용 → L4 소모품 근거로 쓰지 않음. maintenance-detail 은 L4 에서 시험.
- HTTP 코드와 body.success/code 를 구분. 문서 예제의 JSON 오류·표기 불일치 주의.
- Webhook: 회사 범위 구독, AES-256-GCM 복호화, challenge 검증, data.id 중복 제거, occurredAt 역순 방지, 내구성 저장 후 2xx 응답, 주기 조회로 누락 보완.
- 비밀값은 환경변수(.env.example 참고)로만. 저장소·대화에 붙여 넣지 않는다.
