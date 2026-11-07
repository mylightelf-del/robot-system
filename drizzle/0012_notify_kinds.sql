ALTER TABLE "notification_logs" ALTER COLUMN "incident_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_logs" ADD COLUMN "kind" text DEFAULT 'INCIDENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_logs" ADD COLUMN "ref_id" text;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD COLUMN "kinds" jsonb DEFAULT '["INCIDENT","ESCALATION","MISSED_RUN","NO_ACTIVITY","REPORT"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD COLUMN "no_activity_hours" integer DEFAULT 0 NOT NULL;