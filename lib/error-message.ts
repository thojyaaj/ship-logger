/**
 * A dropped request (flaky warehouse wifi, a phone losing signal mid-scan)
 * surfaces to the client as a real `Error` — e.g. React's RSC transport
 * throwing "Connection closed." (minified in production as React error
 * #412) when the flight stream closes with chunks still pending — but its
 * message is internal framework text, not something a packer can act on.
 *
 * React error #441, by contrast, is what *every* plain `Error` thrown by a
 * Server Action becomes on the client in production: Next.js deliberately
 * strips the real message before it crosses the wire (only a `digest`
 * survives) so server internals aren't leaked, and React's Flight client
 * reconstructs that redacted placeholder as error #441 — the same code
 * regardless of whether the original error was "Cannot delete the open
 * session" or a typo in a query. It must NOT be matched here, or every
 * genuine business-logic error thrown by an action gets misreported as a
 * dropped connection. (Verified against this app's actual production
 * build: `resolveErrorProd()` in
 * node_modules/next/dist/compiled/react-server-dom-webpack/cjs/react-server-dom-webpack-client.browser.production.js
 * hardcodes error 441 for every redacted error, and error 412 for the
 * "Connection closed" stream-abort case — see `close()` in the same file.)
 *
 * Business-logic errors we throw ourselves (e.g. "Only a submitted session
 * can be reopened.") should still pass through unchanged.
 */
const TRANSPORT_ERROR_PATTERNS = [
  /Minified React error #412\b/,
  /Connection closed/i,
  /Failed to fetch/i,
  /NetworkError/i,
  /Load failed/i,
  /fetch failed/i,
];

// The redacted placeholder itself (see comment above) isn't a transport
// failure, but its message is React internals, not something to show a
// packer — route it to the caller's fallback instead of surfacing it raw.
const REDACTED_SERVER_ERROR_PATTERN = /Minified React error #441\b/;

export function isTransportError(err: unknown): boolean {
  return err instanceof Error && TRANSPORT_ERROR_PATTERNS.some((p) => p.test(err.message));
}

export function actionErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  if (isTransportError(err)) {
    return "Connection dropped before that finished — check your signal and try again.";
  }
  if (REDACTED_SERVER_ERROR_PATTERN.test(err.message)) return fallback;
  return err.message || fallback;
}
