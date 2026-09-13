CREATE TABLE "problem_dismissal" (
	"id" text PRIMARY KEY NOT NULL,
	"scan_id" text NOT NULL,
	"category" text NOT NULL,
	"dismissed_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"dismissed_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "problem_dismissal" ADD CONSTRAINT "problem_dismissal_scan_id_scan_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."scan"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "problem_dismissal" ADD CONSTRAINT "problem_dismissal_dismissed_by_app_user_id_fk" FOREIGN KEY ("dismissed_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "problem_dismissal_scan_category_idx" ON "problem_dismissal" USING btree ("scan_id","category");