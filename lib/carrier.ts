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
 * Carrier order matters: EPG's prefix is checked first since it's not in any
 * public tracking-number dataset (it's EPG-internal), then UPS/DHL via
 * ts-tracking-number, which also validates the checksum. See PRD §5.1 — with
 * only three carriers and two of them prefixed, a hand-written resolver is
 * simpler and more auditable than a generic multi-carrier matcher.
 */
export function detectCarrier(raw: string): CarrierDetection {
  const trackingNumber = raw.trim().toUpperCase().replace(/\s+/g, "");

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
  const dhlMatch = getTracking(trackingNumber, [dhlData]);
  if (dhlMatch && /^\d{10,11}$/.test(trackingNumber)) {
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
