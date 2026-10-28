# 청소로봇 통합관제 시스템 (1단계 시제품)

포스코와이드의 여러 사업장 청소로봇(PUDU MT1·CC1·BG1, CenoBots L4)을 본사·현장·고객사가 권한별로 관리하는 웹 시스템입니다.
현재는 **1단계 시제품**으로, 가상 사업장 5곳·로봇 20대 샘플 데이터로 화면과 운영 흐름을 확인하는 단계입니다.

> ⚠ 샘플 데이터 · 시뮬레이션: 사업장명·모델별 대수·배치는 모두 가상이며 실제 로봇에 명령을 보내지 않습니다.
> 역할 전환기는 실제 인증을 대신하지 않습니다(실제 로그인은 2단계).

## 문서
- `docs/HANDOFF.md` — 인수인계 기준 문서(요구사항·제조사 문서 검토 결과·단계 계획)
- `docs/01-요구사항-정리.md` — 요구사항 이해, 구현 구조, 미확인 사항, 제안
- `docs/02-1단계-시제품-보고.md` — 구현 항목, 테스트 결과, 완료/미완료, 다음 단계
- `src/lib/vendors/cenobots/README.md` — CenoBots 어댑터 구현 전 메모

## 실행 방법 (로컬 PC)
요구사항: Node.js 20 이상(권장 22), npm.

```bash
git clone <이 저장소>
cd robot-system
npm install
cp .env.example .env.local   # 1단계에서는 수정 없이 그대로 사용 가능
npm run dev
```

브라우저에서 http://localhost:3000 을 엽니다. 오른쪽 위 "현재 사용자"에서 샘플 사용자를 바꾸면 역할별 화면을 비교할 수 있습니다.

| 샘플 사용자 | 역할 | 범위 |
|---|---|---|
| 김본사 | 본사 관리자 | 전체 사업장, 관리 설정, 보고서 확정 |
| 이현장 | 현장 담당자 | 가상 사업장 1·2 |
| 박현장 | 현장 담당자 | 가상 사업장 3·4·5 |
| 최고객 | 고객 기본 | 가상 사업장 1 조회만 |
| 정고객 | 고객 제어 | 가상 사업장 2, 실행·일시정지·재개·중단만 |
| 한퇴직 | 비활성 | 모든 접근 차단 |

서버를 재시작하면 샘플 데이터가 초기화됩니다(관리 설정 → "샘플 데이터 초기화"로도 가능).

## 검증
```bash
npm run typecheck   # TypeScript
npm run lint        # ESLint
npm test            # vitest — 인가·명령·보고서 필수 테스트 30건
npm run build       # 프로덕션 빌드
```

브라우저 자동 조작 검증(선택, Playwright 필요):
```bash
npm i -D playwright && npx playwright install chromium
npm run dev            # 다른 터미널에서 3000 포트로 실행
node scripts/e2e-flows.js      # 명령·영역 검증·장애 조치·보고서 확정·권한 차단 흐름
node scripts/screenshots.js    # 역할별 화면 스크린샷 → docs/screenshots/
```

## 환경변수
`.env.example` 참고. 1단계는 `VENDOR_MODE=sample` 만 사용합니다. 제조사 API 키는 서버 비밀 설정에만 두고 저장소·대화에 붙여 넣지 않습니다.

## 단계 계획 (인수인계 문서 9장)
1. 시제품 ✅ (이 저장소)
2. 기반: 서버 인증·사업장별 인가·영속 저장(PostgreSQL)·감사 이력·환경 분리
3. CenoBots 읽기 연동(한 대 실기 대조)
4. CenoBots 제어 연동(지정 시험 로봇·시험 시간)
5. 이벤트·알림·보고서(Webhook, 이메일/알림톡, PDF 보관)
6. PUDU 확장 및 5개 사업장 시범 운영. BIB 는 후속.
