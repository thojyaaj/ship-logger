"use client";

import { useState, useTransition } from "react";
import { saveDisplaySettingsAction } from "./display-settings-actions";
import { actionErrorMessage } from "@/lib/error-message";

/**
 * A single boolean setting, so this auto-saves on toggle rather than
 * needing an explicit Save button the way DhlPickupSettingsClient's
 * multi-field form does — reverts the checkbox if the save fails.
 */
export default function DisplaySettingsClient({ initialBoxesAsTabs }: { initialBoxesAsTabs: boolean }) {
  const [boxesAsTabs, setBoxesAsTabs] = useState(initialBoxesAsTabs);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle() {
    const next = !boxesAsTabs;
    setBoxesAsTabs(next);
    setError(null);
    startTransition(async () => {
      try {
        await saveDisplaySettingsAction(next);
      } catch (err) {
        setBoxesAsTabs(!next);
        setError(actionErrorMessage(err, "Couldn't save — please retry."));
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="route-line pb-2">
        <h2 className="font-stencil text-xl tracking-wide">Display Settings</h2>
        <p className="tag-label !normal-case !tracking-normal text-ink-faint mt-1">
          Controls how EPG boxes are shown on a shipment&apos;s detail page.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input type="checkbox" checked={boxesAsTabs} onChange={toggle} disabled={isPending} />
        Show EPG boxes as tabs (instead of one long stacked list)
      </label>

      {error && <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}
    </div>
  );
}
