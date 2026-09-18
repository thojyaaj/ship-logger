import Link from "next/link";
import { carrierLabel } from "@/lib/carrier";
import type { DataGaps, DataGapKind } from "@/lib/analytics";

const GAP_LABEL: Record<DataGapKind, string> = {
  "no-order-match": "No order match",
  "no-charge": "No shipping charge on order",
  "no-cost": "No label cost",
};

function money(amount: number, currency: string | null): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
  } catch {
    return amount.toFixed(2);
  }
}

function GapTile({ label, count, sub, active }: { label: string; count: number; sub: string; active: boolean }) {
  return (
    <div className="bg-paper-panel border border-line p-3 min-w-0">
      <div className={`tag-label ${active ? "!text-amber-ink" : ""}`}>{label}</div>
      <div className={`data font-semibold text-xl mt-0.5 ${active ? "!text-amber-ink" : "!text-ink-faint"}`}>{count}</div>
      <div className="text-xs text-ink-faint font-condensed mt-0.5">{sub}</div>
    </div>
  );
}

/**
 * The parcels every cost/charge/margin figure on this page silently leaves
 * out, and why. Three separate failure modes with separate fixes — no order
 * match, matched order with no shipping charge, charge with no label cost —
 * so they're counted separately rather than folded into one "missing data"
 * number. Renders a quiet all-clear line when there's nothing missing, so
 * "no alert" can be told apart from "alert not built".
 */
export default function DataGapsPanel({ gaps, currency }: { gaps: DataGaps; currency: string | null }) {
  if (gaps.totalParcels === 0) return null;

  if (gaps.marginExcluded === 0 && gaps.unmatched === 0) {
    return (
      <div className="border-l-4 border-green bg-green-dim px-3 py-2 text-green-ink text-sm font-condensed">
        <strong className="font-semibold">Margin covers every parcel</strong> — all {gaps.totalParcels} have an order match, a label cost and a
        customer charge.
      </div>
    );
  }

  const coveredPct = (gaps.marginCovered / gaps.totalParcels) * 100;
  const gapCarriers = gaps.byCarrier.filter((c) => c.unmatched + c.missingCharge + c.chargedNoCost > 0);

  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3 border-l-4 border-amber">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <span className="tag-label !text-amber-ink">Hidden cost &amp; margin exposure</span>
        <span className="data text-xs text-ink-faint">
          margin figures cover {gaps.marginCovered} of {gaps.totalParcels} parcels ({coveredPct.toFixed(0)}%)
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <GapTile
          label="No order match"
          count={gaps.unmatched}
          active={gaps.unmatched > 0}
          sub={gaps.unmatched > 0 ? "no Shopify order found, so no charge to compare" : "every scan matched an order"}
        />
        <GapTile
          label="Cost paid, no charge data"
          count={gaps.missingCharge}
          active={gaps.missingCharge > 0}
          sub={gaps.missingCharge > 0 ? `${money(gaps.costExposure, currency)} label cost with nothing to compare` : "none"}
        />
        <GapTile
          label="Charged, no cost data"
          count={gaps.chargedNoCost}
          active={gaps.chargedNoCost > 0}
          sub={
            gaps.chargedNoCost > 0
              ? `${money(gaps.chargedUncosted, currency)} charged — a loss here would be invisible`
              : "none"
          }
        />
      </div>

      {gapCarriers.length > 0 && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs font-condensed text-ink-faint">
          {gapCarriers.map((c) => (
            <span key={c.carrier}>
              <strong className="text-ink font-semibold">{carrierLabel(c.carrier)}</strong> · {c.unmatched} unmatched · {c.missingCharge} no charge
              · {c.chargedNoCost} no cost
            </span>
          ))}
        </div>
      )}

      {gaps.examples.length > 0 && (
        <div className="flex flex-col">
          <span className="tag-label !text-[0.6rem] mb-1">
            Most recent affected parcels{gaps.marginExcluded > gaps.examples.length ? ` (showing ${gaps.examples.length} of ${gaps.marginExcluded})` : ""}
          </span>
          <ul className="flex flex-col divide-y divide-line">
            {gaps.examples.map((e) => (
              <li key={e.scanId}>
                <Link
                  href={`/shipments/${e.sessionId}`}
                  className="flex items-center gap-3 py-1.5 text-sm hover:bg-paper-dim px-1 min-w-0"
                >
                  <span className="tag-label !text-[0.6rem] w-10 shrink-0">{carrierLabel(e.carrier)}</span>
                  <span className="data text-xs truncate flex-1 min-w-0">{e.trackingNumber}</span>
                  <span className="text-xs text-ink-faint font-condensed shrink-0">{e.shipDate}</span>
                  <span className="text-xs text-amber-ink font-condensed shrink-0 text-right">
                    {e.gaps.map((g) => GAP_LABEL[g]).join(" · ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
