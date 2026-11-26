CREATE TABLE "delivery_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"floor" text,
	"dept" text,
	"phone" text NOT NULL,
	"ext" text,
	"destination" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delivery_contacts" ADD CONSTRAINT "delivery_contacts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_contacts_site_name_phone" ON "delivery_contacts" USING btree ("site_id","name","phone");--> statement-breakpoint
CREATE INDEX "delivery_contacts_site_idx" ON "delivery_contacts" USING btree ("site_id");