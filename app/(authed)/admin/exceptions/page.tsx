import Link from "next/link";
import { pageRequireAdmin } from "@/lib/auth";
import { getProblemShipments, type ProblemScan } from "@/lib/shipment-alerts";
import { carrierLabel, statusTone, type Carrier } from "@/lib/carrier";
import { formatCarrierTimestamp } from "@/lib/date";

const CARRIER_ORDER: Carrier[] = ["ups", "dhl", "epg"];

export default async function ExceptionsPage() {
  await pageRequireAdmin();
  const { exceptions, stale } = await getProblemShipments();

  const byCarrier = new Map<Carrier, { exceptions: ProblemScan[]; stale: ProblemScan[] }>();
  for (const carrier of CARRIER_ORDER) byCarrier.set(carrier, { exceptions: [], stale: [] });
  for (const item of exceptions) byCarrier.get(item.carrier)?.exceptions.push(item);
  for (const item of stale) byCarrier.get(item.carrier)?.stale.push(item);

  const total = exceptions.length + stale.length;

  return (
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between flex-wrap gap-2 route-line pb-2">
        <h1 className="font-stencil text-2xl tracking-wide">Exceptions</h1>
        <span className="tag-label !text-ink-faint">{total} open</span>
      </div>

      {total === 0 ? (
        <p className="text-ink-faint">No exceptions or stale parcels right now.</p>
      ) : (
        CARRIER_ORDER.map((carrier) => {
          const group = byCarrier.get(carrier)!;
          if (group.exceptions.length === 0 && group.stale.length === 0) return null;
          return (
            <section key={carrier} className="flex flex-col gap-2">
              <h2 className="tag-label !text-base">{carrierLabel(carrier)}</h2>
              <CarrierTable items={[...group.exceptions, ...group.stale]} />
            </section>
          );
        })
      )}
    </div>
  );
}

function CarrierTable({ items }: { items: ProblemScan[] }) {
  return (
    <div className="overflow-x-auto border border-line">
      <table className="w-full text-sm table-fixed">
        <thead className="bg-paper-dim text-ink-faint">
          <tr>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Tracking</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Order</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Status</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Age</th>
            <th className="text-left px-3 py-2 tag-label !text-ink-faint">Shipment</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id} className="border-t border-line bg-paper-panel">
              <td className="px-3 py-2 data truncate">
                {i.trackingUrl ? (
                  <a href={i.trackingUrl} target="_blank" rel="noreferrer" className="text-blue hover:underline">
                    {i.trackingNumber}
                  </a>
                ) : (
                  i.trackingNumber
                )}
              </td>
              <td className="px-3 py-2 data truncate">{i.orderName ?? <span className="text-ink-faint">—</span>}</td>
              <td className="px-3 py-2 truncate" title={i.statusLabel ?? undefined}>
                {i.statusLabel ? (
                  <span
                    className={`tag-label !text-[0.65rem] px-1.5 py-0.5 inline-block max-w-full truncate ${statusTone(i.statusLabel)}`}
                  >
                    {i.statusLabel}
                  </span>
                ) : (
                  <span className="text-ink-faint">no status yet</span>
                )}
              </td>
              <td className="px-3 py-2 text-ink-faint" title={i.statusAt ? formatCarrierTimestamp(i.statusAt) : undefined}>
                {i.daysSinceUpdate}d
              </td>
              <td className="px-3 py-2 data truncate">
                <Link href={`/shipments/${i.sessionId}`} className="text-blue hover:underline">
                  {i.sessionId.slice(0, 8).toUpperCase()}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
