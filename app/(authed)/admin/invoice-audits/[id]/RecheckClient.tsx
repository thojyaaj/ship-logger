"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actionErrorMessage } from "@/lib/error-message";
import type { RecheckResult } from "@/lib/invoice-audit/audit";
import { recheckInvoiceAuditAction } from "../actions";

/**
 * Re-checks this audit's unverified parcels (no quote / not found) —
 * saved costs first, then up to 80 live ShipStation lookups per click.
 * router.refresh() re-renders the server page with the updated lines and
 * totals rather than patching them client-side.
 */
export default function RecheckClient({ auditId, unverified }: { auditId: string; unverified: number }) {
  const router = useRouter();
  const [result, setResult] = useState<RecheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await recheckInvoiceAuditAction(auditId);
        if (res.status === "error") {
          setError(res.message);
          return;
        }
        setResult(res.data);
        router.refresh();
      } catch (err) {
        setError(actionErrorMessage(err, "Re-check failed — please retry."));
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 border border-line bg-paper-panel p-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-ink-soft">
          {unverified} parcel{unverified === 1 ? "" : "s"} couldn&apos;t be verified yet. Re-checking looks them up again —
          up to 80 per click, so a large batch can take a minute.
        </p>
        <button
          type="button"
          onClick={run}
          disabled={isPending}
          className="btn px-3 py-2 bg-orange text-paper disabled:opacity-50 shrink-0"
        >
          {isPending ? "Re-checking…" : "Re-check unverified parcels"}
        </button>
      </div>
      {error && <p role="alert" className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}
      {result && !error && (
        <p role="status" className="text-sm text-ink-soft">
          Checked {result.checked}, found a cost for {result.resolved}.{" "}
          {result.neverChecked > 0
            ? `${result.neverChecked} still haven't been looked up — click again to continue.`
            : result.remaining > 0
              ? `${result.remaining} still unverified — ShipStation doesn't have a cost for them yet.`
              : "Every parcel is verified."}
        </p>
      )}
    </div>
  );
}
