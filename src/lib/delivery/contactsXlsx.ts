import ExcelJS from "exceljs";
import type { ContactRow } from "@/lib/services/delivery";
import { ValidationError } from "@/lib/util/errors";

/** 엑셀(.xlsx)의 첫 시트에서 머리글(성명/이름, 근무층/층, 부서명/부서, 전화번호/휴대폰, 내선번호)을 찾아 읽는다. */
export async function readContactsXlsx(buf: ArrayBuffer): Promise<ContactRow[]> {
  
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) throw new ValidationError("엑셀에 시트가 없습니다.");
  const text = (v: unknown) => {
    if (v === null || v === undefined) return "";
    if (typeof v === "object" && v && "text" in v) return String((v as { text: unknown }).text ?? "");
    if (typeof v === "object" && v && "result" in v) return String((v as { result: unknown }).result ?? "");
    return String(v);
  };
  let headerRow = 0;
  const col: Record<string, number> = {};
  const want: [string, RegExp][] = [["name", /^(성명|이름|name)$/i], ["floor", /^(근무층|층|floor)$/i], ["dept", /^(부서명|부서|dept)$/i], ["phone", /^(전화번호|휴대폰|휴대전화|핸드폰|mobile|phone)$/i], ["ext", /^(내선번호|내선|ext)$/i]];
  for (let r = 1; r <= Math.min(ws.rowCount, 10) && !headerRow; r++) {
    const row = ws.getRow(r);
    row.eachCell((cell, c) => {
      const t = text(cell.value).replace(/\s/g, "");
      for (const [k, re] of want) if (re.test(t) && !col[k]) col[k] = c;
    });
    if (col.name && col.phone) headerRow = r;
    else for (const k of Object.keys(col)) delete col[k];
  }
  if (!headerRow) throw new ValidationError("머리글(성명·전화번호)을 찾지 못했습니다. 첫 줄에 성명, 근무층, 부서명, 전화번호, 내선번호를 두세요.");
  const out: ContactRow[] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const get = (k: string) => (col[k] ? text(row.getCell(col[k]).value).trim() : "");
    if (!get("name") && !get("phone")) continue;
    out.push({ name: get("name"), floor: get("floor") || null, dept: get("dept") || null, phone: get("phone"), ext: get("ext") || null });
  }
  return out;
}
