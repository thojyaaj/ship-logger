"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteShipmentAction } from "../../scan-actions";
import ConfirmDialog from "../../ConfirmDialog";

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
        className="btn px-4 py-2 border border-red text-red-ink hover:bg-red-dim disabled:opacity-50"
      >
        {deleted ? "Deleted" : "Delete"}
      </button>

      {error && (
        <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>
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
                await deleteShipmentAction(sessionId);
                router.push("/shipments");
              } catch (err) {
                setDeleted(false);
                setError(err instanceof Error ? err.message : "Failed to delete shipment.");
              }
            });
          }}
        />
      )}
    </>
  );
}
