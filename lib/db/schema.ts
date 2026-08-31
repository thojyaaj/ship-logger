import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  integer,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Timestamp columns are `text`, not Postgres's native `timestamp` type,
// formatted as "YYYY-MM-DD HH:MI:SS" UTC with no zone marker — matching
// what SQLite's `(current_timestamp)` produced during Phase 1 dev. Kept
// this way on the Postgres port so lib/date.ts's parsing (and every
// display site built against it) didn't need to change.
const nowUtcText = sql`to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

export const appUser = pgTable("app_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  pinHash: text("pin_hash").notNull(),
  isAdmin: boolean("is_admin").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: text("created_at").notNull().default(nowUtcText),
});

export const shipmentSession = pgTable(
  "shipment_session",
  {
    id: text("id").primaryKey(),
    openedAt: text("opened_at").notNull().default(nowUtcText),
    openedBy: text("opened_by")
      .notNull()
      .references(() => appUser.id),
    submittedAt: text("submitted_at"),
    submittedBy: text("submitted_by").references(() => appUser.id),
    shipDate: text("ship_date").notNull(),
    notes: text("notes").notNull().default(""),
    status: text("status", { enum: ["open", "submitted", "voided"] })
      .notNull()
      .default("open"),
    awbNumber: text("awb_number"),
    masterUpsTracking: text("master_ups_tracking"),
    // Live UPS Track API status for `masterUpsTracking`, refreshed by the
    // nightly ups-status cron (mirrors scan.status_* for EPG). Nullable/never
    // populated until the cron runs at least once for this session.
    masterUpsStatusCode: text("master_ups_status_code"),
    masterUpsStatusLabel: text("master_ups_status_label"),
    masterUpsStatusAt: text("master_ups_status_at"),
    masterUpsStatusCheckedAt: text("master_ups_status_checked_at"),
    // Which EPG box new scans land in. UI-convenience state, not domain data —
    // kept here (rather than only in client state) so a hard refresh mid-session
    // reopens on the same box instead of defaulting back to Box 1.
    activeBoxId: text("active_box_id"),
  },
  // At most one row can be "open" at a time — that's what makes "the open
  // session" unambiguous. A partial unique index on `status` (filtered to
  // just the 'open' rows) enforces this at the database level: a second
  // concurrent INSERT racing to open a session fails with a unique
  // violation instead of silently creating two open sessions. See
  // getOrCreateOpenSession's retry-on-conflict handling in lib/shiplog.ts.
  (t) => [uniqueIndex("shipment_session_one_open_idx").on(t.status).where(sql`${t.status} = 'open'`)],
);

export const box = pgTable(
  "box",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => shipmentSession.id),
    boxNumber: integer("box_number").notNull(),
    upsTracking: text("ups_tracking"),
  },
  (t) => [uniqueIndex("box_session_number_idx").on(t.sessionId, t.boxNumber)],
);

export const scan = pgTable(
  "scan",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => shipmentSession.id),
    boxId: text("box_id").references(() => box.id),
    scannedBy: text("scanned_by")
      .notNull()
      .references(() => appUser.id),
    trackingNumber: text("tracking_number").notNull(),
    carrier: text("carrier", { enum: ["epg", "ups", "dhl", "unknown"] }).notNull(),
    scannedAt: text("scanned_at").notNull().default(nowUtcText),
    sequence: integer("sequence").notNull(),
    orderGid: text("order_gid"),
    orderName: text("order_name"),
    epgExternalRef: text("epg_external_ref"),
    epgFinalMile: text("epg_final_mile"),
    statusCode: text("status_code"),
    statusLabel: text("status_label"),
    statusAt: text("status_at"),
    statusCheckedAt: text("status_checked_at"),
  },
  (t) => [uniqueIndex("scan_tracking_number_idx").on(t.trackingNumber)],
);

// Phase 2 §9b — UPS/DHL parcels carry no reference back to their Shopify
// order (unlike EPG's ERef), so this index is fed by FULFILLMENTS_CREATE/
// UPDATE webhooks plus a one-time backfill, then read locally at scan time
// with no per-scan Shopify API call. EPG parcels don't use this table —
// their order comes from resolving `scan.epg_external_ref` (ERef) via a
// live Shopify query in the nightly EPG status cron (§9a).
export const shopifyOrderIndex = pgTable("shopify_order_index", {
  trackingNumber: text("tracking_number").primaryKey(),
  orderGid: text("order_gid").notNull(),
  orderName: text("order_name").notNull(),
  customerName: text("customer_name"),
  destination: text("destination"),
  updatedAt: text("updated_at").notNull().default(nowUtcText),
});
