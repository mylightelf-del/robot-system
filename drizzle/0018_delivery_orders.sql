CREATE TABLE "delivery_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"robot_id" text NOT NULL,
	"site_id" text,
	"kind" text NOT NULL,
	"trays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" text DEFAULT 'fixed' NOT NULL,
	"execute_task" boolean DEFAULT true NOT NULL,
	"status" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_robot_id_delivery_robots_id_fk" FOREIGN KEY ("robot_id") REFERENCES "public"."delivery_robots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_orders" ADD CONSTRAINT "delivery_orders_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "delivery_orders_robot_idx" ON "delivery_orders" USING btree ("robot_id","requested_at");