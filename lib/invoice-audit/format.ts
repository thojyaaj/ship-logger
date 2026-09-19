import type { LineStatus } from "./classify";

export function formatMoney(amount: number | null, currency: string | null): string {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency ?? "USD" }).format(amount);
  } catch {
    return `${amount.toFixed(2)}${currency ? ` ${currency}` : ""}`;
  }
}

export const STATUS_LABEL: Record<LineStatus, string> = {
  over: "Overcharged",
  duplicate: "Billed twice",
  under: "Undercharged",
  match: "Matches quote",
  no_quote: "No quote",
  currency_mismatch: "Currency differs",
  not_found: "Not found",
};
