CREATE TABLE IF NOT EXISTS "shipment_reset" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" text NOT NULL REFERENCES "shipment_session"("id"),
  "snapshot" text NOT NULL,
  "reset_at" text DEFAULT to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS') NOT NULL,
  "expires_at" text NOT NULL,
  "restored_at" text,
  "reset_by" text NOT NULL REFERENCES "app_user"("id")
);
