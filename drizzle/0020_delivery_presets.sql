CREATE TABLE "delivery_presets" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"trays" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sort" text DEFAULT 'fixed' NOT NULL,
	"execute_task" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_presets" ADD CONSTRAINT "delivery_presets_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;