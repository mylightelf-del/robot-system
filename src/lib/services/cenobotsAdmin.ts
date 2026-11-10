import { and, desc, eq, sql } from "drizzle-orm";
import type { User } from "@/lib/domain/types";
import { assertAdmin } from "@/lib/auth/authz";
import { getDb, schema } from "@/lib/db/client";
import { ValidationError } from "@/lib/util/errors";
import { newId } from "@/lib/util/random";
import { nowIso } from "@/lib/util/time";
import { vendorMode } from "@/lib/vendors";
import { cenobotsSettings, createCenobotsApi, isAllowedDevice, openIdOf } from "@/lib/vendors/cenobots/cenobotsAdapter";
import { hostFromEnv, parseList } from "@/lib/vendors/cenobots/client";
import { encryptCzWebhook } from "@/lib/vendors/cenobots/webhook";
import { cenobotsDryRun } from "@/worker/cenobots";
import { audit } from "./audit";
import { nextRobotId } from "./admin";

/**
 * 관리 설정 → 고급 설정의 「CENOBOTS Open API」 카드. 조회 전용 연동이며 비밀값은 돌려주지 않는다.
 */
export function cenobotsStatusInfo() {
  const mode = vendorMode("CENOBOTS");
  const base = (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return {
    mode,
    dryRun: cenobotsDryRun(),
    host: mode === "mock" ? "mock(내부 픽스처)" : (hostFromEnv() ?? null),
    keyConfigured: !!process.env.CENOBOTS_ACCESS_KEY && !!process.env.CENOBOTS_SECRET_KEY,
    allowed: parseList(process.env.CENOBOTS_ALLOWED_DEVICE_OPEN_IDS),
    webhookUrl: `${base}/api/webhooks/cenobots`,
    webhookConfigured: !!process.env.CENOBOTS_WEBHOOK_SECRET,
    webhookPublic: /^https:\/\//.test(base) && !/localhost|127\.0\.0\.1/.test(base),
  };
}

export async function cenobotsWebhookStats() {
  const [cb] = await getDb()
    .select({ last: sql<string | null>`max(${schema.vendorEvents.receivedAt})`, day: sql<number>`count(*) filter (where ${schema.vendorEvents.receivedAt} > now() - interval '24 hours')::int` })
    .from(schema.vendorEvents)
    .where(eq(schema.vendorEvents.vendor, "CENOBOTS"));
  return { lastAt: cb?.last ? new Date(cb.last).toISOString() : null, last24h: cb?.day ?? 0 };
}

export type CenobotsDeviceRow = { deviceOpenId: string; licensePlate: string; registered: string | null; mock: boolean };

/** 연결 확인 + 로봇 조회: 장비 목록 → 허용 목록만. */
export async function cenobotsTestConnection(user: User): Promise<{ ok: boolean; message: string; devices: CenobotsDeviceRow[] }> {
  assertAdmin(user);
  const s = cenobotsSettings();
  if (!s) return { ok: false, message: "CENOBOTS 연동이 꺼져 있습니다(CENOBOTS_MODE=unconfigured 또는 키·호스트·허용 장비 미설정).", devices: [] };
  const api = createCenobotsApi();
  try {
    const all = await api.listDevices();
    const allowed = all.filter((d) => isAllowedDevice(d, s.cfg.allowed));
    const robots = await getDb().select().from(schema.robots).where(eq(schema.robots.vendor, "CENOBOTS"));
    const devices = allowed.map((d) => ({
      deviceOpenId: d.deviceOpenId,
      licensePlate: d.licensePlate,
      registered: robots.find((r) => openIdOf(r) === d.deviceOpenId || r.vendorMeta?.licensePlate === d.licensePlate)?.id ?? null,
      mock: s.mode === "mock",
    }));
    await audit(user, { siteId: null, robotId: null, action: "VENDOR:CENOBOTS_TEST", params: { mode: s.mode, devices: all.length, allowed: allowed.length }, result: "OK", detail: null, vendorTraceId: null });
    return { ok: true, message: `${s.mode === "mock" ? "[모의] " : ""}연결 확인: 회사 장비 ${all.length}대 중 허용 장비 ${allowed.length}대`, devices };
  } catch (e) {
    const msg = (e as Error).message;
    await audit(user, { siteId: null, robotId: null, action: "VENDOR:CENOBOTS_TEST", params: { mode: s.mode }, result: "ERROR", detail: msg.slice(0, 300), vendorTraceId: null });
    return { ok: false, message: msg, devices: [] };
  }
}

/**
 * 장비 등록(또는 번호판으로 미리 등록한 로봇에 연결). 조회 전용이라 지원 명령은 비운다.
 * 운영 서버의 mock(dry-run)에서는 등록하지 않는다(가짜 deviceOpenId 가 운영 로봇에 붙지 않도록).
 */
export async function cenobotsImportRobots(user: User, siteId: string, floorId: string, openIds: string[]): Promise<number> {
  assertAdmin(user);
  if (cenobotsDryRun()) throw new ValidationError("운영 서버의 모의(mock) 모드에서는 로봇을 등록·연결하지 않습니다. 키를 받아 live 로 바꾼 뒤 등록하세요.");
  const s = cenobotsSettings();
  if (!s) throw new ValidationError("CENOBOTS 연동이 설정되지 않았습니다.");
  const db = getDb();
  const floor = await db.query.floors.findFirst({ where: and(eq(schema.floors.id, floorId), eq(schema.floors.siteId, siteId)) });
  if (!floor) throw new ValidationError("사업장의 층을 선택하세요.");
  const api = createCenobotsApi();
  const devices = (await api.listDevices()).filter((d) => isAllowedDevice(d, s.cfg.allowed));
  let n = 0;
  for (const openId of openIds) {
    const d = devices.find((x) => x.deviceOpenId === openId);
    if (!d) throw new ValidationError(`허용 장비 목록에 없는 deviceOpenId: ${openId}`);
    const robots = await db.select().from(schema.robots).where(eq(schema.robots.vendor, "CENOBOTS"));
    if (robots.some((r) => openIdOf(r) === openId && (r.vendorMeta?.boundMode ?? "live") === s.mode)) continue;
    const info = await api.info(openId).catch(() => null);
    const meta = { source: "api", deviceOpenId: openId, licensePlate: d.licensePlate, boundMode: s.mode, boundAt: nowIso() };
    const placeholder = robots.find((r) => r.vendorMeta?.licensePlate === d.licensePlate);
    if (placeholder) {
      // 번호판으로 미리 등록한 로봇: 연결만 한다(배치·사용 여부는 그대로)
      await db.update(schema.robots).set({ vendorRobotId: openId, serial: info?.serialNumber || placeholder.serial, firmware: info?.softwareVersion || placeholder.firmware, vendorMeta: { ...(placeholder.vendorMeta ?? {}), ...meta } }).where(eq(schema.robots.id, placeholder.id));
      await audit(user, { siteId: placeholder.siteId, robotId: placeholder.id, action: "VENDOR:CENOBOTS_BIND_ROBOT", params: { licensePlate: d.licensePlate, mode: s.mode }, result: "OK", detail: null, vendorTraceId: null });
      n += 1;
      continue;
    }
    const id = await nextRobotId(db);
    const now = nowIso();
    await db.transaction(async (tx) => {
      await tx.insert(schema.robots).values({ id, vendor: "CENOBOTS", model: "L4", vendorRobotId: openId, siteId, floorId, name: info?.remark || d.licensePlate, serial: info?.serialNumber ?? "", firmware: info?.softwareVersion ?? "", active: true, supportedCommands: [], internalNote: "조회 전용 연동", vendorMeta: meta });
      await tx.insert(schema.robotPlacements).values({ id: newId("plc"), robotId: id, siteId, from: now, to: null });
      await tx.insert(schema.robotStatus).values({ robotId: id, common: "UNKNOWN", raw: "등록 직후 — 첫 조회 대기", online: false, batteryPct: null, pose: null, poseIsLastKnown: true, mapVersionId: null, currentMissionId: null, progressPct: null, lastReceivedAt: null, dataAt: null });
      await audit(user, { siteId, robotId: id, action: "VENDOR:CENOBOTS_IMPORT_ROBOT", params: { licensePlate: d.licensePlate, mode: s.mode }, result: "OK", detail: null, vendorTraceId: null }, tx);
    });
    n += 1;
  }
  return n;
}

/** 웹훅 자가 점검: 공개 URL 로 암호화한 challenge 를 보내 같은 값이 돌아오는지(도메인·Caddy·시크릿 확인). 업체에는 아무것도 보내지 않는다. */
export async function cenobotsWebhookSelfTest(user: User): Promise<{ ok: boolean; message: string }> {
  assertAdmin(user);
  const secret = process.env.CENOBOTS_WEBHOOK_SECRET;
  const info = cenobotsStatusInfo();
  if (!secret) throw new ValidationError("CENOBOTS_WEBHOOK_SECRET 이 서버 .env 에 없습니다. 업체 구독을 만든 뒤 받은 시크릿을 넣고 재시작하세요.");
  const challenge = `selftest-${Math.random().toString(36).slice(2, 10)}`;
  const body = encryptCzWebhook(secret, { messageType: "challenge", data: { challenge } });
  try {
    const res = await fetch(info.webhookUrl, { method: "POST", headers: { "Content-Type": "application/json", "X-Webhook-Id": `evt_selftest_${Date.now()}`, "X-Webhook-Timestamp": String(Math.floor(Date.now() / 1000)) }, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(5000) });
    const json = (await res.json().catch(() => null)) as { challenge?: string } | null;
    const ok = res.status === 200 && json?.challenge === challenge;
    await audit(user, { siteId: null, robotId: null, action: "VENDOR:CENOBOTS_WEBHOOK_SELFTEST", params: { status: res.status }, result: ok ? "OK" : "ERROR", detail: null, vendorTraceId: null });
    return { ok, message: ok ? `자가 점검 통과: ${info.webhookUrl} 가 challenge 를 그대로 돌려줌(HTTP 200)` : `자가 점검 실패: HTTP ${res.status}${res.status >= 300 && res.status < 400 ? " — 리다이렉트(업체는 따라가지 않음)" : ""}` };
  } catch (e) {
    return { ok: false, message: `자가 점검 실패: ${(e as Error).message}` };
  }
}

export async function recentCenobotsEvents(limit = 5) {
  return getDb().select().from(schema.vendorEvents).where(eq(schema.vendorEvents.vendor, "CENOBOTS")).orderBy(desc(schema.vendorEvents.receivedAt)).limit(limit);
}
