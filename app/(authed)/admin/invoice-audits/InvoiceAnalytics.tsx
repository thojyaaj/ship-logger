import type { InvoiceAnalytics, OverchargeCause } from "@/lib/invoice-audit/analytics";
import { formatMoney, MARKETPLACE_FEE_LABEL, netLabel } from "@/lib/invoice-audit/format";
import type { ShippingSummary } from "@/lib/invoice-audit/shipping-margin";
import StatTile from "../../analytics/StatTile";
import BarList from "../../analytics/BarList";

const CAUSE_LABEL: Record<OverchargeCause, string> = {
  rate: "Rate above quote",
  heavier: "Billed heavier",
  surcharge: "Surcharges / fees",
  duplicate: "Billed twice",
};

/**
 * Cross-invoice summary above the audit list. Server-rendered — the chart's
 * hover text uses native SVG <title>, same as shipments/VolumeChart.tsx, so
 * there's no client boundary here.
 */
export default function InvoiceAnalyticsSection({ data, shipping }: { data: InvoiceAnalytics; shipping: ShippingSummary }) {
  const { currency } = data;
  const net = netLabel(data.net, currency);
  const overRate = data.verifiedParcels > 0 ? Math.round((data.overchargedParcels / data.verifiedParcels) * 100) : 0;
  const maxCause = Math.max(0, ...data.byCause.map((c) => c.amount));
  const maxCountry = Math.max(0, ...data.byCountry.map((c) => c.amount));

  return (
    <section className="flex flex-col gap-3" aria-labelledby="invoice-analytics-heading">
      <div>
        <h2 id="invoice-analytics-heading" className="tag-label !text-base">
          Across {data.invoiceCount} invoice{data.invoiceCount === 1 ? "" : "s"}
        </h2>
        {data.unverifiedParcels > 0 && (
          <p className="text-xs text-ink-faint mt-1">
            {data.unverifiedParcels} parcel{data.unverifiedParcels === 1 ? "" : "s"} still unverified — not counted below
            until they&apos;re re-checked (nightly, or with the button on each audit).
          </p>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StatTile
          label={net.tone === "gain" ? "Net gain" : net.tone === "loss" ? "Net loss" : "Net"}
          accent={net.tone === "loss" ? "!text-red-ink" : net.tone === "gain" ? "!text-green-ink" : undefined}
          value={formatMoney(Math.abs(data.net), currency)}
          sub={`on ${formatMoney(data.invoicedTotal, currency)} invoiced`}
        />
        <StatTile
          label="Overcharged"
          value={`+${formatMoney(data.overchargeTotal, currency)}`}
          sub={`${data.overchargedParcels} parcels`}
        />
        <StatTile
          label="Undercharged"
          value={`−${formatMoney(data.underchargeTotal, currency)}`}
          sub="EPG billed below quote"
        />
        <StatTile
          label="Overcharge rate"
          value={`${overRate}%`}
          sub={`of ${data.verifiedParcels} verified parcels`}
        />
      </div>

      {shipping.parcelsCounted > 0 && (
        <div className="flex flex-col gap-1">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <StatTile
              label={shipping.profit < 0 ? "Shipping loss" : "Shipping profit"}
              accent={shipping.profit < 0 ? "!text-red-ink" : "!text-green-ink"}
              value={formatMoney(Math.abs(shipping.profit), currency)}
              sub={`${formatMoney(Math.abs(shipping.profit) / shipping.parcelsCounted, currency)} per parcel`}
            />
            <StatTile label="Customers paid for shipping" value={formatMoney(shipping.customerPaid, currency)} />
            <StatTile label={MARKETPLACE_FEE_LABEL} value={`−${formatMoney(shipping.fee, currency)}`} />
            <StatTile label="EPG billed" value={`−${formatMoney(shipping.billed, currency)}`} sub={`${shipping.parcelsCounted} parcels`} />
          </div>
          {shipping.parcelsMissing > 0 && (
            <p className="text-xs text-ink-faint">
              Shipping figures leave out {shipping.parcelsMissing} parcel{shipping.parcelsMissing === 1 ? "" : "s"} with no
              matched order yet.
            </p>
          )}
        </div>
      )}

      <NetPerInvoiceChart points={data.perInvoice} currency={currency} />

      <div className="grid md:grid-cols-2 gap-3">
        <BarList
          title="Where overcharges come from"
          emptyMessage="No overcharges yet."
          rows={data.byCause.map((c) => ({
            key: c.cause,
            // No count in the label: BarList truncates labels at phone width.
            label: CAUSE_LABEL[c.cause],
            value: c.amount,
            displayValue: formatMoney(c.amount, currency),
            pct: maxCause > 0 ? (c.amount / maxCause) * 100 : 0,
            barClassName: "bg-red",
          }))}
        />
        <BarList
          title="Overcharges by destination"
          emptyMessage="No overcharges yet."
          rows={data.byCountry.map((c) => ({
            key: c.country,
            label: titleCase(c.country),
            value: c.amount,
            displayValue: formatMoney(c.amount, currency),
            pct: maxCountry > 0 ? (c.amount / maxCountry) * 100 : 0,
            barClassName: "bg-red",
          }))}
        />
      </div>
    </section>
  );
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

const CHART_HEIGHT = 100;
const BAR_FILL_RATIO = 0.6;

/**
 * Diverging bars around a zero line: a net loss rises above it (red), a net
 * gain drops below (green). Direction carries the meaning as well as color,
 * and the axis is labeled, so it reads without relying on red/green alone.
 * Each bar links to its audit.
 */
function NetPerInvoiceChart({ points, currency }: { points: InvoiceAnalytics["perInvoice"]; currency: string }) {
  if (points.length === 0) return null;

  const maxLoss = Math.max(0, ...points.map((p) => p.net));
  const maxGain = Math.max(0, ...points.map((p) => -p.net));
  const span = maxLoss + maxGain || 1;
  const pad = 4;
  const plot = CHART_HEIGHT - pad * 2;
  const zeroY = pad + (maxLoss / span) * plot;
  const barWidth = 100 / points.length;
  const fillWidth = barWidth * BAR_FILL_RATIO;
  const labelStride = Math.max(1, Math.ceil(points.length / 8));

  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <span className="tag-label">Net per invoice</span>
        <span className="tag-label !text-ink-faint">Above the line = loss · below = gain</span>
      </div>

      <svg
        viewBox={`0 0 100 ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        className="w-full h-36"
        role="img"
        aria-label={`Net loss or gain for the last ${points.length} invoices`}
      >
        {points.map((p, i) => {
          const h = (Math.abs(p.net) / span) * plot;
          const x = i * barWidth + (barWidth - fillWidth) / 2;
          const loss = p.net > 0;
          // One flat string — see VolumeChart.tsx on SVG <title> hydration.
          const tooltip =
            `${p.invoiceNumber}: ${p.net === 0 ? "break even" : `${loss ? "net loss" : "net gain"} ${formatMoney(Math.abs(p.net), currency)}`}` +
            ` (over +${formatMoney(p.overchargeTotal, currency)}, under −${formatMoney(p.underchargeTotal, currency)})`;
          return (
            // Mouse shortcut only: the SVG is one role="img" for screen
            // readers, and the audit list below links every invoice for
            // keyboard users, so these stay out of the tab order.
            <a key={p.id} href={`/admin/invoice-audits/${p.id}`} tabIndex={-1}>
              <title>{tooltip}</title>
              {/* Full-height transparent hit area — a thin or zero bar is still easy to hover/click. */}
              <rect x={i * barWidth} y={0} width={barWidth} height={CHART_HEIGHT} className="fill-transparent" />
              <rect
                x={x}
                y={loss ? zeroY - h : zeroY}
                width={fillWidth}
                height={Math.max(h, 0.8)}
                className={p.net === 0 ? "fill-ink-faint" : loss ? "fill-red" : "fill-green"}
              />
            </a>
          );
        })}
        <line
          x1="0"
          y1={zeroY}
          x2="100"
          y2={zeroY}
          className="stroke-line-strong"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="flex data text-[0.6rem] text-ink-faint">
        {points.map((p, i) => (
          <span key={p.id} style={{ width: `${100 / points.length}%` }} className="text-center truncate">
            {i % labelStride === 0 || i === points.length - 1 ? p.invoiceNumber.replace(/^[A-Z]+/, "") : ""}
          </span>
        ))}
      </div>
    </div>
  );
}
