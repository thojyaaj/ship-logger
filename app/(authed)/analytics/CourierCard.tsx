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

function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
  } catch {
    return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
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
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat
          label="Cost paid"
          value={formatMoney(data.totalCost, data.currency)}
          sub={data.avgCost !== null ? `${formatMoney(data.avgCost, data.currency)}/pkg` : undefined}
        />
        <Stat label="Charged" value={formatMoney(data.totalCharged, data.currency)} />
        <Stat
          label="Margin"
          value={formatMoney(data.margin, data.currency)}
          accent={data.margin !== null ? (data.margin < 0 ? "!text-red-ink" : "!text-green-ink") : undefined}
        />
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
        {data.epgFinalMileDays !== undefined && (
          <Stat
            label="Final-mile"
            value={data.epgFinalMileDays !== null ? `${data.epgFinalMileDays.toFixed(1)}d` : "—"}
            sub={data.epgFinalMileSample ? `hub → door · ${data.epgFinalMileSample} parcels` : "hub → door"}
          />
        )}
        {data.dhlPickup && (
          <Stat
            label="Picked up"
            value={String(data.dhlPickup.totalParcels)}
            sub={data.dhlPickup.avgWeightLb !== null ? `${data.dhlPickup.avgWeightLb} lb avg` : undefined}
          />
        )}
      </div>
    </div>
  );
}
