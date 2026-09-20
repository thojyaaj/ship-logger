ALTER TABLE "invoice_audit_line" ADD COLUMN "shipstation_ship_date" text;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "order_ref" text;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "order_name" text;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "order_shipping_amount" real;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "order_shipping_currency" text;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "enriched_at" text;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "enrich_note" text;--> statement-breakpoint
CREATE INDEX "invoice_audit_line_order_ref_idx" ON "invoice_audit_line" USING btree ("order_ref");