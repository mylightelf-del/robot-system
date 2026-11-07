import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db/client";
import { getNotificationSetting, type DbLike } from "@/lib/db/repo";
import { notifyRecipients } from "@/lib/notify/notifier";
import { formatDateTime, nowIso } from "@/lib/util/time";

/**
 * 운영 알림(장애 외): 워커가 10분마다 돌린다. 모두 "같은 대상에 한 번만"(notification_logs 의 kind+refId 로 판단, 억제 기록도 포함).
 * - 예정 작업 미실행: 자동 판정으로 MISSED 가 된 계획 회차(최근 MISSED_LOOKBACK_HOURS 안)를 사업장 수신자에게 통보.
 * - 장기간 무실적: 사업장 설정 noActivityHours > 0 이면, 그 시간 동안 실적(종료 시각 기준)이 없는 사용 중인 실제 로봇을 통보. 로봇당 하루 한 번.
 * 사용 중지된 사업장·로봇은 제외한다.
 */
export const MISSED_LOOKBACK_HOURS = 24;
const NO_ACTIVITY_REPEAT_HOURS = 24;

function base(): string {
  return (process.env.APP_BASE_URL || "").replace(/\/$/, "");
}

async function alreadyNotified(kind: "MISSED_RUN" | "NO_ACTIVITY" | "CONSUMABLE", refIds: string[], since: string | null, db: DbLike): Promise<Set<string>> {
  if (refIds.length === 0) return new Set();
  const rows = await db
    .select({ refId: schema.notificationLogs.refId })
    .from(schema.notificationLogs)
    .where(and(eq(schema.notificationLogs.kind, kind), inArray(schema.notificationLogs.refId, refIds), ...(since ? [gte(schema.notificationLogs.at, since)] : [])));
  return new Set(rows.map((r) => r.refId!).filter(Boolean));
}

export async function notifyMissedRuns(now: string = nowIso(), db: DbLike = getDb()): Promise<number> {
  const since = new Date(new Date(now).getTime() - MISSED_LOOKBACK_HOURS * 3600_000).toISOString();
  const rows = await db
    .select({ p: schema.plannedRuns, taskName: schema.registeredTasks.name, robotName: schema.robots.name, robotActive: schema.robots.active, site: schema.sites })
    .from(schema.plannedRuns)
    .innerJoin(schema.sites, eq(schema.sites.id, schema.plannedRuns.siteId))
    .leftJoin(schema.registeredTasks, eq(schema.registeredTasks.id, schema.plannedRuns.taskId))
    .leftJoin(schema.robots, eq(schema.robots.id, schema.plannedRuns.robotId))
    .where(and(eq(schema.plannedRuns.status, "MISSED"), gte(schema.plannedRuns.plannedAt, since), isNull(schema.sites.retiredAt), sql`${schema.plannedRuns.reason} like '%자동 판정%'`));
  if (rows.length === 0) return 0;
  const done = await alreadyNotified("MISSED_RUN", rows.map((r) => r.p.id), null, db);
  let sent = 0;
  for (const r of rows) {
    if (done.has(r.p.id) || r.robotActive === false) continue;
    const setting = await getNotificationSetting(r.site.id, db);
    const tz = r.site.timezone;
    const logs = await notifyRecipients(setting, r.site.id, now, tz, { kind: "MISSED_RUN", label: "예정 작업 미실행", refId: r.p.id }, async () => ({
      subject: `[청소로봇 미실행] ${r.site.name} ${r.robotName ?? r.p.robotId} — ${r.taskName ?? r.p.taskId}`.slice(0, 150),
      title: `[예정 작업 미실행] ${r.site.name} · ${r.robotName ?? r.p.robotId}`,
      lines: [`사업장: ${r.site.name}`, `로봇: ${r.robotName ?? r.p.robotId}`, `작업: ${r.taskName ?? r.p.taskId}`, `예정: ${formatDateTime(r.p.plannedAt, tz)}`, `판정: ${r.p.reason ?? "실적 없음"}`, "안내: 로봇 상태·현장 상황을 확인하세요. 늦게 들어온 실적은 48시간 안에 자동으로 다시 맞춥니다."],
      url: `${base()}/tasks?site=${encodeURIComponent(r.site.id)}`,
    }));
    if (logs.length === 0) {
      // 수신자가 없으면 '통보 없음' 기록을 남겨 같은 회차를 다시 보지 않는다
      await db.insert(schema.notificationLogs).values({ id: `ntf-${r.p.id}-none`, at: now, channel: "EMAIL", recipient: "-", status: "SUPPRESSED", reason: "예정 작업 미실행 — 억제: 수신자 없음", kind: "MISSED_RUN", refId: r.p.id, incidentId: null });
      continue;
    }
    await db.insert(schema.notificationLogs).values(logs.map((l) => ({ ...l, incidentId: null })));
    if (logs.some((l) => l.status === "SENT" || l.status === "MOCK_SENT")) sent += 1;
  }
  return sent;
}

