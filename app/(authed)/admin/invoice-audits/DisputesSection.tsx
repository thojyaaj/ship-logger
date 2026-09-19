import Link from "next/link";
import type { DisputeSummary, disputeTotals } from "@/lib/invoice-audit/disputes";
import { formatMoney } from "@/lib/invoice-audit/format";
import { formatWarehouseTimestamp } from "@/lib/date";
import StatTile from "../../analytics/StatTile";

const STATUS: Record<DisputeSummary["status"], { text: string; tone: string }> = {
  draft: { text: "Draft — not sent", tone: "bg-paper-dim text-ink-soft" },
  sent: { text: "Waiting on EPG", tone: "bg-amber-dim text-amber-ink" },
  resolved: { text: "Resolved", tone: "bg-green-dim text-green-ink" },
};

/** Disputes sent to EPG so far — how much was claimed and how much came back. */
export default function DisputesSection({
  disputes,
  totals,
}: {
  disputes: DisputeSummary[];
  totals: ReturnType<typeof disputeTotals>;
}) {
  const { currency } = totals;
  const recoveredPct = totals.disputed > 0 ? Math.round((totals.credited / totals.disputed) * 100) : 0;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="disputes-heading">
      <h2 id="disputes-heading" className="tag-label !text-base">
        Disputes with EPG
      </h2>
      {totals.sentCount > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <StatTile label="Disputed" value={formatMoney(totals.disputed, currency)} sub={`${totals.sentCount} sent`} />
          <StatTile
            label="Credited back"
            accent={totals.credited > 0 ? "!text-green-ink" : undefined}
            value={formatMoney(totals.credited, currency)}
            sub={`${recoveredPct}% of disputed`}
          />
          <StatTile label="Waiting on EPG" value={`${totals.pendingParcels}`} sub="parcels" />
          <StatTile label="Rejected" value={`${totals.rejectedParcels}`} sub="parcels" />
        </div>
      )}
      <div className="border border-line divide-y divide-line">
        {disputes.map((d) => (
          <Link
            key={d.id}
            href={`/admin/invoice-audits/disputes/${d.id}`}
            className="flex items-center justify-between gap-3 flex-wrap px-3 py-3 bg-paper-panel hover:bg-paper-dim"
          >
            <div className="flex flex-col gap-0.5 min-w-0">
              <span className="data font-semibold">Dispute {d.id.slice(0, 8).toUpperCase()}</span>
              <span className="text-xs text-ink-faint">
                {d.sentAt ? `Sent ${formatWarehouseTimestamp(d.sentAt)}` : `Created ${formatWarehouseTimestamp(d.createdAt)}`} ·{" "}
                {d.invoiceNumbers.join(", ")} · {d.parcels} parcels
              </span>
            </div>
            <div className="flex items-center gap-2 flex-wrap text-xs font-condensed font-semibold uppercase tracking-widest">
              <span className="px-2 py-1 bg-paper-dim text-ink-soft">Disputed {formatMoney(d.disputed, d.currency)}</span>
              {d.credited > 0 && (
                <span className="px-2 py-1 bg-green-dim text-green-ink">Credited {formatMoney(d.credited, d.currency)}</span>
              )}
              <span className={`px-2 py-1 ${STATUS[d.status].tone}`}>{STATUS[d.status].text}</span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
