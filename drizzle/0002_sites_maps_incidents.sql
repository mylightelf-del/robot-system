ALTER TABLE "incidents" ADD COLUMN "occurrences" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "last_occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "map_versions" ADD COLUMN "vendor" text;--> statement-breakpoint
ALTER TABLE "map_versions" ADD COLUMN "vendor_map_name" text;--> statement-breakpoint
ALTER TABLE "map_versions" ADD COLUMN "image_url" text;--> statement-breakpoint
ALTER TABLE "map_versions" ADD COLUMN "resolution" double precision;--> statement-breakpoint
ALTER TABLE "map_versions" ADD COLUMN "origin" jsonb;