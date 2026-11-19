# 24. Microsoft Teams 개인 알림 (2026-11-17)

배송 도착·재알림·취소·막힘 알림(그리고 장애 알림 수신자)을 **받는 사람 개인의 Teams 채팅**으로 보낸다. 메일을 거치지 않는다.

## 1. 방식 — 봇 직접 발송(기본, 1~2초)
```
(설치 때) Teams ──설치 알림(JWT 서명)──▶ /api/teams/messages ──▶ teams_conversations(직원별 개인 채팅 주소·이메일)
(알림 때) Wide Bot ──Bearer 봇 토큰──▶ Bot Connector {serviceUrl}/v3/conversations/{id}/activities ──▶ 직원 Teams(앱 채팅 + 휴대폰 푸시)
```
- 사용자 결정(2026-11-17): 워크플로(Power Automate)는 대기열 때문에 수 초~수 분 늦을 수 있어 **봇 직접 발송**으로 한다.
- 알림은 「Wide Bot」 앱 개인 채팅으로 온다(알림 전용, 사용자가 입력하면 안내만 답함).
- 받는 사람 = Wide Bot 사용자 이메일. 설치 때 Teams 구성원 조회로 얻은 이메일·UPN(소문자)과 맞춘다.
- **앱이 설치된 직원에게만** 보낼 수 있다(Microsoft 규칙). 관리자가 설치 정책으로 일괄 설치한다. 미설치 직원은 기록에 "설치되지 않음" 실패로 남는다.
- 보안: 수신 주소는 Bot Framework JWT(RS256, 발급자·대상 앱·만료·serviceUrl·msteams 키) 검증, 우리 테넌트 활동만 저장, 토큰은 Microsoft 호스트(serviceUrl 허용 목록)로만 보낸다. 앱 제거·차단(403/404)이면 이후 보내지 않음.
- 봇 미설정이면 2순위로 워크플로 웹훅(TEAMS_WORKFLOW_URL), 둘 다 없으면 모의 발송.

## 2. 처음 한 번 설정
### A. Azure 에서 봇 등록(무료 F0)
1. https://portal.azure.com (회사 Microsoft 365 관리자 계정) → 리소스 만들기 → **Azure Bot** → 만들기
   - 봇 핸들: `widebot-notify` · 가격 책정 계층: **F0(무료)** 로 변경 · 앱 유형: **단일 테넌트** · 생성 유형: **새 Microsoft 앱 ID 만들기**
   - (구독이 없으면 Azure 무료 계정/종량제 구독을 먼저 만든다. F0 봇은 요금 없음.)
2. 만든 봇 → **구성(Configuration)**
   - 메시징 엔드포인트: `https://widebot.kro.kr/api/teams/messages` → 적용
   - **Microsoft App ID**, **App Tenant ID** 복사
   - 「암호 관리」 → 인증서 및 암호 → **새 클라이언트 암호**(만료 24개월) → **값** 복사(한 번만 보임)
3. **채널** → **Microsoft Teams** 추가 → 동의 → 적용

### B. Wide Bot 서버에 반영
- GitHub 저장소 Secrets 에 `TEAMS_BOT_APP_ID`, `TEAMS_BOT_APP_SECRET`, `TEAMS_BOT_TENANT_ID` 등록 → `ops.yml` 의 **sync-secrets** 실행(값 미출력).
- 앱 ID(비밀 아님)로 Teams 앱 파일 생성: `npx tsx scripts/teams-app.ts <앱 ID>` → `widebot-teams-app.zip`.

### C. Teams 관리 센터에서 앱 올리기·설치
1. https://admin.teams.microsoft.com → Teams 앱 → **앱 관리** → **업로드(새 앱 업로드)** → zip 선택.
2. Teams 앱 → **설정 정책** → 전역(조직 전체 기본값) 또는 대상 그룹 정책 → **설치된 앱 → 앱 추가 → Wide Bot** → 저장.
   - 반영까지 몇 시간(최대 24시간). 바로 시험하려면 본인 Teams → 앱 → 「조직을 위해 빌드됨」 → Wide Bot → **추가**.
3. 설치되면 각자에게 Wide Bot 환영 메시지가 오고, Wide Bot 은 그 채팅 주소를 저장한다.

### D. 확인
- 관리 설정 → 알림 → 「시험 발송」(채널 Teams, 주소 = 본인 Teams 이메일) → 1~2초 안에 Wide Bot 채팅으로 카드. 기록 사유에 걸린 시간(ms)이 남는다.
- 클라이언트 암호 만료(24개월) 전에 새 암호로 교체해야 한다.

## 3. 코드
- `src/lib/notify/teamsBot.ts`(토큰·JWT 검증·설치 처리·직접 발송), `src/app/api/teams/messages/route.ts`(수신), `src/lib/notify/teams.ts`(카드·워크플로 예비 경로), `scripts/teams-app.ts`(앱 zip), 테이블 `teams_conversations`(0022).
- 카드: Adaptive Card 1.4, 「항목: 값」은 표, 색은 도착=초록·재알림/취소=주황·막힘/오류=빨강, 「Wide Bot 에서 보기」 버튼.

## 4. 시험
- `tests/teamsBot.test.ts`: 서명 없음·위조·다른 앱·만료·모르는 키 → 401, 설치 → 주소·이메일 저장+환영, 다른 테넌트 무시, 제거 → 중지, 배송 도착 → 설치 직원은 봇 직접 발송·미설치 직원은 실패 기록, 403 → 이후 중지, Microsoft 아닌 serviceUrl 로는 토큰 미전송.
- `tests/teams.test.ts`: 예비 경로(워크플로 웹훅) 가상 끝단 시험.
