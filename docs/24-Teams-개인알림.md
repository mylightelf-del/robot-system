# 24. Microsoft Teams 개인 알림 (2026-11-17)

배송 도착·재알림·취소·막힘 알림(그리고 장애 알림 수신자)을 **받는 사람 개인의 Teams 채팅**으로 보낸다.

## 1. 방식 — Teams 워크플로(Power Automate) 웹훅 1개
```
Wide Bot ──POST(JSON: recipient=이메일, Adaptive Card)──▶ Teams 워크플로 웹훅
                                                     └▶ 「Flow bot 과의 채팅」으로 그 사람에게 카드 게시
```
- 봇 등록·Azure 앱 없이, 회사 Microsoft 365 계정 하나로 만든다. 받는 사람은 **Teams 로그인 이메일**(Wide Bot 사용자 이메일과 같아야 함).
- 채널 웹훅(Incoming Webhook)은 채널 전용이라 개인 발송이 안 된다 → 워크플로 방식을 쓴다.
- Graph API 로 앱이 개인 채팅을 보내는 것은 Microsoft 가 막아 둠(위임 권한·봇 필요) → 쓰지 않는다.

## 2. Teams 에서 만들 흐름(한 번만, 5분)
1. Teams → 왼쪽 「…」 → **워크플로(Workflows)** → 새 흐름 → 빈 흐름(또는 make.powerautomate.com → 만들기 → 인스턴트 흐름).
2. 트리거: **「Teams 웹후크 요청이 수신되는 경우(When a Teams webhook request is received)」** → 트리거할 수 있는 사람: **누구나(Anyone)**.
3. 동작 추가: **「채팅 또는 채널에 카드 게시(Post card in a chat or channel)」**
   - 게시 형식: **Flow bot** · 게시 위치: **Flow bot 과 채팅(Chat with Flow bot)**
   - 받는 사람(Recipient): 식 `triggerBody()?['recipient']`
   - 적응형 카드(Adaptive Card): 식 `first(triggerBody()?['attachments'])?['content']`
4. 저장 → 트리거에 나온 **HTTP URL** 을 복사(서명 `sig=` 포함, 비밀값).
5. GitHub 저장소 Settings → Secrets and variables → Actions → **`TEAMS_WORKFLOW_URL`** 로 등록 → Claude 가 `ops.yml` 의 `sync-secrets` 로 서버에 반영.

## 3. Wide Bot 쪽
- 채널 `TEAMS`: 배송 수신자 편집(배송 화면)·장애 알림 수신자(관리 설정, 주소=이메일)에서 고른다.
- `src/lib/notify/teams.ts`: 카드(Adaptive Card 1.4, 「항목: 값」은 표, 색은 도착=초록·재알림/취소=주황·막힘/오류=빨강, 「Wide Bot 에서 보기」 버튼).
- 웹훅은 **접수(202)** 만 돌려주고 실제 전달은 흐름이 비동기로 한다 → 기록의 SENT 는 "워크플로 접수"를 뜻한다. 받는 사람 이메일이 틀리면 흐름 실행 기록(Power Automate)에서 실패로 보인다.
- `TEAMS_WORKFLOW_URL` 이 없으면 모의 발송(MOCK_SENT). https 만 허용(가상 시험용 localhost 예외).

## 4. 가상 시험(`tests/teams.test.ts`)
가상 에이전트 웹훅(배송 도착 알림) → Wide Bot → **가상 Teams 워크플로 웹훅(로컬 HTTP 서버, 202)** 끝까지:
- 수신자 2명 → 개인별 카드 1건씩(recipient = 각자 이메일), 3분 미수령 → 각자 재알림 1건, 다시 돌려도 추가 없음.
- 워크플로가 401 로 거절 → 기록 FAILED(사유에 HTTP 코드).
- `TEAMS_SIM_OUT=<파일>` 로 받은 본문을 남겨 카드 미리보기를 만들 수 있다.

## 5. 실제 확인 순서
1. 위 2번 흐름 생성 → URL 을 GitHub Secret 에 등록.
2. `sync-secrets` 실행(서버 .env 반영·재시작).
3. 관리 설정 → 알림 → 「시험 발송」(채널 Teams, 주소 = 본인 Teams 이메일) → 본인 Teams 에 Workflows 채팅 카드가 오는지 확인.
