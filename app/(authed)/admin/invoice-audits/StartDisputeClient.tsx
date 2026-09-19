"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actionErrorMessage } from "@/lib/error-message";
import { formatMoney } from "@/lib/invoice-audit/format";
import { createDisputeAction } from "./actions";

export type DisputableInvoice = { id: string; invoiceNumber: string; parcels: number; amount: number; currency: string };

/**
 * Starts a dispute with ePost Global from the chosen invoices' overcharged
 * and double-billed parcels — only ones not already in a dispute, so the
 * same charge is never sent twice. Creating it opens the dispute's page,
 * where the report is sent and EPG's answer recorded.
 */
export default function StartDisputeClient({ invoices }: { invoices: DisputableInvoice[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(invoices.map((i) => i.id)));
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const chosen = invoices.filter((i) => selected.has(i.id));
  const parcels = chosen.reduce((n, i) => n + i.parcels, 0);
  const amount = Math.round(chosen.reduce((n, i) => n + i.amount, 0) * 100) / 100;
  const currency = invoices[0]?.currency ?? "USD";

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function create() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await createDisputeAction(chosen.map((i) => i.id));
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        router.push(`/admin/invoice-audits/disputes/${result.data.id}`);
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't create the dispute — please retry."));
      }
    });
  }

  return (
    <section className="flex flex-col gap-3 border border-line bg-paper-panel p-4" aria-labelledby="start-dispute-heading">
      <div>
        <h2 id="start-dispute-heading" className="tag-label !text-base">
          Start a dispute with EPG
        </h2>
        <p className="text-sm text-ink-soft mt-1">
          Collects the overcharged and double-billed parcels that aren&apos;t in a dispute yet. Next you send it to
          ePost Global (Gmail draft or CSV) and record their answer.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Invoices to include</legend>
        <div className="flex items-center gap-3 text-xs">
          <button type="button" className="underline text-ink-soft hover:text-ink" onClick={() => setSelected(new Set(invoices.map((i) => i.id)))}>
            Select all
          </button>
          <button type="button" className="underline text-ink-soft hover:text-ink" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {invoices.map((i) => (
            <label
              key={i.id}
              className={`flex items-center gap-2 border px-2.5 py-1.5 text-xs cursor-pointer ${
                selected.has(i.id) ? "border-ink bg-paper" : "border-line text-ink-soft"
              }`}
            >
              <input type="checkbox" checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
              <span className="data font-semibold">{i.invoiceNumber}</span>
              <span className="data">
                {i.parcels} · +{formatMoney(i.amount, i.currency)}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={create}
          disabled={chosen.length === 0 || isPending}
          className="btn px-4 py-2 bg-orange text-paper disabled:opacity-50"
        >
          {isPending ? "Creating…" : "Create dispute"}
        </button>
        <span className="text-sm text-ink-soft" aria-live="polite">
          {chosen.length} invoice{chosen.length === 1 ? "" : "s"} · {parcels} parcel{parcels === 1 ? "" : "s"} ·{" "}
          {formatMoney(amount, currency)}
        </span>
      </div>
      {error && <p role="alert" className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}
    </section>
  );
}
