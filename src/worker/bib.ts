import { and, eq, sql } from "drizzle-orm";
import { newId } from "@/lib/util/random";
import type { Robot } from "@/lib/domain/types";
import { getDb, schema } from "@/lib/db/client";
import { nowIso } from "@/lib/util/time";
import { vendorMode } from "@/lib/vendors";
import { createBibApi, type BibApi } from "@/lib/vendors/bib/api";
import { mapBibStatus } from "@/lib/vendors/bib/mapping";
import { recordVendorSync, type SyncResult } from "./pudu";
import { imageSize } from "@/lib/services/sites";
import { importExternalMap, siteMapFor, syncVendorFloorMaps } from "@/lib/services/vendorMaps";

/**
 * BIB(라이노스 Rhiverse) 동기화 — 조회 전용(docs/22 §6). 가이드 v0.1 에는 청소 실적·장애 이력 API 가 없다.
 * 사용자 결정(2026-11-26 「있는 대로만」): 상태 폴링에서 현재 작업이 나타났다 사라지는 것을 보고 **관측 기반 작업 기록**을 실적으로 남긴다
 * (시작·종료는 폴링 간격(60초) 정밀도, 면적·결과는 미제공 → 면적 0, 결과 '완료'로 두고 종료 사유에 관측 기반임을 적는다). 장애 이력은 없음.
 * 주기: 상태 BIB_POLL_STATUS_SECONDS(60), 목록·작업 BIB_POLL_CATALOG_MINUTES(60). 끄기: BIB_MODE=unconfigured.
 */
const sync = (job: string, fn: () => Promise<{ detail: string; counts?: Record<string, number> }>) => recordVendorSync("BIB", job, fn);

export function bibEnabled(): boolean {
  return vendorMode("BIB") === "live";
}

/** 연결된(사용 중) BIB 로봇: 제조사 목록에서 일련번호로 연결된 것(vendorMeta.source="api"). */
export async function bibRobots(): Promise<Robot[]> {
  return (await getDb()
    .select()
    .from(schema.robots)
    .where(and(eq(schema.robots.vendor, "BIB"), eq(schema.robots.active, true), sql`${schema.robots.vendorMeta} ->> ${"source"} = ${"api"}`))) as unknown as Robot[];
}

/** 로봇 목록 → 미리 등록한 로봇(vendorMeta.sn)에 robotId 연결 + 등록 작업. 연결된 로봇은 다시 사용으로 바꾼다. */
export async function syncBibCatalog(api: BibApi = createBibApi()): Promise<SyncResult> {
  return sync("catalog", async () => {
    const db = getDb();
    const list = await api.listRobots();
    const all = await db.select().from(schema.robots).where(eq(schema.robots.vendor, "BIB"));
    let bound = 0;
    let tasks = 0;
    for (const r of all) {
      const sn = String(r.vendorMeta?.sn ?? r.serial ?? "");
      const hit = list.find((x) => x.handle1 === sn);
      if (!hit) continue;
      const meta = { ...(r.vendorMeta ?? {}), source: "api", bibRobotId: hit.robotId, bibName: hit.name, boundAt: (r.vendorMeta?.boundAt as string | undefined) ?? nowIso() };
      if (r.vendorRobotId !== hit.robotId || r.vendorMeta?.source !== "api" || !r.active) {
        await db.update(schema.robots).set({ vendorRobotId: hit.robotId, vendorMeta: meta, active: true }).where(eq(schema.robots.id, r.id));
        bound += 1;
      }
      for (const t of await api.tasks(hit.robotId)) {
        const id = `task-bib-${t.taskId}`.slice(0, 120);
        const name = t.name || t.taskId;
        await db.insert(schema.registeredTasks).values({ id, siteId: r.siteId, robotId: r.id, name, zoneIds: [], mode: "SCRUB", vendorTaskRef: t.taskId }).onConflictDoUpdate({ target: schema.registeredTasks.id, set: { name, siteId: r.siteId } });
        tasks += 1;
      }
    }
    return { detail: `계정 로봇 ${list.length}대 · 연결 ${bound} · 등록 작업 ${tasks}`, counts: { robots: list.length, bound, tasks } };
  });
}

