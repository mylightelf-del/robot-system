"use client";

import { useState } from "react";
import { NOTIFY_KIND_LABEL, NOTIFY_KINDS, type CommandType, type NotifyKind, type Role, type Severity, type User } from "@/lib/domain/types";
import { COMMAND_LABEL, ROLE_LABEL } from "@/lib/domain/status";
import {
  addRecipientAction,
  createUserAction,
  reissueInviteAction,
  relocateRobotAction,
  removeRecipientAction,
  setRobotActiveAction,
  testRecipientAction,
  updateRecipientAction,
  resetSampleAction,
  setSiteManagerCanConfirmAction,
  setRemoteControlAction,
  setUserActiveAction,
  setUserPermissionsAction,
  updateThresholdsAction,
} from "@/app/actions";
import { ActionButton, btn, ResultLine, useAction } from "./ActionButton";

const CMDS: CommandType[] = ["START_TASK", "PAUSE", "RESUME", "STOP", "GO_HOME", "AREA_CLEAN"];
const ROLES: Role[] = ["HQ_ADMIN", "SITE_MANAGER", "CUSTOMER_BASIC", "CUSTOMER_CONTROL"];

export function UserRow({ u, sites, selfId, auth }: { u: User; sites: { id: string; name: string }[]; selfId: string; auth: { hasPassword: boolean; inviteLink: string | null; lastLoginAt: string | null } }) {
  const { pending, result, run } = useAction();
  const [siteIds, setSiteIds] = useState(u.sitePermissions.map((p) => p.siteId));
  const [cmds, setCmds] = useState<CommandType[]>(u.sitePermissions[0]?.allowedCommands ?? []);
  return (
    <tr className={u.active ? "" : "opacity-60"}>
      <td>
        <div className="font-medium">{u.name}</div>
        <div className="text-xs text-gray-500">{u.email}</div>
      </td>
      <td>
        {ROLE_LABEL[u.role]}
        <div className="text-[11px] text-gray-500">{auth.hasPassword ? "비밀번호 설정됨" : "초대 대기"}{auth.lastLoginAt ? "" : " · 로그인 기록 없음"}</div>
      </td>
      <td>
        <div className="flex flex-wrap gap-1">
          {sites.map((s) => (
            <label key={s.id} className="text-xs flex items-center gap-0.5 border rounded px-1">
              <input type="checkbox" checked={siteIds.includes(s.id)} disabled={u.role === "HQ_ADMIN"} onChange={(e) => setSiteIds((v) => (e.target.checked ? [...v, s.id] : v.filter((x) => x !== s.id)))} />
              {s.name.replace(/^가상 사업장 /, "")}
            </label>
          ))}
        </div>
        {u.role === "HQ_ADMIN" && <div className="text-[11px] text-gray-500">본사 관리자는 전체 사업장</div>}
      </td>
      <td>
        {u.role === "CUSTOMER_CONTROL" ? (
          <div className="flex flex-wrap gap-1">
            {CMDS.map((c) => (
              <label key={c} className="text-xs flex items-center gap-0.5 border rounded px-1">
                <input type="checkbox" checked={cmds.includes(c)} onChange={(e) => setCmds((v) => (e.target.checked ? [...v, c] : v.filter((x) => x !== c)))} />
                {COMMAND_LABEL[c]}
              </label>
            ))}
          </div>
        ) : u.role === "CUSTOMER_BASIC" ? (
          <span className="text-xs text-gray-500">제어 불가</span>
        ) : (
          <span className="text-xs text-gray-500">역할 규칙(허용 범위)</span>
        )}
      </td>
      <td>
        <div className="flex flex-wrap gap-1">
          {u.role !== "HQ_ADMIN" && (
            <button type="button" className={btn.small} disabled={pending} onClick={() => run(() => setUserPermissionsAction(u.id, siteIds, cmds))}>
              권한 저장
            </button>
          )}
          {u.id !== selfId && (
            <ActionButton variant="small" action={() => setUserActiveAction(u.id, !u.active)} showResult={false}>
              {u.active ? "비활성화" : "활성화"}
            </ActionButton>
          )}
          <button type="button" className={btn.small} disabled={pending} onClick={() => { if (window.confirm("초대 링크를 재발급하면 이 사용자의 기존 로그인이 모두 종료됩니다. 계속할까요?")) run(() => reissueInviteAction(u.id)); }}>
            초대 재발급
          </button>
        </div>
        {auth.inviteLink && <div className="text-[11px] text-amber-800 break-all mt-1">초대 링크(유효): {auth.inviteLink}</div>}
        <ResultLine result={result} />
        {result?.ok && result.link && <div className="text-[11px] text-amber-800 break-all">새 초대 링크: {result.link}</div>}
      </td>
    </tr>
  );
}

