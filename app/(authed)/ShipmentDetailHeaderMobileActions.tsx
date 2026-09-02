"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftIcon } from "./icons";

// A single shipment's detail page only (any route under /shipments/<id>),
// mobile only — swaps in for the search icon in that spot, same pattern as
// ShipmentsHeaderMobileActions but pointing the other direction: back to
// the log this shipment came from, not back to the scan station.
export default function ShipmentDetailHeaderMobileActions() {
  const pathname = usePathname();
  if (!pathname.startsWith("/shipments/")) return null;

  return (
    <Link
      href="/shipments"
      aria-label="Back to shipments log"
      title="Back to shipments log"
      className="md:hidden btn border border-paper/30 text-paper/70 hover:text-paper hover:border-paper/60 p-2 flex items-center"
    >
      <ArrowLeftIcon className="w-4 h-4" />
    </Link>
  );
}
