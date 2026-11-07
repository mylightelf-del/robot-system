import { withAuth, query } from "@/lib/api/http";
import { listReports } from "@/lib/services/reports";

/** 보고서 목록. 고객은 확정·공개본만(서비스 규칙). 파일은 /api/reports/{id}/export?format=pptx|xlsx (Bearer 가능). */
export const GET = withAuth(async ({ req, user }) => ({ reports: await listReports(user, query(req).get("siteId") ?? undefined) }));
