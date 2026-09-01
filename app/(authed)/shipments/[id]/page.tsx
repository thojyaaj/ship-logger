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
      <div className="flex flex-col gap-3 route-line pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Link href="/shipments" className="tag-label hover:!text-ink">
              ← Shipments
            </Link>
            <h1 className="font-stencil text-2xl tracking-wide mt-1">{session.shipDate}</h1>
          </div>
          <span
            className={`tag-label px-3 py-1 shrink-0 ${
              session.status === "submitted"
                ? "bg-green-dim !text-green-ink"
                : "bg-amber-dim !text-amber-ink"
            }`}
          >
            {session.status}
          </span>
        </div>

        {/* One row, always — flex-nowrap keeps Export CSV / Reopen /
            Delete / DHL Pickup from wrapping onto a second line;
            overflow-x-auto is the fallback on the very narrowest phones
            rather than letting them clip. */}
        <div className="flex items-center justify-center gap-2 flex-nowrap overflow-x-auto w-full pb-1">
          <a
            href={`/shipments/${session.id}/export`}
            className="btn px-4 py-2 border border-line-strong text-ink hover:bg-paper-dim shrink-0"
          >
            Export CSV
          </a>
          {/* Admin-only, matching reopenSessionAction's requireAdmin — showing
              it to packers would just render a button that always errors. */}
          {session.status === "submitted" && user.isAdmin && <ReopenButton sessionId={session.id} />}
          {user.isAdmin && <DeleteShipmentButton sessionId={session.id} shipDate={session.shipDate} />}
          {showDhlPickup && <DhlPickupPanel sessionId={session.id} initialRequest={pickupRequest} />}
        </div>
      </div>

      {/* Courier tally, always 1x4 (mobile and desktop alike) — three
          color-coded carrier counts plus a Total box styled to stand out
          (dark fill, same treatment as the scan page's Session Total tile)
          rather than blending in as a fourth plain Field. Centered on
          mobile, left-aligned (the original layout) on desktop. */}
      <div className="grid grid-cols-4 gap-px bg-line text-sm text-center md:text-left">
        <Field label="EPG" value={String(totals.epg)} accent="!text-orange" tint="bg-orange-dim" />
        <Field label="UPS" value={String(totals.ups)} accent="!text-blue" tint="bg-blue-dim" />
        <Field label="DHL" value={String(totals.dhl)} accent="!text-amber" tint="bg-amber-dim" />
        <div className="bg-ink text-paper p-3">
          <div className="tag-label !text-orange">Total</div>
          <div className="data font-semibold text-lg mt-0.5">{totals.total}</div>
        </div>
      </div>

      {/* Shipment metadata — its own grid (the parent's gap-6 supplies the
          space above), 3-up on mobile wrapping to a second row, 5-up on
          desktop so a fully populated EPG shipment's AWB/Master UPS
          tracking/status/Opened/Submitted all land in a single row.
          Opened/Submitted span the full row on mobile instead of packing
          into the 3-column grid — with 5 items that leaves an empty
          trailing cell that reads as a 6th, blank box. Centered on desktop
          per the metadata grid's own alignment (independent of the courier
          grid above). */}
      <div className="grid grid-cols-3 md:grid-cols-5 gap-px bg-line text-sm md:text-center">
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
          <div className="bg-paper-panel p-3 min-w-0">
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
        <Field label="Opened" value={formatWarehouseTimestamp(session.openedAt)} className="col-span-3 md:col-span-1" />
        {session.submittedAt && (
          <Field
            label="Submitted"
            value={formatWarehouseTimestamp(session.submittedAt)}
            className="col-span-3 md:col-span-1"
          />
        )}
      </div>

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
  tint,
  href,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: string;
  tint?: string;
  href?: string;
  className?: string;
}) {
  return (
    // min-w-0: grid items default to min-width:auto, which — same as the
    // scan input's flex-1 overflow bug — refuses to shrink a long value
    // (e.g. a 1Z... UPS tracking number) below its own intrinsic width,
    // pushing it outside the cell instead of truncating.
    <div className={`p-3 min-w-0 ${tint ?? "bg-paper-panel"} ${className ?? ""}`}>
      <div className={`tag-label ${accent ?? ""}`}>{label}</div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={`block truncate font-semibold text-blue hover:underline ${mono ? "data text-sm" : "data"}`}
        >
          {value}
        </a>
      ) : (
        <div className={`truncate font-semibold ${mono ? "data text-sm" : "data"}`}>{value}</div>
      )}
    </div>
  );
}

