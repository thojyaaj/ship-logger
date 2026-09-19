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

/**
 * Overcharges (including double billing) minus undercharges, rounded to
 * cents — positive means the carrier billed more than ShipStation quoted
 * overall, i.e. money lost on this invoice. Only covers verified parcels.
 */
export function netOvercharge(a: { overchargeTotal: number; underchargeTotal: number }): number {
  return Math.round((a.overchargeTotal - a.underchargeTotal) * 100) / 100;
}

export function netLabel(net: number, currency: string): { text: string; tone: "loss" | "gain" | "even" } {
  if (net > 0) return { text: `Net loss ${formatMoney(net, currency)}`, tone: "loss" };
  if (net < 0) return { text: `Net gain ${formatMoney(-net, currency)}`, tone: "gain" };
  return { text: "Break even", tone: "even" };
}
