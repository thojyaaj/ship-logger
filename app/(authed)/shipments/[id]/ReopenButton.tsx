"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { reopenSessionAction } from "../../scan-actions";
import ConfirmDialog from "../../ConfirmDialog";
import { actionErrorMessage } from "@/lib/error-message";
import { withTransportRetry } from "@/lib/with-retry";
import { RotateCcwIcon } from "./icons";

export default function ReopenButton({ sessionId }: { sessionId: string }) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <>
      <button
        type="button"
        disabled={isPending}
        onClick={() => setShowConfirm(true)}
        className="btn inline-flex flex-col md:flex-row items-center justify-center gap-1 px-3 md:px-4 py-2 border border-amber text-amber-ink hover:bg-amber-dim disabled:opacity-50 shrink-0"
      >
        <RotateCcwIcon className="w-5 h-5 md:hidden" />
        <span className="md:hidden">Reopen</span>
        <span className="hidden md:inline">{isPending ? "Reopening…" : "Reopen for corrections"}</span>
      </button>

      {error && (
        <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>
      )}

      {showConfirm && (
        <ConfirmDialog
          title="Reopen this shipment?"
          message="This puts an already-submitted shipment back into an editable state so corrections can be scanned. The reopen is recorded in the shipment's notes."
          confirmLabel="Reopen"
          onCancel={() => setShowConfirm(false)}
          onConfirm={() => {
            setShowConfirm(false);
            setError(null);
            startTransition(async () => {
              try {
                await withTransportRetry(() => reopenSessionAction(sessionId));
                router.push("/");
              } catch (err) {
                // Was a bare alert(), which drops an OS dialog into an app that
                // has a themed ConfirmDialog for exactly this.
                setError(actionErrorMessage(err, "Failed to reopen shipment."));
              }
            });
          }}
        />
      )}
    </>
  );
}
