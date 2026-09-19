import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { pageRequireAdmin } from "@/lib/auth";
import { invoiceAuditLine } from "@/lib/db/schema";
import { loadLinesWithShipDate } from "@/lib/invoice-audit/audit";
import { getDisputeSummary } from "@/lib/invoice-audit/disputes";
import { formatMoney, STATUS_LABEL } from "@/lib/invoice-audit/format";
import { gmailDraftLink, gmailDraftUrl } from "@/lib/invoice-audit/gmail-draft";
import { formatWarehouseTimestamp } from "@/lib/date";
import DisputeActionsClient from "./DisputeActionsClient";
import DisputeLinesClient, { type DisputeLine } from "./DisputeLinesClient";

const STATUS_TEXT = { draft: "Draft — not sent yet", sent: "Sent — waiting on EPG", resolved: "Resolved" } as const;

export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  await pageRequireAdmin();
  const { id } = await params;
  const d = await getDisputeSummary(id);
  if (!d) notFound();
  const rows = await loadLinesWithShipDate(eq(invoiceAuditLine.disputeId, id));
  const draftUrl = gmailDraftUrl();

  const lines: DisputeLine[] = rows.map((l) => ({
    id: l.id,
    invoiceNumber: l.invoiceNumber,
    epgRef: l.epgRef,
    finalMileTracking: l.finalMileTracking,
    shipDate: l.shipDate,
    issue: STATUS_LABEL[l.status],
    disputedAmount: l.disputedAmount ?? 0,
    outcome: l.disputeOutcome ?? "pending",
    creditedAmount: l.creditedAmount,
    auditId: l.auditId,
  }));

  const tone = { draft: "bg-paper-dim text-ink-soft", sent: "bg-amber-dim text-amber-ink", resolved: "bg-green-dim text-green-ink" }[d.status];

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="route-line pb-2">
        <Link href="/admin/invoice-audits" className="tag-label !text-ink-faint hover:!text-ink underline">
          ← Invoice audits
        </Link>
        <div className="flex items-center gap-3 flex-wrap mt-1">
          <h1 className="font-stencil text-2xl tracking-wide">Dispute {d.id.slice(0, 8).toUpperCase()}</h1>
          <span className={`px-2 py-0.5 text-xs font-condensed font-semibold uppercase tracking-wider ${tone}`}>
            {STATUS_TEXT[d.status]}
          </span>
        </div>
        <p className="text-xs text-ink-faint mt-1">
          Created {formatWarehouseTimestamp(d.createdAt)}
          {d.sentAt ? ` · sent ${formatWarehouseTimestamp(d.sentAt)}` : ""} · invoices {d.invoiceNumbers.join(", ")}
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Tile label="Disputed" value={formatMoney(d.disputed, d.currency)} sub={`${d.parcels} parcels`} />
        <Tile label="Credited back" value={formatMoney(d.credited, d.currency)} tone={d.credited > 0 ? "green" : undefined} />
        <Tile label="Waiting on EPG" value={`${d.status === "draft" ? d.parcels : d.pendingParcels}`} sub="parcels" />
        <Tile label="Rejected" value={`${d.rejectedParcels}`} sub="parcels" tone={d.rejectedParcels > 0 ? "red" : undefined} />
      </div>

      <DisputeActionsClient
        disputeId={d.id}
        status={d.status}
        csvHref={`/admin/invoice-audits/disputes/${d.id}/csv`}
        gmailHref={draftUrl ? gmailDraftLink(draftUrl, d.id) : null}
      />

      <DisputeLinesClient disputeId={d.id} sent={d.status !== "draft"} currency={d.currency} lines={lines} />
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "red" | "green" }) {
  return (
    <div className="border border-line bg-paper-panel px-3 py-2 min-w-0">
      <div className="tag-label !text-ink-faint truncate">{label}</div>
      <div className={`data text-lg font-semibold ${tone === "red" ? "text-red-ink" : tone === "green" ? "text-green-ink" : ""}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-ink-faint">{sub}</div>}
    </div>
  );
}
