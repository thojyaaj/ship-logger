CREATE TABLE "display_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"boxes_as_tabs" boolean DEFAULT true NOT NULL,
	"updated_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "display_settings" ADD CONSTRAINT "display_settings_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;