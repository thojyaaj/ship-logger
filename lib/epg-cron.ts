import "server-only";
import { db } from "./db";
import { scan } from "./db/schema";
import { and, eq, gt } from "drizzle-orm";
import { lookupEpgStatuses } from "./epg";
import { nowSqlTimestamp, toSqlTimestamp } from "./date";
import { findOrderByName } from "./shopify";

const LOOKBACK_DAYS = 45;

function isTerminal(statusLabel: string | null): boolean {
  if (!statusLabel) return false;
  return /delivered|returned to sender|return to shipper/i.test(statusLabel);
}

export type EpgCronResult = {
  candidates: number;
  updated: number;
  stillPending: number;
  ordersResolved: number;
  orderResolutionMisses: number; // ERef present but no matching Shopify order — a real data problem (§9a)
  orderResolutionErrors: number; // Shopify lookup itself failed (rate limit, transient API error) — retried next run
};

/**
 * Refreshes EPG status for scans that aren't already in a terminal state,
 * capped to a lookback window so cost (such as it is — this is free, but
 * still uncourteous to hammer an undocumented endpoint) stays bounded.
 * See PRD §8.9 / §5.6.
 */
export async function runEpgStatusCron(): Promise<EpgCronResult> {
  const cutoff = toSqlTimestamp(new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  // "Not terminal" is a regex-ish check on status text, awkward to express in
  // SQL — pull recent EPG scans and filter in JS instead. Row count here is
  // small enough (one warehouse's daily volume) that this is simpler, not slower.
  const allRecent = await db
    .select()
    .from(scan)
    .where(and(eq(scan.carrier, "epg"), gt(scan.scannedAt, cutoff)));

  // Two reasons to look at a scan: its status isn't final yet, or its Shopify
  // order still hasn't been resolved.
  //
  // The second half is the fix for parcels that permanently lost their order
  // number. Previously this was only `!isTerminal(...)`, so the moment a parcel
  // read "Delivered" it dropped out of the candidate set forever — and order
  // resolution happens *in this same loop*. Any parcel that reached a terminal
  // status before its order was matched (delivered fast, or the Shopify lookup
  // failed on the very run that marked it delivered) could never be retried,
  // no matter how many times the cron ran afterwards.
  const pending = allRecent.filter((s) => !isTerminal(s.statusLabel) || !s.orderGid);

  if (pending.length === 0) {
    return {
      candidates: allRecent.length,
      updated: 0,
      stillPending: 0,
      ordersResolved: 0,
      orderResolutionMisses: 0,
      orderResolutionErrors: 0,
    };
  }

  const trackingNumbers = pending.map((s) => s.trackingNumber);
  const results = await lookupEpgStatuses(trackingNumbers);

  let updated = 0;
  let ordersResolved = 0;
  let orderResolutionMisses = 0;
  let orderResolutionErrors = 0;
  const now = nowSqlTimestamp();
  for (const s of pending) {
    const record = results.get(s.trackingNumber);
    if (!record) {
      await db.update(scan).set({ statusCheckedAt: now }).where(eq(scan.id, s.id));
      continue;
    }

    // §9a: resolve the Shopify order via ERef once EPG has ingested it.
    // Skip if already resolved on a prior run — ERef doesn't change once set.
    // findOrderByName hits the Shopify Admin API and can throw (rate limit,
    // transient 5xx) — caught per-scan so one bad lookup doesn't abort the
    // rest of this batch's status updates, matching every other external
    // call in this cron (§8.9: never let one bad thing take the rest down).
    let orderGid: string | null = null;
    let orderName: string | null = null;
    // Fall back to the ERef already stored from an earlier run. EPG's response
    // isn't guaranteed to repeat every field on every call, and dropping back
    // to null for one poll shouldn't cost us a lookup we could still make.
    const externalRef = record.externalRef ?? s.epgExternalRef;
    if (externalRef && !s.orderGid) {
      try {
        const order = await findOrderByName(externalRef);
        if (order) {
          orderGid = order.gid;
          orderName = order.name;
          ordersResolved += 1;
        } else {
          // ERef present but no matching order — a genuine data problem
          // (mislabeled parcel, wrong order name format), not a transient miss.
          orderResolutionMisses += 1;
        }
      } catch {
        orderResolutionErrors += 1;
      }
    }

    await db
      .update(scan)
      .set({
        epgExternalRef: record.externalRef,
        epgFinalMile: record.finalMileTracking,
        statusCode: record.latestEvent ? String(record.latestEvent.categoryId) : null,
        statusLabel: record.latestEvent?.event ?? null,
        statusAt: record.latestEvent?.eventAt ?? null,
        statusCheckedAt: now,
        ...(orderGid ? { orderGid, orderName } : {}),
      })
      .where(eq(scan.id, s.id));
    updated += 1;
  }

  return {
    candidates: allRecent.length,
    updated,
    stillPending: pending.length - updated,
    ordersResolved,
    orderResolutionMisses,
    orderResolutionErrors,
  };
}
