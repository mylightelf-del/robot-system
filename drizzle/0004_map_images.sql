CREATE TABLE "map_images" (
	"map_version_id" text PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"size" integer NOT NULL,
	"source_url" text NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "map_images" ADD CONSTRAINT "map_images_map_version_id_map_versions_id_fk" FOREIGN KEY ("map_version_id") REFERENCES "public"."map_versions"("id") ON DELETE no action ON UPDATE no action;