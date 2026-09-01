import Link from "next/link";
import { notFound } from "next/navigation";
import { pageRequireUser } from "@/lib/auth";
import { getShipmentDetail, ShipmentNotFoundError } from "@/lib/shiplog";
import { formatWarehouseTimestamp } from "@/lib/date";
import { trackingUrl, statusTone } from "@/lib/carrier";
import ReopenButton from "./ReopenButton";
import DeleteShipmentButton from "./DeleteShipmentButton";
import ScanTable from "./ScanTable";
import DhlPickupPanel from "./DhlPickupPanel";
import { getLatestPickupRequest } from "@/lib/dhl-pickup";

export default async function ShipmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await pageRequireUser();
  const { id } = await params;

  let dashboard;
  try {
    dashboard = await getShipmentDetail(id);
  } catch (err) {
    // Only a genuinely missing shipment is a 404 — anything else (a dropped
    // database connection, a query bug) must surface as a real error rather
    // than be disguised as "no such shipment".
    if (err instanceof ShipmentNotFoundError) notFound();
    throw err;
  }
  const { session, boxes, scans, totals, userNames } = dashboard;

  const showDhlPickup = user.isAdmin && session.status === "submitted" && totals.dhl > 0;
  const pickupRequest = showDhlPickup ? await getLatestPickupRequest(session.id) : null;

  const boxedScans = new Map<string, typeof scans>();
  const unboxedScans: typeof scans = [];
  for (const s of scans) {
    if (s.boxId) {
      if (!boxedScans.has(s.boxId)) boxedScans.set(s.boxId, []);
      boxedScans.get(s.boxId)!.push(s);
    } else {
      unboxedScans.push(s);
    }
  }

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-3 route-line pb-3">
        <div>
          <Link href="/shipments" className="tag-label hover:!text-ink">
            ← Shipments
          </Link>
          <h1 className="font-stencil text-2xl tracking-wide mt-1">{session.shipDate}</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`tag-label px-3 py-1 ${
              session.status === "submitted"
                ? "bg-green-dim !text-green-ink"
                : "bg-amber-dim !text-amber-ink"
            }`}
          >
            {session.status}
          </span>
          <a
            href={`/shipments/${session.id}/export`}
            className="btn px-4 py-2 border border-line-strong text-ink hover:bg-paper-dim"
          >
            Export CSV
          </a>
          {/* Admin-only, matching reopenSessionAction's requireAdmin — showing
              it to packers would just render a button that always errors. */}
          {session.status === "submitted" && user.isAdmin && <ReopenButton sessionId={session.id} />}
          {user.isAdmin && <DeleteShipmentButton sessionId={session.id} shipDate={session.shipDate} />}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line text-sm">
        <Field label="EPG" value={String(totals.epg)} accent="text-orange" />
        <Field label="UPS" value={String(totals.ups)} accent="text-blue" />
        <Field label="DHL" value={String(totals.dhl)} accent="text-amber" />
        <Field label="Total" value={String(totals.total)} />
        {session.awbNumber && <Field label="AWB" value={session.awbNumber} mono />}
        {session.masterUpsTracking && (
          <Field
            label="Master UPS tracking"
            value={session.masterUpsTracking}
            href={trackingUrl("ups", session.masterUpsTracking) ?? undefined}
            mono
          />
        )}
        {session.masterUpsTracking && (
          <div className="bg-paper-panel p-3">
            <div className="tag-label">Master UPS Status</div>
            <div className="mt-1">
              <span
                className={`tag-label !text-[0.65rem] px-1.5 py-0.5 inline-block ${statusTone(session.masterUpsStatusLabel)}`}
              >
                {session.masterUpsStatusLabel ?? "STATUS PENDING"}
              </span>
            </div>
            {session.masterUpsStatusAt && (
              <div className="data text-xs text-ink-faint mt-1">as of {session.masterUpsStatusAt}</div>
            )}
          </div>
        )}
        <Field label="Opened" value={formatWarehouseTimestamp(session.openedAt)} />
        {session.submittedAt && (
          <Field label="Submitted" value={formatWarehouseTimestamp(session.submittedAt)} />
        )}
      </div>

      {showDhlPickup && <DhlPickupPanel sessionId={session.id} initialRequest={pickupRequest} />}

      {session.notes && (
        <div className="border-l-4 border-line-strong bg-paper-dim p-3 text-sm whitespace-pre-wrap font-condensed">
          {session.notes}
        </div>
      )}

      {boxes.map((b) => (
        <div key={b.id} className="flex flex-col gap-1">
          <h2 className="tag-label !text-sm !text-ink flex items-baseline gap-2">
            BOX {String(b.boxNumber).padStart(2, "0")}
            <span className="!normal-case !tracking-normal font-condensed text-ink-faint text-xs">
              ({b.scanCount} parcels)
            </span>
            {b.upsTracking && <span className="data text-ink-faint text-xs">{b.upsTracking}</span>}
          </h2>
          <ScanTable rows={boxedScans.get(b.id) ?? []} userNames={userNames} />
        </div>
      ))}

      {unboxedScans.length > 0 && (
        <div className="flex flex-col gap-1">
          <h2 className="tag-label !text-sm !text-ink">UPS / DHL Parcels</h2>
          <ScanTable rows={unboxedScans} userNames={userNames} />
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  accent,
  href,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: string;
  href?: string;
}) {
  return (
    <div className="bg-paper-panel p-3">
      <div className={`tag-label ${accent ?? ""}`}>{label}</div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={`font-semibold text-blue hover:underline ${mono ? "data text-sm" : "data"}`}
        >
          {value}
        </a>
      ) : (
        <div className={`font-semibold ${mono ? "data text-sm" : "data"}`}>{value}</div>
      )}
    </div>
  );
}

