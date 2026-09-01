import { getTracking, ups as upsData, dhl as dhlData } from "ts-tracking-number";

export type Carrier = "epg" | "ups" | "dhl" | "unknown";

export type CarrierDetection = {
  carrier: Carrier;
  /** Normalized (trimmed, uppercased) tracking number to store/compare. */
  trackingNumber: string;
  /** false only when the format is recognized but the checksum fails. */
  checksumValid: boolean;
  /** Human-readable reason, set when checksumValid is false or carrier is unknown. */
  reason?: string;
};

const EPG_PATTERN = /^EPG\d{15}$/;

/**
 * A run of one repeated digit ("0000000000") satisfies DHL's mod-7 check digit
 * often enough to be accepted silently, but is never a real serial — it's a
 * test barcode, a placeholder label, or a misfired scanner. Cheap to exclude,
 * and it cannot reject a genuine parcel.
 */
function isDegenerateSerial(value: string): boolean {
  return /^(\d)\1+$/.test(value);
}

/**
 * The one normalization every tracking number goes through before it's
 * compared, stored, or looked up anywhere in the app — scan-time detection,
 * the Shopify order index (webhook + backfill), duplicate checks. Two
 * different call sites normalizing differently (or one of them not at all)
 * is exactly how a real fulfillment silently stops matching its scan.
 */
export function normalizeTrackingNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, "");
}

/**
 * Carrier order matters: EPG's prefix is checked first since it's not in any
 * public tracking-number dataset (it's EPG-internal), then UPS/DHL via
 * ts-tracking-number, which also validates the checksum. See PRD §5.1 — with
 * only three carriers and two of them prefixed, a hand-written resolver is
 * simpler and more auditable than a generic multi-carrier matcher.
 */
export function detectCarrier(raw: string): CarrierDetection {
  const trackingNumber = normalizeTrackingNumber(raw);

  if (EPG_PATTERN.test(trackingNumber)) {
    return { carrier: "epg", trackingNumber, checksumValid: true };
  }

  const upsMatch = getTracking(trackingNumber, [upsData]);
  if (upsMatch) {
    return { carrier: "ups", trackingNumber, checksumValid: true };
  }
  if (/^1Z[0-9A-Z]{16}$/.test(trackingNumber)) {
    // Right shape for UPS, but the checksum used by ts-tracking-number failed —
    // almost always a scanner misread of one character.
    return {
      carrier: "ups",
      trackingNumber,
      checksumValid: false,
      reason: "UPS format matched but the check digit failed — likely a misread.",
    };
  }

  // DHL Express serials run 10-11 digits (jkeen/tracking_number_data); don't
  // hard-code 10 or valid numbers like "73891051146" get rejected outright.
  //
  // Caveat worth knowing: DHL's check digit is mod-7 over 10 digits, so it only
  // rejects ~9 of every 10 wrong numbers. Measured against this library, 10.1%
  // of random 10-digit strings are accepted as valid DHL with no warning at all
  // — e.g. "4085551234", a phone number. That is inherent to the format, not
  // something a stricter regex can fix, so scanning a stray 10-digit barcode
  // (an order number, a UPC) can still book a phantom parcel. Undo removes it.
  const dhlMatch = getTracking(trackingNumber, [dhlData]);
  if (dhlMatch && /^\d{10,11}$/.test(trackingNumber) && !isDegenerateSerial(trackingNumber)) {
    return { carrier: "dhl", trackingNumber, checksumValid: true };
  }
  if (/^\d{10,11}$/.test(trackingNumber)) {
    return {
      carrier: "dhl",
      trackingNumber,
      checksumValid: false,
      reason: "DHL format matched but the check digit failed — likely a misread.",
    };
  }

  return {
    carrier: "unknown",
    trackingNumber,
    checksumValid: false,
    reason: "Not a recognized EPG/UPS/DHL tracking number.",
  };
}

export function carrierLabel(carrier: Carrier): string {
  switch (carrier) {
    case "epg":
      return "ePost Global";
    case "ups":
      return "UPS";
    case "dhl":
      return "DHL";
    default:
      return "Unknown";
  }
}

export function trackingUrl(carrier: Carrier, trackingNumber: string): string | null {
  switch (carrier) {
    case "epg":
      return `https://epgtrack.com/${trackingNumber}`;
    case "ups":
      return `https://www.ups.com/track?tracknum=${trackingNumber}`;
    case "dhl":
      return `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`;
    default:
      return null;
  }
}

/** Tailwind classes for a status badge, shared by the shipments list and detail pages. */
export function statusTone(label: string | null): string {
  if (!label) return "bg-paper-dim !text-ink-faint";
  if (/delivered/i.test(label)) return "bg-green-dim !text-green-ink";
  if (/exception|return/i.test(label)) return "bg-red-dim !text-red-ink";
  return "bg-blue-dim !text-blue-ink";
}