export async function notifyNoActivity(now: string = nowIso(), db: DbLike = getDb()): Promise<number> {
  const settings = await db.select().from(schema.notificationSettings).where(sql`${schema.notificationSettings.noActivityHours} > 0`);
  if (settings.length === 0) return 0;
  const sites = await db.select().from(schema.sites).where(and(inArray(schema.sites.id, settings.map((s) => s.siteId)), isNull(schema.sites.retiredAt)));
  let sent = 0;
  const repeatSince = new Date(new Date(now).getTime() - NO_ACTIVITY_REPEAT_HOURS * 3600_000).toISOString();
  for (const site of sites) {
    const hours = settings.find((s) => s.siteId === site.id)!.noActivityHours;
    const cutoff = new Date(new Date(now).getTime() - hours * 3600_000).toISOString();
    const robots = await db
      .select()
      .from(schema.robots)
      .where(and(eq(schema.robots.siteId, site.id), eq(schema.robots.active, true), sql`${schema.robots.vendorMeta}->>'source' = 'api'`));
    if (robots.length === 0) continue;
    const done = await alreadyNotified("NO_ACTIVITY", robots.map((r) => r.id), repeatSince, db);
    for (const robot of robots) {
      if (done.has(robot.id)) continue;
      const [last] = await db.select({ endedAt: schema.actualRuns.endedAt }).from(schema.actualRuns).where(eq(schema.actualRuns.robotId, robot.id)).orderBy(desc(schema.actualRuns.endedAt)).limit(1);
      // 실적이 한 번도 없는 로봇(등록 직후)은 통보하지 않는다 — 등록 뒤 첫 실적 전에 오해를 만들지 않도록
      if (!last) continue;
      if (last.endedAt >= cutoff) continue;
      const setting = await getNotificationSetting(site.id, db);
      const tz = site.timezone;
      const idleHours = Math.round((new Date(now).getTime() - new Date(last.endedAt).getTime()) / 3600_000);
      const logs = await notifyRecipients(setting, site.id, now, tz, { kind: "NO_ACTIVITY", label: "장기간 무실적", refId: robot.id }, async () => ({
        subject: `[청소로봇 무실적] ${site.name} ${robot.name} — ${idleHours}시간 동안 청소 실적 없음`.slice(0, 150),
        title: `[장기간 무실적] ${site.name} · ${robot.name}`,
        lines: [`사업장: ${site.name}`, `로봇: ${robot.name}`, `마지막 실적: ${formatDateTime(last.endedAt, tz)} (${idleHours}시간 전)`, `기준: ${hours}시간 동안 실적 없음(사업장 알림 설정)`, "안내: 예약이 꺼져 있거나 로봇이 멈춰 있을 수 있습니다. 로봇 상태와 예약을 확인하세요."],
        url: `${base()}/robots/${encodeURIComponent(robot.id)}`,
      }));
      if (logs.length === 0) continue;
      await db.insert(schema.notificationLogs).values(logs.map((l) => ({ ...l, incidentId: null })));
      if (logs.some((l) => l.status === "SENT" || l.status === "MOCK_SENT")) sent += 1;
    }
  }
  return sent;
}

export const CONSUMABLE_REPEAT_DAYS = 7;

/**
 * 소모품·점검 통보(kind CONSUMABLE): 잔여 수명 LOW_CONSUMABLE_PCT 미만인 항목(7일에 한 번), 기한이 지난 점검 항목(한 번).
 * 사용 중지 로봇·사업장 제외. 수신자가 이 종류를 받도록 설정돼 있어야 한다.
 */
