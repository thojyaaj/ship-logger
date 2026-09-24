import type { Carrier } from "@/lib/carrier";

/** Filled-bar background per carrier — the same brand tokens the courier cards and mix bars use (see globals.css). */
export function carrierBarClass(carrier: Carrier): string {
  switch (carrier) {
    case "epg":
      return "bg-epg";
    case "ups":
      return "bg-ups";
    case "dhl":
      return "bg-dhl";
    default:
      return "bg-ink-faint";
  }
}

/** Line/dot stroke per carrier, for SVG charts. */
export function carrierStrokeClass(carrier: Carrier): string {
  switch (carrier) {
    case "epg":
      return "stroke-epg";
    case "ups":
      return "stroke-ups";
    case "dhl":
      return "stroke-dhl";
    default:
      return "stroke-ink-faint";
  }
}

/** Legend/dot fill per carrier, for SVG charts. */
export function carrierFillClass(carrier: Carrier): string {
  switch (carrier) {
    case "epg":
      return "fill-epg";
    case "ups":
      return "fill-ups";
    case "dhl":
      return "fill-dhl";
    default:
      return "fill-ink-faint";
  }
}
