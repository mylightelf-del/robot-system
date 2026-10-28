import { sql } from "drizzle-orm";
import type { StoreData } from "@/lib/store/data";
import { getDb, schema } from "./client";
import { hashPassword } from "@/lib/auth/password";
import { nowIso } from "@/lib/util/time";

const TABLES_IN_DELETE_ORDER = [
  "sessions",
  "site_permissions",
  "notification_logs",
  "incident_actions",
  "incidents",
  "commands",
  "actual_runs",
  "planned_runs",
  "schedules",
  "registered_tasks",
  "inspections",
  "maintenance_items",
  "report_versions",
  "audit_logs",
  "robot_status",
  "robot_placements",
  "robots",
  "zones",
  "map_versions",
  "floors",
  "notification_recipients",
  "notification_settings",
  "vendor_connections",
  "app_settings",
  "users",
  "sites",
];

/** 모든 업무 테이블을 비운다(마이그레이션 이력은 유지). 테스트·샘플 초기화 전용. */
export async function resetDatabase(): Promise<void> {
  const db = getDb();
  await db.execute(sql.raw(`TRUNCATE TABLE ${TABLES_IN_DELETE_ORDER.map((t) => `"${t}"`).join(", ")} CASCADE`));
}

/**
 * 샘플 StoreData 를 DB 에 적재한다. 샘플 사용자에게는 개발용 공통 비밀번호를 설정한다.
 * 운영 DB 에는 이 함수를 사용하지 않는다(ALLOW_SAMPLE_RESET=false).
 */
export async function seedDatabase(data: StoreData, samplePassword: string): Promise<void> {
  const db = getDb();
  const passwordHash = await hashPassword(samplePassword);
  const chunk = async <T>(rows: T[], insert: (rows: T[]) => Promise<unknown>) => {
    for (let i = 0; i < rows.length; i += 500) await insert(rows.slice(i, i + 500));
  };

  await db.transaction(async (tx) => {
    await tx.insert(schema.sites).values(data.sites);
    await tx.insert(schema.floors).values(data.floors);
    await tx.insert(schema.mapVersions).values(data.mapVersions);
    await tx.insert(schema.zones).values(data.zones);
    await tx.insert(schema.robots).values(data.robots);
    await tx.insert(schema.robotPlacements).values(data.placements.map((p, i) => ({ id: `plc-${p.robotId}-${i}`, ...p })));
    await tx.insert(schema.robotStatus).values(Object.values(data.statuses));
    await tx.insert(schema.registeredTasks).values(data.tasks);
    await tx.insert(schema.schedules).values(data.schedules);
    await chunk(data.plannedRuns, (rows) => tx.insert(schema.plannedRuns).values(rows));
    const robotById = new Map(data.robots.map((r) => [r.id, r]));
    await chunk(
      data.actualRuns.map((r) => ({ ...r, vendor: robotById.get(r.robotId)!.vendor, vendorRobotId: robotById.get(r.robotId)!.vendorRobotId })),
      (rows) => tx.insert(schema.actualRuns).values(rows),
    );
    await tx.insert(schema.commands).values(data.commands.map((c) => ({ ...c, idempotencyKey: (c.params.idempotencyKey as string | undefined) ?? null })));
    for (const inc of data.incidents) {
      const { actions, notifications, ...row } = inc;
      await tx.insert(schema.incidents).values(row);
      if (actions.length) await tx.insert(schema.incidentActions).values(actions.map((a) => ({ ...a, incidentId: inc.id })));
      if (notifications.length) await tx.insert(schema.notificationLogs).values(notifications.map((n) => ({ ...n, incidentId: inc.id })));
    }
    await chunk(data.inspections, (rows) => tx.insert(schema.inspections).values(rows));
    await tx.insert(schema.maintenanceItems).values(
      Object.entries(data.maintenance).flatMap(([robotId, items]) => items.map((m, i) => ({ id: `mnt-${robotId}-${i}`, robotId, ...m }))),
    );
    await tx.insert(schema.reportVersions).values(data.reports);
    await tx.insert(schema.auditLogs).values(data.audit);
    await tx.insert(schema.users).values(
      data.users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        active: u.active,
        passwordHash,
        inviteToken: null,
        inviteExpiresAt: null,
        failedLogins: 0,
        lockedUntil: null,
        lastLoginAt: null,
        createdAt: nowIso(),
      })),
    );
    const perms = data.users.flatMap((u) => u.sitePermissions.map((p) => ({ userId: u.id, siteId: p.siteId, allowedCommands: p.allowedCommands })));
    if (perms.length) await tx.insert(schema.sitePermissions).values(perms);
    await tx.insert(schema.notificationSettings).values(data.notificationSettings.map((n) => ({ siteId: n.siteId, dedupeMinutes: n.dedupeMinutes, escalateAfterMinutes: n.escalateAfterMinutes })));
    await tx.insert(schema.notificationRecipients).values(data.notificationSettings.flatMap((n) => n.recipients.map((r) => ({ ...r, siteId: n.siteId }))));
    await tx.insert(schema.vendorConnections).values(data.vendorConnections);
    // 워커가 동시에 기본 설정 행을 만들 수 있으므로(loadSettings) 덮어쓰기로 넣는다.
    const settingsRow = { id: "default", ...data.settings, staleThresholdMinutes: 15 };
    await tx.insert(schema.appSettings).values(settingsRow).onConflictDoUpdate({ target: schema.appSettings.id, set: settingsRow });
  });
}
