import type { Robot, Vendor } from "@/lib/domain/types";
import type { VendorAdapter } from "./adapter";
import { SampleAdapter } from "./sample/sampleAdapter";
import { CenobotsAdapter } from "./cenobots/cenobotsAdapter";
import { PuduAdapter } from "./pudu/puduAdapter";
import { configFromEnv as puduConfigFromEnv } from "./pudu/client";

/**
 * 어댑터 선택. 제조사별로 모드를 따로 둔다.
 * - VENDOR_MODE=sample(기본) 이면 전부 샘플.
 * - VENDOR_MODE=live 이면 제조사별 *_MODE(기본 live) 와 키 설정 여부에 따라 실제 어댑터. 키가 없으면 샘플로 두지 않고 "미설정" 상태로 보고한다.
 */
export type VendorMode = "sample" | "live" | "unconfigured";

export function vendorMode(vendor: Vendor): VendorMode {
  // 빈 문자열(.env 에 'PUDU_MODE=' 만 있는 경우)은 미설정으로 본다 — 실서버 첫 배포에서 샘플 모드로 떨어졌던 원인
  const global = process.env.VENDOR_MODE || "sample";
  const own = process.env[`${vendor}_MODE`] || undefined;
  const mode = own ?? global;
  if (mode !== "live") return "sample";
  switch (vendor) {
    case "PUDU": {
      // 키·클러스터에 더해 허용 매장(PUDU_SHOP_IDS)이 있어야 live. 대리점 키는 다른 고객사 로봇까지 보이므로 매장 제한 없이는 켜지 않는다.
      const cfg = puduConfigFromEnv();
      return cfg && cfg.shopIds.length > 0 ? "live" : "unconfigured";
    }
    case "CENOBOTS":
      return "unconfigured"; // 3단계 구현 전
    default:
      return "unconfigured";
  }
}

/**
 * 실제 API 로 다루는 로봇인지. 제조사 모드가 live 이고, 제조사 API 에서 등록(vendorMeta.source="api")한 로봇만 실제로 본다.
 * 샘플 적재 로봇(가상 SN)은 live 모드에서도 실제 API 에 조회·명령하지 않는다(실제/샘플 분리 원칙).
 */
export function isLiveRobot(robot: Pick<Robot, "vendor" | "vendorMeta">): boolean {
  return vendorMode(robot.vendor) === "live" && robot.vendorMeta?.source === "api";
}

export function getAdapter(robot: Robot): VendorAdapter {
  if (!isLiveRobot(robot)) return new SampleAdapter(robot.vendor);
  switch (robot.vendor) {
    case "PUDU":
      return new PuduAdapter();
    case "CENOBOTS":
      return new CenobotsAdapter();
    default:
      return new SampleAdapter(robot.vendor);
  }
}

export function vendorModes(): Record<Vendor, VendorMode> {
  return { PUDU: vendorMode("PUDU"), CENOBOTS: vendorMode("CENOBOTS"), BIB: vendorMode("BIB") };
}
