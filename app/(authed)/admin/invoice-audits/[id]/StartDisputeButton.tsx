"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actionErrorMessage } from "@/lib/error-message";
import { createDisputeAction } from "../actions";

/** Starts a dispute from this one invoice's not-yet-disputed overcharges, then opens it. */
export default function StartDisputeButton({ auditId, parcels }: { auditId: string; parcels: number }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              const result = await createDisputeAction([auditId]);
              if (result.status === "error") setError(result.message);
              else router.push(`/admin/invoice-audits/disputes/${result.data.id}`);
            } catch (err) {
              setError(actionErrorMessage(err, "Couldn't create the dispute — please retry."));
            }
          });
        }}
        className="btn px-3 py-2 bg-orange text-paper text-sm disabled:opacity-50"
        title="Collect this invoice's overcharged parcels into a dispute to send to ePost Global"
      >
        {isPending ? "Creating…" : `Start a dispute (${parcels})`}
      </button>
      {error && <p role="alert" className="text-xs text-red-ink">{error}</p>}
    </div>
  );
}
