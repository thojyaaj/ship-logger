/**
 * Generic horizontal bar list — label, a proportional fill bar, and a
 * value on the right. Reused for carrier mix, order match rate, and status
 * breakdown so those three sections share one visual language instead of
 * three bespoke chart types.
 */
export default function BarList({
  title,
  rows,
  emptyMessage,
}: {
  title: string;
  rows: { key: string; label: string; value: number; displayValue: string; pct: number; barClassName: string }[];
  emptyMessage?: string;
}) {
  const hasData = rows.some((r) => r.value > 0);

  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3">
      <span className="tag-label">{title}</span>
      {hasData ? (
        <div className="flex flex-col gap-2.5">
          {rows.map((r) => (
            <div key={r.key} className="flex items-center gap-3">
              <span className="font-condensed text-sm w-32 md:w-40 shrink-0 truncate" title={r.label}>
                {r.label}
              </span>
              <div className="flex-1 h-3 bg-paper-dim min-w-0">
                <div className={`h-full ${r.barClassName}`} style={{ width: `${Math.max(r.pct, r.value > 0 ? 2 : 0)}%` }} />
              </div>
              <span className="data text-xs text-ink-faint w-16 shrink-0 text-right">{r.displayValue}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-ink-faint text-sm font-condensed">{emptyMessage ?? "No data in this window."}</p>
      )}
    </div>
  );
}
