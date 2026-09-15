"use client";

import { useState, useTransition } from "react";
import { saveDisplaySettingsAction } from "./display-settings-actions";
import { actionErrorMessage } from "@/lib/error-message";
import type { DisplaySettings } from "@/lib/display-settings";

/**
 * Both settings live in one row (see lib/display-settings.ts), so each
 * toggle saves the *whole* current settings object, not just the field that
 * changed — sending only the flipped field would silently reset the other
 * one back to whatever the server action's default is. Auto-saves on toggle
 * rather than needing an explicit Save button the way DhlPickupSettingsClient's
 * multi-field form does — reverts the checkbox if the save fails.
 */
export default function DisplaySettingsClient({ initial }: { initial: DisplaySettings }) {
  const [settings, setSettings] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle(key: keyof DisplaySettings) {
    const prev = settings;
    const next = { ...settings, [key]: !settings[key] };
    setSettings(next);
    setError(null);
    startTransition(async () => {
      try {
        await saveDisplaySettingsAction(next);
      } catch (err) {
        setSettings(prev);
        setError(actionErrorMessage(err, "Couldn't save — please retry."));
      }
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="route-line pb-2">
        <h2 className="font-stencil text-xl tracking-wide">Display Settings</h2>
        <p className="tag-label !normal-case !tracking-normal text-ink-faint mt-1">
          Controls how EPG boxes and per-order weight show up on the scan page and a shipment&apos;s detail page.
        </p>
      </div>

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={settings.boxesAsTabs}
          onChange={() => toggle("boxesAsTabs")}
          disabled={isPending}
        />
        Show EPG boxes as tabs (instead of one long stacked list)
      </label>

      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={settings.showOrderWeight}
          onChange={() => toggle("showOrderWeight")}
          disabled={isPending}
        />
        Show each order&apos;s weight (scan page and shipment detail page)
      </label>

      {error && <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}
    </div>
  );
}