export function NewUserForm({ sites }: { sites: { id: string; name: string }[] }) {
  const { pending, result, run } = useAction();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("CUSTOMER_BASIC");
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [cmds, setCmds] = useState<CommandType[]>([]);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap gap-2">
        <input className="border rounded px-2 py-1" placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="border rounded px-2 py-1" placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select className="border rounded px-2 py-1" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-1">
        {sites.map((s) => (
          <label key={s.id} className="text-xs flex items-center gap-0.5 border rounded px-1">
            <input type="checkbox" checked={siteIds.includes(s.id)} onChange={(e) => setSiteIds((v) => (e.target.checked ? [...v, s.id] : v.filter((x) => x !== s.id)))} />
            {s.name}
          </label>
        ))}
      </div>
      {role === "CUSTOMER_CONTROL" && (
        <div className="flex flex-wrap gap-1">
          {CMDS.map((c) => (
            <label key={c} className="text-xs flex items-center gap-0.5 border rounded px-1">
              <input type="checkbox" checked={cmds.includes(c)} onChange={(e) => setCmds((v) => (e.target.checked ? [...v, c] : v.filter((x) => x !== c)))} />
              {COMMAND_LABEL[c]}
            </label>
          ))}
        </div>
      )}
      <button type="button" className={btn.primary} disabled={pending} onClick={() => run(() => createUserAction({ name, email, role, siteIds, allowedCommands: cmds }))}>
        사용자 등록 + 초대 링크 발급
      </button>
      <ResultLine result={result} />
      {result?.ok && result.link && (
        <div className="rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900 break-all">
          초대 링크(72시간 유효, 1회용): <b>{result.link}</b>
          <div className="mt-1 text-[11px]">이메일 발송 연동(5단계) 전까지는 이 링크를 직접 전달하세요.</div>
        </div>
      )}
    </div>
  );
}

/** 통보 종류 체크박스(수신자 추가·수정·내 구독 공용). */
export function KindPicker({ value, onChange, disabled }: { value: NotifyKind[]; onChange: (v: NotifyKind[]) => void; disabled?: boolean }) {
  return (
    <span className="inline-flex flex-wrap gap-x-2 gap-y-0.5">
      {NOTIFY_KINDS.map((k) => (
        <label key={k} className="inline-flex items-center gap-0.5 whitespace-nowrap">
          <input type="checkbox" disabled={disabled} checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} />
          {NOTIFY_KIND_LABEL[k]}
        </label>
      ))}
    </span>
  );
}

export const kindsSummary = (kinds: NotifyKind[]) => (kinds.length === NOTIFY_KINDS.length ? "모든 통보" : kinds.map((k) => NOTIFY_KIND_LABEL[k]).join("·"));

function RecipientKindsEditor({ siteId, recipient }: { siteId: string; recipient: { id: string; kinds: NotifyKind[] } }) {
  const { pending, result, run } = useAction();
  const [open, setOpen] = useState(false);
  const [kinds, setKinds] = useState<NotifyKind[]>(recipient.kinds);
  if (!open) return <button type="button" className={btn.small} onClick={() => setOpen(true)}>종류 변경</button>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <KindPicker value={kinds} onChange={setKinds} disabled={pending} />
      <button type="button" className={btn.small} disabled={pending || kinds.length === 0} onClick={() => run(async () => { const r = await updateRecipientAction(siteId, recipient.id, { kinds }); if (r.ok) setOpen(false); return r; })}>저장</button>
      <button type="button" className={btn.small} onClick={() => setOpen(false)}>취소</button>
      <ResultLine result={result} />
    </span>
  );
}

