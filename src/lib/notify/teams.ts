/**
 * Microsoft Teams 개인 발송(docs/24).
 *
 * 방식: Teams 「워크플로(Power Automate)」의 웹훅 트리거 하나로 받고, 흐름 안에서
 * 「채팅 또는 채널에 카드 게시 — Flow bot 으로 · Flow bot 과의 채팅 · 받는 사람 = recipient」로 개인에게 1:1 전달한다.
 * - 별도 봇 등록·Azure 앱 없이 됨(회사 Microsoft 365 계정 하나로 흐름 생성).
 * - 받는 사람은 Teams 로그인 이메일(UPN). 우리 사용자 이메일과 같아야 한다.
 *
 * 보내는 본문(흐름에서 그대로 사용):
 *   { type: "message", recipient: "<email>", title, text, url,
 *     attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: <Adaptive Card 1.4> }] }
 * 흐름의 카드 칸에는  first(triggerBody()?['attachments'])?['content']  를, 받는 사람 칸에는  triggerBody()?['recipient']  를 넣는다.
 *
 * 웹훅 URL 은 서명(sig)이 든 비밀값이라 서버 .env(TEAMS_WORKFLOW_URL)에만 둔다.
 */

export interface TeamsConfig {
  url: string;
  timeoutMs: number;
}

export function teamsConfig(): TeamsConfig | null {
  const url = process.env.TEAMS_WORKFLOW_URL?.trim();
  // https 만 허용. 단, 가상 웹훅(scripts/teams-sim.ts) 시험용 localhost 는 http 허용.
  if (!url || !(/^https:\/\//.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(url))) return null;
  return { url, timeoutMs: Number(process.env.TEAMS_TIMEOUT_MS ?? 15000) };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
let fetchImpl: FetchLike | null = null;
/** 시험용: 웹훅 호출을 가로챈다(null 이면 실제 fetch). */
export function setTeamsFetchForTest(f: FetchLike | null): void {
  fetchImpl = f;
}

export interface TeamsMessage {
  title: string;
  lines: string[]; // "항목: 값"
  url: string;
  /** 강조 색: good(초록) | attention(빨강) | warning(주황) | accent(파랑) */
  tone?: "good" | "attention" | "warning" | "accent";
}

/** Adaptive Card 1.4 (Teams 개인 채팅에서 보이는 카드). */
export function teamsCard(m: TeamsMessage): Record<string, unknown> {
  // "항목: 값"(항목이 짧은 줄)은 표로, 나머지 문장은 표 아래 문단으로
  const facts: { title: string; value: string }[] = [];
  const notes: string[] = [];
  for (const l of m.lines) {
    const i = l.indexOf(":");
    if (i > 0 && i <= 12) facts.push({ title: l.slice(0, i).trim(), value: l.slice(i + 1).trim() });
    else notes.push(l);
  }
  return {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body: [
      { type: "TextBlock", text: m.title, weight: "Bolder", size: "Medium", wrap: true, color: m.tone ?? "accent" },
      ...(facts.length ? [{ type: "FactSet", facts }] : []),
      ...notes.map((t) => ({ type: "TextBlock", text: t, wrap: true, spacing: "Small" })),
      { type: "TextBlock", text: "Wide Bot 통합관제", size: "Small", isSubtle: true, spacing: "Medium" },
    ],
    actions: m.url ? [{ type: "Action.OpenUrl", title: "Wide Bot 에서 보기", url: m.url }] : [],
  };
}

export function teamsPayload(recipient: string, m: TeamsMessage): Record<string, unknown> {
  return {
    type: "message",
    recipient,
    title: m.title,
    text: [m.title, ...m.lines].join("\n"),
    url: m.url,
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: teamsCard(m) }],
  };
}

/** 개인에게 카드 1건. 워크플로 웹훅은 접수만 하고(202) 실제 전달은 흐름이 비동기로 한다. */
export async function sendTeamsToPerson(cfg: TeamsConfig, email: string, m: TeamsMessage): Promise<{ ok: boolean; reason: string }> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, reason: "Teams 받는 사람 이메일 형식 오류" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const f: FetchLike = fetchImpl ?? ((u, i) => fetch(u, i));
    const res = await f(cfg.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(teamsPayload(email, m)), signal: controller.signal });
    if (res.status >= 200 && res.status < 300) return { ok: true, reason: `Teams 워크플로 접수(HTTP ${res.status})` };
    const body = (await res.text().catch(() => "")).slice(0, 200);
    return { ok: false, reason: `Teams 워크플로 거절(HTTP ${res.status}) ${body}`.trim() };
  } catch (e) {
    return { ok: false, reason: `Teams 전송 실패: ${(e as Error).name === "AbortError" ? "시간 초과" : (e as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}
