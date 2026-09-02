import Link from "next/link";
import { notFound } from "next/navigation";
import { pageRequireUser } from "@/lib/auth";
import { getShipmentDetail, ShipmentNotFoundError } from "@/lib/shiplog";
import { formatCarrierTimestamp, formatWarehouseTimestamp } from "@/lib/date";
import { trackingUrl, statusTone } from "@/lib/carrier";
import ReopenButton from "./ReopenButton";
import DeleteShipmentButton from "./DeleteShipmentButton";
import ScanTable from "./ScanTable";
import DhlPickupPanel from "./DhlPickupPanel";
import { getLatestPickupRequest, getDhlPickupSettings } from "@/lib/dhl-pickup";

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
  // Defaults to enabled when settings haven't been configured yet — the
  // schedule attempt itself already surfaces a clear "not configured" error
  // in that case, so there's nothing extra for the enabled flag to guard.
  const dhlSchedulingEnabled = showDhlPickup ? ((await getDhlPickupSettings())?.enabled ?? true) : true;

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
    <div className="flex-1 flex flex-col gap-6 p-4 pb-20 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex flex-col gap-3 route-line pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            {/* Mobile: redundant now that the header itself has a
                back-to-shipments-log icon (see
                ShipmentDetailHeaderMobileActions) — desktop has no header
                equivalent, so it keeps this breadcrumb. */}
            <Link href="/shipments" className="hidden md:inline tag-label hover:!text-ink">
              ← Shipments
            </Link>
            <h1 className="data text-lg tracking-wide mt-1 truncate" title={session.id}>
              {session.id}
            </h1>
            {session.status === "submitted" && session.submittedBy && (
              <div className="mt-1 -mx-1 px-1.5 py-0.5 bg-paper-dim text-green-ink font-condensed text-xs inline-block">
                Submitted by {userNames[session.submittedBy] ?? "Unknown"}
              </div>
            )}
          </div>
            {/* Bigger than the standard tag-label size (0.65rem) so status
              — the thing a packer scans this page for — actually stands
              out, with the close-out details directly beneath it. */}
            <div
              className={`flex flex-col items-center text-center gap-0.5 px-3 py-2 shrink-0 ${
                session.status === "submitted"
                ? "bg-green !text-white"
                : "bg-amber-dim !text-amber-ink"
              }`}
            >
              <span className="tag-label !text-base !text-white">{session.status}</span>
            {session.status === "submitted" && session.submittedAt && (
              <span className="font-condensed text-xs">{formatWarehouseTimestamp(session.submittedAt)}</span>
            )}
          </div>
        </div>

        {/* Desktop: one row, always — flex-nowrap keeps Reopen / Delete /
            DHL Pickup from wrapping onto a second line; overflow-x-auto is
            the fallback on the very narrowest phones rather than letting
            them clip. Export CSV is desktop-only (a mobile browser can't do
            much with a downloaded CSV). */}
        <div className="flex items-center justify-center gap-2 flex-nowrap overflow-x-auto w-full pb-1">
          <a
            href={`/shipments/${session.id}/export`}
            className="hidden md:inline-flex btn px-4 py-2 border border-line-strong text-ink hover:bg-paper-dim shrink-0"
          >
            Export CSV
          </a>
          {/* Mobile: a real fixed tab bar docked to the bottom of the
              viewport instead of sitting inline up here — these are the
              actions a packer reaches for repeatedly while scrolling a long
              manifest, not something worth scrolling back up for.
              md:contents dissolves this wrapper's own box at the desktop
              breakpoint so the same three buttons just rejoin the row above
              as plain flex items, unchanged from before. */}
          <div className="fixed md:contents bottom-0 inset-x-0 z-20 flex items-stretch gap-2 bg-ink border-t border-line-strong px-3 py-2">
            {/* Admin-only, matching reopenSessionAction's requireAdmin — showing
                it to packers would just render a button that always errors. */}
            {session.status === "submitted" && user.isAdmin && <ReopenButton sessionId={session.id} />}
            {user.isAdmin && <DeleteShipmentButton sessionId={session.id} shipDate={session.shipDate} />}
            {showDhlPickup && (
              <DhlPickupPanel
                sessionId={session.id}
                initialRequest={pickupRequest}
                schedulingEnabled={dhlSchedulingEnabled}
              />
            )}
          </div>
        </div>
      </div>

      {/* Courier tally, always 1x4 (mobile and desktop alike) — three
          color-coded carrier counts plus a Total box styled to stand out
          (dark fill, same treatment as the scan page's Session Total tile)
          rather than blending in as a fourth plain Field. Centered on
          mobile, left-aligned (the original layout) on desktop. */}
      <div className="grid grid-cols-4 gap-px bg-line text-sm text-center md:text-left">
        <Field label="EPG" value={String(totals.epg)} accent="!text-orange" tint="bg-orange-dim" valueClassName="text-lg" />
        <Field label="UPS" value={String(totals.ups)} accent="!text-blue" tint="bg-blue-dim" valueClassName="text-lg" />
        <Field label="DHL" value={String(totals.dhl)} accent="!text-amber" tint="bg-amber-dim" valueClassName="text-lg" />
        <div className="bg-ink text-paper p-3">
          <div className="tag-label !text-orange">Total</div>
          <div className="data font-semibold text-lg mt-0.5">{totals.total}</div>
        </div>
      </div>

      {/* Shipment metadata — AWB/Master UPS status/tracking only. Opened is
          just noise (nobody's asked when packing started) and Submitted now
          lives as the second line of the status tag above, not its own box.
          2 cols on mobile, 3 on desktop (one line, full width) — Status
          before Tracking (DOM order) so on mobile AWB+Status share row 1
          and Tracking falls to row 2 on its own, full width there (long
          tracking numbers need the room) rather than half; on desktop all
          three just sit in the single 3-col row regardless of order.
          Centered both ways: text-center for the horizontal axis, and each
          cell is a centered flex column so a shorter cell's label+value
          block sits at the same vertical mid-point as Status's taller one
          (badge + "as of" line) instead of hugging the top. */}
      {(session.awbNumber || session.masterUpsTracking) && (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-line text-sm text-center">
          {session.awbNumber && (
            <Field label="AWB" value={session.awbNumber} mono className="flex flex-col justify-center" />
          )}
          {session.masterUpsTracking && (
            <div className="bg-paper-panel p-3 min-w-0 flex flex-col justify-center">
              <div className="tag-label">Master UPS Status</div>
              <div className="mt-1">
                <span
                  className={`tag-label !text-[0.65rem] px-1.5 py-0.5 inline-block ${statusTone(session.masterUpsStatusLabel)}`}
                >
                  {session.masterUpsStatusLabel ?? "STATUS PENDING"}
                </span>
              </div>
              {session.masterUpsStatusAt && (
                <div className="data text-xs text-ink-faint mt-1">
                  as of {formatCarrierTimestamp(session.masterUpsStatusAt)}
                </div>
              )}
            </div>
          )}
          {session.masterUpsTracking && (
            <Field
              label="Master UPS tracking"
              value={session.masterUpsTracking}
              href={trackingUrl("ups", session.masterUpsTracking) ?? undefined}
              mono
              className="col-span-2 md:col-span-1 flex flex-col justify-center"
            />
          )}
        </div>
      )}

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
          <ScanTable rows={boxedScans.get(b.id) ?? []} />
        </div>
      ))}

      {unboxedScans.length > 0 && (
        <div className="flex flex-col gap-1">
          <h2 className="tag-label !text-sm !text-ink">UPS / DHL Parcels</h2>
          <ScanTable rows={unboxedScans} />
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
  valueClassName,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: string;
  tint?: string;
  href?: string;
  className?: string;
  valueClassName?: string;
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
          className={`block truncate font-semibold text-blue hover:underline ${mono ? "data text-sm" : "data"} ${valueClassName ?? ""}`}
        >
          {value}
        </a>
      ) : (
        <div className={`truncate font-semibold ${mono ? "data text-sm" : "data"} ${valueClassName ?? ""}`}>
          {value}
        </div>
      )}
    </div>
  );
}
