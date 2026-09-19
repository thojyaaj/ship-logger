"use client";

import { useMemo, useState } from "react";
import type { InvoiceAuditLineRow } from "@/lib/invoice-audit/audit";
import type { LineStatus } from "@/lib/invoice-audit/classify";
import { formatMoney, STATUS_LABEL } from "@/lib/invoice-audit/format";
import { trackingUrl } from "@/lib/carrier";

type Filter = "review" | "all" | LineStatus;

// "Needs review" is the default: an admin opening an audit wants the
// problems, not 100 matching rows to scroll past.
const NEEDS_REVIEW: ReadonlySet<LineStatus> = new Set(["over", "duplicate", "not_found", "no_quote", "currency_mismatch"]);

const STATUS_TONE: Record<LineStatus, string> = {
  over: "bg-red-dim text-red-ink",
  duplicate: "bg-red-dim text-red-ink",
  under: "bg-blue-dim text-blue-ink",
  match: "bg-green-dim text-green-ink",
  no_quote: "bg-paper-dim text-ink-soft",
  currency_mismatch: "bg-paper-dim text-ink-soft",
  not_found: "bg-amber-dim text-amber-ink",
};

function needsReview(l: InvoiceAuditLineRow): boolean {
  return NEEDS_REVIEW.has(l.status) || l.billedHeavier;
}

export default function AuditLinesClient({ lines, currency }: { lines: InvoiceAuditLineRow[]; currency: string }) {
  const counts = useMemo(() => {
    const c = new Map<Filter, number>([
      ["review", lines.filter(needsReview).length],
      ["all", lines.length],
    ]);
    for (const l of lines) c.set(l.status, (c.get(l.status) ?? 0) + 1);
    return c;
  }, [lines]);

  const [filter, setFilter] = useState<Filter>(() => (counts.get("review") ? "review" : "all"));

  const chips: Filter[] = [
    "review",
    "all",
    ...(["over", "duplicate", "under", "match", "no_quote", "currency_mismatch", "not_found"] as LineStatus[]).filter(
      (s) => counts.get(s),
    ),
  ];
  const visible = lines.filter((l) => (filter === "all" ? true : filter === "review" ? needsReview(l) : l.status === filter));

  const label = (f: Filter) => (f === "review" ? "Needs review" : f === "all" ? "All" : STATUS_LABEL[f]);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter parcels">
        {chips.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
            className={`btn px-2.5 py-1 text-xs border ${
              filter === f ? "bg-ink text-paper border-ink" : "bg-paper-panel text-ink-soft border-line hover:border-line-strong"
            }`}
          >
            {label(f)} <span className="opacity-70">({counts.get(f) ?? 0})</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="text-ink-faint text-sm">Nothing here — every parcel on this invoice matched its quote.</p>
      ) : (
        <>
          <div className="hidden md:block border border-line overflow-x-auto">
            <table className="w-full text-sm table-fixed">
              <colgroup>
                <col className="w-[22%]" />
                <col className="w-[13%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
                <col className="w-[9%]" />
                <col className="w-[11%]" />
                <col className="w-[25%]" />
              </colgroup>
              <thead className="bg-paper-dim">
                <tr>
                  <th className="text-left px-3 py-2 tag-label !text-ink-faint">Parcel</th>
                  <th className="text-left px-3 py-2 tag-label !text-ink-faint">Status</th>
                  <th className="text-right px-3 py-2 tag-label !text-ink-faint">Billed</th>
                  <th className="text-right px-3 py-2 tag-label !text-ink-faint">Quoted</th>
                  <th className="text-right px-3 py-2 tag-label !text-ink-faint">Diff</th>
                  <th className="text-right px-3 py-2 tag-label !text-ink-faint">Weight (lb)</th>
                  <th className="text-left px-3 py-2 tag-label !text-ink-faint">Notes</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => (
                  <tr key={l.id} className="border-t border-line bg-paper-panel align-top">
                    <td className="px-3 py-2">
                      <ParcelIds line={l} />
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={l.status} />
                    </td>
                    <td className="px-3 py-2 data text-right">{formatMoney(l.invoicedAmount, l.invoicedCurrency)}</td>
                    <td className="px-3 py-2 data text-right">
                      {formatMoney(l.quotedAmount, l.quotedCurrency)}
                      {l.quoteSource === "shipstation" && <div className="text-[10px] text-ink-faint">live lookup</div>}
                    </td>
                    <td className="px-3 py-2 data text-right">
                      <Diff value={l.difference} currency={currency} />
                    </td>
                    <td className={`px-3 py-2 data text-right ${l.billedHeavier ? "text-red-ink font-semibold" : ""}`}>
                      {l.billedWeightLb ?? "—"}
                      <div className="text-[10px] text-ink-faint">label {l.quotedWeightLb?.toFixed(3) ?? "—"}</div>
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-soft">{l.note ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="md:hidden flex flex-col gap-2">
            {visible.map((l) => (
              <div key={l.id} className="border border-line bg-paper-panel p-3 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <ParcelIds line={l} />
                  <StatusBadge status={l.status} />
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <Figure label="Billed" value={formatMoney(l.invoicedAmount, l.invoicedCurrency)} />
                  <Figure label="Quoted" value={formatMoney(l.quotedAmount, l.quotedCurrency)} />
                  <div>
                    <div className="tag-label !text-ink-faint">Diff</div>
                    <div className="data">
                      <Diff value={l.difference} currency={currency} />
                    </div>
                  </div>
                </div>
                {l.note && <p className="text-xs text-ink-soft">{l.note}</p>}
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function ParcelIds({ line }: { line: InvoiceAuditLineRow }) {
  const epgUrl = line.epgRef ? trackingUrl("epg", line.epgRef) : null;
  return (
    <div className="flex flex-col min-w-0">
      {line.epgRef &&
        (epgUrl ? (
          <a href={epgUrl} target="_blank" rel="noreferrer" className="data text-blue hover:underline break-all">
            {line.epgRef}
          </a>
        ) : (
          <span className="data break-all">{line.epgRef}</span>
        ))}
      <span className="data text-[11px] text-ink-faint break-all">
        {line.finalMileTracking} · {line.destinationCountry ?? "—"} · row {line.sheetRow}
      </span>
    </div>
  );
}

function StatusBadge({ status }: { status: LineStatus }) {
  return (
    <span className={`inline-block px-2 py-0.5 text-[11px] font-condensed font-semibold uppercase tracking-wider whitespace-nowrap ${STATUS_TONE[status]}`}>
      {STATUS_LABEL[status]}
    </span>
  );
}

function Diff({ value, currency }: { value: number | null; currency: string }) {
  if (value === null) return <span className="text-ink-faint">—</span>;
  if (value === 0) return <span>{formatMoney(0, currency)}</span>;
  return (
    <span className={value > 0 ? "text-red-ink font-semibold" : "text-blue-ink"}>
      {value > 0 ? "+" : "−"}
      {formatMoney(Math.abs(value), currency)}
    </span>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="tag-label !text-ink-faint">{label}</div>
      <div className="data">{value}</div>
    </div>
  );
}
