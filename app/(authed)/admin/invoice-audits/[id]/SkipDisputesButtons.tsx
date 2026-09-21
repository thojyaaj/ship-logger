"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actionErrorMessage } from "@/lib/error-message";
import { setAuditSkippedAction } from "../actions";

/**
 * Invoice-level skip: leave every not-yet-disputed overcharge on this
 * invoice out of disputes (an old invoice, or charges you've decided to
 * accept), and bring them back again if you change your mind.
 */
export default function SkipDisputesButtons({
  auditId,
  undisputed,
  skipped,
}: {
  auditId: string;
  undisputed: number;
  skipped: number;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(skip: boolean) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await setAuditSkippedAction(auditId, skip);
        if (result.status === "error") setError(result.message);
        else router.refresh();
      } catch (err) {
        setError(actionErrorMessage(err, "That didn't work — please retry."));
      }
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2 flex-wrap justify-end">
        {undisputed > 0 && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => {
              if (window.confirm(`Skip disputing ${undisputed} overcharged parcel${undisputed === 1 ? "" : "s"} on this invoice? You can restore them any time.`)) run(true);
            }}
            className="btn px-3 py-2 border border-line-strong bg-paper-panel hover:bg-paper-dim text-sm disabled:opacity-50"
            title="Leave this invoice's overcharges out of disputes"
          >
            Skip disputes ({undisputed})
          </button>
        )}
        {skipped > 0 && (
          <button
            type="button"
            disabled={isPending}
            onClick={() => run(false)}
            className="text-xs text-ink-soft underline hover:text-ink disabled:opacity-50"
          >
            Restore {skipped} skipped
          </button>
        )}
      </div>
      {error && <p role="alert" className="text-xs text-red-ink">{error}</p>}
    </div>
  );
}
