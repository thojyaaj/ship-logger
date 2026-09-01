import { pageRequireUser } from "@/lib/auth";
import { listShipments, getDailyVolume } from "@/lib/shiplog";
import VolumeChart from "./VolumeChart";
import ShipmentSearchForm from "./ShipmentSearchForm";
import SwipeableShipmentRow from "./SwipeableShipmentRow";

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

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-baseline justify-between route-line pb-2">
        <h1 className="font-stencil text-2xl tracking-wide">Shipments Log</h1>
        <span className="tag-label">{shipments.length} on record</span>
      </div>

      <VolumeChart points={dailyVolume} />

      <ShipmentSearchForm initialQuery={q ?? ""} initialDate={date ?? ""} />

      {hasFilter && (
        <p className="tag-label !normal-case !tracking-normal">
          {shipments.length} shipment{shipments.length === 1 ? "" : "s"} {filterDescriptions.join(" and ")}.
        </p>
      )}

      <div className="flex flex-col border-t border-line">
        {shipments.map((s, i) => (
          <SwipeableShipmentRow key={s.id} shipment={s} isAdmin={user.isAdmin} showSwipeHint={i === 0} />
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
