CREATE TABLE "shipstation_epg_label_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"ship_to_name" text DEFAULT '' NOT NULL,
	"ship_to_company_name" text DEFAULT '' NOT NULL,
	"ship_to_address_line1" text DEFAULT '' NOT NULL,
	"ship_to_address_line2" text,
	"ship_to_city" text DEFAULT '' NOT NULL,
	"ship_to_state" text DEFAULT '' NOT NULL,
	"ship_to_postal_code" text DEFAULT '' NOT NULL,
	"ship_to_country_code" text DEFAULT 'US' NOT NULL,
	"ship_to_phone" text DEFAULT '' NOT NULL,
	"ship_from_warehouse_name" text DEFAULT '' NOT NULL,
	"service_code" text DEFAULT 'ups_ground' NOT NULL,
	"confirmation" text DEFAULT 'delivery' NOT NULL,
	"bill_to_party" text DEFAULT 'recipient' NOT NULL,
	"bill_to_account" text DEFAULT '' NOT NULL,
	"bill_to_postal_code" text DEFAULT '' NOT NULL,
	"bill_to_country_code" text DEFAULT 'US' NOT NULL,
	"package_length_in" real DEFAULT 20 NOT NULL,
	"package_width_in" real DEFAULT 20 NOT NULL,
	"package_height_in" real DEFAULT 20 NOT NULL,
	"updated_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "shipment_session" ADD COLUMN "shipstation_shipment_id" text;--> statement-breakpoint
ALTER TABLE "shipment_session" ADD COLUMN "shipstation_draft_status" text;--> statement-breakpoint
ALTER TABLE "shipment_session" ADD COLUMN "shipstation_draft_error" text;--> statement-breakpoint
ALTER TABLE "shipment_session" ADD COLUMN "shipstation_draft_at" text;--> statement-breakpoint
ALTER TABLE "shipstation_epg_label_settings" ADD CONSTRAINT "shipstation_epg_label_settings_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;