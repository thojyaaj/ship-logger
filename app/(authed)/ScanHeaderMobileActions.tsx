"use client";

import Link from "next/link";
import { useScanHeaderState } from "./ScanHeaderState";
import { ListIcon } from "./icons";

// Renders nothing unless ScanClient is mounted (i.e. only on the scan
// page) — CommandPalette hides its own mobile trigger whenever this has
// something to show, so the header swaps search for shipment-logs+Submit
// instead of stacking both.
export default function ScanHeaderMobileActions() {
  const { submit } = useScanHeaderState();
  if (!submit) return null;

  return (
    <div className="md:hidden flex items-center gap-2">
      <Link
        href="/shipments"
        aria-label="Shipment logs"
        title="Shipment logs"
        className="btn border border-paper/30 text-paper/70 hover:text-paper hover:border-paper/60 p-2 flex items-center"
      >
        <ListIcon className="w-4 h-4" />
      </Link>
      <button
        type="button"
        onClick={submit.onSubmit}
        disabled={!submit.canSubmit}
        className="btn px-4 py-2 bg-orange text-paper disabled:opacity-30"
      >
        SUBMIT
      </button>
    </div>
  );
}
