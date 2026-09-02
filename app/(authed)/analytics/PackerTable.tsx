import type { PackerStat } from "@/lib/analytics";

/** Per-packer scan volume and submission count, ranked by scans — the crew leaderboard. */
export default function PackerTable({ packers }: { packers: PackerStat[] }) {
  const maxScans = Math.max(1, ...packers.map((p) => p.scans));

  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3">
      <span className="tag-label">Crew activity</span>
      {packers.length > 0 ? (
        <div className="flex flex-col border-t border-line">
          {packers.map((p, i) => (
            <div key={p.userId} className="flex items-center gap-3 py-2 border-b border-line">
              <span className="tag-label !text-ink-faint w-5 shrink-0 text-right">{i + 1}</span>
              <span className="font-condensed font-semibold text-sm w-28 md:w-36 shrink-0 truncate">
                {p.name}
                {p.packerCode && <span className="text-ink-faint font-normal"> #{p.packerCode}</span>}
              </span>
              <div className="flex-1 h-3 bg-paper-dim min-w-0">
                <div className="h-full bg-orange" style={{ width: `${Math.max((p.scans / maxScans) * 100, p.scans > 0 ? 2 : 0)}%` }} />
              </div>
              <span className="data text-xs text-ink-faint w-20 shrink-0 text-right">{p.scans} scans</span>
              <span className="data text-xs text-ink-faint w-24 shrink-0 text-right hidden sm:inline">
                {p.shipmentsSubmitted} submitted
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-ink-faint text-sm font-condensed">No activity in this window.</p>
      )}
    </div>
  );
}
