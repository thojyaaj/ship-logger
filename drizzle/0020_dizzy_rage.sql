CREATE TABLE "ai_insight" (
	"id" text PRIMARY KEY NOT NULL,
	"window_days" integer NOT NULL,
	"text" text NOT NULL,
	"generated_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"generated_by" text
);
--> statement-breakpoint
ALTER TABLE "ai_insight" ADD CONSTRAINT "ai_insight_generated_by_app_user_id_fk" FOREIGN KEY ("generated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;