import { isTransportError } from "./error-message";

/**
 * Retries a server action when the failure looks like a dropped connection
 * rather than a real business error — a flaky warehouse wifi/cell hiccup
 * usually clears within a second, so silently retrying beats bothering the
 * packer with an error for something that isn't actually wrong. Only wrap
 * calls whose server-side effect is idempotent (see shiplog.ts) — retrying
 * a non-idempotent mutation risks applying it twice.
 */
export async function withTransportRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 400): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isTransportError(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
