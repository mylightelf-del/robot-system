# CenoBots(CZ Robots) 어댑터 — 조회 전용

상태: **구현(2026-11-10), mock 검증 완료, live 는 키 수령 후**. 설계·매핑·운영 절차는 `docs/22-CENOBOT-BIB-연동.md`.
업체 문서: `docs/vendors/cenobots/openapi_v1.0.18.txt`.

- `client.ts` 서명·봉투·재시도·쓰기 경로 차단 / `api.ts` 조회 API / `mapping.ts` 매핑 표 / `mock.ts` 픽스처 / `webhook.ts` 복호화·저장 / `cenobotsAdapter.ts` 어댑터(명령은 항상 거부)
- 워커: `src/worker/cenobots.ts`. 모드: `CENOBOTS_MODE=unconfigured|mock|live`.
- 명령(시작·중지·예약 변경·설정·오디오·지도 변경·즐겨찾기 실행)은 요청 범위 밖이라 구현하지 않는다.
- 확인 필요(키 수령 후 첫 호출): mission/list pageIndex 시작값, duration 단위, coverage 형식, 실제 status 값, maintenance-detail 의 L4 값.
