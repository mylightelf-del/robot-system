import { withAuth, query } from "@/lib/api/http";
import { getSiteView } from "@/lib/services/robots";

/** 사업장 관제: 층·지도·로봇 위치. ?floorId= 로 층 선택. 지도 이미지는 /api/maps/{mapVersionId}(Bearer 가능). */
export const GET = withAuth<{ siteId: string }>(async ({ req, user, params }) => getSiteView(user, decodeURIComponent(params.siteId), query(req).get("floorId") ?? undefined));
