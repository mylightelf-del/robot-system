-- 보고서 일정(설치·일간·주간·월간): 달력 월(month) 대신 종류(kind)·차수(seq)·기간(period_start~period_end)으로 저장한다.
-- 기존 행은 달력 월 월간 보고서(seq 0)로 옮긴다.
DROP INDEX "report_versions_site_month_version";--> statement-breakpoint
ALTER TABLE "report_versions" ADD COLUMN "kind" text DEFAULT 'MONTHLY' NOT NULL;--> statement-breakpoint
ALTER TABLE "report_versions" ADD COLUMN "seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "report_versions" ADD COLUMN "period_start" text;--> statement-breakpoint
ALTER TABLE "report_versions" ADD COLUMN "period_end" text;--> statement-breakpoint
UPDATE "report_versions" SET "period_start" = "month" || '-01', "period_end" = to_char((to_date("month" || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day'), 'YYYY-MM-DD');--> statement-breakpoint
ALTER TABLE "report_versions" ALTER COLUMN "period_start" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "report_versions" ALTER COLUMN "period_end" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "installed_on" text;--> statement-breakpoint
CREATE UNIQUE INDEX "report_versions_site_period_version" ON "report_versions" USING btree ("site_id","kind","period_start","period_end","version");--> statement-breakpoint
ALTER TABLE "report_versions" DROP COLUMN "month";
