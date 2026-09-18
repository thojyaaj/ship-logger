import { carrierLabel } from "@/lib/carrier";
import { MIN_TREND_SAMPLE, type CarrierMarginTrend } from "@/lib/analytics-derive";
import { carrierFillClass, carrierStrokeClass } from "./carrier-colors";

const CHART_W = 600;
const CHART_H = 110;
const PAD_X = 28;
const PAD_Y = 10;

function money(amount: number | null): string {
  return amount === null ? "—" : `$${amount.toFixed(2)}`;
}

function pct(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)}%`;
}

/** Signed delta with a color: `goodWhenUp` flips which direction reads green (margin up is good; cost up is bad). */
function Delta({ value, unit, goodWhenUp, insufficient }: { value: number | null; unit: string; goodWhenUp: boolean; insufficient: boolean }) {
  if (value === null) {
    return <span className="text-ink-faint">{insufficient ? "too few parcels" : "—"}</span>;
  }
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return <span className="text-ink-faint">flat</span>;
  const good = goodWhenUp ? rounded > 0 : rounded < 0;
  return (
    <span className={good ? "text-green-ink" : "text-red-ink"}>
      {rounded > 0 ? "+" : ""}
      {rounded.toFixed(1)}
      {unit}
    </span>
  );
}

/**
 * Per-carrier margin over time. The table answers "is it trending down"
 * (margin and cost-per-parcel vs. the previous equal-length window — a fall
 * in margin with a rise in cost-per-parcel and flat charges is rate creep);
 * the weekly lines show whether that's a steady slide or a one-week blip.
 * Hollow dots are weeks with fewer than MIN_TREND_SAMPLE parcels — plotted,
 * but not to be trusted on their own.
 */
export default function MarginTrend({ trends, windowDays }: { trends: CarrierMarginTrend[]; windowDays: number }) {
  const withWeeks = trends.filter((t) => t.weekly.some((w) => w.marginPct !== null));
  const showChart = withWeeks.length > 0 && withWeeks.some((t) => t.weekly.length >= 2);

  const values = withWeeks.flatMap((t) => t.weekly.map((w) => w.marginPct).filter((v): v is number => v !== null));
  // One shared y-axis across carriers, so a thin-margin carrier reads as
  // thin next to a fat-margin one instead of each line filling the box.
  const lo = Math.min(0, ...values);
  const hi = Math.max(10, ...values);
  const span = hi - lo || 1;
  const weekCount = withWeeks[0]?.weekly.length ?? 0;
  const x = (i: number) => PAD_X + (weekCount > 1 ? (i / (weekCount - 1)) * (CHART_W - PAD_X - 8) : 0);
  const y = (v: number) => PAD_Y + (1 - (v - lo) / span) * (CHART_H - 2 * PAD_Y);

  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="tag-label">Margin trend by carrier</span>
        <span className="tag-label !text-ink-faint">last {windowDays}d vs the {windowDays}d before</span>
      </div>

      {trends.length === 0 ? (
        <p className="text-ink-faint text-sm font-condensed">No parcels with both a label cost and a customer charge in the last {windowDays * 2} days.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm font-condensed min-w-[34rem]">
              <thead>
                <tr className="text-left">
                  <th className="tag-label !text-[0.6rem] font-normal pb-1">Carrier</th>
                  <th className="tag-label !text-[0.6rem] font-normal pb-1 text-right">Margin</th>
                  <th className="tag-label !text-[0.6rem] font-normal pb-1 text-right">vs prev</th>
                  <th className="tag-label !text-[0.6rem] font-normal pb-1 text-right">Cost / parcel</th>
                  <th className="tag-label !text-[0.6rem] font-normal pb-1 text-right">vs prev</th>
                  <th className="tag-label !text-[0.6rem] font-normal pb-1 text-right">Charged / parcel</th>
                  <th className="tag-label !text-[0.6rem] font-normal pb-1 text-right">vs prev</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {trends.map((t) => {
                  const insufficient = t.current.count < MIN_TREND_SAMPLE || t.previous.count < MIN_TREND_SAMPLE;
                  return (
                    <tr key={t.carrier}>
                      <td className="py-1.5">
                        <span className="font-semibold">{carrierLabel(t.carrier)}</span>
                        <span className="text-xs text-ink-faint"> · {t.current.count} / {t.previous.count} parcels</span>
                      </td>
                      <td className="data py-1.5 text-right">{pct(t.current.marginPct)}</td>
                      <td className="data py-1.5 text-right">
                        <Delta value={t.marginPctChange} unit=" pts" goodWhenUp insufficient={insufficient} />
                      </td>
                      <td className="data py-1.5 text-right">{money(t.current.avgCost)}</td>
                      <td className="data py-1.5 text-right">
                        <Delta value={t.avgCostPctChange} unit="%" goodWhenUp={false} insufficient={insufficient} />
                      </td>
                      <td className="data py-1.5 text-right">{money(t.current.avgCharged)}</td>
                      <td className="data py-1.5 text-right">
                        <Delta value={t.avgChargedPctChange} unit="%" goodWhenUp insufficient={insufficient} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {showChart ? (
            <div className="flex flex-col gap-1">
              <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full h-auto" role="img" aria-label="Weekly margin percentage by carrier">
                {[lo, (lo + hi) / 2, hi].map((tick) => (
                  <g key={tick}>
                    <line x1={PAD_X} x2={CHART_W - 8} y1={y(tick)} y2={y(tick)} className="stroke-line" strokeWidth="1" strokeDasharray="3 3" />
                    <text x={PAD_X - 4} y={y(tick) + 3} textAnchor="end" className="fill-ink-faint" fontSize="9">
                      {Math.round(tick)}%
                    </text>
                  </g>
                ))}
                {withWeeks.map((t) => {
                  // A week with no margin data breaks the line rather than
                  // being bridged, so a gap in coverage isn't drawn as a trend.
                  const segments: { i: number; v: number }[][] = [];
                  let run: { i: number; v: number }[] = [];
                  t.weekly.forEach((w, i) => {
                    if (w.marginPct === null) {
                      if (run.length) segments.push(run);
                      run = [];
                    } else {
                      run.push({ i, v: w.marginPct });
                    }
                  });
                  if (run.length) segments.push(run);
                  return (
                    <g key={t.carrier}>
                      {segments.map((seg, si) =>
                        seg.length > 1 ? (
                          <polyline
                            key={si}
                            points={seg.map((p) => `${x(p.i)},${y(p.v)}`).join(" ")}
                            fill="none"
                            strokeWidth="2"
                            className={carrierStrokeClass(t.carrier)}
                          />
                        ) : null,
                      )}
                      {t.weekly.map((w, i) =>
                        w.marginPct === null ? null : (
                          <circle
                            key={i}
                            cx={x(i)}
                            cy={y(w.marginPct)}
                            r="3.5"
                            strokeWidth="2"
                            className={`${carrierStrokeClass(t.carrier)} ${w.count >= MIN_TREND_SAMPLE ? carrierFillClass(t.carrier) : "fill-paper-panel"}`}
                          >
                            <title>{`${carrierLabel(t.carrier)}, ${w.weeksAgo === 0 ? "most recent 7 days" : `${w.weeksAgo * 7 + 1}–${w.weeksAgo * 7 + 7} days ago`}: ${w.marginPct.toFixed(1)}% margin, ${money(w.avgCost)} avg cost, ${w.count} parcel${w.count === 1 ? "" : "s"}`}</title>
                          </circle>
                        ),
                      )}
                    </g>
                  );
                })}
              </svg>
              <div className="flex items-center justify-between text-[0.65rem] text-ink-faint font-condensed" style={{ paddingLeft: `${(PAD_X / CHART_W) * 100}%` }}>
                <span>{weekCount} weeks ago</span>
                <span className="flex items-center gap-3">
                  {withWeeks.map((t) => (
                    <span key={t.carrier} className="flex items-center gap-1">
                      <svg width="10" height="10" aria-hidden="true">
                        <circle cx="5" cy="5" r="4" strokeWidth="2" className={`${carrierStrokeClass(t.carrier)} ${carrierFillClass(t.carrier)}`} />
                      </svg>
                      {carrierLabel(t.carrier)}
                    </span>
                  ))}
                  <span>○ &lt; {MIN_TREND_SAMPLE} parcels</span>
                </span>
                <span>this week</span>
              </div>
            </div>
          ) : (
            <p className="text-ink-faint text-xs font-condensed">Weekly trend needs a 30d or 90d window.</p>
          )}
        </>
      )}
    </div>
  );
}