export function RecipientsPanel({ siteId, recipients, dedupeMinutes, escalateAfterMinutes, noActivityHours, kakaoUsers }: { siteId: string; recipients: { id: string; channel: "EMAIL" | "KAKAO"; address: string; minSeverity: Severity; hoursFrom: string; hoursTo: string; kinds: NotifyKind[] }[]; dedupeMinutes: number; escalateAfterMinutes: number; noActivityHours: number; kakaoUsers: { id: string; name: string; linked: boolean }[] }) {
  const { pending, result, run } = useAction();
  const [channel, setChannel] = useState<"EMAIL" | "KAKAO">("EMAIL");
  const [address, setAddress] = useState("");
  const [kakaoUser, setKakaoUser] = useState(kakaoUsers[0]?.id ?? "");
  const [sev, setSev] = useState<Severity>("HIGH");
  const [from, setFrom] = useState("00:00");
  const [to, setTo] = useState("23:59");
  const [kinds, setKinds] = useState<NotifyKind[]>([...NOTIFY_KINDS]);
  const [dedupe, setDedupe] = useState(dedupeMinutes);
  const [esc, setEsc] = useState(escalateAfterMinutes);
  const [idleHours, setIdleHours] = useState(noActivityHours);
  const label = (r: { channel: string; address: string }) => {
    if (r.channel === "EMAIL") return r.address;
    if (!r.address.startsWith("user:")) return `${r.address} (전화번호 알림톡 — 모의)`;
    const u = kakaoUsers.find((k) => k.id === r.address.slice(5));
    return u ? `${u.name}${u.linked ? "" : " (카카오톡 미연결 — 본인이 내 계정에서 연결)"}` : `${r.address} (사용자 없음)`;
  };
  return (
    <div className="space-y-2 text-xs">
      <ul className="space-y-1">
        {recipients.length === 0 && <li className="text-gray-500">수신자가 없습니다. 아래에서 추가하세요.</li>}
        {recipients.map((r) => (
          <li key={r.id} className="flex items-center gap-2 flex-wrap">
            <span className="rounded bg-gray-100 px-1">{r.channel === "EMAIL" ? "이메일" : "카카오톡"}</span>
            <span>{label(r)}</span>
            <span className="text-gray-500">등급 ≥ {r.minSeverity} · {r.hoursFrom}~{r.hoursTo} · {kindsSummary(r.kinds)}</span>
            <RecipientKindsEditor siteId={siteId} recipient={r} />
            <ActionButton variant="small" action={() => testRecipientAction(siteId, r.id)}>
              시험 발송
            </ActionButton>
            <ActionButton variant="small" action={() => removeRecipientAction(siteId, r.id)} showResult={false}>
              삭제
            </ActionButton>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-1 items-center">
        <select className="border rounded px-1 py-0.5" value={channel} onChange={(e) => setChannel(e.target.value as "EMAIL" | "KAKAO")}>
          <option value="EMAIL">이메일</option>
          <option value="KAKAO">카카오톡(사용자 본인)</option>
        </select>
        {channel === "EMAIL" ? (
          <input className="border rounded px-1 py-0.5 w-48" placeholder="이메일 주소" value={address} onChange={(e) => setAddress(e.target.value)} />
        ) : (
          <select className="border rounded px-1 py-0.5" value={kakaoUser} onChange={(e) => setKakaoUser(e.target.value)}>
            {kakaoUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}{u.linked ? "" : " (미연결)"}
              </option>
            ))}
          </select>
        )}
        <select className="border rounded px-1 py-0.5" value={sev} onChange={(e) => setSev(e.target.value as Severity)}>
          {(["LOW", "MEDIUM", "HIGH", "CRITICAL"] as Severity[]).map((s) => (
            <option key={s} value={s}>
              ≥ {s}
            </option>
          ))}
        </select>
        <input type="time" className="border rounded px-1 py-0.5" value={from} onChange={(e) => setFrom(e.target.value)} />~
        <input type="time" className="border rounded px-1 py-0.5" value={to} onChange={(e) => setTo(e.target.value)} />
        <button
          type="button"
          className={btn.small}
          disabled={pending || kinds.length === 0 || (channel === "EMAIL" ? !address.trim() : !kakaoUser)}
          onClick={() => run(() => addRecipientAction(siteId, { channel, address: channel === "EMAIL" ? address : `user:${kakaoUser}`, minSeverity: sev, hoursFrom: from, hoursTo: to, kinds }))}
        >
          수신자 추가
        </button>
      </div>
      <div className="flex flex-wrap gap-1 items-center">
        받을 통보: <KindPicker value={kinds} onChange={setKinds} />
      </div>
      <div className="flex flex-wrap gap-1 items-center">
        중복 억제 <input type="number" className="border rounded px-1 py-0.5 w-16" value={dedupe} onChange={(e) => setDedupe(Number(e.target.value))} />분 · 미조치 확대 통보{" "}
        <input type="number" className="border rounded px-1 py-0.5 w-16" value={esc} onChange={(e) => setEsc(Number(e.target.value))} />분 · 무실적 통보{" "}
        <input type="number" className="border rounded px-1 py-0.5 w-16" min={0} max={720} value={idleHours} onChange={(e) => setIdleHours(Number(e.target.value))} />시간(0=끔)
        <button type="button" className={btn.small} disabled={pending} onClick={() => run(() => updateThresholdsAction(siteId, dedupe, esc, idleHours))}>
          임계값 저장
        </button>
      </div>
      <p className="text-gray-500">등급·시간대는 장애 통보에만 적용됩니다. 무실적 통보는 그 시간 동안 청소 실적이 없는 실제 로봇을 하루 한 번 알립니다. 보고서 발행 통보는 고객 공개 때 PPT·Excel 을 이메일로 보냅니다.</p>
      <ResultLine result={result} />
    </div>
  );
}

