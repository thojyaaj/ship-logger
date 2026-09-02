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
        title={deleted ? "In Trash" : "Delete"}
        aria-label={deleted ? "In Trash" : "Delete"}
        // Mobile: solid fill, no border, big touch target — see
        // ReopenButton for why red-ink text alone didn't hold up against
        // this bar's bg-ink. Desktop: icon-only, plain colored icon
        // matching the admin roster's icon-button convention.
        className="btn inline-flex flex-col md:inline items-center justify-center gap-1.5 px-3 md:px-0 py-3.5 md:py-0 bg-red text-paper hover:bg-red-ink md:bg-transparent md:text-red-ink md:hover:text-red disabled:opacity-50 flex-1 md:flex-none"
      >
        <TrashIcon className="w-7 h-7 md:w-5 md:h-5" />
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
          message={`This moves the ${shipDate} shipment to Trash. It can be restored from the Trash page within 30 days, after which it's permanently deleted.`}
          confirmLabel="Move to Trash"
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
