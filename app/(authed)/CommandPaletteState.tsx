"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

type CommandPaletteState = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const CommandPaletteStateContext = createContext<CommandPaletteState | null>(null);

/**
 * Wraps the header (which owns the palette's trigger/modal) and `children`
 * (the page content) so ScanClient's always-focused scan input can know the
 * palette is open and stop stealing focus back from it via onBlur — the
 * same problem it already solves for SubmitDialog/OrderPanel, just for a
 * sibling component instead of a prop it already receives.
 */
export function CommandPaletteStateProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <CommandPaletteStateContext.Provider value={{ open, setOpen }}>{children}</CommandPaletteStateContext.Provider>
  );
}

export function useCommandPaletteState(): CommandPaletteState {
  const ctx = useContext(CommandPaletteStateContext);
  if (!ctx) throw new Error("useCommandPaletteState must be used within CommandPaletteStateProvider");
  return ctx;
}
