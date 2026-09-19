/**
 * The per-parcel verdict rules for a carrier invoice audit — pure, so the
 * thresholds live in one place and can be reasoned about without a DB.
 */

/** Differences within this (in invoice currency) are rounding, not a billing error. */
export const PRICE_TOLERANCE = 0.05;

/**
 * Billed weight only counts as "heavier than the label" past this margin —
 * scales and ShipStation's stored weight routinely disagree by an ounce or
 * two, which isn't worth an admin's attention.
 */
function weightMarginLb(quotedWeightLb: number): number {
  return Math.max(0.1, quotedWeightLb * 0.1);
}

export type LineStatus = "over" | "under" | "match" | "no_quote" | "not_found" | "currency_mismatch" | "duplicate";

export type Quote = {
  /** Something (a scan, or a ShipStation label) was found for this parcel at all. */
  found: boolean;
  amount: number | null;
  currency: string | null;
  weightLb: number | null;
};

export type Verdict = { status: LineStatus; difference: number | null; billedHeavier: boolean };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function classifyLine(input: {
  invoicedAmount: number;
  invoicedCurrency: string;
  billedWeightLb: number | null;
  quote: Quote;
  duplicate: boolean;
}): Verdict {
  const { invoicedAmount, invoicedCurrency, billedWeightLb, quote, duplicate } = input;
  const billedHeavier =
    billedWeightLb !== null &&
    quote.weightLb !== null &&
    quote.weightLb > 0 &&
    billedWeightLb > quote.weightLb + weightMarginLb(quote.weightLb);

  // A parcel billed twice is wrong in full, whatever the quote said.
  if (duplicate) return { status: "duplicate", difference: round2(invoicedAmount), billedHeavier };
  if (!quote.found) return { status: "not_found", difference: null, billedHeavier };
  if (quote.amount === null) return { status: "no_quote", difference: null, billedHeavier };
  if ((quote.currency ?? invoicedCurrency).toUpperCase() !== invoicedCurrency.toUpperCase()) {
    return { status: "currency_mismatch", difference: null, billedHeavier };
  }

  const difference = round2(invoicedAmount - quote.amount);
  if (difference > PRICE_TOLERANCE) return { status: "over", difference, billedHeavier };
  if (difference < -PRICE_TOLERANCE) return { status: "under", difference, billedHeavier };
  return { status: "match", difference, billedHeavier };
}
