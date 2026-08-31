import Link from "next/link";
import { pageRequireUser } from "@/lib/auth";
import { listShipments, getDailyVolume } from "@/lib/shiplog";
import { statusTone } from "@/lib/carrier";
import VolumeChart from "./VolumeChart";

export default async function ShipmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; date?: string }>;
}) {
  await pageRequireUser();
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

      <form className="flex gap-2 flex-wrap">
        <input
          type="text"
          name="q"
          defaultValue={q ?? ""}
          placeholder="SEARCH BY TRACKING NUMBER…"
          className="data flex-1 min-w-[220px] text-lg px-4 py-3 border border-line-strong focus:border-orange outline-none bg-paper-panel"
        />
        <label className="flex items-center gap-2 shrink-0">
          <span className="tag-label !text-ink-soft">Ship date</span>
          <input
            type="date"
            name="date"
            defaultValue={date ?? ""}
            className="data text-lg px-3 py-3 border border-line-strong focus:border-orange outline-none bg-paper-panel"
          />
        </label>
        <button type="submit" className="btn px-6 py-3 bg-ink text-paper">
          Search
        </button>
        {hasFilter && (
          <Link
            href="/shipments"
            className="btn px-4 py-3 border border-line-strong text-ink-soft hover:bg-paper-dim"
          >
            Clear
          </Link>
        )}
      </form>

      {hasFilter && (
        <p className="tag-label !normal-case !tracking-normal">
          {shipments.length} shipment{shipments.length === 1 ? "" : "s"} {filterDescriptions.join(" and ")}.
        </p>
      )}

      <div className="flex flex-col border-t border-line">
        {shipments.map((s) => (
          <Link
            key={s.id}
            href={`/shipments/${s.id}`}
            className="flex items-center gap-4 px-4 py-3 border-b border-line bg-paper-panel hover:bg-white transition-colors"
          >
            <div className="w-28 shrink-0">
              <div className="data font-semibold">{s.shipDate}</div>
              <span
                className={`tag-label !text-[0.6rem] px-1.5 py-0.5 inline-block mt-0.5 ${
                  s.status === "submitted"
                    ? "bg-green-dim !text-green-ink"
                    : "bg-amber-dim !text-amber-ink"
                }`}
              >
                {s.status}
              </span>
            </div>
            <div className="flex-1 flex gap-4 text-sm data">
              <span className="text-orange">EPG {s.totals.epg}</span>
              <span className="text-blue">UPS {s.totals.ups}</span>
              <span className="text-amber">DHL {s.totals.dhl}</span>
              {s.boxCount > 0 && <span className="text-ink-soft">{s.boxCount} box(es)</span>}
            </div>
            <div className="flex flex-col items-end gap-1 shrink-0 text-right">
              {s.awbNumber && <span className="tag-label !normal-case">{s.awbNumber}</span>}
              {s.totals.epg > 0 && s.masterUpsTracking && (
                <span
                  title={`Master UPS ${s.masterUpsTracking}${s.masterUpsStatusAt ? ` — as of ${s.masterUpsStatusAt}` : ""}`}
                  className={`tag-label !text-[0.6rem] px-1.5 py-0.5 inline-block whitespace-nowrap ${statusTone(s.masterUpsStatusLabel)}`}
                >
                  {s.masterUpsStatusLabel ?? "STATUS PENDING"}
                </span>
              )}
            </div>
          </Link>
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
