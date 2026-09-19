CREATE TABLE "invoice_dispute" (
	"id" text PRIMARY KEY NOT NULL,
	"carrier" text NOT NULL,
	"created_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
	"created_by" text,
	"sent_at" text,
	"sent_by" text
);
--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "dispute_id" text;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "disputed_amount" real;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "dispute_outcome" text;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "credited_amount" real;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD COLUMN "dispute_resolved_at" text;--> statement-breakpoint
ALTER TABLE "invoice_dispute" ADD CONSTRAINT "invoice_dispute_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_dispute" ADD CONSTRAINT "invoice_dispute_sent_by_app_user_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_audit_line" ADD CONSTRAINT "invoice_audit_line_dispute_id_invoice_dispute_id_fk" FOREIGN KEY ("dispute_id") REFERENCES "public"."invoice_dispute"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_audit_line_dispute_idx" ON "invoice_audit_line" USING btree ("dispute_id");--> statement-breakpoint
ALTER TABLE "invoice_dispute" ENABLE ROW LEVEL SECURITY;
