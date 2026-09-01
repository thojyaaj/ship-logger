"use client";

import { useState, useTransition } from "react";
import type { DhlPickupSettings, DhlPickupSettingsInput } from "@/lib/dhl-pickup";
import { saveDhlPickupSettingsAction } from "./actions";
import { actionErrorMessage } from "@/lib/error-message";

const EMPTY: DhlPickupSettingsInput = {
  accountNumber: "",
  contactName: "",
  contactPhone: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
  countryCode: "US",
  readyTime: "09:00",
  closeTime: "17:00",
  avgWeightLbPerParcel: 1,
  specialInstructions: "",
};

export default function DhlPickupSettingsClient({
  initialSettings,
}: {
  initialSettings: DhlPickupSettings | null;
}) {
  const [form, setForm] = useState<DhlPickupSettingsInput>(
    initialSettings
      ? {
          accountNumber: initialSettings.accountNumber,
          contactName: initialSettings.contactName,
          contactPhone: initialSettings.contactPhone,
          addressLine1: initialSettings.addressLine1,
          addressLine2: initialSettings.addressLine2 ?? "",
          city: initialSettings.city,
          state: initialSettings.state,
          postalCode: initialSettings.postalCode,
          countryCode: initialSettings.countryCode,
          readyTime: initialSettings.readyTime,
          closeTime: initialSettings.closeTime,
          avgWeightLbPerParcel: initialSettings.avgWeightLbPerParcel,
          specialInstructions: initialSettings.specialInstructions ?? "",
        }
      : EMPTY,
  );
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function set<K extends keyof DhlPickupSettingsInput>(key: K, value: DhlPickupSettingsInput[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const result = await saveDhlPickupSettingsAction(form);
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
    <div className="flex-1 flex flex-col gap-6 p-4 md:p-6 max-w-2xl mx-auto w-full">
      <div className="route-line pb-2">
        <h1 className="font-stencil text-2xl tracking-wide">DHL Pickup Settings</h1>
        <p className="tag-label !normal-case !tracking-normal text-ink-faint mt-1">
          Controls what gets sent to DHL when a pickup is scheduled from a submitted shipment.
          Doesn&apos;t schedule anything by itself.
        </p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-6 corners p-4 bg-paper-panel">
        <Section title="Account">
          <Field label="DHL account number">
            <Input value={form.accountNumber} onChange={(v) => set("accountNumber", v)} required />
          </Field>
        </Section>

        <Section title="Pickup contact">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Contact name">
              <Input value={form.contactName} onChange={(v) => set("contactName", v)} required />
            </Field>
            <Field label="Contact phone">
              <Input value={form.contactPhone} onChange={(v) => set("contactPhone", v)} required />
            </Field>
          </div>
        </Section>

        <Section title="Pickup address">
          <div className="flex flex-col gap-3">
            <Field label="Address line 1">
              <Input value={form.addressLine1} onChange={(v) => set("addressLine1", v)} required />
            </Field>
            <Field label="Address line 2 (optional)">
              <Input value={form.addressLine2} onChange={(v) => set("addressLine2", v)} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <Field label="City" className="sm:col-span-2">
                <Input value={form.city} onChange={(v) => set("city", v)} required />
              </Field>
              <Field label="State">
                <Input value={form.state} onChange={(v) => set("state", v.toUpperCase())} maxLength={2} required />
              </Field>
              <Field label="ZIP">
                <Input value={form.postalCode} onChange={(v) => set("postalCode", v)} required />
              </Field>
            </div>
            <Field label="Country code">
              <Input
                value={form.countryCode}
                onChange={(v) => set("countryCode", v.toUpperCase())}
                maxLength={2}
                required
                className="w-24"
              />
            </Field>
          </div>
        </Section>

        <Section title="Pickup window">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Ready time (warehouse-local)">
              <input
                type="time"
                value={form.readyTime}
                onChange={(e) => set("readyTime", e.target.value)}
                required
                className="data border border-line-strong px-3 py-2 bg-paper font-condensed w-full"
              />
            </Field>
            <Field label="Close time (warehouse-local)">
              <input
                type="time"
                value={form.closeTime}
                onChange={(e) => set("closeTime", e.target.value)}
                required
                className="data border border-line-strong px-3 py-2 bg-paper font-condensed w-full"
              />
            </Field>
          </div>
        </Section>

        <Section title="Weight estimate">
          <Field label="Average weight per parcel (lb) — packages aren't individually weighed">
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={form.avgWeightLbPerParcel}
              onChange={(e) => set("avgWeightLbPerParcel", Number(e.target.value))}
              required
              className="data border border-line-strong px-3 py-2 bg-paper font-condensed w-32"
            />
          </Field>
        </Section>

        <Section title="Special instructions (optional)">
          <textarea
            value={form.specialInstructions}
            onChange={(e) => set("specialInstructions", e.target.value)}
            rows={3}
            className="border border-line-strong px-3 py-2 bg-paper font-condensed w-full"
            placeholder="e.g. use the loading dock on the north side"
          />
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
