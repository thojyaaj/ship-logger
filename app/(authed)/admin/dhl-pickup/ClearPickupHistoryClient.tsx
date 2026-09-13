"use client";

import { useState, useTransition } from "react";
import { clearDhlPickupHistoryAction } from "./actions";
import { actionErrorMessage } from "@/lib/error-message";
import ConfirmDialog from "../../ConfirmDialog";

/**
 * One-time maintenance action, not a settings control — every row in
 * dhl_pickup_request today is manual test data from building the pickup
 * feature (see lib/dhl-pickup.ts's clearDhlPickupHistory), which was
 * inflating Analytics' DHL cancel-rate stat. Irreversible, unlike
 * BackfillCountriesClient's safe-to-rerun fill, so it goes through
 * ConfirmDialog first rather than acting on a single click.
 */
export default function ClearPickupHistoryClient() {
  const [confirming, setConfirming] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setConfirming(false);
    setError(null);
    startTransition(async () => {
      try {
        const result = await clearDhlPickupHistoryAction();
        setDeleted(result.deleted);
      } catch (err) {
        setError(actionErrorMessage(err, "Clearing pickup history failed — please retry."));
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="route-line pb-2">
        <h2 className="font-stencil text-xl tracking-wide">DHL Pickup History Cleanup</h2>
        <p className="tag-label !normal-case !tracking-normal text-ink-faint mt-1">
          Deletes every DHL pickup request/cancellation on record — all of it is test data from
          building the pickup feature, not real warehouse activity. Real pickups scheduled after
          this runs are unaffected. Cannot be undone.
        </p>
      </div>

      <button
        type="button"
        onClick={() => setConfirming(true)}
        disabled={isPending}
        className="btn self-start px-4 py-2 bg-red text-paper disabled:opacity-50"
      >
        {isPending ? "Clearing…" : "Clear Pickup History"}
      </button>

      {error && <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}

      {deleted !== null && !error && (
        <p className="tag-label !normal-case !tracking-normal text-ink-faint">
          {deleted === 0 ? "Nothing to delete." : `Deleted ${deleted} pickup record${deleted === 1 ? "" : "s"}.`}
        </p>
      )}

      {confirming && (
        <ConfirmDialog
          title="Clear DHL pickup history?"
          message="This permanently deletes every DHL pickup request and cancellation on record. This cannot be undone."
          confirmLabel="Clear History"
          danger
          onConfirm={run}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
