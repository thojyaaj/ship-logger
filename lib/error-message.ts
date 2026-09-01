/**
 * A dropped request (flaky warehouse wifi, a phone losing signal mid-scan)
 * surfaces to the client as a real `Error` — e.g. React's RSC transport
 * throwing "Minified React error #441; ... Connection closed." — but its
 * message is internal framework text, not something a packer can act on.
 * Business-logic errors we throw ourselves (e.g. "Only a submitted session
 * can be reopened.") should still pass through unchanged.
 */
const TRANSPORT_ERROR_PATTERNS = [
  /Minified React error #44\d/,
  /Connection closed/i,
  /Failed to fetch/i,
  /NetworkError/i,
  /Load failed/i,
  /fetch failed/i,
];

export function isTransportError(err: unknown): boolean {
  return err instanceof Error && TRANSPORT_ERROR_PATTERNS.some((p) => p.test(err.message));
}

export function actionErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  if (isTransportError(err)) {
    return "Connection dropped before that finished — check your signal and try again.";
  }
  return err.message || fallback;
}
