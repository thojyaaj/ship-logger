"use client";

import { useScanHeaderState } from "./ScanHeaderState";
import { PadlockIcon } from "./icons";
import SwitchUserButton from "./SwitchUserButton";

// The standalone mobile padlock — every page except the scan page, which
// renders its own copy positioned between the shipment-logs icon and
// Submit instead (see ScanHeaderMobileActions).
export default function MobileSwitchUserButton() {
  const { submit } = useScanHeaderState();
  if (submit) return null;

  return (
    <SwitchUserButton className="md:hidden p-2 flex items-center" label="Switch user / log out">
      <PadlockIcon className="w-4 h-4" />
    </SwitchUserButton>
  );
}
