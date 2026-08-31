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

export const shipmentSession = pgTable("shipment_session", {
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
  // Which EPG box new scans land in. UI-convenience state, not domain data —
  // kept here (rather than only in client state) so a hard refresh mid-session
  // reopens on the same box instead of defaulting back to Box 1.
  activeBoxId: text("active_box_id"),
});

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
