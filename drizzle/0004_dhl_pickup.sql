CREATE TABLE "dhl_pickup_request" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"status" text NOT NULL,
	"dispatch_confirmation_number" text,
	"parcel_count" integer NOT NULL,
	"total_weight_lb" real NOT NULL,
	"error_message" text,
	"cancelled_at" text,
	"cancelled_by" text
);
--> statement-breakpoint
CREATE TABLE "dhl_pickup_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"account_number" text NOT NULL,
	"contact_name" text NOT NULL,
	"contact_phone" text NOT NULL,
	"address_line1" text NOT NULL,
	"address_line2" text,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"postal_code" text NOT NULL,
	"country_code" text DEFAULT 'US' NOT NULL,
	"ready_time" text NOT NULL,
	"close_time" text NOT NULL,
	"avg_weight_lb_per_parcel" real DEFAULT 1 NOT NULL,
	"special_instructions" text,
	"updated_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "dhl_pickup_request" ADD CONSTRAINT "dhl_pickup_request_session_id_shipment_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."shipment_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dhl_pickup_request" ADD CONSTRAINT "dhl_pickup_request_requested_by_app_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dhl_pickup_request" ADD CONSTRAINT "dhl_pickup_request_cancelled_by_app_user_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dhl_pickup_settings" ADD CONSTRAINT "dhl_pickup_settings_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dhl_pickup_request_one_active_idx" ON "dhl_pickup_request" USING btree ("session_id") WHERE "dhl_pickup_request"."status" = 'requested';