export async function notifyConsumables(now: string = nowIso(), db: DbLike = getDb()): Promise<number> {
  const { LOW_CONSUMABLE_PCT } = await import("./maintenance");
  const robots = await db
    .select({ r: schema.robots, site: schema.sites })
    .from(schema.robots)
    .innerJoin(schema.sites, eq(schema.sites.id, schema.robots.siteId))
    .where(and(eq(schema.robots.active, true), isNull(schema.sites.retiredAt)));
  if (robots.length === 0) return 0;
  const robotIds = robots.map((x) => x.r.id);
  const low = await db.select().from(schema.maintenanceItems).where(and(inArray(schema.maintenanceItems.robotId, robotIds), sql`${schema.maintenanceItems.remainingPct} is not null and ${schema.maintenanceItems.remainingPct} < ${LOW_CONSUMABLE_PCT}`));
  const overdue = await db.select().from(schema.inspections).where(and(inArray(schema.inspections.robotId, robotIds), isNull(schema.inspections.doneAt), sql`${schema.inspections.dueAt} < ${now}`));
  const refs = [...low.map((m) => `cons:${m.robotId}:${m.name}`), ...overdue.map((i) => `insp:${i.id}`)];
  if (refs.length === 0) return 0;
  const repeatSince = new Date(new Date(now).getTime() - CONSUMABLE_REPEAT_DAYS * 86400_000).toISOString();
  const doneLow = await alreadyNotified("CONSUMABLE", low.map((m) => `cons:${m.robotId}:${m.name}`), repeatSince, db);
  const doneInsp = await alreadyNotified("CONSUMABLE", overdue.map((i) => `insp:${i.id}`), null, db);
  let sent = 0;
  const send = async (robotId: string, refId: string, subject: string, title: string, lines: string[]) => {
    const rb = robots.find((x) => x.r.id === robotId)!;
    const setting = await getNotificationSetting(rb.site.id, db);
    const logs = await notifyRecipients(setting, rb.site.id, now, rb.site.timezone, { kind: "CONSUMABLE", label: "소모품·점검", refId }, async () => ({ subject: subject.slice(0, 150), title, lines, url: `${base()}/robots/${encodeURIComponent(robotId)}` }));
    if (logs.length === 0) {
      await db.insert(schema.notificationLogs).values({ id: `ntf-${refId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80)}-${Date.now().toString(36)}`, at: now, channel: "EMAIL", recipient: "-", status: "SUPPRESSED", reason: "소모품·점검 — 억제: 수신자 없음", kind: "CONSUMABLE", refId, incidentId: null });
      return;
    }
    await db.insert(schema.notificationLogs).values(logs.map((l) => ({ ...l, incidentId: null })));
    if (logs.some((l) => l.status === "SENT" || l.status === "MOCK_SENT")) sent += 1;
  };
  for (const m of low) {
    const ref = `cons:${m.robotId}:${m.name}`;
    if (doneLow.has(ref)) continue;
    const rb = robots.find((x) => x.r.id === m.robotId)!;
    await send(m.robotId, ref, `[청소로봇 소모품] ${rb.site.name} ${rb.r.name} — ${m.name} ${Math.round(m.remainingPct ?? 0)}%`, `[소모품 교체 필요] ${rb.site.name} · ${rb.r.name}`, [`사업장: ${rb.site.name}`, `로봇: ${rb.r.name}`, `항목: ${m.name}`, `잔여: ${Math.round(m.remainingPct ?? 0)}% (기준 ${LOW_CONSUMABLE_PCT}% 미만)`, "안내: 교체 부품을 준비하고 교체 뒤 로봇에서 잔여 수명을 초기화하세요."]);
  }
  for (const i of overdue) {
    const ref = `insp:${i.id}`;
    if (doneInsp.has(ref)) continue;
    const rb = robots.find((x) => x.r.id === i.robotId)!;
    await send(i.robotId, ref, `[청소로봇 점검 기한] ${rb.site.name} ${rb.r.name} — ${i.item}`, `[점검 기한 지남] ${rb.site.name} · ${rb.r.name}`, [`사업장: ${rb.site.name}`, `로봇: ${rb.r.name}`, `점검 항목: ${i.item}`, `기한: ${formatDateTime(i.dueAt, rb.site.timezone)}`, "안내: 점검을 마치면 로봇 화면의 점검표에서 완료 처리하세요."]);
  }
  return sent;
}
