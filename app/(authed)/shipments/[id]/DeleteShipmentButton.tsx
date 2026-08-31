"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { deleteShipmentAction } from "../../scan-actions";
import ConfirmDialog from "../../ConfirmDialog";

export default function DeleteShipmentButton({ sessionId, shipDate }: { sessionId: string; shipDate: string }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <>
      <button
        type="button"
        disabled={isPending}
        onClick={() => setShowConfirm(true)}
        className="btn px-4 py-2 border border-red text-red-ink hover:bg-red-dim disabled:opacity-50"
      >
        {isPending ? "Deleting…" : "Delete"}
      </button>

      {showConfirm && (
        <ConfirmDialog
          title="Delete this shipment?"
          message={`This permanently removes the ${shipDate} shipment and every scan in it from history. This cannot be undone.`}
          confirmLabel="Delete permanently"
          danger
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => {
            setShowConfirm(false);
            startTransition(async () => {
              try {
                await deleteShipmentAction(sessionId);
                router.push("/shipments");
              } catch (err) {
                alert(err instanceof Error ? err.message : "Failed to delete shipment.");
              }
            });
          }}
        />
      )}
    </>
  );
}
