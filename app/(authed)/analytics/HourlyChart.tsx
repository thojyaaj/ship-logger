import type { HourlyActivityPoint } from "@/lib/analytics";

// Server-rendered SVG, same pattern as shipments/VolumeChart — no charting
// library, native <title> for hover tooltips, no client JS needed.
const CHART_HEIGHT = 60;
const BAR_FILL_RATIO = 0.7;

function formatHour(hour: number): string {
  if (hour === 0) return "12a";
  if (hour === 12) return "12p";
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
}

/** 24-hour scan-activity histogram, warehouse-local — when packers are actually on the belt, not just how much they ship. */
export default function HourlyChart({ points }: { points: HourlyActivityPoint[] }) {
  const max = Math.max(1, ...points.map((p) => p.count));
  const total = points.reduce((sum, p) => sum + p.count, 0);
  const barWidth = 100 / points.length;
  const barFillWidth = barWidth * BAR_FILL_RATIO;
  const barOffset = (barWidth - barFillWidth) / 2;
  const peakHour = points.reduce((best, p) => (p.count > best.count ? p : best), points[0]);

  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="tag-label">Scans by hour of day</span>
        <span className="tag-label !text-ink">
          {total > 0 ? `peak ${formatHour(peakHour.hour)}–${formatHour((peakHour.hour + 1) % 24)}` : "no data"}
        </span>
      </div>

      <svg viewBox={`0 0 100 ${CHART_HEIGHT}`} preserveAspectRatio="none" className="w-full h-16">
        <line x1="0" y1={CHART_HEIGHT - 1} x2="100" y2={CHART_HEIGHT - 1} className="stroke-line" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
        {points.map((p) => {
          const x = p.hour * barWidth + barOffset;
          const h = (p.count / max) * (CHART_HEIGHT - 6);
          const y = CHART_HEIGHT - 1 - h;
          return (
            <g key={p.hour}>
              <title>{`${formatHour(p.hour)}–${formatHour((p.hour + 1) % 24)}: ${p.count} scan${p.count === 1 ? "" : "s"}`}</title>
              {p.count > 0 ? (
                <rect x={x} y={y} width={barFillWidth} height={h} className="fill-blue" />
              ) : (
                <rect x={x} y={CHART_HEIGHT - 2} width={barFillWidth} height={1} className="fill-line" />
              )}
            </g>
          );
        })}
      </svg>

      <div className="flex data text-[0.6rem] text-ink-faint">
        {points.map((p) => (
          <span key={p.hour} style={{ width: `${barWidth}%` }} className="text-center truncate">
            {p.hour % 3 === 0 ? formatHour(p.hour) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
