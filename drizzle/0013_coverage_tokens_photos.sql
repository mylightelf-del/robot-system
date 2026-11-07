CREATE TABLE "api_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"site_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "incident_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"internal" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_history" (
	"id" text PRIMARY KEY NOT NULL,
	"robot_id" text NOT NULL,
	"name" text NOT NULL,
	"remaining_pct" double precision NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_images" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"kind" text NOT NULL,
	"content_type" text NOT NULL,
	"data" "bytea" NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actual_runs" ADD COLUMN "coverage" jsonb;--> statement-breakpoint
ALTER TABLE "zones" ADD COLUMN "vendor_zone_id" text;--> statement-breakpoint
ALTER TABLE "incident_photos" ADD CONSTRAINT "incident_photos_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_history" ADD CONSTRAINT "maintenance_history_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_images" ADD CONSTRAINT "run_images_run_id_actual_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."actual_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_key" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "incident_photos_incident_idx" ON "incident_photos" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "maintenance_history_robot_idx" ON "maintenance_history" USING btree ("robot_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_images_run_kind" ON "run_images" USING btree ("run_id","kind");