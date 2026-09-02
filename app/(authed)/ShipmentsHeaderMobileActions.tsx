"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftIcon } from "./icons";

// Shipments log only, mobile only — swaps in for the search icon in that
// one spot (see CommandPalette's own pathname check) since jumping back to
// the scan station is the far more common thing to want from this page
// than a keyword search.
export default function ShipmentsHeaderMobileActions() {
  const pathname = usePathname();
  if (pathname !== "/shipments") return null;

  return (
    <Link
      href="/"
      aria-label="Back to scan"
      title="Back to scan"
      className="md:hidden btn border border-paper/30 text-paper/70 hover:text-paper hover:border-paper/60 p-2 flex items-center"
    >
      <ArrowLeftIcon className="w-4 h-4" />
    </Link>
  );
}
