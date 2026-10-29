import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { CommandType, NotificationRecipient, Role, Severity, User } from "@/lib/domain/types";
import { assertActive, assertAdmin } from "@/lib/auth/authz";
import { destroyUserSessions } from "@/lib/auth/session";
import { hashPassword, randomToken } from "@/lib/auth/password";
import { getDb, schema } from "@/lib/db/client";
import { getNotificationSetting, getRobot, getStatus, listUsers, loadSettings, openPlacement } from "@/lib/db/repo";
import { NotFoundError, ValidationError } from "@/lib/util/errors";
import { newId } from "@/lib/util/random";
import { addMinutes, nowIso } from "@/lib/util/time";
import { audit } from "./audit";

const INVITE_HOURS = 72;

/** 관리 설정 화면 데이터(본사 관리자 전용). */
export async function getAdminData(user: User) {
  assertActive(user);
  assertAdmin(user);
  const db = getDb();
  const sites = await db.select().from(schema.sites).orderBy(schema.sites.id);
  const settingsRows = await db.select().from(schema.notificationSettings);
  const notificationSettings = [];
  for (const s of settingsRows) notificationSettings.push((await getNotificationSetting(s.siteId, db))!);
  const userRows = await db.select({ id: schema.users.id, inviteToken: schema.users.inviteToken, inviteExpiresAt: schema.users.inviteExpiresAt, passwordHash: schema.users.passwordHash, lastLoginAt: schema.users.lastLoginAt }).from(schema.users);
  return {
    sites,
    floors: await db.select().from(schema.floors).orderBy(schema.floors.id),
    zones: await db.select().from(schema.zones).orderBy(schema.zones.id),
    mapVersions: (await db.select().from(schema.mapVersions)).map((m) => ({ ...m, corners: m.corners ?? null })),
    robots: await db.select().from(schema.robots).orderBy(schema.robots.id),
    placements: await db.select().from(schema.robotPlacements),
    users: await listUsers(db),
    userAuth: userRows.map((u) => ({ id: u.id, hasPassword: !!u.passwordHash, inviteLink: u.inviteToken && u.inviteExpiresAt && u.inviteExpiresAt > nowIso() ? inviteUrl(u.inviteToken) : null, lastLoginAt: u.lastLoginAt })),
    notificationSettings,
    vendorConnections: await db.select().from(schema.vendorConnections).orderBy(schema.vendorConnections.id),
    settings: await loadSettings(db),
    audit: await db.select().from(schema.auditLogs).orderBy(desc(schema.auditLogs.at)).limit(50),
    allowSampleReset: process.env.ALLOW_SAMPLE_RESET === "true",
  };
}

