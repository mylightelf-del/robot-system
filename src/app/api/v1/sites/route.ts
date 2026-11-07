import { withAuth } from "@/lib/api/http";
import { listSites } from "@/lib/services/robots";

/** 접근 가능한 사업장 목록. */
export const GET = withAuth(async ({ user }) => ({ sites: await listSites(user) }));
