CREATE TABLE "kakao_links" (
	"user_id" text PRIMARY KEY NOT NULL,
	"kakao_user_id" text NOT NULL,
	"access_token" text NOT NULL,
	"access_expires_at" timestamp with time zone NOT NULL,
	"refresh_token" text NOT NULL,
	"refresh_expires_at" timestamp with time zone,
	"linked_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "kakao_links" ADD CONSTRAINT "kakao_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;