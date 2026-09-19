import Link from "next/link";
import { notFound } from "next/navigation";
import { pageRequireAdmin } from "@/lib/auth";
import { getInvoiceAudit } from "@/lib/invoice-audit/audit";
import { formatMoney } from "@/lib/invoice-audit/format";
import { formatWarehouseTimestamp } from "@/lib/date";
import AuditLinesClient from "./AuditLinesClient";

export default async function InvoiceAuditPage({ params }: { params: Promise<{ id: string }> }) {
  await pageRequireAdmin();
  const { id } = await params;
  const result = await getInvoiceAudit(id);
  if (!result) notFound();
  const { audit: a, lines } = result;

  const tiles: { label: string; value: string; tone?: "red" | "green" }[] = [
    { label: "Invoiced", value: formatMoney(a.invoicedTotal, a.currency) },
    { label: "ShipStation quoted", value: formatMoney(a.quotedTotal, a.currency) },
    {
      label: "Overcharged",
      value: `+${formatMoney(a.overchargeTotal, a.currency)}`,
      tone: a.overchargeTotal > 0 ? "red" : "green",
    },
    { label: "Undercharged", value: `−${formatMoney(a.underchargeTotal, a.currency)}` },
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

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {tiles.map((t) => (
          <div key={t.label} className="border border-line bg-paper-panel px-3 py-2">
            <div className="tag-label !text-ink-faint">{t.label}</div>
            <div
              className={`data text-lg font-semibold ${t.tone === "red" ? "text-red-ink" : t.tone === "green" ? "text-green-ink" : ""}`}
            >
              {t.value}
            </div>
          </div>
        ))}
      </div>

      {a.quotedTotal > 0 && a.noQuoteCount + a.notFoundCount > 0 && (
        <p className="text-sm text-ink-soft">
          The quoted total only covers parcels with a ShipStation cost — {a.noQuoteCount + a.notFoundCount} parcel
          {a.noQuoteCount + a.notFoundCount === 1 ? "" : "s"} couldn&apos;t be verified, so it won&apos;t add up to the
          invoiced total. Re-uploading the file later re-checks them.
        </p>
      )}

      <AuditLinesClient lines={lines} currency={a.currency} />
    </div>
  );
}
