CREATE TABLE "severity_overrides" (
	"code" text PRIMARY KEY NOT NULL,
	"severity" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
