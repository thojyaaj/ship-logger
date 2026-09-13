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
  getEpgFinalMileTime,
  getCostStats,
  getOnTimeDeliveryStats,
  getRateShopSavings,
  getShippingMargin,
  getExceptionBreakdown,
} from "@/lib/analytics";
import { carrierLabel, type Carrier } from "@/lib/carrier";
import { getProblemSummary } from "@/lib/shipment-alerts";
import VolumeChart from "../shipments/VolumeChart";
import HourlyChart from "./HourlyChart";
import BarList from "./BarList";
import PackerTable from "./PackerTable";
import StatTile from "./StatTile";
import CourierCard, { type CourierCardData } from "./CourierCard";
import AiInsights from "./AiInsights";

// AiInsights's server action makes one (slow, thoughtful) Anthropic call —
// longer than the default 10s Vercel Function duration allows.
export const maxDuration = 60;

const RANGE_OPTIONS = [7, 30, 90] as const;
const COURIER_ORDER: Carrier[] = ["epg", "ups", "dhl"];

function formatHours(hours: number | null): string {
  if (hours === null) return "—";
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
  } catch {
    return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
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

  const [
    dailyVolume,
    overview,
    carrierMix,
    packers,
    hourly,
    orderMatch,
    statusBreakdown,
    dhlStats,
    health,
    weekday,
    comparison,
    problems,
    epgFinalMile,
    costStats,
    onTimeDelivery,
    rateShopSavings,
    shippingMargin,
    exceptionBreakdown,
  ] = await Promise.all([
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
    getProblemSummary(),
    getEpgFinalMileTime(days),
    getCostStats(days),
    getOnTimeDeliveryStats(days),
    getRateShopSavings(days),
    getShippingMargin(days),
    getExceptionBreakdown(days),
  ]);
  const problemTotal = problems.exceptionCount + problems.staleCount + problems.lossCount;

  const maxStatusCount = Math.max(1, ...statusBreakdown.map((s) => s.count));
  const maxWeekdayCount = Math.max(1, ...weekday.map((w) => w.count));
  const maxCarrierCost = Math.max(1, ...costStats.byCarrier.map((c) => c.totalCost));
  const maxExceptionReasonCount = Math.max(1, ...exceptionBreakdown.topReasonsOverall.map((r) => r.count));
  const onTimeTotal = onTimeDelivery.reduce((sum, o) => sum + o.total, 0);
  const onTimeOnTime = onTimeDelivery.reduce((sum, o) => sum + o.onTime, 0);
  const onTimeOverallPct = onTimeTotal > 0 ? (onTimeOnTime / onTimeTotal) * 100 : null;
  // EPG-only — UPS/DHL parcels are never boxed (see totalEpgPackages).
  const avgParcelsPerBox = overview.totalBoxes > 0 ? overview.totalEpgPackages / overview.totalBoxes : null;

  const courierCards: CourierCardData[] = COURIER_ORDER.map((carrier) => {
    const mix = carrierMix.find((c) => c.carrier === carrier);
    const cost = costStats.byCarrier.find((c) => c.carrier === carrier);
    const margin = shippingMargin.byCarrier.find((c) => c.carrier === carrier);
    const onTime = onTimeDelivery.find((c) => c.carrier === carrier);
    const match = orderMatch.find((c) => c.carrier === carrier);
    const exceptions = exceptionBreakdown.byCarrier.find((c) => c.carrier === carrier);

    return {
      carrier,
      volume: mix?.count ?? 0,
      volumePct: mix?.pct ?? 0,
      totalCost: cost?.totalCost ?? null,
      avgCost: cost?.avgCost ?? null,
      totalCharged: margin?.totalCharged ?? null,
      margin: margin?.margin ?? null,
      currency: costStats.currency,
      onTimePct: onTime?.pct ?? null,
      onTimeSample: onTime?.total ?? 0,
      exceptionCount: exceptions?.count ?? 0,
      topExceptionReason: exceptions?.topReason ?? null,
      orderMatchPct: match ? match.pct : null,
      ...(carrier === "epg" ? { epgFinalMileDays: epgFinalMile.avgDays, epgFinalMileSample: epgFinalMile.sampleSize } : {}),
      ...(carrier === "dhl" ? { dhlPickup: { totalParcels: dhlStats.totalParcels, avgWeightLb: dhlStats.avgWeightLb } } : {}),
    };
  });

  // Handed to AiInsights as-is — the same numbers already on this page, not
  // a fresh query, and small enough to pass through a server action as a
  // plain argument.
  const aiSnapshot = {
    windowDays: days,
    overview,
    comparison,
    carrierMix,
    orderMatch,
    costStats,
    shippingMargin,
    onTimeDelivery,
    rateShopSavings,
    exceptionBreakdown,
    statusBreakdown,
    weekdayVolume: weekday,
    dhlPickupStats: dhlStats,
    operationalHealth: health,
    epgFinalMile,
    perCourier: courierCards,
  };

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-2 route-line pb-2">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="font-stencil text-2xl tracking-wide">Analytics</h1>
          <Link
            href="/admin/exceptions"
            className={`tag-label px-2.5 py-1 border ${
              problemTotal > 0 ? "border-red-ink bg-red-dim !text-red-ink" : "border-line-strong hover:bg-paper-dim"
            }`}
          >
            {problemTotal > 0 ? `${problemTotal} exception${problemTotal === 1 ? "" : "s"}` : "Exceptions"}
          </Link>
        </div>
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

      <AiInsights windowDays={days} snapshot={aiSnapshot} />

      {/* Overview KPIs — the six numbers worth knowing at a glance before
          drilling into any chart below. Net shipping margin leads — it's
          the single "are we gaining or losing money" number every other
          cost/charge tile on this page breaks down further. */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <StatTile
          label="Net shipping margin"
          value={shippingMargin.count > 0 ? formatMoney(shippingMargin.netMargin, costStats.currency) : "—"}
          sub={
            shippingMargin.count > 0
              ? `${shippingMargin.marginPct !== null ? `${shippingMargin.marginPct.toFixed(1)}% of charged` : ""} · ${shippingMargin.count} parcels`
              : "no cost+charged data yet"
          }
          accent={
            shippingMargin.count === 0 ? "!text-ink-faint" : shippingMargin.netMargin < 0 ? "!text-red-ink" : "!text-green-ink"
          }
        />
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
        <StatTile
          label="EPG final-mile"
          value={epgFinalMile.avgDays !== null ? `${epgFinalMile.avgDays.toFixed(1)}d` : "—"}
          sub={epgFinalMile.sampleSize > 0 ? `hub → door · ${epgFinalMile.sampleSize} parcels` : "no delivered parcels yet"}
        />
        <StatTile
          label="Total shipping cost"
          value={formatMoney(costStats.totalCost, costStats.currency)}
          sub={
            costStats.byCarrier.length > 0
              ? `${costStats.byCarrier.reduce((n, c) => n + c.count, 0)} parcels costed`
              : "no cost data backfilled yet"
          }
        />
        <StatTile
          label="Avg cost / package"
          value={formatMoney(costStats.avgCostPerPackage, costStats.currency)}
          sub="from ShipStation labels"
        />
        <StatTile
          label="On-time delivery"
          value={onTimeOverallPct !== null ? `${onTimeOverallPct.toFixed(0)}%` : "—"}
          sub={onTimeTotal > 0 ? `${onTimeOnTime}/${onTimeTotal} parcels · unverified data source` : "no delivery-estimate data yet"}
          accent={onTimeTotal === 0 ? "!text-ink-faint" : undefined}
        />
        <StatTile
          label="Potential rate-shop savings"
          value={rateShopSavings.count > 0 ? formatMoney(rateShopSavings.totalSavings, null) : "—"}
          sub={
            rateShopSavings.count > 0
              ? `${rateShopSavings.count} parcels compared · unverified data source`
              : "no rate-estimate data yet"
          }
          accent={
            rateShopSavings.count === 0 ? "!text-ink-faint" : rateShopSavings.totalSavings > 0 ? "!text-amber-ink" : undefined
          }
        />
      </div>

      {/* Per-courier breakdown — the one section that answers "how is each
          carrier actually doing" without cross-referencing four different
          bar lists by eye. */}
      <div className="grid md:grid-cols-3 gap-3">
        {courierCards.map((c) => (
          <CourierCard key={c.carrier} data={c} />
        ))}
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
        title="Cost by carrier"
        rows={costStats.byCarrier.map((c) => ({
          key: c.carrier,
          label: carrierLabel(c.carrier),
          value: c.totalCost,
          displayValue: formatMoney(c.totalCost, costStats.currency),
          pct: (c.totalCost / maxCarrierCost) * 100,
          barClassName: carrierBarClass(c.carrier),
        }))}
        emptyMessage="No cost data backfilled yet."
      />

      <BarList
        title="On-time delivery by carrier"
        rows={onTimeDelivery.map((o) => ({
          key: o.carrier,
          label: carrierLabel(o.carrier),
          value: o.total,
          displayValue: o.pct !== null ? `${o.onTime}/${o.total} · ${o.pct.toFixed(0)}%` : "—",
          pct: o.pct ?? 0,
          barClassName: o.pct === null ? "bg-ink-faint" : o.pct >= 90 ? "bg-green" : o.pct >= 70 ? "bg-amber" : "bg-red",
        }))}
        emptyMessage="No delivery-estimate data backfilled yet (unverified data source — see lib/shipstation.ts)."
      />

      <BarList
        title="Most common exceptions"
        rows={exceptionBreakdown.topReasonsOverall.map((r) => ({
          key: r.label,
          label: r.label,
          value: r.count,
          displayValue: String(r.count),
          pct: (r.count / maxExceptionReasonCount) * 100,
          barClassName: "bg-red",
        }))}
        emptyMessage="No exceptions in this window."
      />

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
