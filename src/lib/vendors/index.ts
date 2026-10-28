import type { Robot } from "@/lib/domain/types";
import type { VendorAdapter } from "./adapter";
import { SampleAdapter } from "./sample/sampleAdapter";
import { CenobotsAdapter } from "./cenobots/cenobotsAdapter";
import { PuduAdapter } from "./pudu/puduAdapter";

/**
 * 어댑터 선택.
 * 환경변수 VENDOR_MODE=sample(기본) 이면 모든 로봇에 샘플 어댑터를 사용한다.
 * VENDOR_MODE=live 는 3단계 이후 실제 어댑터가 구현된 뒤에만 의미가 있다(현재는 UNSUPPORTED 오류).
 */
export function getAdapter(robot: Robot): VendorAdapter {
  const mode = process.env.VENDOR_MODE ?? "sample";
  if (mode !== "live") return new SampleAdapter(robot.vendor);
  switch (robot.vendor) {
    case "CENOBOTS":
      return new CenobotsAdapter();
    case "PUDU":
      return new PuduAdapter();
    default:
      return new SampleAdapter(robot.vendor);
  }
}
