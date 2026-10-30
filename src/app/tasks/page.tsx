import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { listPlannedRuns, listTasks } from "@/lib/services/tasks";
import { listCommands } from "@/lib/services/commands";
import { listRobots, listSites, listZonesInSites } from "@/lib/services/robots";
import { isCustomer } from "@/lib/auth/authz";
import { AppError } from "@/lib/util/errors";
import { Card, Empty, PageTitle, SimTag } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { SiteFilter } from "@/components/SiteFilter";
import { CancelPlannedButton, NewScheduleForm, NewTaskForm, ScheduleToggle } from "@/components/TaskPanels";
import { CommandStateBadge } from "@/components/StatusBadge";
import { COMMAND_LABEL, PLANNED_STATUS_LABEL, RUN_RESULT_LABEL } from "@/lib/domain/status";
import { addMinutes, formatDateTime, nowIso } from "@/lib/util/time";

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ site?: string; show?: string }> }) {
  const { site, show } = await searchParams;
  // 등록 작업 필터: 예약된 작업만(기본) / 등록 작업 포함(예약 없는 작업까지 전체)
  const showAll = show === "all";
  const user = await getCurrentUser();
  let tasks, sites, planned, commands, robots;
  const now = nowIso();
  try {
    sites = await listSites(user);
    tasks = await listTasks(user, site || undefined);
    planned = await listPlannedRuns(user, { siteId: site || undefined, fromIso: addMinutes(now, -60 * 24), toIso: addMinutes(now, 60 * 48) });
    commands = await listCommands(user, { siteId: site || undefined, limit: 20 });
    robots = await listRobots(user, site || undefined);
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const customer = isCustomer(user);
  const zones = await listZonesInSites(site ? [site] : sites.map((s) => s.id));
  const allTasks = tasks;
  const scheduledCount = allTasks.filter((t) => t.schedules.some((s) => s.enabled)).length;
  tasks = showAll ? allTasks : allTasks.filter((t) => t.schedules.some((s) => s.enabled));
  const q = (v: string) => `/tasks?${new URLSearchParams({ ...(site ? { site } : {}), ...(v === "all" ? { show: "all" } : {}) }).toString()}`;
  const chip = (active: boolean) => `px-2 py-0.5 rounded border text-xs ${active ? "bg-navy text-white border-navy" : "bg-white border-gray-300 text-gray-700"}`;

  return (
    <>
      <PageTitle title="작업·일정" subtitle="등록 작업, 예약, 예정 회차와 원격 명령 이력" right={<SiteFilter sites={sites} current={site ?? ""} basePath="/tasks" extra={showAll ? "show=all" : ""} />} />

      <div className="grid lg:grid-cols-2 gap-4">
        <Card
          className="min-w-0"
          title="등록 작업 · 예약"
          right={
            <span className="flex flex-wrap gap-1 items-center">
              <Link href={q("scheduled")} className={chip(!showAll)}>예약된 작업만 {scheduledCount}</Link>
              <Link href={q("all")} className={chip(showAll)}>등록 작업 포함 {allTasks.length}</Link>
            </span>
          }
        >
          {tasks.length === 0 ? (
            <Empty>{showAll ? "등록 작업이 없습니다." : "사용 중인 예약이 있는 작업이 없습니다. '등록 작업 포함'을 누르면 예약 없는 작업까지 보입니다."}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>작업</th>
                    <th>로봇</th>
                    <th>구역</th>
                    <th>예약</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr key={t.task.id}>
                      <td>
                        <div className="font-medium">{t.task.name}</div>
                        <div className="text-xs text-gray-500">{t.siteName} · {t.task.mode}{t.task.vendorTaskRef ? ` · 제조사 참조 ${t.task.vendorTaskRef}` : ""}</div>
                      </td>
                      <td>
                        <Link href={`/robots/${t.task.robotId}`} className="text-navy hover:underline">{t.robotName}</Link>
                        <div className="text-xs text-gray-500">{t.vendor} {t.model}</div>
                      </td>
                      <td className="text-xs">{t.zoneNames.join(", ")}</td>
                      <td>
                        {t.schedules.length === 0 ? (
                          <span className="text-gray-400 text-xs">없음</span>
                        ) : (
                          <ul className="space-y-1">
                            {t.schedules.map((s) => (
                              <li key={s.id} className="text-xs flex items-center gap-2 flex-wrap">
                                <span className={s.enabled ? "" : "line-through text-gray-400"}>
                                  {s.daysOfWeek.map((d) => DOW[d]).join("")} {s.time}
                                </span>
                                <span className={`rounded px-1 ${s.executor === "VENDOR" ? "bg-sky-50 text-sky-800" : "bg-gray-100 text-gray-700"}`}>{s.executor === "VENDOR" ? "제조사 예약" : "자체 실행기"}</span>
                                {!customer && <ScheduleToggle scheduleId={s.id} enabled={s.enabled} disabled={false} />}
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!customer && (
            <div className="mt-4 space-y-4">
              <details className="border rounded p-3">
                <summary className="cursor-pointer text-sm font-medium">새 작업 등록</summary>
                <div className="mt-2">
                  <NewTaskForm robots={robots.map((r) => ({ id: r.robot.id, name: r.robot.name, floorId: r.floor.id, model: r.robot.model, siteName: r.site.name }))} zones={zones} />
                </div>
              </details>
              <details className="border rounded p-3">
                <summary className="cursor-pointer text-sm font-medium">예약 추가</summary>
                <div className="mt-2">
                  <NewScheduleForm tasks={allTasks.map((t) => ({ id: t.task.id, name: t.task.name, robotName: t.robotName }))} />
                </div>
              </details>
            </div>
          )}
        </Card>

        <Card className="min-w-0" title="예정 작업 회차 (어제 ~ 모레)" right={<span className="text-xs text-gray-500">{planned.length}회</span>}>
          {planned.length === 0 ? (
            <Empty>표시할 회차가 없습니다.</Empty>
          ) : (
            <div className="overflow-x-auto max-h-[520px] overflow-y-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>예정 시각</th>
                    <th>작업 / 로봇</th>
                    <th>상태</th>
                    <th>실제 결과</th>
                    {!customer && <th></th>}
                  </tr>
                </thead>
                <tbody>
                  {planned.map((p) => (
                    <tr key={p.id}>
                      <td className="whitespace-nowrap">{formatDateTime(p.plannedAt)}</td>
                      <td>
                        <div className="text-sm">{p.taskName}</div>
                        <div className="text-xs text-gray-500">{p.robotName} · {p.siteName}</div>
                      </td>
                      <td>
                        <span className={p.status === "MISSED" ? "text-red-700" : p.status === "DONE" ? "text-emerald-700" : p.status === "PLANNED" ? "text-gray-700" : "text-gray-500"}>{PLANNED_STATUS_LABEL[p.status]}</span>
                        {p.reason && <div className="text-xs text-gray-500">{p.reason}</div>}
                      </td>
                      <td className="text-xs">{p.runResult ? RUN_RESULT_LABEL[p.runResult as keyof typeof RUN_RESULT_LABEL] : "-"}</td>
                      {!customer && <td>{p.status === "PLANNED" && p.plannedAt > now ? <CancelPlannedButton plannedId={p.id} /> : null}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-gray-500 mt-2">예정 회차와 실제 수행을 연결해 미실행 작업을 찾습니다. 휴일·취소는 유효 계획에서 제외하고 변경 이력을 남깁니다.</p>
        </Card>
      </div>

      <div className="mt-4">
        <Card title="원격 명령 이력" right={<SimTag>샘플 어댑터</SimTag>}>
          {commands.length === 0 ? (
            <Empty>{customer ? "본인이 내린 명령이 없습니다." : "명령 이력이 없습니다."}</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>요청 시각</th>
                    <th>사용자</th>
                    <th>로봇</th>
                    <th>명령</th>
                    <th>상태</th>
                    <th>메시지</th>
                  </tr>
                </thead>
                <tbody>
                  {commands.map((c) => (
                    <tr key={c.id}>
                      <td className="whitespace-nowrap">{formatDateTime(c.requestedAt)}</td>
                      <td>{c.userName}</td>
                      <td>
                        <Link href={`/robots/${c.robotId}`} className="text-navy hover:underline">{c.robotName}</Link>
                        <div className="text-xs text-gray-500">{c.siteName}</div>
                      </td>
                      <td>{COMMAND_LABEL[c.type]}</td>
                      <td><CommandStateBadge state={c.state} /></td>
                      <td className="text-xs">{c.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-gray-500 mt-2">명령은 요청 → 접수 → 실행 확인 → 완료/실패/결과 불명으로 관리합니다. HTTP 접수만으로 완료 처리하지 않습니다.</p>
        </Card>
      </div>
    </>
  );
}
