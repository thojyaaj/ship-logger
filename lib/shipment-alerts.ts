import "server-only";
import { db } from "./db";
import { scan, shipmentSession } from "./db/schema";
import { and, eq, gt, inArray, isNull, ne } from "drizzle-orm";
import { toSqlTimestamp, parseCarrierTimestamp } from "./date";
import { carrierLabel, trackingUrl, type Carrier } from "./carrier";
import { sendAlertEmail } from "./email";

const LOOKBACK_DAYS = 90;
const STALE_DAYS = 7;

// Carriers with a real per-scan status feed. EPG scans can also carry
// exception-shaped text (customs holds are common on international mail),
// so it's included for the exceptions half; the stale check stays scoped to
// UPS/DHL per how this was asked for — EPG's status text is much less
// standardized, and epgtrack.com is already the least reliable of the three
// sources (see lib/epg.ts), so a 7-day-silent EPG scan is a weaker signal.
const EXCEPTION_CARRIERS: Carrier[] = ["ups", "dhl", "epg"];
const STALE_CARRIERS: Carrier[] = ["ups", "dhl"];

function isTerminal(statusLabel: string | null): boolean {
  if (!statusLabel) return false;
  return /delivered|returned to sender|return to shipper/i.test(statusLabel);
}

// Broader than lib/carrier.ts's statusTone regex on purpose: this gates an
// email, so it's tuned toward catching real customs/payment problems (the
// motivating case: "duties are due") even at some risk of a false positive,
// rather than toward clean display styling. Untested against live carrier
// text for every case — like lib/ups.ts, expect to tune this once real
// exception strings are seen in production.
const EXCEPTION_RE =
  /exception|duty|duties|customs|clearance|payment.*(due|required)|action required|delivery attempt|refused|undeliverable|held at/i;

function isException(statusLabel: string | null): boolean {
  if (!statusLabel) return false;
  return EXCEPTION_RE.test(statusLabel);
}

export type ProblemScan = {
  id: string;
  trackingNumber: string;
  carrier: Carrier;
  sessionId: string;
  orderName: string | null;
  statusLabel: string | null;
  statusAt: string | null;
  daysSinceUpdate: number;
  trackingUrl: string | null;
};

export type ProblemShipments = {
  exceptions: ProblemScan[];
  stale: ProblemScan[];
};

function daysSince(value: string): number {
  const ms = Date.now() - parseCarrierTimestamp(value).getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Live query — no stored "alert" table. Both the admin page and the daily
 * digest cron call this directly, so what's shown always matches what's
 * currently true rather than a snapshot from whenever the cron last ran.
 */
export async function getProblemShipments(): Promise<ProblemShipments> {
  const cutoff = toSqlTimestamp(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  const rows = await db
    .select({
      id: scan.id,
      trackingNumber: scan.trackingNumber,
      carrier: scan.carrier,
      sessionId: scan.sessionId,
      orderName: scan.orderName,
      statusLabel: scan.statusLabel,
      statusAt: scan.statusAt,
      scannedAt: scan.scannedAt,
    })
    .from(scan)
    .innerJoin(shipmentSession, eq(scan.sessionId, shipmentSession.id))
    .where(
      and(
        inArray(scan.carrier, EXCEPTION_CARRIERS),
        isNull(shipmentSession.deletedAt),
        ne(shipmentSession.status, "voided"),
        gt(scan.scannedAt, cutoff),
      ),
    );

  const exceptions: ProblemScan[] = [];
  const stale: ProblemScan[] = [];

  for (const r of rows) {
    // Last known movement: the carrier's own event time if we have one,
    // otherwise when it was scanned in — a scan that's never gotten a
    // status at all is exactly as stale as one whose status stopped moving.
    const lastUpdate = r.statusAt ?? r.scannedAt;
    const entry: ProblemScan = {
      id: r.id,
      trackingNumber: r.trackingNumber,
      carrier: r.carrier as Carrier,
      sessionId: r.sessionId,
      orderName: r.orderName,
      statusLabel: r.statusLabel,
      statusAt: r.statusAt,
      daysSinceUpdate: daysSince(lastUpdate),
      trackingUrl: trackingUrl(r.carrier as Carrier, r.trackingNumber),
    };

    if (isException(r.statusLabel)) {
      exceptions.push(entry);
      continue; // an exception scan isn't also double-counted as stale
    }

    if (
      STALE_CARRIERS.includes(r.carrier as Carrier) &&
      !isTerminal(r.statusLabel) &&
      entry.daysSinceUpdate >= STALE_DAYS
    ) {
      stale.push(entry);
    }
  }

  exceptions.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);
  stale.sort((a, b) => b.daysSinceUpdate - a.daysSinceUpdate);

  return { exceptions, stale };
}

export type ProblemSummary = { exceptionCount: number; staleCount: number };

/** Cheap counts-only version for the in-app banner shown on every admin page load. */
export async function getProblemSummary(): Promise<ProblemSummary> {
  const { exceptions, stale } = await getProblemShipments();
  return { exceptionCount: exceptions.length, staleCount: stale.length };
}

function rowsHtml(items: ProblemScan[]): string {
  return items
    .map(
      (i) => `<tr>
        <td style="padding:4px 8px;font-family:monospace">${carrierLabel(i.carrier)}</td>
        <td style="padding:4px 8px;font-family:monospace">${i.trackingUrl ? `<a href="${i.trackingUrl}">${i.trackingNumber}</a>` : i.trackingNumber}</td>
        <td style="padding:4px 8px">${i.orderName ?? "—"}</td>
        <td style="padding:4px 8px">${i.statusLabel ?? "—"}</td>
        <td style="padding:4px 8px">${i.daysSinceUpdate}d</td>
        <td style="padding:4px 8px"><a href="https://ship.otcshoppeexpress.com/shipments/${i.sessionId}">shipment</a></td>
      </tr>`,
    )
    .join("");
}

/**
 * Sends one digest email covering every currently-open problem — not one
 * email per newly-found problem. There's no stored "already notified" state
 * (see getProblemShipments), so this is deliberately a standing daily
 * reminder rather than a one-shot alert: an unresolved exception keeps
 * showing up in the digest every day until it's fixed, which is the
 * intended behavior for something an admin needs to actually act on.
 */
export async function runShipmentAlertsCron(): Promise<ProblemSummary> {
  const { exceptions, stale } = await getProblemShipments();
  if (exceptions.length === 0 && stale.length === 0) {
    return { exceptionCount: 0, staleCount: 0 };
  }

  const parts: string[] = [];
  if (exceptions.length > 0) {
    parts.push(
      `<h2>Exceptions (${exceptions.length})</h2><table>${rowsHtml(exceptions)}</table>`,
    );
  }
  if (stale.length > 0) {
    parts.push(
      `<h2>Stale — no update in ${STALE_DAYS}+ days (${stale.length})</h2><table>${rowsHtml(stale)}</table>`,
    );
  }

  await sendAlertEmail(
    `Ship Logger: ${exceptions.length} exception(s), ${stale.length} stale shipment(s)`,
    parts.join("<hr/>"),
  );

  return { exceptionCount: exceptions.length, staleCount: stale.length };
}
