import Link from "next/link";
import { getCurrentUser } from "@/lib/auth/session";
import { getRobotDetail } from "@/lib/services/robots";
import { isCustomer } from "@/lib/auth/authz";
import { AppError } from "@/lib/util/errors";
import { Card, KV, Notice, PageTitle, SimTag } from "@/components/ui";
import { AccessDenied } from "@/components/AccessDenied";
import { FloorMap } from "@/components/FloorMap";
import { AutoRefresh } from "@/components/AutoRefresh";
import { CommandPanel } from "@/components/CommandPanel";
import { InspectionPanel } from "@/components/InspectionPanel";
import { Battery, CommandStateBadge, IncidentStatusBadge, SeverityBadge, StatusBadge } from "@/components/StatusBadge";
import { formatDateTime, relativeFromNow } from "@/lib/util/time";
import { MODEL_LABEL, VENDOR_LABEL } from "@/lib/domain/commands";
import { COMMAND_LABEL, RUN_RESULT_LABEL } from "@/lib/domain/status";
import { canRetry } from "@/lib/services/commands";

export default async function RobotPage({ params }: { params: Promise<{ robotId: string }> }) {
  const { robotId } = await params;
  const user = await getCurrentUser();
  let d;
  try {
    d = await getRobotDetail(user, robotId);
  } catch (e) {
    return <AccessDenied reason={e instanceof AppError ? e.message : "접근할 수 없습니다."} />;
  }
  const tz = d.site.timezone;
  const customer = isCustomer(user);
  const st = d.status;

  return (
    <>
      <AutoRefresh seconds={5} />
      <PageTitle
        title={`${d.robot.name}`}
        subtitle={
          <>
            {VENDOR_LABEL[d.robot.vendor]} {MODEL_LABEL[d.robot.model]} · 관리번호 {d.robot.id} ·{" "}
            <Link href={`/sites/${d.site.id}?floor=${d.floor.id}`} className="underline">
              {d.site.name} / {d.floor.name}
            </Link>
          </>
        }
        right={<StatusBadge status={st.common} />}
      />

      {d.mapMismatch && <div className="mb-3"><Notice tone="warn">로봇이 보고한 지도 버전({st.mapVersionId})이 이 층의 현재 지도({d.map?.id})와 다릅니다. 영역 지정 명령은 차단됩니다.</Notice></div>}
      {st.common === "UNKNOWN" && <div className="mb-3"><Notice tone="warn">상태 데이터가 수신된 적이 없습니다(상태 불명). 수치 0 이 아니라 &lsquo;미수신&rsquo;으로 표시합니다.</Notice></div>}

      <div className="grid lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <Card title="현재 상태">
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-2">
              <KV
                items={[
                  { k: "공통 상태", v: <StatusBadge status={st.common} /> },
                  { k: "원시 상태", v: customer ? <span className="text-gray-400">(고객 비공개)</span> : <code className="text-xs">{st.raw || "(없음)"}</code> },
                  { k: "통신", v: st.online ? <span className="text-emerald-700">온라인</span> : <span className="text-gray-700">오프라인</span> },
                  { k: "배터리", v: <Battery pct={st.batteryPct} /> },
                  { k: "작업 진행", v: st.progressPct === null ? "해당 없음" : `${Math.round(st.progressPct)}%` },
                ]}
              />
              <KV
                items={[
                  { k: "마지막 수신", v: <>{formatDateTime(st.lastReceivedAt, tz)} <span className="text-xs text-gray-500">({relativeFromNow(st.lastReceivedAt, d.now)})</span></> },
                  { k: "데이터 발생", v: formatDateTime(st.dataAt, tz) },
                  { k: "위치", v: st.pose ? `${st.poseIsLastKnown ? "마지막 보고 위치" : "현재 위치"} (지도 px ${Math.round(st.pose.x)}, ${Math.round(st.pose.y)})` : !d.isSimulation && !d.map?.imageUrl ? <span className="text-amber-700">지도 미연결 — 관리 설정에서 이 층에 제조사 지도를 가져오면 표시됩니다</span> : "미수신" },
                  { k: "지도 버전", v: st.mapVersionId ?? "미수신" },
                  { k: "현재 작업", v: st.currentMissionId ?? "없음" },
                ]}
              />
            </div>
            {d.map && (
              <div className="mt-3">
                <FloorMap map={d.map} zones={d.zones} robots={[{ id: d.robot.id, name: d.robot.name, common: st.common, pose: st.pose, poseIsLastKnown: st.poseIsLastKnown, batteryPct: st.batteryPct, progressPct: st.progressPct }]} highlightRobotId={d.robot.id} />
              </div>
            )}
          </Card>

          <Card title="원격 작업 지시" right={d.isSimulation ? <SimTag /> : null}>
            {!d.site.remoteControlEnabled ? (
              <p className="text-sm text-gray-600">이 사업장은 원격 제어가 꺼져 있습니다. {customer ? "필요하면 본사에 요청하세요." : "본사 관리자가 관리 설정 → 원격 제어(사업장별)에서 켤 수 있습니다."}</p>
            ) : (
            <CommandPanel
              robotId={d.robot.id}
              vendor={d.robot.vendor}
              model={d.robot.model}
              allowed={d.allowedCommands}
              supported={d.robot.supportedCommands}
              tasks={d.tasks}
              map={d.map}
              zones={d.zones}
              robot={{ id: d.robot.id, name: d.robot.name, common: st.common, pose: st.pose, poseIsLastKnown: st.poseIsLastKnown, batteryPct: st.batteryPct, progressPct: st.progressPct }}
              isSimulation={d.isSimulation}
              mapMismatch={d.mapMismatch}
            />
            )}
            {!customer && d.commands.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <div className="text-sm font-medium mb-1">명령 이력</div>
                <table className="data">
                  <thead>
                    <tr>
                      <th>요청 시각</th>
                      <th>명령</th>
                      <th>상태</th>
                      <th>결과 메시지</th>
                      <th>추적 ID</th>
                      <th>재시도</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.commands.map((c) => {
                      const r = canRetry(c, d.now);
                      return (
                        <tr key={c.id}>
                          <td className="whitespace-nowrap">{formatDateTime(c.requestedAt, tz)}</td>
                          <td>{COMMAND_LABEL[c.type]}</td>
                          <td><CommandStateBadge state={c.state} /></td>
                          <td className="text-xs">{c.message}</td>
                          <td className="font-mono text-xs">{c.vendorTraceId ?? "-"}</td>
                          <td className="text-xs">{c.state === "UNKNOWN" || c.state === "FAILED" ? (r.ok ? <span className="text-amber-700">{r.reason}</span> : <span className="text-gray-500">{r.reason}</span>) : "-"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="작업 이력 (최근 30건)">
            <div className="overflow-x-auto">
              <table className="data">
                <thead>
                  <tr>
                    <th>시작</th>
                    <th>구분</th>
                    <th>결과</th>
                    <th>면적</th>
                    <th>시간</th>
                    <th>물/세제</th>
                    <th>종료 사유</th>
                  </tr>
                </thead>
                <tbody>
                  {d.runs.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">{formatDateTime(r.startedAt, tz)}</td>
                      <td>{r.origin === "PLANNED" ? "계획" : r.origin === "REMOTE" ? "원격 지시" : "즉시 지시"}</td>
                      <td className={r.result === "COMPLETED" ? "text-emerald-700" : "text-amber-700"}>{RUN_RESULT_LABEL[r.result]}</td>
                      <td>{r.areaM2.toLocaleString()}㎡</td>
                      <td>{r.durationMin}분</td>
                      <td className="text-xs">{r.waterL === null ? <span className="text-gray-400">미제공</span> : `${r.waterL}L / ${r.detergentMl ?? "-"}mL`}</td>
                      <td className="text-xs">{r.endReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <Card title="로봇 정보">
            <KV
              items={[
                { k: "제조사", v: VENDOR_LABEL[d.robot.vendor] },
                { k: "모델", v: MODEL_LABEL[d.robot.model] },
                { k: "내부 관리번호", v: d.robot.id },
                { k: "제조사 ID", v: customer ? <span className="text-gray-400">(고객 비공개)</span> : <code className="text-xs">{d.robot.vendorRobotId}</code> },
                { k: "시리얼", v: d.robot.serial },
                { k: "펌웨어", v: d.robot.firmware },
                { k: "지원 명령", v: d.robot.supportedCommands.map((c) => COMMAND_LABEL[c]).join(", ") },
                ...(customer ? [] : [{ k: "내부 메모", v: d.robot.internalNote || <span className="text-gray-400">없음</span> }]),
              ]}
            />
            <div className="mt-3 text-xs text-gray-500">
              배치 이력:
              <ul className="list-disc ml-4">
                {d.placements.map((p) => (
                  <li key={p.from}>
                    {p.siteName} ({formatDateTime(p.from, tz)} ~ {p.to ? formatDateTime(p.to, tz) : "현재"})
                  </li>
                ))}
              </ul>
              {d.placements.length > 1 && <p className="mt-1">이전 사업장에서의 실적은 그 사업장 보고서에 남습니다.</p>}
            </div>
          </Card>

          <Card title="유지관리">
            <table className="data">
              <tbody>
                {d.maintenance.map((m) => (
                  <tr key={m.name}>
                    <td>{m.name}</td>
                    <td className="text-right">
                      {m.source === "UNSUPPORTED" ? <span className="text-gray-400 text-xs">API 미제공(미확인)</span> : m.source === "MANUAL" ? <span className="text-xs">수기</span> : m.remainingPct === null ? "미수신" : `${m.remainingPct}%`}
                      {m.source === "API" && d.isSimulation && <span className="ml-1 text-[10px] text-amber-700">샘플</span>}
                      {m.source === "API" && !d.isSimulation && <span className="ml-1 text-[10px] text-blue-700">API</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {d.robot.vendor === "CENOBOTS" && <p className="text-xs text-gray-500 mt-2">L4 의 잔여 수명은 maintenance-detail API 를 실기에서 시험한 뒤 사용합니다. consumablesStatistics 는 SP50 전용이라 근거로 쓰지 않습니다.</p>}
          </Card>

          <Card title="점검표">
            <InspectionPanel robotId={d.robot.id} inspections={d.inspections} canEdit={!customer} tz={tz} />
          </Card>

          <Card title="장애 이력">
            {d.incidents.length === 0 ? (
              <p className="text-sm text-gray-500">장애 이력이 없습니다.</p>
            ) : (
              <ul className="divide-y text-sm">
                {d.incidents.map((i) => (
                  <li key={i.id} className="py-2">
                    <div className="flex flex-wrap gap-1 items-center">
                      <SeverityBadge severity={i.severity} />
                      <IncidentStatusBadge status={i.status} />
                      <span className="text-xs text-gray-500">{formatDateTime(i.occurredAt, tz)}</span>
                    </div>
                    <div className="mt-0.5">{i.message}</div>
                    {i.rawMessage && <div className="text-xs text-gray-500 font-mono">{i.rawMessage}</div>}
                  </li>
                ))}
              </ul>
            )}
            <Link href={`/incidents?site=${d.site.id}`} className="text-xs text-navy hover:underline mt-2 inline-block">장애·조치 화면으로</Link>
          </Card>
        </div>
      </div>
    </>
  );
}
