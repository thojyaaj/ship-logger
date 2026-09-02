import type { DailyVolumePoint } from "@/lib/shiplog";
import type { Carrier } from "@/lib/carrier";

// Purely presentational, server-rendered SVG — no client JS needed. Native
// <title> elements give hover tooltips without a "use client" boundary.
const CHART_HEIGHT = 100;
const BAR_FILL_RATIO = 0.7; // leaves a visible gap between bars

const SEGMENT_ORDER: Carrier[] = ["epg", "ups", "dhl", "unknown"];
const SEGMENT_FILL: Record<Carrier, string> = {
  epg: "fill-orange",
  ups: "fill-blue",
  dhl: "fill-amber",
  unknown: "fill-ink-faint",
};

export default function VolumeChart({ points }: { points: DailyVolumePoint[] }) {
  if (points.length === 0) return null;

  const max = Math.max(1, ...points.map((p) => p.total));
  const totalShipped = points.reduce((sum, p) => sum + p.total, 0);
  const barWidth = 100 / points.length;
  const barFillWidth = barWidth * BAR_FILL_RATIO;
  const barOffset = (barWidth - barFillWidth) / 2;
  const plotHeight = CHART_HEIGHT - 14; // headroom above the tallest bar

  // Skip labels so dates don't collide at typical container widths — always
  // show the first and last day, plus evenly spaced ones between.
  const labelStride = Math.max(1, Math.ceil(points.length / 8));
  // Mobile needs a much sparser set: its label row can't reuse the desktop
  // row's per-bar percentage width at all. At 30 points that's ~3.3% of a
  // ~340px content area — about 11px per slot — nowhere near enough for a
  // 5-character "MM-DD" string regardless of how many neighboring slots are
  // left empty, since every visible label is still boxed into that same
  // narrow per-bar width. (Reported live as "I just see a bunch of
  // zeroes" — the clipped-to-a-sliver remainder of dates that mostly start
  // with a leading 0.) Mobile gets its own row instead: a handful of
  // labels sized to their own text, spread across the full width with
  // justify-between rather than pinned to individual bars.
  const mobileLabelStride = Math.max(1, Math.ceil(points.length / 4));
  const mobileLabelPoints = points.filter((_, i) => i % mobileLabelStride === 0 || i === points.length - 1);

  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="tag-label">
          Packages Shipped — {points[0].shipDate} to {points[points.length - 1].shipDate}
        </span>
        <div className="flex items-center gap-3">
          <Legend swatchClass="bg-orange" label="EPG" />
          <Legend swatchClass="bg-blue" label="UPS" />
          <Legend swatchClass="bg-amber" label="DHL" />
          <span className="tag-label !text-ink">{totalShipped} total</span>
        </div>
      </div>

      <svg viewBox={`0 0 100 ${CHART_HEIGHT}`} preserveAspectRatio="none" className="w-full h-28">
        <line
          x1="0"
          y1={CHART_HEIGHT - 1}
          x2="100"
          y2={CHART_HEIGHT - 1}
          className="stroke-line"
          strokeWidth="0.5"
          vectorEffect="non-scaling-stroke"
        />
        {points.map((p, i) => {
          const x = i * barWidth + barOffset;
          let yCursor = CHART_HEIGHT - 1;
          const segments = SEGMENT_ORDER.filter((c) => p[c] > 0).map((carrier) => {
            const h = (p[carrier] / max) * plotHeight;
            const y = yCursor - h;
            yCursor = y;
            return { carrier, y, h };
          });

          // Built as one flat string, not multi-line JSX, so SVG <title>'s
          // text content is a single text node — mixed expression/whitespace
          // children here previously produced a server/client hydration
          // mismatch (React splits multi-line JSX text differently for
          // foreign-namespace elements like SVG <title>).
          const tooltip =
            `${p.shipDate}: ${p.total} package${p.total === 1 ? "" : "s"}` +
            (p.total > 0 ? ` (EPG ${p.epg} · UPS ${p.ups} · DHL ${p.dhl})` : "");

          return (
            <g key={p.shipDate}>
              <title>{tooltip}</title>
              {segments.length > 0 ? (
                segments.map((seg) => (
                  <rect key={seg.carrier} x={x} y={seg.y} width={barFillWidth} height={seg.h} className={SEGMENT_FILL[seg.carrier]} />
                ))
              ) : (
                <rect x={x} y={CHART_HEIGHT - 2} width={barFillWidth} height={1} className="fill-line" />
              )}
            </g>
          );
        })}
      </svg>

      {/* Mobile: a handful of full, un-truncated labels spread across the
          row — not pinned under their exact bar, just roughly representing
          "start … end" the way any compact trend chart label row does. */}
      <div className="flex md:hidden justify-between data text-[0.6rem] text-ink-faint">
        {mobileLabelPoints.map((p) => (
          <span key={p.shipDate}>{p.shipDate.slice(5)}</span>
        ))}
      </div>
      {/* Desktop: unchanged — one label slot per bar, aligned under it. */}
      <div className="hidden md:flex data text-[0.6rem] text-ink-faint">
        {points.map((p, i) => (
          <span key={p.shipDate} style={{ width: `${barWidth}%` }} className="text-center truncate">
            {i % labelStride === 0 || i === points.length - 1 ? p.shipDate.slice(5) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function Legend({ swatchClass, label }: { swatchClass: string; label: string }) {
  return (
    <span className="flex items-center gap-1 tag-label">
      <span className={`inline-block w-2 h-2 ${swatchClass}`} />
      {label}
    </span>
  );
}
