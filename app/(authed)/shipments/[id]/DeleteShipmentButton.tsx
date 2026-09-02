"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteShipmentAction } from "../../scan-actions";
import ConfirmDialog from "../../ConfirmDialog";
import { actionErrorMessage } from "@/lib/error-message";
import { withTransportRetry } from "@/lib/with-retry";
import { TrashIcon } from "./icons";

export default function DeleteShipmentButton({ sessionId, shipDate }: { sessionId: string; shipDate: string }) {
  const [showConfirm, setShowConfirm] = useState(false);
  // Optimistic "already gone" state, set the instant the user confirms —
  // deliberately not navigated away on yet, so a failure can just revert
  // this flag and show the error inline instead of needing to signal a
  // rollback across a page the user has already left.
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <>
      <button
        type="button"
        disabled={isPending || deleted}
        onClick={() => setShowConfirm(true)}
        // Mobile: solid fill, no border — see ReopenButton for why red-ink
        // text alone didn't hold up against this bar's bg-ink. Desktop
        // keeps the original outline pill, unchanged.
        className="btn inline-flex flex-col md:flex-row items-center justify-center gap-1.5 md:gap-1 px-3 md:px-4 py-3.5 md:py-2 bg-red text-paper hover:bg-red-ink md:bg-transparent md:border md:border-red md:text-red-ink md:hover:bg-red-dim disabled:opacity-50 flex-1 md:flex-none md:shrink-0"
      >
        <TrashIcon className="w-7 h-7 md:hidden" />
        <span className="hidden md:inline">{deleted ? "Deleted" : "Delete"}</span>
      </button>

      {/* absolute here floats this above the mobile tab bar (its fixed
          parent's box) instead of squeezing in as a fourth tab; md:static
          reverts to a plain inline message under the button on desktop. */}
      {error && (
        <p className="absolute bottom-full left-0 right-0 mb-2 md:static md:mb-0 border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">
          {error}
        </p>
      )}

      {showConfirm && (
        <ConfirmDialog
          title="Delete this shipment?"
          message={`This permanently removes the ${shipDate} shipment and every scan in it from history. This cannot be undone.`}
          confirmLabel="Delete permanently"
          danger
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => {
            setShowConfirm(false);
            setError(null);
            setDeleted(true);
            startTransition(async () => {
              try {
                await withTransportRetry(() => deleteShipmentAction(sessionId));
                router.push("/shipments");
              } catch (err) {
                setDeleted(false);
                setError(actionErrorMessage(err, "Failed to delete shipment."));
              }
            });
          }}
        />
      )}
    </>
  );
}
