CREATE TABLE "actual_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"vendor_robot_id" text NOT NULL,
	"vendor_run_id" text NOT NULL,
	"robot_id" text NOT NULL,
	"site_id" text NOT NULL,
	"floor_id" text NOT NULL,
	"task_id" text,
	"zone_ids" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone NOT NULL,
	"result" text NOT NULL,
	"end_reason" text,
	"area_m_2" double precision NOT NULL,
	"duration_min" double precision NOT NULL,
	"water_l" double precision,
	"detergent_ml" double precision,
	"origin" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"raw_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"site_manager_can_confirm_reports" boolean DEFAULT false NOT NULL,
	"command_expiry_minutes" integer DEFAULT 5 NOT NULL,
	"command_accepted_timeout_seconds" integer DEFAULT 60 NOT NULL,
	"stale_threshold_minutes" integer DEFAULT 15 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL,
	"user_name" text NOT NULL,
	"site_id" text,
	"robot_id" text,
	"action" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" text NOT NULL,
	"detail" text,
	"vendor_trace_id" text
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"robot_id" text NOT NULL,
	"type" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"state" text NOT NULL,
	"state_changed_at" timestamp with time zone NOT NULL,
	"message" text,
	"vendor_trace_id" text,
	"simulation" text,
	"idempotency_key" text
);
--> statement-breakpoint
CREATE TABLE "floors" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"current_map_version_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incident_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"user_id" text NOT NULL,
	"note" text NOT NULL,
	"internal" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"robot_id" text NOT NULL,
	"code" text NOT NULL,
	"severity" text NOT NULL,
	"raw_message" text DEFAULT '' NOT NULL,
	"customer_message" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"assignee_id" text,
	"resolved_at" timestamp with time zone,
	"vendor_event_id" text,
	"raw_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"robot_id" text NOT NULL,
	"item" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"done_at" timestamp with time zone,
	"done_by" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "maintenance_items" (
	"id" text PRIMARY KEY NOT NULL,
	"robot_id" text NOT NULL,
	"name" text NOT NULL,
	"remaining_pct" double precision,
	"source" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "map_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"floor_id" text NOT NULL,
	"version" integer NOT NULL,
	"width_px" integer NOT NULL,
	"height_px" integer NOT NULL,
	"corners" jsonb
);
--> statement-breakpoint
CREATE TABLE "notification_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"channel" text NOT NULL,
	"address" text NOT NULL,
	"min_severity" text NOT NULL,
	"hours_from" text DEFAULT '00:00' NOT NULL,
	"hours_to" text DEFAULT '23:59' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"site_id" text PRIMARY KEY NOT NULL,
	"dedupe_minutes" integer DEFAULT 30 NOT NULL,
	"escalate_after_minutes" integer DEFAULT 60 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "planned_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"task_id" text NOT NULL,
	"robot_id" text NOT NULL,
	"site_id" text NOT NULL,
	"planned_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"actual_run_id" text,
	"change_history" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registered_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"robot_id" text NOT NULL,
	"name" text NOT NULL,
	"zone_ids" jsonb NOT NULL,
	"mode" text NOT NULL,
	"vendor_task_ref" text
);
--> statement-breakpoint
CREATE TABLE "report_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"month" text NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"aggregates" jsonb NOT NULL,
	"comments" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by" text NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"confirmed_at" timestamp with time zone,
	"confirmed_by" text,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "robot_placements" (
	"id" text PRIMARY KEY NOT NULL,
	"robot_id" text NOT NULL,
	"site_id" text NOT NULL,
	"from" timestamp with time zone NOT NULL,
	"to" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "robot_status" (
	"robot_id" text PRIMARY KEY NOT NULL,
	"common" text NOT NULL,
	"raw" text DEFAULT '' NOT NULL,
	"online" boolean DEFAULT false NOT NULL,
	"battery_pct" double precision,
	"pose" jsonb,
	"pose_is_last_known" boolean DEFAULT false NOT NULL,
	"map_version_id" text,
	"current_mission_id" text,
	"progress_pct" double precision,
	"last_received_at" timestamp with time zone,
	"data_at" timestamp with time zone,
	"raw_payload" jsonb
);
--> statement-breakpoint
CREATE TABLE "robots" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"model" text NOT NULL,
	"vendor_robot_id" text NOT NULL,
	"site_id" text NOT NULL,
	"floor_id" text NOT NULL,
	"name" text NOT NULL,
	"serial" text DEFAULT '' NOT NULL,
	"firmware" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"supported_commands" jsonb NOT NULL,
	"internal_note" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"days_of_week" jsonb NOT NULL,
	"time" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"executor" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_permissions" (
	"user_id" text NOT NULL,
	"site_id" text NOT NULL,
	"allowed_commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "site_permissions_user_id_site_id_pk" PRIMARY KEY("user_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"is_sample" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"password_hash" text,
	"invite_token" text,
	"invite_expires_at" timestamp with time zone,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"label" text NOT NULL,
	"status" text NOT NULL,
	"region" text,
	"notes" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" text PRIMARY KEY NOT NULL,
	"floor_id" text NOT NULL,
	"name" text NOT NULL,
	"polygon" jsonb NOT NULL,
	"area_m_2" double precision NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actual_runs" ADD CONSTRAINT "actual_runs_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "actual_runs" ADD CONSTRAINT "actual_runs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "floors" ADD CONSTRAINT "floors_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_actions" ADD CONSTRAINT "incident_actions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_items" ADD CONSTRAINT "maintenance_items_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "map_versions" ADD CONSTRAINT "map_versions_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_logs" ADD CONSTRAINT "notification_logs_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_recipients" ADD CONSTRAINT "notification_recipients_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_runs" ADD CONSTRAINT "planned_runs_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "planned_runs" ADD CONSTRAINT "planned_runs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registered_tasks" ADD CONSTRAINT "registered_tasks_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registered_tasks" ADD CONSTRAINT "registered_tasks_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_versions" ADD CONSTRAINT "report_versions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "robot_placements" ADD CONSTRAINT "robot_placements_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "robot_placements" ADD CONSTRAINT "robot_placements_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "robot_status" ADD CONSTRAINT "robot_status_robot_id_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "robots" ADD CONSTRAINT "robots_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "robots" ADD CONSTRAINT "robots_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_task_id_registered_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."registered_tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_permissions" ADD CONSTRAINT "site_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_permissions" ADD CONSTRAINT "site_permissions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_floor_id_floors_id_fk" FOREIGN KEY ("floor_id") REFERENCES "public"."floors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actual_runs_dedupe_key" ON "actual_runs" USING btree ("vendor","vendor_robot_id","vendor_run_id");--> statement-breakpoint
CREATE INDEX "actual_runs_site_started_idx" ON "actual_runs" USING btree ("site_id","started_at");--> statement-breakpoint
CREATE INDEX "actual_runs_robot_started_idx" ON "actual_runs" USING btree ("robot_id","started_at");--> statement-breakpoint
CREATE INDEX "audit_logs_at_idx" ON "audit_logs" USING btree ("at");--> statement-breakpoint
CREATE UNIQUE INDEX "commands_idempotency_key" ON "commands" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "commands_robot_idx" ON "commands" USING btree ("robot_id","requested_at");--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_vendor_event_key" ON "incidents" USING btree ("vendor_event_id");--> statement-breakpoint
CREATE INDEX "incidents_site_idx" ON "incidents" USING btree ("site_id","occurred_at");--> statement-breakpoint
CREATE INDEX "planned_runs_site_time_idx" ON "planned_runs" USING btree ("site_id","planned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_versions_site_month_version" ON "report_versions" USING btree ("site_id","month","version");--> statement-breakpoint
CREATE INDEX "robot_placements_robot_idx" ON "robot_placements" USING btree ("robot_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_invite_token_key" ON "users" USING btree ("invite_token");