ALTER TABLE "delivery_robots" ADD COLUMN "source" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "delivery_robots" ADD COLUMN "sn" text;--> statement-breakpoint
ALTER TABLE "delivery_robots" ADD COLUMN "shop_id" text;