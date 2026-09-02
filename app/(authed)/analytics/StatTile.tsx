/** A single KPI number — label on top, big value, optional sub-line underneath (plain muted text, or a node — e.g. a colored period-over-period delta). */
export default function StatTile({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: React.ReactNode;
  accent?: string;
}) {
  return (
    <div className="bg-paper-panel border border-line p-3 min-w-0 flex flex-col justify-center">
      <div className={`tag-label ${accent ?? ""}`}>{label}</div>
      <div className="data font-semibold text-xl mt-0.5 truncate">{value}</div>
      {sub && <div className="text-xs text-ink-faint font-condensed mt-0.5 truncate">{sub}</div>}
    </div>
  );
}
