import Link from "next/link";
import { pageRequireAdmin } from "@/lib/auth";
import { listInvoiceAudits } from "@/lib/invoice-audit/audit";
import { formatMoney, netLabel, netOvercharge } from "@/lib/invoice-audit/format";
import { formatWarehouseTimestamp } from "@/lib/date";
import UploadInvoiceClient from "./UploadInvoiceClient";
import DisputeReportClient from "./DisputeReportClient";
import InvoiceAnalyticsSection from "./InvoiceAnalytics";
import { getInvoiceAnalytics } from "@/lib/invoice-audit/analytics";
import { getShippingSummaries, sumShippingSummaries } from "@/lib/invoice-audit/shipping-margin";

// uploadEpgInvoiceAction runs live ShipStation lookups for parcels without
// a backfilled cost — up to ~30s (see MAX_LIVE_LOOKUPS in
// lib/invoice-audit/audit.ts), past Vercel's default function duration.
export const maxDuration = 60;

// Solid fills (not the -dim tints the over/under chips use) so the net —
// the one figure that answers "am I losing money on this invoice" — reads
// first in each row.
const NET_TONE = {
  loss: "bg-red text-paper",
  gain: "bg-green text-paper",
  even: "bg-ink-soft text-paper",
} as const;

export default async function InvoiceAuditsPage() {
  await pageRequireAdmin();
  const [audits, analytics, shipping] = await Promise.all([listInvoiceAudits(), getInvoiceAnalytics(), getShippingSummaries()]);
  const disputable = audits
    .filter((a) => a.overCount + a.duplicateCount > 0)
    .map((a) => ({
      id: a.id,
      invoiceNumber: a.invoiceNumber,
      parcels: a.overCount + a.duplicateCount,
      amount: a.overchargeTotal,
      currency: a.currency,
    }));

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="route-line pb-2">
        <h1 className="font-stencil text-2xl tracking-wide">Invoice Audits</h1>
        <p className="text-sm text-ink-soft mt-1">
          What the carrier billed for each parcel vs. what ShipStation quoted when the label was bought.
        </p>
      </div>

      {analytics.invoiceCount > 0 && (
        <InvoiceAnalyticsSection data={analytics} shipping={sumShippingSummaries(shipping.values())} />
      )}

      {disputable.length > 0 && <DisputeReportClient invoices={disputable} />}

      <UploadInvoiceClient />

      <section className="flex flex-col gap-2">
        <div>
          <h2 className="tag-label !text-base">Past audits</h2>
          <p className="text-xs text-ink-faint mt-1">
            Net = overcharged − undercharged, against ShipStation&apos;s quote. Shipping = what customers paid for
            shipping, minus Fruugo&apos;s 20% fee, minus what EPG billed. Parcels without a quote or a matched order
            aren&apos;t counted yet.
          </p>
        </div>
        {audits.length === 0 ? (
          <p className="text-ink-faint text-sm">No invoices audited yet.</p>
        ) : (
          <div className="border border-line divide-y divide-line">
            {audits.map((a) => {
              const flagged = a.overCount + a.duplicateCount;
              const net = netLabel(netOvercharge(a), a.currency);
              const ship = shipping.get(a.id);
              return (
                <Link
                  key={a.id}
                  href={`/admin/invoice-audits/${a.id}`}
                  className="flex items-center justify-between gap-3 flex-wrap px-3 py-3 bg-paper-panel hover:bg-paper-dim"
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="data font-semibold">
                      {a.carrier.toUpperCase()} · {a.invoiceNumber}
                    </span>
                    <span className="text-xs text-ink-faint">
                      {formatWarehouseTimestamp(a.createdAt)} · {a.source === "email" ? "from Gmail" : "uploaded"} · {a.lineCount}{" "}
                      parcels · {formatMoney(a.invoicedTotal, a.currency)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-xs font-condensed font-semibold uppercase tracking-widest">
                    <span className="px-2 py-1 bg-red-dim text-red-ink">
                      {flagged} over · +{formatMoney(a.overchargeTotal, a.currency)}
                    </span>
                    <span className="px-2 py-1 bg-blue-dim text-blue-ink">
                      {a.underCount} under · −{formatMoney(a.underchargeTotal, a.currency)}
                    </span>
                    <span className={`px-2 py-1 ${NET_TONE[net.tone]}`}>{net.text}</span>
                    {ship && ship.parcelsCounted > 0 && (
                      // Outlined, not filled, so it doesn't read as a second
                      // version of the Net chip beside it — a different measure.
                      <span
                        className={`px-2 py-1 border-2 ${ship.profit < 0 ? "border-red text-red-ink" : "border-green text-green-ink"}`}
                      >
                        Shipping {ship.profit < 0 ? "loss" : "profit"} {formatMoney(Math.abs(ship.profit), a.currency)}
                      </span>
                    )}
                    {a.notFoundCount + a.noQuoteCount > 0 && (
                      <span className="px-2 py-1 bg-paper-dim text-ink-soft">{a.notFoundCount + a.noQuoteCount} unverified</span>
                    )}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
