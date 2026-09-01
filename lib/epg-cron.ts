import "server-only";
import { db } from "./db";
import { scan } from "./db/schema";
import { and, eq, gt } from "drizzle-orm";
import { lookupEpgStatuses } from "./epg";
import { nowSqlTimestamp, toSqlTimestamp } from "./date";
import { findOrderByName } from "./shopify";
import { lookupOrderIndex } from "./order-index";

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
  /**
   * Parcels EPG returned no data for at all. Distinguishes "EPG hasn't ingested
   * this label yet / doesn't know it" from "we fetched it but couldn't match an
   * order" — without this the two are indistinguishable in the response, and
   * they have completely different causes and fixes.
   */
  epgNoRecord: number;
  /**
   * Orders resolved from the local webhook-fed index rather than from EPG's
   * ERef. Counted separately because it needs no EPG data at all — these are
   * parcels that would otherwise have waited on EPG ingestion, or waited
   * forever if EPG never picked them up.
   */
  ordersFromIndex: number;
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
      epgNoRecord: 0,
      ordersFromIndex: 0,
    };
  }

  const trackingNumbers = pending.map((s) => s.trackingNumber);
  const results = await lookupEpgStatuses(trackingNumbers);

  let updated = 0;
  let ordersResolved = 0;
  let orderResolutionMisses = 0;
  let orderResolutionErrors = 0;
  let epgNoRecord = 0;
  let ordersFromIndex = 0;
  const now = nowSqlTimestamp();
  for (const s of pending) {
    // Try the local index before anything else. It's a free, no-network lookup
    // and it doesn't depend on EPG having ingested the label, so it resolves
    // the exact parcels the ERef path can never reach. Scans recorded before
    // EPG was wired into this lookup get picked up here.
    if (!s.orderGid) {
      const indexed = await lookupOrderIndex(s.trackingNumber);
      if (indexed) {
        await db
          .update(scan)
          .set({ orderGid: indexed.orderGid, orderName: indexed.orderName })
          .where(eq(scan.id, s.id));
        s.orderGid = indexed.orderGid;
        s.orderName = indexed.orderName;
        ordersFromIndex += 1;
      }
    }

    const record = results.get(s.trackingNumber);
    if (!record) {
      epgNoRecord += 1;
      // EPG returned nothing for this parcel on this poll. That used to end
      // the iteration outright — but if a previous poll already stored an
      // ERef, we can still resolve the Shopify order from it without EPG
      // telling us anything new. Skipping that was why a parcel could sit
      // with a known ERef and permanently no order number.
      if (s.epgExternalRef && !s.orderGid) {
        try {
          const order = await findOrderByName(s.epgExternalRef);
          if (order) {
            await db
              .update(scan)
              .set({ orderGid: order.gid, orderName: order.name, statusCheckedAt: now })
              .where(eq(scan.id, s.id));
            ordersResolved += 1;
            continue;
          }
          orderResolutionMisses += 1;
        } catch {
          orderResolutionErrors += 1;
        }
      }
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
        // Never overwrite a known ERef with null. EPG omitting the field on one
        // poll shouldn't erase the value a later run needs to match the order.
        epgExternalRef: externalRef,
        epgFinalMile: record.finalMileTracking ?? s.epgFinalMile,
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
    epgNoRecord,
    ordersFromIndex,
  };
}
