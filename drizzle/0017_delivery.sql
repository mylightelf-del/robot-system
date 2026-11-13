CREATE TABLE "delivery_events" (
	"id" text PRIMARY KEY NOT NULL,
	"msg_id" text NOT NULL,
	"msg_type" text NOT NULL,
	"agent_robot_id" text,
	"received_at" timestamp with time zone NOT NULL,
	"occurred_at" timestamp with time zone,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"process_error" text,
	CONSTRAINT "delivery_events_msgId_unique" UNIQUE("msg_id")
);
--> statement-breakpoint
CREATE TABLE "delivery_legs" (
	"id" text PRIMARY KEY NOT NULL,
	"robot_id" text NOT NULL,
	"site_id" text,
	"destination" text NOT NULL,
	"tray_index" integer DEFAULT 0 NOT NULL,
	"task_ref" text,
	"mode" text DEFAULT '' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"status" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"on_the_way_at" timestamp with time zone,
	"arrived_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"complete_type" text,
	"estimated_ms" integer,
	"spend_ms" integer,
	"last_event_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	"reminded_at" timestamp with time zone,
	"notify_result" text
);
--> statement-breakpoint
CREATE TABLE "delivery_recipients" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"destination" text NOT NULL,
	"user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"channels" jsonb DEFAULT '["PUSH","EMAIL"]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delivery_robots" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_robot_id" text NOT NULL,
	"group_id" text DEFAULT '' NOT NULL,
	"device_id" text DEFAULT '' NOT NULL,
	"site_id" text,
	"name" text NOT NULL,
	"shop_name" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_state" jsonb,
	"last_seen_at" timestamp with time zone,
	"destinations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "delivery_robots_agentRobotId_unique" UNIQUE("agent_robot_id")
);
--> statement-breakpoint
ALTER TABLE "delivery_legs" ADD CONSTRAINT "delivery_legs_robot_id_delivery_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."delivery_robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_legs" ADD CONSTRAINT "delivery_legs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_recipients" ADD CONSTRAINT "delivery_recipients_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_robots" ADD CONSTRAINT "delivery_robots_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_events_pending_idx" ON "delivery_events" USING btree ("processed_at","received_at");--> statement-breakpoint
CREATE INDEX "delivery_legs_robot_dest_idx" ON "delivery_legs" USING btree ("robot_id","destination");--> statement-breakpoint
CREATE INDEX "delivery_legs_arrived_idx" ON "delivery_legs" USING btree ("arrived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_recipients_site_dest" ON "delivery_recipients" USING btree ("site_id","destination");