CREATE TABLE "vendor_events" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"event_type" text NOT NULL,
	"vendor_robot_id" text,
	"event_key" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"occurred_at" timestamp with time zone,
	"trace_id" text,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"process_error" text
);
--> statement-breakpoint
CREATE TABLE "vendor_sync_state" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"job" text NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_ok_at" timestamp with time zone,
	"last_error" text,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "robots" ADD COLUMN "vendor_meta" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "vendor_events_key" ON "vendor_events" USING btree ("vendor","event_key");--> statement-breakpoint
CREATE INDEX "vendor_events_pending_idx" ON "vendor_events" USING btree ("processed_at","received_at");