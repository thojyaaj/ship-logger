"use client";

import { useState } from "react";
import { formatMoney } from "@/lib/invoice-audit/format";

type DisputableInvoice = { id: string; invoiceNumber: string; parcels: number; amount: number; currency: string };

/**
 * Picks which invoices go into the carrier-facing dispute CSV (see
 * lib/invoice-audit/dispute-report.ts). Only invoices with something to
 * dispute are listed; all are selected by default.
 */
export default function DisputeReportClient({ invoices }: { invoices: DisputableInvoice[] }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(invoices.map((i) => i.id)));

  const chosen = invoices.filter((i) => selected.has(i.id));
  const parcels = chosen.reduce((n, i) => n + i.parcels, 0);
  const amount = chosen.reduce((n, i) => n + i.amount, 0);
  const currency = invoices[0]?.currency ?? "USD";

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <section className="flex flex-col gap-3 border border-line bg-paper-panel p-4" aria-labelledby="dispute-heading">
      <div>
        <h2 id="dispute-heading" className="tag-label !text-base">
          Dispute report for EPG
        </h2>
        <p className="text-sm text-ink-soft mt-1">
          A CSV of every overcharged or double-billed parcel, with a reason for each, to send to ePost Global. It
          leaves out customer payments and internal notes.
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
              <span className="data">+{formatMoney(i.amount, i.currency)}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex items-center gap-3 flex-wrap">
        {chosen.length > 0 ? (
          <a
            href={`/admin/invoice-audits/dispute-report?ids=${chosen.map((i) => encodeURIComponent(i.id)).join(",")}`}
            className="btn px-4 py-2 bg-orange text-paper"
          >
            Download dispute CSV
          </a>
        ) : (
          <span className="btn px-4 py-2 bg-orange text-paper opacity-50" aria-disabled="true">
            Download dispute CSV
          </span>
        )}
        <span className="text-sm text-ink-soft" aria-live="polite">
          {chosen.length} invoice{chosen.length === 1 ? "" : "s"} · {parcels} parcel{parcels === 1 ? "" : "s"} ·{" "}
          {formatMoney(Math.round(amount * 100) / 100, currency)} disputed
        </span>
      </div>
    </section>
  );
}
