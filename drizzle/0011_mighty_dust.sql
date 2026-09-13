ALTER TABLE "scan" ADD COLUMN "shipstation_weight_lb" real;--> statement-breakpoint
ALTER TABLE "scan" ADD COLUMN "shipstation_length_in" real;--> statement-breakpoint
ALTER TABLE "scan" ADD COLUMN "shipstation_width_in" real;--> statement-breakpoint
ALTER TABLE "scan" ADD COLUMN "shipstation_height_in" real;--> statement-breakpoint
ALTER TABLE "scan" ADD COLUMN "shipstation_checked_at" text;