import Link from "next/link";
import { pageRequireUser } from "@/lib/auth";
import { listShipments, getDailyVolume } from "@/lib/shiplog";
import VolumeChart from "./VolumeChart";
import ShipmentSearchForm from "./ShipmentSearchForm";
import SwipeableShipmentRow from "./SwipeableShipmentRow";
import { TrashIcon } from "./[id]/icons";

export default async function ShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; date?: string }>;
}) {
  const user = await pageRequireUser();
  const { q, date } = await searchParams;
  // The trend chart always covers the full trailing window regardless of
  // the search/date filters below — it's an overview, not a filtered view.
  const [shipments, dailyVolume] = await Promise.all([
    listShipments({ search: q, date }),
    getDailyVolume(30),
  ]);
  const hasFilter = Boolean(q || date);

  const filterDescriptions: string[] = [];
  if (q) filterDescriptions.push(`contain a tracking number matching “${q}”`);
  if (date) filterDescriptions.push(`shipped on ${date}`);

  // The swipe hint should land on the first row a swipe would actually do
  // something to — the open session (if it's first, which it usually is)
  // can't be deleted, so hinting on it would demo a gesture that just
  // shakes and refuses.
  const swipeHintIndex = shipments[0]?.status === "open" ? 1 : 0;

  return (
    // pb-24 clears the fixed tracking-search footer ShipmentSearchForm adds
    // on mobile so the last shipment row isn't hidden behind it; md:pb-6
    // reverts to the normal padding once that footer is back in static
    // flow at desktop widths.
    <div className="flex-1 flex flex-col gap-6 p-4 pb-24 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-baseline justify-between route-line pb-2">
        <h1 className="font-stencil text-2xl tracking-wide">Shipments Log</h1>
        <div className="flex items-center gap-3">
          <span className="tag-label">{shipments.length} on record</span>
          {/* Desktop, admin-only — Trash lost its own top-nav link (see
              layout.tsx) in favor of living right next to the log it
              trashes shipments out of. */}
          {user.isAdmin && (
            <Link
              href="/admin/trash"
              className="hidden md:inline-flex btn items-center gap-1.5 px-3 py-1.5 bg-orange text-paper hover:bg-orange-ink"
            >
              <TrashIcon className="w-4 h-4" />
              Trash
            </Link>
          )}
        </div>
      </div>

      {/* Moved to its own Analytics page on mobile (admin-only) — no room
          for a trend chart above a manifest that's already fighting for
          space on a phone. Desktop keeps it here too, unchanged. */}
      <div className="hidden md:block">
        <VolumeChart points={dailyVolume} />
      </div>

      <ShipmentSearchForm initialQuery={q ?? ""} initialDate={date ?? ""} />

      {hasFilter && (
        <p className="tag-label !normal-case !tracking-normal">
          {shipments.length} shipment{shipments.length === 1 ? "" : "s"} {filterDescriptions.join(" and ")}.
        </p>
      )}

      <div className="flex flex-col border-t border-line">
        {shipments.map((s, i) => (
          <SwipeableShipmentRow key={s.id} shipment={s} isAdmin={user.isAdmin} showSwipeHint={i === swipeHintIndex} />
        ))}
        {shipments.length === 0 && (
          <p className="text-ink-faint text-center py-12 border-b border-line data">
            {hasFilter ? "NO SHIPMENTS FOUND" : "NO SHIPMENTS SUBMITTED YET"}
          </p>
        )}
      </div>
    </div>
  );
}
