CREATE TABLE "shopify_order_index" (
	"tracking_number" text PRIMARY KEY NOT NULL,
	"order_gid" text NOT NULL,
	"order_name" text NOT NULL,
	"customer_name" text,
	"destination" text,
	"updated_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
