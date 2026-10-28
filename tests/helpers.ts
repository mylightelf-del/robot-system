import { afterAll } from "vitest";
import type { User } from "@/lib/domain/types";
import { buildSampleStore } from "@/lib/sample/seed";
import { resetDatabase, seedDatabase } from "@/lib/db/seed";
import { closeDb, getDb, schema } from "@/lib/db/client";
import { getUser } from "@/lib/db/repo";
import { nowIso } from "@/lib/util/time";
import { eq } from "drizzle-orm";

export const SAMPLE_PASSWORD = "sample1234!";

/** DB 를 비우고 샘플 데이터를 적재한다. */
export async function resetAndSeed(): Promise<void> {
  await resetDatabase();
  await seedDatabase(buildSampleStore(nowIso()), SAMPLE_PASSWORD);
}

export async function user(id: string): Promise<User> {
  const u = await getUser(id);
  if (!u) throw new Error(`샘플 사용자 없음: ${id}`);
  return u;
}

export async function setRobotStatus(robotId: string, patch: Partial<typeof schema.robotStatus.$inferInsert>) {
  await getDb().update(schema.robotStatus).set(patch).where(eq(schema.robotStatus.robotId, robotId));
}

afterAll(async () => {
  await closeDb();
});

export { getDb, schema };
