import { carrierLabel, type Carrier } from "@/lib/carrier";
import type { WeekdayVolumePoint } from "@/lib/analytics";
import { carrierBarClass } from "./carrier-colors";

const CARRIERS: Carrier[] = ["epg", "ups", "dhl", "unknown"];
// Monday-first — the warehouse's working week; Sunday's usually empty and
// reads better at the bottom than heading the list.
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * Volume by day of week, stacked by carrier. Total volume alone can't say
 * whether a busy Thursday is EPG batching, a UPS/DHL pickup schedule, or a
 * packing habit — the stack shows which carrier is behind each day, and the
 * per-carrier peak line underneath says it in words. "Avg / day" divides by
 * the number of days that actually shipped, so a weekday that simply
 * occurred more often in the window isn't mistaken for a busier one.
 */
export default function WeekdayCarrierChart({ points }: { points: WeekdayVolumePoint[] }) {
  const ordered = WEEKDAY_ORDER.map((d) => points.find((p) => p.weekday === d)!).filter(Boolean);
  const max = Math.max(1, ...ordered.map((p) => p.count));
  const total = ordered.reduce((sum, p) => sum + p.count, 0);
  const activeCarriers = CARRIERS.filter((c) => ordered.some((p) => p.byCarrier[c] > 0));

  const peaks = activeCarriers.map((carrier) => {
    const carrierTotal = ordered.reduce((sum, p) => sum + p.byCarrier[carrier], 0);
    const peak = ordered.reduce((best, p) => (p.byCarrier[carrier] > best.byCarrier[carrier] ? p : best), ordered[0]);
    return { carrier, peak, carrierTotal, share: carrierTotal > 0 ? (peak.byCarrier[carrier] / carrierTotal) * 100 : 0 };
  });

  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="tag-label">Volume by day of week</span>
        <span className="flex items-center gap-3 text-[0.65rem] text-ink-faint font-condensed">
          {activeCarriers.map((c) => (
            <span key={c} className="flex items-center gap-1">
              <span className={`inline-block w-2.5 h-2.5 ${carrierBarClass(c)}`} />
              {carrierLabel(c)}
            </span>
          ))}
        </span>
      </div>

      {total === 0 ? (
        <p className="text-ink-faint text-sm font-condensed">No data in this window.</p>
      ) : (
        <>
          <div className="flex flex-col gap-2.5">
            {ordered.map((p) => (
              <div key={p.weekday} className="flex items-center gap-3">
                <span className="font-condensed text-sm w-10 shrink-0">{p.label}</span>
                <div className="flex-1 h-3 bg-paper-dim min-w-0 flex">
                  {CARRIERS.map((c) =>
                    p.byCarrier[c] > 0 ? (
                      <div
                        key={c}
                        className={`h-full ${carrierBarClass(c)}`}
                        style={{ width: `${(p.byCarrier[c] / max) * 100}%` }}
                        title={`${carrierLabel(c)}: ${p.byCarrier[c]}`}
                      />
                    ) : null,
                  )}
                </div>
                <span className="data text-xs text-ink-faint w-28 shrink-0 text-right">
                  {p.count}
                  {p.shipDays > 0 && ` · ${(p.count / p.shipDays).toFixed(1)}/day`}
                </span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-0.5 text-xs font-condensed text-ink-faint border-t border-line pt-2">
            {peaks.map(({ carrier, peak, carrierTotal, share }) => (
              <span key={carrier}>
                <strong className="text-ink font-semibold">{carrierLabel(carrier)}</strong> peaks on {peak.label}: {peak.byCarrier[carrier]} of{" "}
                {carrierTotal} parcels ({share.toFixed(0)}%)
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