/** 로봇 사용 중지/재사용(본사 관리자, 고급 설정). 중지해도 로봇 자체에는 아무 명령도 가지 않는다. */
export function RobotActivePanel({ robots }: { robots: { id: string; name: string; siteName: string; floorName: string; active: boolean; live: boolean; siteRetired: boolean }[] }) {
  const { pending, result, run } = useAction();
  return (
    <div className="text-sm">
      <table className="data">
        <thead>
          <tr>
            <th>로봇</th>
            <th>사업장 / 층</th>
            <th>상태</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {robots.map((r) => (
            <tr key={r.id} className={r.active ? "" : "text-gray-500"}>
              <td>{r.name} <span className="font-mono text-xs">{r.id}</span>{r.live ? <span className="ml-1 text-[10px] text-blue-700">API</span> : null}</td>
              <td>{r.siteName} / {r.floorName}</td>
              <td>{r.active ? <span className="text-emerald-700 font-medium">사용 중</span> : <span>사용 중지</span>}</td>
              <td>
                {r.siteRetired ? (
                  <span className="text-xs text-gray-500">사업장 사용 중지</span>
                ) : (
                  <button
                    type="button"
                    className={r.active ? `${btn.small} border-red-300 text-red-800` : `${btn.small} border-emerald-400 text-emerald-800`}
                    disabled={pending}
                    onClick={() => {
                      const reason = window.prompt(
                        r.active
                          ? `'${r.name}' 로봇을 사용 중지합니다.\n- 운영 화면·상태 동기화·보고서 운영 대수에서 빠지고 명령이 막힙니다. 미래 예정 회차는 취소됩니다.\n- 실적·장애·명령 이력은 남고, 로봇 자체에는 아무 명령도 보내지 않습니다.\n사유(감사 기록):`
                          : `'${r.name}' 로봇을 다시 사용합니다. 다음 동기화부터 상태를 받습니다.\n사유(감사 기록):`,
                        "",
                      );
                      if (reason === null) return;
                      run(() => setRobotActiveAction(r.id, !r.active, reason));
                    }}
                  >
                    {r.active ? "사용 중지" : "다시 사용"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ResultLine result={result} />
    </div>
  );
}

export function RelocateForm({ robots, floors }: { robots: { id: string; name: string; siteId: string }[]; floors: { id: string; siteId: string; name: string; siteName: string }[] }) {
  const { pending, result, run } = useAction();
  const [robotId, setRobotId] = useState(robots[0]?.id ?? "");
  const [floorId, setFloorId] = useState(floors[0]?.id ?? "");
  const floor = floors.find((f) => f.id === floorId);
  return (
    <div className="flex flex-wrap gap-2 items-center text-sm">
      <select className="border rounded px-2 py-1" value={robotId} onChange={(e) => setRobotId(e.target.value)}>
        {robots.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} ({r.id})
          </option>
        ))}
      </select>
      →
      <select className="border rounded px-2 py-1" value={floorId} onChange={(e) => setFloorId(e.target.value)}>
        {floors.map((f) => (
          <option key={f.id} value={f.id}>
            {f.siteName} / {f.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={btn.secondary}
        disabled={pending || !floor}
        onClick={() => {
          const reason = window.prompt("로봇 배치(층)를 바꿉니다. 로봇 자체의 지도는 바뀌지 않지만 이 시스템의 위치 표시·보고서 소속이 바뀝니다.\n사유를 입력하세요(감사 기록).", "");
          if (reason === null) return;
          run(() => relocateRobotAction(robotId, floor!.siteId, floor!.id, reason));
        }}
      >
        배치 변경
      </button>
      <ResultLine result={result} />
      <span className="text-xs text-gray-500">로봇이 실제로 다른 층·현장으로 옮겨졌을 때만 쓰세요. 과거 실적은 당시 사업장에 남고, 미래 예정 회차는 취소됩니다. 실제 로봇은 사유가 필요합니다.</span>
    </div>
  );
}

export function SettingsPanel({ siteManagerCanConfirm, allowSampleReset }: { siteManagerCanConfirm: boolean; allowSampleReset: boolean }) {
  return (
    <div className="flex flex-wrap gap-3 items-center text-sm">
      <span>현장 담당자 보고서 확정 권한: <b>{siteManagerCanConfirm ? "허용" : "불가(본사만)"}</b></span>
      <ActionButton variant="small" action={() => setSiteManagerCanConfirmAction(!siteManagerCanConfirm)} showResult={false}>
        {siteManagerCanConfirm ? "불가로 변경" : "허용으로 변경"}
      </ActionButton>
      {allowSampleReset ? (
        <ActionButton variant="danger" confirmText="샘플 데이터를 초기 상태로 되돌립니다(모든 세션 종료 → 재로그인 필요). 계속할까요?" action={() => resetSampleAction()}>
          샘플 데이터 초기화
        </ActionButton>
      ) : (
        <span className="text-xs text-gray-500">샘플 초기화는 이 환경에서 비활성(ALLOW_SAMPLE_RESET=false)</span>
      )}
    </div>
  );
}

/** 사업장별 원격 제어 켜기/끄기(본사 관리자). 끄면 누구도(본사 포함) 그 사업장 로봇에 원격 명령을 보낼 수 없다. */
export function RemoteControlPanel({ sites }: { sites: { id: string; name: string; enabled: boolean; liveRobots: number }[] }) {
  const { pending, result, run } = useAction();
  return (
    <div className="text-sm">
      <table className="data">
        <thead>
          <tr>
            <th>사업장</th>
            <th>실제 로봇</th>
            <th>원격 제어</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sites.map((s) => (
            <tr key={s.id}>
              <td>{s.name}</td>
              <td>{s.liveRobots}대</td>
              <td>{s.enabled ? <span className="text-emerald-700 font-medium">켜짐</span> : <span className="text-gray-500">꺼짐</span>}</td>
              <td>
                <button
                  type="button"
                  className={s.enabled ? btn.small : `${btn.small} border-emerald-400 text-emerald-800`}
                  disabled={pending}
                  onClick={() => {
                    const reason = window.prompt(
                      s.enabled ? `'${s.name}' 원격 제어를 끕니다. 이 사업장 로봇에 아무도 원격 명령을 보낼 수 없습니다.\n사유(감사 기록):` : `'${s.name}' 원격 제어를 켭니다. 권한이 있는 사용자가 실제 로봇에 시작·중지·복귀 명령을 보낼 수 있습니다.\n사유(감사 기록):`,
                      "",
                    );
                    if (reason === null) return;
                    run(() => setRemoteControlAction(s.id, !s.enabled, reason));
                  }}
                >
                  {s.enabled ? "끄기" : "켜기"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ResultLine result={result} />
    </div>
  );
}
