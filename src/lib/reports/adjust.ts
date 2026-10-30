import type { ReportAdjustments, ReportAggregates } from "@/lib/domain/types";

/**
 * 보고서 수치 보정(웹에서 수정). 원래 집계값(aggregates)은 바꾸지 않고, 보정값을 키별로 따로 두었다가 표시·출력 때 덮어쓴다.
 * 키: "summary.<항목>" 또는 "<표>.<행 ID>.<항목>" (예: byFloor.site-01-f1.areaM2, byDay.2026-10-16.runs, inspections.청수 보충.done)
 */
const SUMMARY_FIELDS = ["robotCount", "validPlanned", "plannedCompleted", "completionRatePct", "cancelled", "excluded", "missed", "adhocRuns", "totalRuns", "cumulativeAreaM2", "totalDurationMin", "waterL", "detergentMl"] as const;
type SummaryField = (typeof SUMMARY_FIELDS)[number];

const TABLES = {
  byFloor: { id: "floorId", fields: ["runs", "areaM2", "durationMin"] },
  byZone: { id: "zoneId", fields: ["runs", "areaM2"] },
  byRobot: { id: "robotId", fields: ["runs", "completed", "areaM2"] },
  byDay: { id: "date", fields: ["runs", "completed", "areaM2", "durationMin"] },
  inspections: { id: "item", fields: ["done", "total"] },
} as const;
type TableName = keyof typeof TABLES;

type Parsed = { kind: "summary"; field: SummaryField } | { kind: "table"; table: TableName; rowId: string; field: string };

function parseKey(key: string): Parsed | null {
  const parts = key.split(".");
  if (parts[0] === "summary" && parts.length === 2 && (SUMMARY_FIELDS as readonly string[]).includes(parts[1])) return { kind: "summary", field: parts[1] as SummaryField };
  if (parts.length >= 3 && parts[0] in TABLES) {
    const table = parts[0] as TableName;
    const field = parts[parts.length - 1];
    if (!(TABLES[table].fields as readonly string[]).includes(field)) return null;
    return { kind: "table", table, rowId: parts.slice(1, -1).join("."), field };
  }
  return null;
}

type Row = Record<string, unknown>;
function findRow(a: ReportAggregates, table: TableName, rowId: string): Row | undefined {
  const rows = (a[table] ?? []) as unknown as Row[];
  return rows.find((r) => String(r[TABLES[table].id]) === rowId);
}

/** 키가 가리키는 원래 값. 키가 틀렸거나 행이 없으면 undefined, 값이 '미제공'이면 null. */
export function originalValue(a: ReportAggregates, key: string): number | null | undefined {
  const p = parseKey(key);
  if (!p) return undefined;
  if (p.kind === "summary") {
    const v = a[p.field];
    return v === undefined ? undefined : (v as number | null);
  }
  const row = findRow(a, p.table, p.rowId);
  if (!row) return undefined;
  return row[p.field] as number;
}

/** 표시·출력용 집계: 보정값을 덮어쓴 사본. 완료율을 직접 고치지 않았으면 고친 분자·분모로 다시 계산한다. */
export function applyAdjustments(a: ReportAggregates, adj: ReportAdjustments | null | undefined): ReportAggregates {
  if (!adj || Object.keys(adj).length === 0) return a;
  const out = structuredClone(a) as ReportAggregates;
  for (const [key, { value }] of Object.entries(adj)) {
    const p = parseKey(key);
    if (!p) continue;
    if (p.kind === "summary") (out as unknown as Row)[p.field] = value;
    else {
      const row = findRow(out, p.table, p.rowId);
      if (row) row[p.field] = value;
    }
  }
  if (!adj["summary.completionRatePct"] && (adj["summary.validPlanned"] || adj["summary.plannedCompleted"])) {
    out.completionRatePct = out.validPlanned > 0 ? Math.round((out.plannedCompleted / out.validPlanned) * 1000) / 10 : null;
  }
  return out;
}

export function isValidAdjustKey(a: ReportAggregates, key: string): boolean {
  return originalValue(a, key) !== undefined;
}
