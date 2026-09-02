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
        title={isPending ? "Reopening…" : "Reopen for corrections"}
        aria-label={isPending ? "Reopening…" : "Reopen for corrections"}
        // Mobile: solid fill, no border, big touch target in the fixed tab
        // bar — the amber-ink text this used to pair with a bare outline
        // was tuned for sitting on a light -dim chip, and read as
        // barely-visible dark-brown-on-near-black against this bar's
        // bg-ink. Desktop: icon-only now, sitting inline with the session
        // id row rather than a bordered pill — plain colored icon matching
        // the admin roster's icon-button convention.
        className="btn inline-flex flex-col md:inline items-center justify-center gap-1.5 px-3 md:px-0 py-3.5 md:py-0 bg-amber text-paper hover:bg-amber-ink md:bg-transparent md:text-amber-ink md:hover:text-amber disabled:opacity-50 flex-1 md:flex-none"
      >
        <RotateCcwIcon className="w-7 h-7 md:w-5 md:h-5" />
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
