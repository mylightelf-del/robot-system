import { buildSampleStore } from "@/lib/sample/seed";
import { runSimulationTick } from "@/lib/vendors/sample/simulation";
import { nowIso } from "@/lib/util/time";
import type { StoreData } from "./data";

/**
 * 메모리 저장소 싱글턴 (1단계 시제품 전용).
 * - 서버 프로세스가 재시작되면 샘플 데이터로 초기화된다(영속 저장은 2단계).
 * - 개발 서버의 모듈 재적재에도 유지되도록 globalThis 에 보관한다.
 */
const g = globalThis as unknown as { __robotStore?: StoreData };

export function getStore(): StoreData {
  if (!g.__robotStore) {
    g.__robotStore = buildSampleStore(nowIso());
  }
  runSimulationTick(g.__robotStore, nowIso());
  return g.__robotStore;
}

/** 테스트·재초기화용. */
export function resetStore(now: string = nowIso()): StoreData {
  g.__robotStore = buildSampleStore(now);
  return g.__robotStore;
}
