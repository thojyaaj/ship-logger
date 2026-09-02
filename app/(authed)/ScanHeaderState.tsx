"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type ScanSubmitControls = {
  canSubmit: boolean;
  totalCount: number;
  onSubmit: () => void;
};

type ScanHeaderState = {
  // null except while the scan page is mounted — the header reads this to
  // know whether to show its default mobile actions (search + hamburger) or
  // the scan page's own (shipment-logs link + Submit), same pattern as
  // CommandPaletteState but for a sibling instead of a shared toggle.
  submit: ScanSubmitControls | null;
  setSubmit: (submit: ScanSubmitControls | null) => void;
};

const ScanHeaderStateContext = createContext<ScanHeaderState | null>(null);

export function ScanHeaderStateProvider({ children }: { children: ReactNode }) {
  const [submit, setSubmit] = useState<ScanSubmitControls | null>(null);
  return (
    <ScanHeaderStateContext.Provider value={{ submit, setSubmit }}>{children}</ScanHeaderStateContext.Provider>
  );
}

export function useScanHeaderState(): ScanHeaderState {
  const ctx = useContext(ScanHeaderStateContext);
  if (!ctx) throw new Error("useScanHeaderState must be used within ScanHeaderStateProvider");
  return ctx;
}
