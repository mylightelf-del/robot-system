ALTER TABLE "incidents" ADD COLUMN "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "dismissed_by" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "dismiss_reason" text;