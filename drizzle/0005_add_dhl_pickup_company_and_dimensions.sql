ALTER TABLE "dhl_pickup_settings" ADD COLUMN "company_name" text DEFAULT 'OTC Shoppe Express' NOT NULL;--> statement-breakpoint
ALTER TABLE "dhl_pickup_settings" ADD COLUMN "avg_length_in" real DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "dhl_pickup_settings" ADD COLUMN "avg_width_in" real DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "dhl_pickup_settings" ADD COLUMN "avg_height_in" real DEFAULT 12 NOT NULL;