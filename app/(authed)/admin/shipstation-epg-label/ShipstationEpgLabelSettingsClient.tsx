"use client";

import { useState, useTransition } from "react";
import type {
  ShipstationEpgLabelSettings,
  ShipstationEpgLabelSettingsInput,
} from "@/lib/shipstation-epg-label";
import { saveShipstationEpgLabelSettingsAction } from "./actions";
import { actionErrorMessage } from "@/lib/error-message";

const EMPTY: ShipstationEpgLabelSettingsInput = {
  enabled: true,
  shipToName: "",
  shipToCompanyName: "",
  shipToAddressLine1: "",
  shipToAddressLine2: "",
  shipToCity: "",
  shipToState: "",
  shipToPostalCode: "",
  shipToCountryCode: "US",
  shipToPhone: "",
  shipFromWarehouseName: "",
  serviceCode: "ups_ground",
  confirmation: "delivery",
  billToParty: "recipient",
  billToAccount: "",
  billToPostalCode: "",
  billToCountryCode: "US",
  packageLengthIn: 20,
  packageWidthIn: 20,
  packageHeightIn: 20,
};

export default function ShipstationEpgLabelSettingsClient({
  initialSettings,
}: {
  initialSettings: ShipstationEpgLabelSettings | null;
}) {
  const [form, setForm] = useState<ShipstationEpgLabelSettingsInput>(
    initialSettings
      ? {
          enabled: initialSettings.enabled,
          shipToName: initialSettings.shipToName,
          shipToCompanyName: initialSettings.shipToCompanyName,
          shipToAddressLine1: initialSettings.shipToAddressLine1,
          shipToAddressLine2: initialSettings.shipToAddressLine2 ?? "",
          shipToCity: initialSettings.shipToCity,
          shipToState: initialSettings.shipToState,
          shipToPostalCode: initialSettings.shipToPostalCode,
          shipToCountryCode: initialSettings.shipToCountryCode,
          shipToPhone: initialSettings.shipToPhone,
          shipFromWarehouseName: initialSettings.shipFromWarehouseName,
          serviceCode: initialSettings.serviceCode,
          confirmation: initialSettings.confirmation,
          billToParty: initialSettings.billToParty,
          billToAccount: initialSettings.billToAccount,
          billToPostalCode: initialSettings.billToPostalCode,
          billToCountryCode: initialSettings.billToCountryCode,
          packageLengthIn: initialSettings.packageLengthIn,
          packageWidthIn: initialSettings.packageWidthIn,
          packageHeightIn: initialSettings.packageHeightIn,
        }
      : EMPTY,
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function set<K extends keyof ShipstationEpgLabelSettingsInput>(
    key: K,
    value: ShipstationEpgLabelSettingsInput[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const result = await saveShipstationEpgLabelSettingsAction(form);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        setSaved(true);
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't save settings — please retry."));
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="route-line pb-2">
        <h2 className="font-stencil text-xl tracking-wide">ShipStation EPG Label Settings</h2>
        <p className="tag-label !normal-case !tracking-normal text-ink-faint mt-1">
          Controls the UPS shipment auto-drafted in ShipStation for every EPG box when a
          shipment is submitted. Only pre-fills a draft — weight still has to be entered and
          the label bought by hand in ShipStation.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-6 corners p-4 bg-paper-panel">
        <Section title="Drafting">
          <label className="flex items-center gap-2 text-sm font-condensed">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set("enabled", e.target.checked)}
              className="w-4 h-4"
            />
            Auto-draft a ShipStation shipment for every EPG box on submit
          </label>
          <p className="text-xs text-ink-faint font-condensed">
            Turn this off to stop new drafts from being created. Boxes already drafted keep
            their ShipStation shipment.
          </p>
        </Section>

        <Section title="Ship-to (the EPG consolidation hub)">
          <div className="flex flex-col gap-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Name / Attn">
                <Input value={form.shipToName} onChange={(v) => set("shipToName", v)} required />
              </Field>
              <Field label="Company name">
                <Input value={form.shipToCompanyName} onChange={(v) => set("shipToCompanyName", v)} />
              </Field>
            </div>
            <Field label="Address line 1">
              <Input value={form.shipToAddressLine1} onChange={(v) => set("shipToAddressLine1", v)} required />
            </Field>
            <Field label="Address line 2 (optional)">
              <Input value={form.shipToAddressLine2 ?? ""} onChange={(v) => set("shipToAddressLine2", v)} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <Field label="City" className="sm:col-span-2">
                <Input value={form.shipToCity} onChange={(v) => set("shipToCity", v)} required />
              </Field>
              <Field label="State">
                <Input
                  value={form.shipToState}
                  onChange={(v) => set("shipToState", v.toUpperCase())}
                  maxLength={2}
                  required
                />
              </Field>
              <Field label="ZIP">
                <Input value={form.shipToPostalCode} onChange={(v) => set("shipToPostalCode", v)} required />
              </Field>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Country code">
                <Input
                  value={form.shipToCountryCode}
                  onChange={(v) => set("shipToCountryCode", v.toUpperCase())}
                  maxLength={2}
                  required
                  className="w-24"
                />
              </Field>
              <Field label="Phone">
                <Input value={form.shipToPhone} onChange={(v) => set("shipToPhone", v)} required />
              </Field>
            </div>
          </div>
        </Section>

        <Section title="Ship from">
          <Field label="ShipStation warehouse name (must match a warehouse already set up in ShipStation)">
            <Input
              value={form.shipFromWarehouseName}
              onChange={(v) => set("shipFromWarehouseName", v)}
              required
            />
          </Field>
        </Section>

        <Section title="Service">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="ShipStation service code">
              <Input value={form.serviceCode} onChange={(v) => set("serviceCode", v)} required />
            </Field>
            <Field label="Confirmation">
              <select
                value={form.confirmation}
                onChange={(e) => set("confirmation", e.target.value)}
                className="data border border-line-strong px-3 py-2 bg-paper font-condensed w-full"
              >
                <option value="none">None</option>
                <option value="delivery">Online (delivery)</option>
                <option value="signature">Signature</option>
                <option value="adult_signature">Adult signature</option>
              </select>
            </Field>
          </div>
        </Section>

        <Section title="Billing (Other Shipping Options)">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Bill to">
              <select
                value={form.billToParty}
                onChange={(e) => set("billToParty", e.target.value as "recipient" | "third_party")}
                className="data border border-line-strong px-3 py-2 bg-paper font-condensed w-full"
              >
                <option value="recipient">Recipient</option>
                <option value="third_party">Third party</option>
              </select>
            </Field>
            <Field label="Account #">
              <Input value={form.billToAccount} onChange={(v) => set("billToAccount", v)} required />
            </Field>
            <Field label="Billing country code">
              <Input
                value={form.billToCountryCode}
                onChange={(v) => set("billToCountryCode", v.toUpperCase())}
                maxLength={2}
                required
                className="w-24"
              />
            </Field>
            <Field label="Billing postal code">
              <Input value={form.billToPostalCode} onChange={(v) => set("billToPostalCode", v)} required />
            </Field>
          </div>
        </Section>

        <Section title="Package dimensions (in)">
          <div className="grid grid-cols-3 gap-3 max-w-sm">
            <Field label="Length">
              <input
                type="number"
                min="1"
                step="1"
                value={form.packageLengthIn}
                onChange={(e) => set("packageLengthIn", Number(e.target.value))}
                required
                className="data border border-line-strong px-3 py-2 bg-paper font-condensed w-full"
              />
            </Field>
            <Field label="Width">
              <input
                type="number"
                min="1"
                step="1"
                value={form.packageWidthIn}
                onChange={(e) => set("packageWidthIn", Number(e.target.value))}
                required
                className="data border border-line-strong px-3 py-2 bg-paper font-condensed w-full"
              />
            </Field>
            <Field label="Height">
              <input
                type="number"
                min="1"
                step="1"
                value={form.packageHeightIn}
                onChange={(e) => set("packageHeightIn", Number(e.target.value))}
                required
                className="data border border-line-strong px-3 py-2 bg-paper font-condensed w-full"
              />
            </Field>
          </div>
        </Section>

        {error && (
          <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>
        )}
        {saved && !error && (
          <p className="border-l-4 border-green bg-green-dim px-3 py-2 text-green-ink text-sm">
            Settings saved.
          </p>
        )}

        <div>
          <button
            type="submit"
            disabled={isPending}
            className="btn px-4 py-2 bg-orange text-paper disabled:opacity-50"
          >
            {isPending ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="tag-label">{title}</span>
      {children}
    </div>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex flex-col gap-1 ${className ?? ""}`}>
      <span className="text-xs text-ink-faint font-condensed">{label}</span>
      {children}
    </label>
  );
}

function Input({
  value,
  onChange,
  required,
  maxLength,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  maxLength?: number;
  className?: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      required={required}
      maxLength={maxLength}
      className={`data border border-line-strong px-3 py-2 bg-paper font-condensed w-full ${className ?? ""}`}
    />
  );
}
