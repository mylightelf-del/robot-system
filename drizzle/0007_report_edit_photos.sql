CREATE TABLE "report_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "report_versions" ADD COLUMN "adjustments" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "report_versions" ADD COLUMN "content" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "report_photos" ADD CONSTRAINT "report_photos_report_id_report_versions_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."report_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_photos_report_idx" ON "report_photos" USING btree ("report_id");