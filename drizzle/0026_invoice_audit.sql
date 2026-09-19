CREATE TABLE "invoice_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"carrier" text NOT NULL,
	"invoice_number" text NOT NULL,
	"file_name" text,
	"source" text NOT NULL,
	"email_message_id" text,
	"created_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"created_by" text,
	"currency" text NOT NULL,
	"line_count" integer NOT NULL,
	"invoiced_total" real NOT NULL,
	"quoted_total" real NOT NULL,
	"overcharge_total" real NOT NULL,
	"undercharge_total" real NOT NULL,
	"over_count" integer NOT NULL,
	"under_count" integer NOT NULL,
	"match_count" integer NOT NULL,
	"no_quote_count" integer NOT NULL,
	"not_found_count" integer NOT NULL,
	"duplicate_count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_audit_line" (
	"id" text PRIMARY KEY NOT NULL,
	"audit_id" text NOT NULL,
	"sheet_row" integer NOT NULL,
	"awb" text,
	"service" text,
	"epg_ref" text,
	"final_mile_tracking" text,
	"destination_country" text,
	"actual_weight_lb" real,
	"dim_weight_lb" real,
	"billed_weight_lb" real,
	"sell_rate" real NOT NULL,
	"surcharge_total" real NOT NULL,
	"invoiced_amount" real NOT NULL,
	"invoiced_currency" text NOT NULL,
	"scan_id" text,
	"quote_source" text,
	"quoted_amount" real,
	"quoted_currency" text,
	"quoted_weight_lb" real,
	"status" text NOT NULL,
	"difference" real,
	"billed_heavier" boolean DEFAULT false NOT NULL,
	"note" text
);
--> statement-breakpoint
ALTER TABLE "invoice_audit" ADD CONSTRAINT "invoice_audit_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD CONSTRAINT "invoice_audit_line_audit_id_invoice_audit_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."invoice_audit"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoice_audit_carrier_invoice_idx" ON "invoice_audit" USING btree ("carrier","invoice_number");--> statement-breakpoint
CREATE INDEX "invoice_audit_line_audit_idx" ON "invoice_audit_line" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "invoice_audit_line_epg_ref_idx" ON "invoice_audit_line" USING btree ("epg_ref");--> statement-breakpoint
ALTER TABLE "invoice_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ENABLE ROW LEVEL SECURITY;
