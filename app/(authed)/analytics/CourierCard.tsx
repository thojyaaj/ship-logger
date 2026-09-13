import { carrierLabel, type Carrier } from "@/lib/carrier";

export type CourierCardData = {
  carrier: Carrier;
  volume: number;
  volumePct: number;
  totalCost: number | null;
  avgCost: number | null;
  totalCharged: number | null;
  margin: number | null;
  currency: string | null;
  onTimePct: number | null;
  onTimeSample: number;
  exceptionCount: number;
  topExceptionReason: string | null;
  orderMatchPct: number | null;
  /** EPG only. */
  epgFinalMileDays?: number | null;
  epgFinalMileSample?: number;
  /** DHL only. */
  dhlPickup?: { totalParcels: number; avgWeightLb: number | null };
};

function formatMoney(amount: number | null, currency: string | null, opts?: { decimals?: number }): string {
  if (amount === null) return "—";
  const decimals = opts?.decimals ?? 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amount);
  } catch {
    return `${amount.toFixed(decimals)}${currency ? ` ${currency}` : ""}`;
  }
}

function Stat({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="min-w-0">
      <div className="tag-label !text-[0.6rem]">{label}</div>
      <div className={`data font-semibold truncate ${accent ?? ""}`}>{value}</div>
      {sub && (
        <div className="text-[0.65rem] text-ink-faint truncate" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}

/**
 * A tinted, left-accented sub-panel — groups related stats (money vs.
 * service-quality vs. carrier-specific) into their own visual block instead
 * of one undifferentiated grid, so the eye has somewhere to land before
 * reading numbers.
 */
function StatGroup({ label, accent, bg, children }: { label: string; accent: string; bg: string; children: React.ReactNode }) {
  return (
    <div className={`border-l-2 ${accent} ${bg} px-3 py-2.5 flex flex-col gap-2`}>
      <div className="tag-label !text-[0.55rem] !tracking-[0.18em]">{label}</div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">{children}</div>
    </div>
  );
}

/** One courier's whole story at a glance — volume, cost vs. charged, margin, on-time %, exceptions, order matching, plus whichever carrier-specific stat applies (EPG final-mile, DHL pickups). */
export default function CourierCard({ data }: { data: CourierCardData }) {
  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-stencil text-lg tracking-wide">{carrierLabel(data.carrier)}</h3>
        <span className="tag-label !text-ink-faint">
          {data.volume} parcel{data.volume === 1 ? "" : "s"} · {data.volumePct.toFixed(0)}%
        </span>
      </div>

      {/* Totals round to whole dollars — the exact cents live in the
          per-package sub-line below "Cost paid" instead, since a fixed-width
          grid column truncates a comma-thousands total ("$2,155.…") the
          moment cents push it past a few hundred dollars. */}
      <StatGroup label="Money" accent="border-blue" bg="bg-blue-dim/30">
        <Stat
          label="Cost paid"
          value={formatMoney(data.totalCost, data.currency, { decimals: 0 })}
          sub={data.avgCost !== null ? `${formatMoney(data.avgCost, data.currency)}/pkg` : undefined}
        />
        <Stat label="Charged" value={formatMoney(data.totalCharged, data.currency, { decimals: 0 })} />
        <Stat
          label="Margin"
          value={formatMoney(data.margin, data.currency, { decimals: 0 })}
          accent={data.margin !== null ? (data.margin < 0 ? "!text-red-ink" : "!text-green-ink") : undefined}
        />
      </StatGroup>

      <StatGroup label="Service" accent="border-amber" bg="bg-amber-dim/30">
        <Stat
          label="On-time"
          value={data.onTimePct !== null ? `${data.onTimePct.toFixed(0)}%` : "—"}
          sub={data.onTimeSample > 0 ? `${data.onTimeSample} tracked` : "no data yet"}
        />
        <Stat label="Order match" value={data.orderMatchPct !== null ? `${data.orderMatchPct.toFixed(0)}%` : "—"} />
        <Stat
          label="Exceptions"
          value={String(data.exceptionCount)}
          accent={data.exceptionCount > 0 ? "!text-red-ink" : undefined}
          sub={data.topExceptionReason ?? undefined}
        />
      </StatGroup>

      {(data.epgFinalMileDays !== undefined || data.dhlPickup) && (
        <StatGroup label={data.epgFinalMileDays !== undefined ? "Final-mile" : "Pickup"} accent="border-line-strong" bg="bg-paper-dim">
          {data.epgFinalMileDays !== undefined && (
            <Stat
              label="Final-mile"
              value={data.epgFinalMileDays !== null ? `${data.epgFinalMileDays.toFixed(1)}d` : "—"}
              sub={data.epgFinalMileSample ? `hub → door · ${data.epgFinalMileSample} parcels` : "hub → door"}
            />
          )}
          {data.dhlPickup && (
            <>
              <Stat label="Picked up" value={String(data.dhlPickup.totalParcels)} />
              <Stat
                label="Avg weight"
                value={data.dhlPickup.avgWeightLb !== null ? `${data.dhlPickup.avgWeightLb} lb` : "—"}
              />
            </>
          )}
        </StatGroup>
      )}
    </div>
  );
}
