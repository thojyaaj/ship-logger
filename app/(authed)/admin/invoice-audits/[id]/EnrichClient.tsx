"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actionErrorMessage } from "@/lib/error-message";
import type { EnrichResult } from "@/lib/invoice-audit/enrich";
import { enrichInvoiceAuditAction } from "../actions";

/**
 * Looks up ship date and customer shipping charge through ShipStation and
 * Shopify for parcels this audit couldn't get them for from a scan — up to
 * 40 per click (two ShipStation calls each). The nightly job does the same
 * for recent audits; this is for when you want it now.
 */
export default function EnrichClient({ auditId, candidates }: { auditId: string; candidates: number }) {
  const router = useRouter();
  const [result, setResult] = useState<EnrichResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await enrichInvoiceAuditAction(auditId);
        if (res.status === "error") {
          setError(res.message);
          return;
        }
        setResult(res.data);
        router.refresh();
      } catch (err) {
        setError(actionErrorMessage(err, "The lookup failed — please retry."));
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 border border-line bg-paper-panel p-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-ink-soft">
          {candidates} parcel{candidates === 1 ? "" : "s"} {candidates === 1 ? "is" : "are"} missing a ship date or customer
          charge. This looks them up in ShipStation and Shopify — up to 40 per click, so a large batch takes a minute.
        </p>
        <button
          type="button"
          onClick={run}
          disabled={isPending}
          className="btn px-3 py-2 bg-orange text-paper disabled:opacity-50 shrink-0"
        >
          {isPending ? "Looking up…" : "Look up in ShipStation"}
        </button>
      </div>
      {error && <p role="alert" className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}
      {result && !error && (
        <p role="status" className="text-sm text-ink-soft">
          Looked up {result.checked}: found {result.shipDates} ship date{result.shipDates === 1 ? "" : "s"} and{" "}
          {result.customerCharges} customer charge{result.customerCharges === 1 ? "" : "s"}.{" "}
          {result.aborted
            ? "Stopped early — ShipStation or Shopify kept failing. Try again in a few minutes."
            : result.remaining > 0
              ? `${result.remaining} left — click again to continue.`
              : "All done."}
        </p>
      )}
    </div>
  );
}
