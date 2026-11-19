CREATE TABLE "teams_conversations" (
	"aad_object_id" text PRIMARY KEY NOT NULL,
	"email" text,
	"upn" text,
	"name" text,
	"tenant_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"service_url" text NOT NULL,
	"removed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "teams_conversations_email_idx" ON "teams_conversations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "teams_conversations_upn_idx" ON "teams_conversations" USING btree ("upn");