/**
 * 층 지도 맞추기(조회만): 로봇의 로컬 지도들을 이름으로 사업장 층에 짝지어 그림을 가져온다(규칙은 services/vendorMaps).
 * BIB 위치는 지도 그림 픽셀(왼쪽 위 0,0 · y 아래로)이라 모서리를 그림 픽셀 그대로 둔다(변환 없이 그림 위 좌표).
 * 판 구분: mapHandle(가이드 v0.1 에 판 정보 없음 — 같은 handle 의 그림이 바뀌면 관리 화면 「그림 다시 받기」).
 */
export async function syncBibMaps(api: BibApi = createBibApi()): Promise<SyncResult> {
  return sync("maps", async () => {
    const robots = await bibRobots();
    const list = [];
    for (const robot of robots) {
      const l = await api.maps(robot.vendorRobotId).catch(() => null);
      list.push({ robot, maps: (l?.localMapList ?? []).map((m) => ({ name: m.name || m.mapHandle, version: m.mapHandle, inUse: m.mapHandle === l?.activeMapHandle })) });
    }
    return syncVendorFloorMaps("BIB", list, async (floorId, robot, ref) => {
      const m = await api.localMap(robot.vendorRobotId, ref.version);
      let bytes: Buffer;
      let mime = m.image.mimeType ?? "";
      if (m.image.type === "BASE64") bytes = Buffer.from(m.image.data, "base64");
      else if (m.image.type === "URL" && /^https?:\/\//.test(m.image.data)) {
        const res = await fetch(m.image.data, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw new Error(`지도 그림 HTTP ${res.status}`);
        bytes = Buffer.from(await res.arrayBuffer());
        mime = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      } else throw new Error(`알 수 없는 그림 형식(${m.image.type})`);
      const size = imageSize(bytes);
      if (!size) throw new Error("그림 크기를 읽지 못함(PNG 아님)");
      const { width: W, height: H } = size;
      const r = await importExternalMap({
        floorId,
        vendor: "BIB",
        mapName: ref.name,
        mapVersion: ref.version,
        widthPx: W,
        heightPx: H,
        corners: { bl: [0, H], tl: [0, 0], tr: [W, 0], br: [W, H] },
        image: { bytes, source: `bib:${robot.vendorRobotId}/${ref.version}`, mimeType: mime },
      });
      return `「${ref.name}」 가져옴 v${r.version}(${robot.id}, ${W}×${H}px) · 그림 ${r.imageStored ? "보관" : `실패(${r.imageError})`}`;
    });
  });
}

/** 상태·현재 작업·현재 지도(원시값). 층은 바꾸지 않는다(로봇 층은 관리자가 정함). */
export async function syncBibStatus(api: BibApi = createBibApi()): Promise<SyncResult> {
  return sync("status", async () => {
    const db = getDb();
    const robots = await bibRobots();
    let updated = 0;
    let failed = 0;
    for (const robot of robots) {
      const rid = robot.vendorRobotId;
      try {
        const s = await api.status(rid);
        const cur = await api.currentTask(rid).catch(() => null);
        const maps = await api.maps(rid).catch(() => null);
        const mapName = maps?.localMapList.find((m) => m.mapHandle === maps.activeMapHandle)?.name ?? null;
        const m = mapBibStatus(s, cur);
        const at = nowIso();
        // 위치: 그림 좌표계(image·pixel)이고 그 지도가 이 층의 현재 지도일 때만 그린다(다른 좌표계·지도면 그리지 않음 — 가이드)
        const p = s.online === false ? null : await api.position(rid).catch(() => null);
        const lp = p?.localMapPosition;
        const map = p && lp?.frame === "image" && lp.unit === "pixel" ? await siteMapFor(robot, "BIB", p.mapHandle) : null;
        const pose = map && lp && Number.isFinite(lp.x) && Number.isFinite(lp.y) ? { x: Math.round(lp.x - (lp.originX || 0)), y: Math.round(lp.y - (lp.originY || 0)), headingDeg: 0 } : null;
        // 관측 기반 작업 기록: 이전 관측과 비교(작업 시작·종료)
        const prev = await db.query.robotStatus.findFirst({ where: eq(schema.robotStatus.robotId, robot.id) });
        const prevObs = ((prev?.rawPayload ?? {}) as { obs?: { taskId: string; startedAt: string } | null }).obs ?? null;
        const nowTask = s.online === false ? null : (cur?.task?.taskId ?? null);
        let obs = prevObs;
        if (prevObs && prevObs.taskId !== nowTask) {
          await closeObservedRun(robot, prevObs, at);
          obs = null;
        }
        if (nowTask && !obs) obs = { taskId: nowTask, startedAt: at };
        const row = {
          robotId: robot.id,
          common: m.common,
          raw: `${m.raw}${mapName ? ` map=${mapName}` : ""}`,
          online: s.online === true,
          batteryPct: typeof s.batteryPercent === "number" ? s.batteryPercent : null,
          pose: pose ?? (map ? (prev?.pose ?? null) : null),
          poseIsLastKnown: !pose,
          mapVersionId: map?.id ?? null,
          currentMissionId: m.missionId,
          progressPct: null,
          lastReceivedAt: at,
          dataAt: s.timeObserved ?? s.timeReceived ?? at,
          rawPayload: { source: "poll", status: s, currentTask: cur, activeMap: mapName, obs },
        };
        await db.insert(schema.robotStatus).values(row).onConflictDoUpdate({ target: schema.robotStatus.robotId, set: row });
        updated += 1;
      } catch (e) {
        failed += 1;
        await db.update(schema.robotStatus).set({ raw: `poll error: ${(e as Error).message}` }).where(eq(schema.robotStatus.robotId, robot.id));
      }
    }
    return { detail: `로봇 ${robots.length}대 중 갱신 ${updated}, 실패 ${failed}`, counts: { robots: robots.length, updated, failed } };
  });
}

/** 관측된 작업 하나를 실적으로 남긴다(1분 미만은 버림). 같은 작업·시작 시각은 한 번만(vendorRunId). */
async function closeObservedRun(robot: Robot, obs: { taskId: string; startedAt: string }, endedAt: string): Promise<void> {
  const min = (new Date(endedAt).getTime() - new Date(obs.startedAt).getTime()) / 60_000;
  if (!(min >= 1)) return;
  const db = getDb();
  const task = await db.query.registeredTasks.findFirst({ where: eq(schema.registeredTasks.vendorTaskRef, obs.taskId) });
  await db
    .insert(schema.actualRuns)
    .values({
      id: newId("run"),
      vendor: "BIB",
      vendorRobotId: robot.vendorRobotId,
      vendorRunId: `obs-${obs.taskId}-${obs.startedAt}`,
      robotId: robot.id,
      siteId: robot.siteId,
      floorId: robot.floorId,
      taskId: task?.id ?? null,
      zoneIds: [],
      startedAt: obs.startedAt,
      endedAt,
      result: "COMPLETED",
      endReason: `관측 기반 기록(BIB API 에 작업 이력 없음 — 시작·종료는 1분 단위 관측, 면적·결과 미제공)${task ? ` · ${task.name}` : ""}`,
      areaM2: 0,
      durationMin: Math.round(min),
      waterL: null,
      detergentMl: null,
      origin: "ADHOC",
      receivedAt: endedAt,
      rawPayload: { observed: true, taskId: obs.taskId },
      coverage: null,
    })
    .onConflictDoNothing();
}
