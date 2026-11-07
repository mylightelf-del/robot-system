CREATE TABLE "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"app_version" text DEFAULT '' NOT NULL,
	"device_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"disabled_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "commands" ADD COLUMN "origin" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "kind" text DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices" USING btree ("token");--> statement-breakpoint
CREATE INDEX "push_devices_user_idx" ON "push_devices" USING btree ("user_id");--> statement-breakpoint
-- 세션 토큰을 해시로 저장하도록 바꾼다(id = SHA-256(토큰)). 기존 행은 원문 토큰이 id 이므로 모두 지운다 → 배포 후 한 번 다시 로그인.
DELETE FROM "sessions";
