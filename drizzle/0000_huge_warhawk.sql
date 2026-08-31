CREATE TABLE "app_user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"pin_hash" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
CREATE TABLE "box" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"box_number" integer NOT NULL,
	"ups_tracking" text
);
--> statement-breakpoint
CREATE TABLE "scan" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"box_id" text,
	"scanned_by" text NOT NULL,
	"tracking_number" text NOT NULL,
	"carrier" text NOT NULL,
	"scanned_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"sequence" integer NOT NULL,
	"order_gid" text,
	"order_name" text,
	"epg_external_ref" text,
	"epg_final_mile" text,
	"status_code" text,
	"status_label" text,
	"status_at" text,
	"status_checked_at" text
);
--> statement-breakpoint
CREATE TABLE "shipment_session" (
	"id" text PRIMARY KEY NOT NULL,
	"opened_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"opened_by" text NOT NULL,
	"submitted_at" text,
	"submitted_by" text,
	"ship_date" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"awb_number" text,
	"master_ups_tracking" text,
	"active_box_id" text
);
--> statement-breakpoint
ALTER TABLE "box" ADD CONSTRAINT "box_session_id_shipment_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."shipment_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_session_id_shipment_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."shipment_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_box_id_box_id_fk" FOREIGN KEY ("box_id") REFERENCES "public"."box"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan" ADD CONSTRAINT "scan_scanned_by_app_user_id_fk" FOREIGN KEY ("scanned_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_session" ADD CONSTRAINT "shipment_session_opened_by_app_user_id_fk" FOREIGN KEY ("opened_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_session" ADD CONSTRAINT "shipment_session_submitted_by_app_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "box_session_number_idx" ON "box" USING btree ("session_id","box_number");--> statement-breakpoint
CREATE UNIQUE INDEX "scan_tracking_number_idx" ON "scan" USING btree ("tracking_number");