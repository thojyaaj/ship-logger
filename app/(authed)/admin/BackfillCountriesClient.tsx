"use client";

import { useState, useTransition } from "react";
import type { BackfillCountriesResult } from "@/lib/order-index";
import { backfillDestinationCountriesAction } from "./backfill-actions";
import { actionErrorMessage } from "@/lib/error-message";

/**
 * One-off maintenance action, not a settings form — there's nothing to
 * configure, just a button that fills in `destinationCountry` and
 * `customerShippingAmount` for scans matched to an order before those
 * columns existed (see lib/order-index.ts's backfillDestinationCountries —
 * one function, both fields, since they're written by the same call). Safe
 * to click repeatedly: each run only ever fills in a currently-null value,
 * never overwrites one that's already set.
 */
export default function BackfillCountriesClient() {
  const [result, setResult] = useState<BackfillCountriesResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      try {
        setResult(await backfillDestinationCountriesAction());
      } catch (err) {
        setError(actionErrorMessage(err, "Backfill failed — please retry."));
      }
    });
  }

  const remaining = result ? result.candidates - result.processed : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="route-line pb-2">
        <h2 className="font-stencil text-xl tracking-wide">Order Data Backfill</h2>
        <p className="tag-label !normal-case !tracking-normal text-ink-faint mt-1">
          Fills in the destination-country badge and the charged-shipping amount (shipment detail
          pages) for parcels that were matched to an order before those existed. New matches already
          get them automatically — this is only for the backlog.
        </p>
      </div>

      <button
        type="button"
        onClick={run}
        disabled={isPending}
        className="btn self-start px-4 py-2 bg-orange text-paper disabled:opacity-50"
      >
        {isPending ? "Backfilling…" : "Run Backfill"}
      </button>

      {error && <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}

      {result && !error && (
        <p className="tag-label !normal-case !tracking-normal text-ink-faint">
          {result.updated} order{result.updated === 1 ? "" : "s"} updated
          {result.errors > 0 && `, ${result.errors} failed (retry by running again)`}.{" "}
          {remaining !== null && remaining > 0
            ? `${remaining} more still pending — click again to continue.`
            : "No more pending."}
        </p>
      )}
    </div>
  );
}
