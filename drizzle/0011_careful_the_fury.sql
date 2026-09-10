CREATE TABLE "shopify_offline_token" (
	"shop" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"scope" text NOT NULL,
	"installed_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "shopify_offline_token" ENABLE ROW LEVEL SECURITY;
