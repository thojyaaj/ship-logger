"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { actionErrorMessage } from "@/lib/error-message";
import { formatMoney } from "@/lib/invoice-audit/format";
import type { DisputeOutcome } from "@/lib/invoice-audit/disputes";
import { recordDisputeOutcomeAction, removeFromDraftDisputeAction } from "../../actions";

export type DisputeLine = {
  id: string;
  invoiceNumber: string;
  epgRef: string | null;
  finalMileTracking: string | null;
  shipDate: string | null;
  issue: string;
  disputedAmount: number;
  outcome: DisputeOutcome;
  creditedAmount: number | null;
  auditId: string;
};

const OUTCOME_TONE: Record<DisputeOutcome, string> = {
  pending: "bg-paper-dim text-ink-soft",
  credited: "bg-green-dim text-green-ink",
  rejected: "bg-red-dim text-red-ink",
};

/**
 * Records EPG's answer per parcel. Bulk: select parcels, then "Credited in
 * full" / "Rejected" / "Back to waiting". A partial credit is entered per
 * parcel with its own amount. router.refresh() re-renders the server page
 * so the totals above update too.
 */
export default function DisputeLinesClient({
  disputeId,
  sent,
  currency,
  lines,
}: {
  disputeId: string;
  sent: boolean;
  currency: string;
  lines: DisputeLine[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [partialFor, setPartialFor] = useState<string | null>(null);
  const [partialAmount, setPartialAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const allSelected = lines.length > 0 && selected.size === lines.length;

  function record(lineIds: string[], outcome: DisputeOutcome, amount?: number) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await recordDisputeOutcomeAction(disputeId, lineIds, outcome, amount);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        setSelected(new Set());
        setPartialFor(null);
        router.refresh();
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't save that — please retry."));
      }
    });
  }

  /** Draft only: take a parcel out of this dispute and skip it (see removeFromDraft). */
  function skipFromDraft(lineId: string) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await removeFromDraftDisputeAction(disputeId, [lineId]);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        // Removing the last parcel deletes the draft, so leave its page.
        if (result.data.deletedDispute) router.push("/admin/invoice-audits");
        else router.refresh();
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't remove that parcel — please retry."));
      }
    });
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const ids = [...selected];

  return (
    <section className="flex flex-col gap-3" aria-labelledby="dispute-parcels-heading">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 id="dispute-parcels-heading" className="tag-label !text-base">
          Parcels ({lines.length})
        </h2>
        {sent && (
          <div className="flex items-center gap-2 flex-wrap" role="group" aria-label="Record EPG's answer for selected parcels">
            <span className="text-xs text-ink-faint">{selected.size} selected:</span>
            <button
              type="button"
              disabled={ids.length === 0 || isPending}
              onClick={() => record(ids, "credited")}
              className="btn px-2.5 py-1 text-xs bg-green text-paper disabled:opacity-40"
            >
              Credited in full
            </button>
            <button
              type="button"
              disabled={ids.length === 0 || isPending}
              onClick={() => record(ids, "rejected")}
              className="btn px-2.5 py-1 text-xs bg-red text-paper disabled:opacity-40"
            >
              Rejected
            </button>
            <button
              type="button"
              disabled={ids.length === 0 || isPending}
              onClick={() => record(ids, "pending")}
              className="btn px-2.5 py-1 text-xs border border-line-strong bg-paper disabled:opacity-40"
            >
              Back to waiting
            </button>
          </div>
        )}
      </div>
      {!sent && (
        <p className="text-xs text-ink-faint">
          Use <strong>Skip</strong> to leave a parcel out of this dispute (you can restore it from its invoice). Mark the
          dispute as sent to record EPG&apos;s answer.
        </p>
      )}
      {error && <p role="alert" className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}

      <div className="border border-line divide-y divide-line bg-paper-panel">
        {sent && (
          <label className="flex items-center gap-2 px-3 py-2 text-xs text-ink-faint bg-paper-dim cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(lines.map((l) => l.id)))}
            />
            Select all
          </label>
        )}
        {lines.map((l) => (
          <div key={l.id} className="flex items-start gap-3 px-3 py-2.5 flex-wrap md:flex-nowrap">
            {sent && (
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(l.id)}
                onChange={() => toggle(l.id)}
                aria-label={`Select ${l.epgRef ?? l.finalMileTracking}`}
              />
            )}
            <div className="flex flex-col flex-1 min-w-[14rem] md:min-w-0">
              <span className="data break-all">{l.epgRef ?? l.finalMileTracking}</span>
              <span className="data text-[11px] text-ink-faint">
                <Link href={`/admin/invoice-audits/${l.auditId}`} className="text-blue hover:underline">
                  {l.invoiceNumber}
                </Link>{" "}
                {l.finalMileTracking && (
                  <>
                    · <span className="break-all">{l.finalMileTracking}</span>{" "}
                  </>
                )}
                · shipped {l.shipDate ?? "—"} · {l.issue}
              </span>
            </div>
            <div className="flex items-center gap-3 flex-wrap justify-end">
              <span className="data text-sm">{formatMoney(l.disputedAmount, currency)}</span>
              <span className={`px-2 py-0.5 text-[11px] font-condensed font-semibold uppercase tracking-wider whitespace-nowrap ${OUTCOME_TONE[l.outcome]}`}>
                {l.outcome === "credited"
                  ? `Credited ${formatMoney(l.creditedAmount ?? 0, currency)}`
                  : l.outcome === "rejected"
                    ? "Rejected"
                    : sent
                      ? "Waiting"
                      : "Not sent"}
              </span>
              {!sent && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => skipFromDraft(l.id)}
                  className="text-xs text-ink-soft underline hover:text-ink disabled:opacity-50"
                  title="Leave this parcel out of the dispute"
                >
                  Skip
                </button>
              )}
              {sent &&
                (partialFor === l.id ? (
                  <form
                    className="flex items-center gap-1"
                    onSubmit={(e) => {
                      e.preventDefault();
                      record([l.id], "credited", Number(partialAmount));
                    }}
                  >
                    <label htmlFor={`partial-${l.id}`} className="sr-only">
                      Credited amount
                    </label>
                    <input
                      id={`partial-${l.id}`}
                      type="number"
                      inputMode="decimal"
                      step="0.01"
                      min="0"
                      autoFocus
                      value={partialAmount}
                      onChange={(e) => setPartialAmount(e.target.value)}
                      className="w-20 border border-line-strong px-1.5 py-0.5 text-xs"
                    />
                    <button type="submit" disabled={isPending || partialAmount === ""} className="btn px-2 py-0.5 text-xs bg-green text-paper disabled:opacity-40">
                      Save
                    </button>
                    <button type="button" onClick={() => setPartialFor(null)} className="text-xs text-ink-faint hover:underline">
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setPartialFor(l.id);
                      setPartialAmount(String(l.creditedAmount ?? ""));
                    }}
                    className="text-xs text-ink-soft underline hover:text-ink"
                  >
                    Partial credit
                  </button>
                ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
