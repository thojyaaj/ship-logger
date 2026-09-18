-- Data-only. lookupShipstationShipment used to call GET /v2/shipments with a
-- `tracking_number` filter that endpoint doesn't have, so it returned the
-- account's newest shipment for every tracking number. Everything it wrote is
-- therefore someone else's data: the order-fallback order id / ship-to name,
-- and the rate-shop best rate (priced to that stranger's destination).
-- Cleared here so the fixed lookup refills them: the order-fallback and
-- rate-shop crons only look at rows with these columns unset, within their
-- lookback window. Rows older than that window stay blank rather than wrong.
UPDATE "scan"
SET "shipstation_order_fallback" = NULL,
    "shipstation_ship_to_name" = NULL,
    "shipstation_order_fallback_checked_at" = NULL
WHERE "shipstation_order_fallback" IS NOT NULL
   OR "shipstation_ship_to_name" IS NOT NULL
   OR "shipstation_order_fallback_checked_at" IS NOT NULL;
--> statement-breakpoint
UPDATE "scan"
SET "shipstation_best_rate_amount" = NULL,
    "shipstation_best_rate_carrier" = NULL,
    "shipstation_best_rate_checked_at" = NULL
WHERE "shipstation_best_rate_amount" IS NOT NULL
   OR "shipstation_best_rate_carrier" IS NOT NULL
   OR "shipstation_best_rate_checked_at" IS NOT NULL;
