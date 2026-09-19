import Link from "next/link";
import { notFound } from "next/navigation";
import { pageRequireAdmin } from "@/lib/auth";
import { getInvoiceAudit } from "@/lib/invoice-audit/audit";
import { formatMoney, MARKETPLACE_FEE_LABEL, netLabel, netOvercharge } from "@/lib/invoice-audit/format";
import { getLineShipping, getShippingSummaries } from "@/lib/invoice-audit/shipping-margin";
import { formatWarehouseTimestamp } from "@/lib/date";
import AuditLinesClient from "./AuditLinesClient";
import RecheckClient from "./RecheckClient";

// recheckInvoiceAuditAction runs live ShipStation lookups — up to ~30s (see
// MAX_LIVE_LOOKUPS in lib/invoice-audit/audit.ts).
export const maxDuration = 60;

export default async function InvoiceAuditPage({ params }: { params: Promise<{ id: string }> }) {
  await pageRequireAdmin();
  const { id } = await params;
  const result = await getInvoiceAudit(id);
  if (!result) notFound();
  const { audit: a, lines } = result;
  const [lineShipping, summaries] = await Promise.all([getLineShipping(id), getShippingSummaries([id])]);
  const shipping = summaries.get(id);
  // currency_mismatch is folded into noQuoteCount but isn't something a
  // re-check can fix, so it's counted out here.
  const unverified = lines.filter((l) => l.status === "no_quote" || l.status === "not_found").length;

  const netAmount = netOvercharge(a);
  const net = netLabel(netAmount, a.currency);
  const tiles: { label: string; value: string; tone?: "red" | "green" }[] = [
    { label: "Invoiced", value: formatMoney(a.invoicedTotal, a.currency) },
    { label: "ShipStation quoted", value: formatMoney(a.quotedTotal, a.currency) },
    {
      label: "Overcharged",
      value: `+${formatMoney(a.overchargeTotal, a.currency)}`,
      tone: a.overchargeTotal > 0 ? "red" : "green",
    },
    { label: "Undercharged", value: `−${formatMoney(a.underchargeTotal, a.currency)}` },
    {
      label: net.tone === "gain" ? "Net gain" : net.tone === "loss" ? "Net loss" : "Net",
      value: net.tone === "even" ? formatMoney(0, a.currency) : formatMoney(Math.abs(netAmount), a.currency),
      tone: net.tone === "loss" ? "red" : "green",
    },
  ];

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-6xl mx-auto w-full">
      <div className="flex items-end justify-between gap-3 flex-wrap route-line pb-2">
        <div>
          <Link href="/admin/invoice-audits" className="tag-label !text-ink-faint hover:!text-ink underline">
            ← Invoice audits
          </Link>
          <h1 className="font-stencil text-2xl tracking-wide mt-1">
            {a.carrier.toUpperCase()} invoice {a.invoiceNumber}
          </h1>
          <p className="text-xs text-ink-faint mt-1">
            {a.source === "email" ? "Received from Gmail" : "Uploaded"} {formatWarehouseTimestamp(a.createdAt)}
            {a.fileName ? ` · ${a.fileName}` : ""} · {a.lineCount} parcels
          </p>
        </div>
        <a
          href={`/admin/invoice-audits/${a.id}/export`}
          className="btn px-3 py-2 border border-line-strong bg-paper-panel hover:bg-paper-dim text-sm"
        >
          Export CSV
        </a>
      </div>

      {/* Five tiles: on a phone the fifth (net) spans both columns rather
          than sitting alone at half width. */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        {tiles.map((t, i) => (
          <div
            key={t.label}
            className={`border border-line bg-paper-panel px-3 py-2 ${i === tiles.length - 1 ? "col-span-2 md:col-span-1" : ""}`}
          >
            <div className="tag-label !text-ink-faint">{t.label}</div>
            <div
              className={`data text-lg font-semibold ${t.tone === "red" ? "text-red-ink" : t.tone === "green" ? "text-green-ink" : ""}`}
            >
              {t.value}
            </div>
          </div>
        ))}
      </div>

      {shipping && shipping.parcelsCounted > 0 && (
        <section className="flex flex-col gap-2" aria-labelledby="shipping-pl-heading">
          <h2 id="shipping-pl-heading" className="tag-label !text-base">
            Shipping profit / loss
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Tile label="Customers paid for shipping" value={formatMoney(shipping.customerPaid, a.currency)} />
            <Tile label={MARKETPLACE_FEE_LABEL} value={`−${formatMoney(shipping.fee, a.currency)}`} />
            <Tile label="EPG billed" value={`−${formatMoney(shipping.billed, a.currency)}`} />
            <Tile
              label={shipping.profit < 0 ? "Shipping loss" : "Shipping profit"}
              value={formatMoney(Math.abs(shipping.profit), a.currency)}
              tone={shipping.profit < 0 ? "red" : "green"}
            />
          </div>
          <p className="text-xs text-ink-faint">
            What customers paid for shipping, minus Fruugo&apos;s fee, minus what EPG billed. Multi-parcel orders split
            their shipping across parcels.
            {shipping.parcelsMissing > 0 &&
              ` ${shipping.parcelsMissing} parcel${shipping.parcelsMissing === 1 ? " has" : "s have"} no matched order yet and ${shipping.parcelsMissing === 1 ? "isn't" : "aren't"} counted.`}
          </p>
        </section>
      )}

      {unverified > 0 && (
        <>
          {a.quotedTotal > 0 && (
            <p className="text-sm text-ink-soft">
              The quoted total only covers parcels with a ShipStation cost, so it won&apos;t add up to the invoiced total
              until the unverified parcels are resolved.
            </p>
          )}
          <RecheckClient auditId={a.id} unverified={unverified} />
        </>
      )}

      <AuditLinesClient lines={lines} currency={a.currency} shipping={Object.fromEntries(lineShipping)} />
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: "red" | "green" }) {
  return (
    <div className="border border-line bg-paper-panel px-3 py-2 min-w-0">
      <div className="tag-label !text-ink-faint truncate">{label}</div>
      <div className={`data text-lg font-semibold ${tone === "red" ? "text-red-ink" : tone === "green" ? "text-green-ink" : ""}`}>
        {value}
      </div>
    </div>
  );
}
