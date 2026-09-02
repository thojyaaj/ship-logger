import Link from "next/link";
import { pageRequireAdmin } from "@/lib/auth";
import { getDailyVolume } from "@/lib/shiplog";
import {
  getOverviewStats,
  getCarrierMix,
  getPackerLeaderboard,
  getHourlyActivity,
  getOrderMatchRate,
  getStatusBreakdown,
  getDhlPickupStats,
  getOperationalHealth,
  getWeekdayVolume,
  getPeriodComparison,
} from "@/lib/analytics";
import { carrierLabel, type Carrier } from "@/lib/carrier";
import VolumeChart from "../shipments/VolumeChart";
import HourlyChart from "./HourlyChart";
import BarList from "./BarList";
import PackerTable from "./PackerTable";
import StatTile from "./StatTile";

const RANGE_OPTIONS = [7, 30, 90] as const;

function formatHours(hours: number | null): string {
  if (hours === null) return "—";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function carrierBarClass(carrier: Carrier): string {
  switch (carrier) {
    case "epg":
      return "bg-orange";
    case "ups":
      return "bg-blue";
    case "dhl":
      return "bg-amber";
    default:
      return "bg-ink-faint";
  }
}

function statusBarClass(label: string): string {
  if (/delivered/i.test(label)) return "bg-green";
  if (/exception|return/i.test(label)) return "bg-red";
  return "bg-blue";
}

/** Colored "+12% vs prev" / "flat" sub-line for a period-over-period delta — null (no previous-window baseline) renders nothing extra. */
function DeltaSub({ pctChange, fallback }: { pctChange: number | null; fallback: string }) {
  if (pctChange === null) return <>{fallback}</>;
  const rounded = Math.round(pctChange);
  if (rounded === 0) return <span className="text-ink-faint">flat vs prev period</span>;
  return (
    <span className={rounded > 0 ? "text-green-ink" : "text-red-ink"}>
      {rounded > 0 ? "+" : ""}
      {rounded}% vs prev period
    </span>
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await pageRequireAdmin();
  const { days: daysParam } = await searchParams;
  const days = (RANGE_OPTIONS as readonly number[]).includes(Number(daysParam)) ? Number(daysParam) : 30;

  const [dailyVolume, overview, carrierMix, packers, hourly, orderMatch, statusBreakdown, dhlStats, health, weekday, comparison] =
    await Promise.all([
      getDailyVolume(days),
      getOverviewStats(days),
      getCarrierMix(days),
      getPackerLeaderboard(days),
      getHourlyActivity(days),
      getOrderMatchRate(days),
      getStatusBreakdown(days),
      getDhlPickupStats(days),
      getOperationalHealth(days),
      getWeekdayVolume(days),
      getPeriodComparison(days),
    ]);

  const maxStatusCount = Math.max(1, ...statusBreakdown.map((s) => s.count));
  const maxWeekdayCount = Math.max(1, ...weekday.map((w) => w.count));
  // EPG-only — UPS/DHL parcels are never boxed (see totalEpgPackages).
  const avgParcelsPerBox = overview.totalBoxes > 0 ? overview.totalEpgPackages / overview.totalBoxes : null;

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-2 route-line pb-2">
        <h1 className="font-stencil text-2xl tracking-wide">Analytics</h1>
        {/* Plain links with a search param, not client state — a fresh
            server render per range keeps every card (and its own query)
            in sync with the same window, no client-side refetch wiring. */}
        <div className="flex items-center gap-1">
          {RANGE_OPTIONS.map((d) => (
            <Link
              key={d}
              href={`/analytics?days=${d}`}
              className={`tag-label px-2.5 py-1 border ${
                d === days ? "bg-ink text-paper border-ink" : "border-line-strong hover:bg-paper-dim"
              }`}
            >
              {d}d
            </Link>
          ))}
        </div>
      </div>

      {/* Overview KPIs — the six numbers worth knowing at a glance before
          drilling into any chart below. */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <StatTile
          label="Shipments"
          value={String(overview.shipmentsSubmitted)}
          sub={<DeltaSub pctChange={comparison.shipments.pctChange} fallback={`last ${days}d`} />}
        />
        <StatTile
          label="Packages"
          value={String(overview.totalPackages)}
          sub={<DeltaSub pctChange={comparison.packages.pctChange} fallback={`${overview.avgPackagesPerShipment.toFixed(1)}/shipment`} />}
        />
        <StatTile
          label="Boxes"
          value={String(overview.totalBoxes)}
          sub={`${overview.avgBoxesPerShipment.toFixed(1)}/shipment · ${avgParcelsPerBox !== null ? avgParcelsPerBox.toFixed(1) : "—"}/box`}
        />
        <StatTile label="Avg pack time" value={formatHours(overview.avgHoursToSubmit)} sub="open → submit" />
        <StatTile
          label="DHL pickups"
          value={String(dhlStats.requested + dhlStats.cancelled)}
          sub={dhlStats.failed > 0 ? `${dhlStats.failed} failed` : "0 failed"}
        />
        <StatTile
          label="Reopened"
          value={String(health.reopenedShipments)}
          sub="needed correction"
          accent={health.reopenedShipments > 0 ? "!text-amber-ink" : undefined}
        />
      </div>

      <VolumeChart points={dailyVolume} />

      <HourlyChart points={hourly} />

      <div className="grid md:grid-cols-2 gap-4">
        <BarList
          title="Carrier mix"
          rows={carrierMix.map((c) => ({
            key: c.carrier,
            label: carrierLabel(c.carrier),
            value: c.count,
            displayValue: `${c.count} · ${c.pct.toFixed(0)}%`,
            pct: c.pct,
            barClassName: carrierBarClass(c.carrier),
          }))}
        />
        <BarList
          title="Order match rate"
          rows={orderMatch.map((m) => ({
            key: m.carrier,
            label: carrierLabel(m.carrier),
            value: m.matched,
            displayValue: `${m.matched}/${m.total} · ${m.pct.toFixed(0)}%`,
            pct: m.pct,
            barClassName: m.pct >= 90 ? "bg-green" : m.pct >= 70 ? "bg-amber" : "bg-red",
          }))}
          emptyMessage="No submitted shipments in this window."
        />
      </div>

      <BarList
        title="Volume by day of week"
        rows={weekday.map((w) => ({
          key: String(w.weekday),
          label: w.label,
          value: w.count,
          displayValue: String(w.count),
          pct: (w.count / maxWeekdayCount) * 100,
          barClassName: "bg-orange",
        }))}
      />

      <PackerTable packers={packers} />

      <BarList
        title="Live carrier status — submitted shipments"
        rows={statusBreakdown.map((s) => ({
          key: s.label,
          label: s.label,
          value: s.count,
          displayValue: String(s.count),
          pct: (s.count / maxStatusCount) * 100,
          barClassName: statusBarClass(s.label),
        }))}
        emptyMessage="No carrier status data in this window."
      />

      {/* DHL pickup detail + operational-health signals — exception/quality
          data rather than volume, grouped together since both are "is
          anything going wrong" reads rather than "how much did we ship." */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatTile label="Parcels picked up" value={String(dhlStats.totalParcels)} sub={`${dhlStats.totalWeightLb} lb total`} />
        <StatTile label="Avg pickup weight" value={dhlStats.avgWeightLb !== null ? `${dhlStats.avgWeightLb} lb` : "—"} />
        <StatTile label="Reset Day used" value={String(health.resets)} sub={`${health.restoredResets} restored`} />
        <StatTile
          label="Trashed"
          value={String(health.trashedShipments)}
          accent={health.trashedShipments > 0 ? "!text-red-ink" : undefined}
        />
      </div>
    </div>
  );
}
