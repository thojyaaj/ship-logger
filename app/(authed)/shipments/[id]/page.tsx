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
import { DownloadIcon } from "./icons";

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
  const { session, boxes, scans, totals, userCodes } = dashboard;
  const submitterCode = session.submittedBy ? userCodes[session.submittedBy] : undefined;

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
    <div className="flex-1 flex flex-col gap-4 md:gap-6 p-4 pb-20 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex flex-col gap-2 md:gap-3 route-line pb-2 md:pb-3">
        <div className="flex items-start md:items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="tag-label">Session ID</div>
            {/* Same first-8-hex-chars convention as the scan page's
                "Session <id>" tag (see ScanClient.tsx) — the full UUID is
                too long to be a useful at-a-glance label, and packers
                already recognize this short form from the scan sheet.
                Sized/weighted to roughly match the status badge's own
                two-line height rather than sitting small next to it.
                Submitted shipments get the submitter's 2-digit crew code
                affixed ("<id>-<code>") instead of a separate "Submitted by
                <name>" line, which never read well at any size — this
                fits into the id itself with no extra vertical space. */}
            <h1 className="data text-3xl font-bold leading-tight tracking-wide" title={session.id}>
              {session.id.slice(0, 8).toUpperCase()}
              {session.status === "submitted" && submitterCode ? `-${submitterCode}` : ""}
            </h1>
          </div>

          {/* Desktop: Export/Reopen/Delete/DHL sit inline in this same row,
              between the session id and the status badge — Export/Reopen/
              Delete are icon-only here (title/aria-label carry the label);
              DHL keeps its text button, just not iconified (see
              DhlPickupPanel). This group itself must stay a real flex box
              (not `hidden`) on mobile — the fixed-position tab bar nested
              inside it (below) needs a non-`display:none` ancestor to
              render at all; position:fixed does not escape a hidden
              parent. Export alone is hidden on mobile since it's a plain
              link with nothing mobile needs from it. The group otherwise
              contributes zero width there: a hidden link plus a
              position:fixed child both take up no space in normal flow, so
              it doesn't push the session id/status apart. */}
          <div className="flex items-center gap-3 shrink-0">
            <a
              href={`/shipments/${session.id}/export`}
              title="Export CSV"
              aria-label="Export CSV"
              className="hidden md:inline-flex text-ink-faint hover:text-ink"
            >
              <DownloadIcon className="w-5 h-5" />
            </a>
            {/* Mobile: a real fixed tab bar docked to the bottom of the
                viewport instead of sitting inline here — these are the
                actions a packer reaches for repeatedly while scrolling a
                long manifest, not something worth scrolling back up for.
                md:contents dissolves this wrapper's own box at the desktop
                breakpoint so the same three buttons just rejoin this row as
                plain flex items instead. */}
            <div className="fixed md:contents bottom-0 inset-x-0 z-20 flex items-stretch gap-2 bg-ink border-t border-line-strong px-3 py-2">
              {/* Admin-only, matching reopenSessionAction's requireAdmin —
                  showing it to packers would just render a button that
                  always errors. */}
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
          Masonry 1fr/2fr split on mobile (3 equal cols on desktop) — Status
          before Tracking (DOM order) so on mobile AWB+Status share row 1
          and Tracking falls to row 2 on its own, full width there (long
          tracking numbers need the room) rather than half; on desktop all
          three just sit in the single 3-col row regardless of order. AWB is
          a short fixed-format number that never needs much room, while
          Status carries a badge plus an "as of <date/time>" line that was
          wrapping in an even 50/50 split — giving it the extra share fits
          that on one line instead.
          Centered both ways: text-center for the horizontal axis, and each
          cell is a centered flex column so a shorter cell's label+value
          block sits at the same vertical mid-point as Status's taller one
          (badge + "as of" line) instead of hugging the top. */}
      {/* Mobile: real gaps + a border per cell reads as separate bento-tray
          compartments rather than one pierced-line sheet — bg-line drops
          out since there's no longer a hairline gap for it to show through.
          md: reverts to the original touching-cells grid (gap-px on a
          bg-line backdrop, no per-cell border) unchanged. */}
      {(session.awbNumber || session.masterUpsTracking) && (
        <div className="grid grid-cols-[1fr_2fr] md:grid-cols-3 gap-2 md:gap-px bg-transparent md:bg-line text-sm text-center">
          {session.awbNumber && (
            <Field
              label="AWB"
              value={session.awbNumber}
              mono
              className="col-start-1 md:col-start-auto border border-line md:border-0 flex flex-col justify-center"
            />
          )}
          {session.masterUpsTracking && (
            // col-start-2 pins Status into the wide 2fr track next to AWB;
            // when AWB isn't rendered at all (a UPS-only session — no DHL,
            // so no master AWB), col-span-2 instead so Status fills the row
            // rather than leaving an empty bordered tile where AWB would
            // have sat. md: releases both back to plain 3-col auto-flow.
            <div
              className={`bg-paper-panel border border-line md:border-0 p-3 min-w-0 flex flex-col justify-center ${
                session.awbNumber ? "col-start-2" : "col-span-2"
              } md:col-start-auto md:col-span-1`}
            >
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
              className="col-span-2 md:col-span-1 border border-line md:border-0 flex flex-col justify-center"
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
