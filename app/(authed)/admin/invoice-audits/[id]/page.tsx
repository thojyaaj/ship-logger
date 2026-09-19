import Link from "next/link";
import { notFound } from "next/navigation";
import { pageRequireAdmin } from "@/lib/auth";
import { getInvoiceAudit } from "@/lib/invoice-audit/audit";
import { formatMoney, netLabel, netOvercharge } from "@/lib/invoice-audit/format";
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

      <AuditLinesClient lines={lines} currency={a.currency} />
    </div>
  );
}
