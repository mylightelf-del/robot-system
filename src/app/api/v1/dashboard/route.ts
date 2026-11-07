import { withAuth } from "@/lib/api/http";
import { getDashboard } from "@/lib/services/dashboard";

/** 종합 대시보드(웹과 같은 데이터·같은 사업장 범위). */
export const GET = withAuth(async ({ user }) => getDashboard(user));