export function inviteUrl(token: string): string {
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/invite/${token}`;
}

export async function setUserActive(user: User, targetId: string, active: boolean): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  const t = await db.query.users.findFirst({ where: eq(schema.users.id, targetId) });
  if (!t) throw new NotFoundError();
  if (t.id === user.id) throw new ValidationError("본인 계정은 비활성화할 수 없습니다.");
  await db.update(schema.users).set({ active }).where(eq(schema.users.id, targetId));
  if (!active) await destroyUserSessions(targetId); // 비활성화 즉시 모든 세션 종료
  await audit(user, { siteId: null, robotId: null, action: "USER:SET_ACTIVE", params: { targetId, active }, result: "OK", detail: active ? null : "세션 전부 종료", vendorTraceId: null }, db);
}

export async function setUserSitePermissions(user: User, targetId: string, siteIds: string[], allowedCommands: CommandType[]): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  const t = await db.query.users.findFirst({ where: eq(schema.users.id, targetId) });
  if (!t) throw new NotFoundError();
  const known = siteIds.length ? await db.select({ id: schema.sites.id }).from(schema.sites).where(inArray(schema.sites.id, siteIds)) : [];
  if (known.length !== new Set(siteIds).size) throw new ValidationError("존재하지 않는 사업장이 있습니다.");
  // 제어 명령은 고객 제어 역할에만 의미가 있다. 고객 기본에는 부여하지 않는다.
  const cmds = t.role === "CUSTOMER_CONTROL" ? allowedCommands : [];
  await db.transaction(async (tx) => {
    await tx.delete(schema.sitePermissions).where(eq(schema.sitePermissions.userId, targetId));
    if (siteIds.length) await tx.insert(schema.sitePermissions).values(siteIds.map((siteId) => ({ userId: targetId, siteId, allowedCommands: cmds })));
    await audit(user, { siteId: null, robotId: null, action: "USER:SET_PERMISSIONS", params: { targetId, siteIds, allowedCommands: cmds }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
}

/** 사용자 등록 → 초대 링크 발급. 비밀번호는 초대 링크에서 본인이 설정한다. */
export async function createUser(user: User, input: { name: string; email: string; role: Role; siteIds: string[]; allowedCommands: CommandType[] }): Promise<{ user: User; inviteLink: string }> {
  const db = getDb();
  assertAdmin(user);
  const email = input.email.trim().toLowerCase();
  if (!input.name.trim() || !email) throw new ValidationError("이름과 이메일을 입력하세요.");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError("이메일 형식이 올바르지 않습니다.");
  if (await db.query.users.findFirst({ where: eq(schema.users.email, email) })) throw new ValidationError("같은 이메일의 사용자가 있습니다.");
  const now = nowIso();
  const token = randomToken(24);
  const u: User = {
    id: newId("u"),
    name: input.name.trim(),
    email,
    role: input.role,
    active: true,
    sitePermissions: input.siteIds.map((siteId) => ({ siteId, allowedCommands: input.role === "CUSTOMER_CONTROL" ? input.allowedCommands : [] })),
  };
  await db.transaction(async (tx) => {
    await tx.insert(schema.users).values({ id: u.id, name: u.name, email: u.email, role: u.role, active: true, passwordHash: null, inviteToken: token, inviteExpiresAt: addMinutes(now, INVITE_HOURS * 60), createdAt: now });
    if (u.sitePermissions.length) await tx.insert(schema.sitePermissions).values(u.sitePermissions.map((p) => ({ userId: u.id, siteId: p.siteId, allowedCommands: p.allowedCommands })));
    await audit(user, { siteId: null, robotId: null, action: "USER:CREATE", params: { role: u.role, siteIds: input.siteIds }, result: "OK", detail: `초대 링크 발급(${INVITE_HOURS}시간 유효)`, vendorTraceId: null }, tx);
  });
  return { user: u, inviteLink: inviteUrl(token) };
}

/** 초대 링크 재발급(비밀번호 재설정에도 사용). 기존 세션은 모두 종료한다. */
export async function reissueInvite(user: User, targetId: string): Promise<string> {
  const db = getDb();
  assertAdmin(user);
  const t = await db.query.users.findFirst({ where: eq(schema.users.id, targetId) });
  if (!t) throw new NotFoundError();
  const token = randomToken(24);
  await db.update(schema.users).set({ inviteToken: token, inviteExpiresAt: addMinutes(nowIso(), INVITE_HOURS * 60) }).where(eq(schema.users.id, targetId));
  await destroyUserSessions(targetId);
  await audit(user, { siteId: null, robotId: null, action: "USER:REISSUE_INVITE", params: { targetId }, result: "OK", detail: "세션 전부 종료", vendorTraceId: null }, db);
  return inviteUrl(token);
}

export async function addRecipient(user: User, siteId: string, r: Omit<NotificationRecipient, "id">): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  const s = await db.query.notificationSettings.findFirst({ where: eq(schema.notificationSettings.siteId, siteId) });
  if (!s) throw new NotFoundError();
  if (!r.address.trim()) throw new ValidationError("수신 주소를 입력하세요.");
  await db.insert(schema.notificationRecipients).values({ id: newId("rcp"), siteId, ...r, address: r.address.trim() });
  await audit(user, { siteId, robotId: null, action: "NOTIFY:ADD_RECIPIENT", params: { channel: r.channel, minSeverity: r.minSeverity }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function removeRecipient(user: User, siteId: string, recipientId: string): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  await db.delete(schema.notificationRecipients).where(and(eq(schema.notificationRecipients.id, recipientId), eq(schema.notificationRecipients.siteId, siteId)));
  await audit(user, { siteId, robotId: null, action: "NOTIFY:REMOVE_RECIPIENT", params: { recipientId }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export async function updateNotificationThresholds(user: User, siteId: string, dedupeMinutes: number, escalateAfterMinutes: number): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  if (!(dedupeMinutes >= 0 && escalateAfterMinutes >= 0)) throw new ValidationError("분 단위 값은 0 이상이어야 합니다.");
  const res = await db.update(schema.notificationSettings).set({ dedupeMinutes, escalateAfterMinutes }).where(eq(schema.notificationSettings.siteId, siteId)).returning();
  if (!res.length) throw new NotFoundError();
  await audit(user, { siteId, robotId: null, action: "NOTIFY:UPDATE_THRESHOLDS", params: { dedupeMinutes, escalateAfterMinutes }, result: "OK", detail: null, vendorTraceId: null }, db);
}

/** 로봇 사업장 이동: 배치 이력을 닫고 새로 연다. 과거 실적은 당시 사업장에 남는다. */
export async function relocateRobot(user: User, robotId: string, toSiteId: string, toFloorId: string): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  const robot = await getRobot(robotId, db);
  if (!robot) throw new NotFoundError();
  const floor = await db.query.floors.findFirst({ where: and(eq(schema.floors.id, toFloorId), eq(schema.floors.siteId, toSiteId)) });
  if (!floor) throw new ValidationError("이동할 사업장의 층을 선택하세요.");
  const st = await getStatus(robot.id, db);
  if (st && (st.common === "CLEANING" || st.common === "PAUSED")) throw new ValidationError("작업 중인 로봇은 이동 처리할 수 없습니다.");
  const now = nowIso();
  await db.transaction(async (tx) => {
    const open = await openPlacement(robot.id, tx);
    if (open) await tx.update(schema.robotPlacements).set({ to: now }).where(eq(schema.robotPlacements.id, open.id));
    await tx.insert(schema.robotPlacements).values({ id: newId("plc"), robotId: robot.id, siteId: toSiteId, from: now, to: null });
    await tx.update(schema.robots).set({ siteId: toSiteId, floorId: toFloorId }).where(eq(schema.robots.id, robot.id));
    await tx.update(schema.robotStatus).set({ mapVersionId: floor.currentMapVersionId, pose: null, poseIsLastKnown: true, progressPct: null, currentMissionId: null }).where(eq(schema.robotStatus.robotId, robot.id));
    // 예정 회차(미래)는 새 사업장으로 이관하지 않고 취소 처리(계획 변경 이력 보존)
    const future = await tx.select().from(schema.plannedRuns).where(and(eq(schema.plannedRuns.robotId, robot.id), eq(schema.plannedRuns.status, "PLANNED"), gt(schema.plannedRuns.plannedAt, now)));
    for (const p of future) {
      await tx
        .update(schema.plannedRuns)
        .set({ status: "CANCELLED", reason: "로봇 사업장 이동", changeHistory: [...p.changeHistory, { at: now, by: user.id, from: p.status, to: "CANCELLED", reason: "로봇 사업장 이동" }] })
        .where(eq(schema.plannedRuns.id, p.id));
    }
    await audit(user, { siteId: toSiteId, robotId: robot.id, action: "ROBOT:RELOCATE", params: { fromSiteId: robot.siteId, toSiteId, toFloorId }, result: "OK", detail: null, vendorTraceId: null }, tx);
  });
}

export async function setSiteManagerCanConfirm(user: User, value: boolean): Promise<void> {
  const db = getDb();
  assertAdmin(user);
  await loadSettings(db);
  await db.update(schema.appSettings).set({ siteManagerCanConfirmReports: value }).where(eq(schema.appSettings.id, "default"));
  await audit(user, { siteId: null, robotId: null, action: "SETTINGS:SITE_MANAGER_CONFIRM", params: { value }, result: "OK", detail: null, vendorTraceId: null }, db);
}

export const SEVERITIES: Severity[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

/** 초대 링크가 유효한(비밀번호 미설정) 계정 수 — 관리 화면 안내용. */
export async function countPendingInvites(): Promise<number> {
  const rows = await getDb().select({ id: schema.users.id }).from(schema.users).where(and(isNull(schema.users.passwordHash), gt(schema.users.inviteExpiresAt, nowIso())));
  return rows.length;
}

export { hashPassword };

// ---- 제조사 연동(PUDU) 관리 ----
import { vendorModes } from "@/lib/vendors";
import { createPuduApi } from "@/lib/vendors/pudu/puduAdapter";
import type { PuduRobot } from "@/lib/vendors/pudu/api";
import { mapProductCode, productParamFor, PUDU_SUPPORTED_COMMANDS } from "@/lib/vendors/pudu/mapping";
import { PUDU_CLUSTERS, parseShopIds } from "@/lib/vendors/pudu/client";

export async function getVendorStatus(user: User) {
  assertAdmin(user);
  const db = getDb();
  const sync = await db.select().from(schema.vendorSyncState).orderBy(schema.vendorSyncState.id);
  const pendingEvents = await db.select({ id: schema.vendorEvents.id }).from(schema.vendorEvents).where(isNull(schema.vendorEvents.processedAt));
  const recentEvents = await db.select().from(schema.vendorEvents).orderBy(desc(schema.vendorEvents.receivedAt)).limit(10);
  const [cb] = await db
    .select({ last: sql<string | null>`max(${schema.vendorEvents.receivedAt})`, day: sql<number>`count(*) filter (where ${schema.vendorEvents.receivedAt} > now() - interval '24 hours')::int` })
    .from(schema.vendorEvents)
    .where(eq(schema.vendorEvents.vendor, "PUDU"));
  return {
    modes: vendorModes(),
    pudu: {
      cluster: process.env.PUDU_API_CLUSTER ?? null,
      clusterLabel: process.env.PUDU_API_CLUSTER ? (PUDU_CLUSTERS[process.env.PUDU_API_CLUSTER]?.label ?? "알 수 없음") : null,
      keyConfigured: !!process.env.PUDU_API_APP_KEY && !!process.env.PUDU_API_APP_SECRET,
      shopIds: parseShopIds(process.env.PUDU_SHOP_IDS),
      callbackConfigured: !!process.env.PUDU_CALLBACK_CODE,
      callbackUrl: `${(process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/webhooks/pudu`,
      callbackPublic: /^https:\/\//.test(process.env.APP_BASE_URL ?? "") && !/localhost|127\.0\.0\.1/.test(process.env.APP_BASE_URL ?? ""),
      lastCallbackAt: cb?.last ? new Date(cb.last).toISOString() : null,
      callbacksLast24h: cb?.day ?? 0,
    },
    sync,
    pendingEvents: pendingEvents.length,
    recentEvents: recentEvents.map((e) => ({ id: e.id, eventType: e.eventType, vendorRobotId: e.vendorRobotId, receivedAt: e.receivedAt, processedAt: e.processedAt, processError: e.processError })),
  };
}

export type PuduRobotRow = { sn: string; productCode: string; model: string | null; shopId: string; shopName: string; nickname: string; registered: boolean };

/**
 * PUDU 연결 확인: Health Check → 허용 매장(PUDU_SHOP_IDS)별 로봇 목록. 비밀값은 돌려주지 않는다.
 * 실기 확인(2026-10): 대리점 키는 다른 고객사 매장 수천 곳·로봇 수천 대가 모두 보이므로, 허용 매장 밖의 로봇은 조회·표시하지 않는다.
 */
export async function puduTestConnection(user: User): Promise<{ ok: boolean; message: string; robots: PuduRobotRow[] }> {
  assertAdmin(user);
  const api = createPuduApi();
  const shopIds = parseShopIds(process.env.PUDU_SHOP_IDS);
  const ok = await api.healthCheck();
  if (!ok) {
    await audit(user, { siteId: null, robotId: null, action: "VENDOR:PUDU_TEST", params: {}, result: "ERROR", detail: "health check 실패", vendorTraceId: null });
    return { ok: false, message: "Health Check 실패 — 키·클러스터·서명을 확인하세요.", robots: [] };
  }
  if (shopIds.length === 0) {
    await audit(user, { siteId: null, robotId: null, action: "VENDOR:PUDU_TEST", params: {}, result: "OK", detail: "health check 통과, 허용 매장 미설정", vendorTraceId: null });
    return { ok: false, message: "인증은 통과했지만 허용 매장(PUDU_SHOP_IDS)이 없습니다. 서버 .env 에 우리 매장의 shop_id 를 넣으세요(`npm run pudu:check -- --shops 검색어` 로 찾을 수 있음).", robots: [] };
  }
  const known = new Set((await getDb().select({ sn: schema.robots.vendorRobotId }).from(schema.robots).where(eq(schema.robots.vendor, "PUDU"))).map((r) => r.sn));
  const robots: PuduRobotRow[] = [];
  for (const shopId of shopIds) {
    const page = await api.listRobots({ shop_id: shopId, limit: 100 });
    for (const r of page.list ?? []) {
      if (String(r.shop_id) !== shopId) continue; // 서버가 필터를 무시해도 허용 매장 밖은 버린다
      robots.push({ sn: r.sn, productCode: r.product_code, model: mapProductCode(r.product_code), shopId: String(r.shop_id), shopName: r.shop_name, nickname: r.nickname ?? "", registered: known.has(r.sn) });
    }
  }
  await audit(user, { siteId: null, robotId: null, action: "VENDOR:PUDU_TEST", params: { shops: shopIds.length, robots: robots.length }, result: "OK", detail: "health check 통과", vendorTraceId: null });
  return { ok: true, message: `연결 확인: 허용 매장 ${shopIds.length}곳에서 PUDU 로봇 ${robots.length}대 조회`, robots };
}

/** PUDU 로봇을 우리 사업장·층에 등록한다. 모델은 product_code 로만 정하고 알 수 없으면 등록을 거부한다. */
export async function puduImportRobots(user: User, siteId: string, floorId: string, sns: string[]): Promise<number> {
  assertAdmin(user);
  const db = getDb();
  const floor = await db.query.floors.findFirst({ where: and(eq(schema.floors.id, floorId), eq(schema.floors.siteId, siteId)) });
  if (!floor) throw new ValidationError("사업장의 층을 선택하세요.");
  const api = createPuduApi();
  const shopIds = parseShopIds(process.env.PUDU_SHOP_IDS);
  if (shopIds.length === 0) throw new ValidationError("허용 매장(PUDU_SHOP_IDS)이 설정되지 않아 등록할 수 없습니다.");
  const bySn = new Map<string, PuduRobot>();
  for (const shopId of shopIds) {
    const page = await api.listRobots({ shop_id: shopId, limit: 100 });
    for (const r of page.list ?? []) if (String(r.shop_id) === shopId) bySn.set(r.sn, r);
  }
  let n = 0;
  for (const sn of sns) {
    const r = bySn.get(sn);
    if (!r) throw new ValidationError(`허용 매장의 PUDU 로봇 목록에 없는 SN: ${sn}`);
    const model = mapProductCode(r.product_code);
    if (!model) throw new ValidationError(`SN ${sn} 의 product_code '${r.product_code}' 는 문서에 없는 모델입니다. 수동 지정 없이 보류합니다.`);
    const exists = await db.query.robots.findFirst({ where: and(eq(schema.robots.vendor, "PUDU"), eq(schema.robots.vendorRobotId, sn)) });
    if (exists) continue;
    // task/list 에 필요한 product 값은 소모품 응답에서 가져온다(없으면 표 추정값).
    let product: string | null = null;
    try {
      product = (await api.listComponents(sn, 5)).list?.[0]?.product ?? null;
    } catch {
      product = null;
    }
    product = product ?? productParamFor(r.product_code);
    const seq = (await db.select({ id: schema.robots.id }).from(schema.robots)).length + 1;
    const id = `PW-R-${String(seq).padStart(3, "0")}`;
    const now = nowIso();
    await db.transaction(async (tx) => {
      await tx.insert(schema.robots).values({ id, vendor: "PUDU", model, vendorRobotId: sn, siteId, floorId, name: r.nickname || `${model} ${sn.slice(-4)}`, serial: sn, firmware: "", active: true, supportedCommands: PUDU_SUPPORTED_COMMANDS, internalNote: "", vendorMeta: { source: "api", shopId: String(r.shop_id), shopName: r.shop_name, productCode: r.product_code, product, mac: r.mac } });
      await tx.insert(schema.robotPlacements).values({ id: newId("plc"), robotId: id, siteId, from: now, to: null });
      await tx.insert(schema.robotStatus).values({ robotId: id, common: "UNKNOWN", raw: "등록 직후 — 첫 폴링 대기", online: false, batteryPct: null, pose: null, poseIsLastKnown: true, mapVersionId: floor.currentMapVersionId, currentMissionId: null, progressPct: null, lastReceivedAt: null, dataAt: null });
      await audit(user, { siteId, robotId: id, action: "VENDOR:PUDU_IMPORT_ROBOT", params: { sn, productCode: r.product_code, model }, result: "OK", detail: null, vendorTraceId: null }, tx);
    });
    n += 1;
  }
  return n;
}

/**
 * 콜백 자가 점검: 서버가 자기 공개 URL(APP_BASE_URL)/api/webhooks/pudu 로 CallbackCode 를 붙여 POST 해 본다.
 * 도메인·Cloudflare·프록시 예외·CallbackCode 가 맞게 설정됐는지 배포 후 확인하는 용도. PUDU 서버를 흉내 낼 뿐 PUDU 에 아무것도 보내지 않는다.
 */
export async function puduCallbackSelfTest(user: User): Promise<{ ok: boolean; message: string }> {
  assertAdmin(user);
  const code = process.env.PUDU_CALLBACK_CODE;
  if (!code) throw new ValidationError("PUDU_CALLBACK_CODE 가 서버 .env 에 없습니다. 대리점 플랫폼에서 콜백 URL 을 등록하고 받은 callback_code 를 넣은 뒤 재시작하세요.");
  const url = `${(process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "")}/api/webhooks/pudu`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", CallbackCode: code, TraceId: `selftest-${Date.now()}` }, body: JSON.stringify({ callback_type: "selfTest", data: { at: nowIso() } }), signal: controller.signal });
    const body = (await res.json().catch(() => ({}))) as { selfTest?: boolean };
    const ok = res.status === 200 && body.selfTest === true;
    await audit(user, { siteId: null, robotId: null, action: "VENDOR:PUDU_CALLBACK_SELFTEST", params: { url }, result: ok ? "OK" : "ERROR", detail: `HTTP ${res.status}`, vendorTraceId: null });
    return ok ? { ok: true, message: `콜백 URL 자가 점검 통과: ${url} 가 5초 안에 200 을 돌려줍니다(CallbackCode 일치).` } : { ok: false, message: `자가 점검 실패: ${url} → HTTP ${res.status}. 도메인·Cloudflare·프록시 예외·CallbackCode 를 확인하세요.` };
  } catch (e) {
    await audit(user, { siteId: null, robotId: null, action: "VENDOR:PUDU_CALLBACK_SELFTEST", params: { url }, result: "ERROR", detail: (e as Error).message, vendorTraceId: null });
    throw new ValidationError(`자가 점검 실패: ${url} 에 연결할 수 없습니다(${(e as Error).name === "AbortError" ? "5초 초과" : (e as Error).message}).`);
  } finally {
    clearTimeout(timer);
  }
}
