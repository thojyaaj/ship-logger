ALTER TABLE "scan" ADD COLUMN "customer_shipping_amount" real;--> statement-breakpoint
ALTER TABLE "scan" ADD COLUMN "customer_shipping_currency" text;--> statement-breakpoint
ALTER TABLE "shopify_order_index" ADD COLUMN "customer_shipping_amount" real;--> statement-breakpoint
ALTER TABLE "shopify_order_index" ADD COLUMN "customer_shipping_currency" text;