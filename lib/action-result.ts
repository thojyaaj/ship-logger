import { ExpectedError } from "./expected-error";

/**
 * Server Action return shape for a call that can fail with an
 * `ExpectedError`. A plain return value isn't subject to Next.js's
 * production redaction of thrown Server Action errors (see
 * `lib/error-message.ts`), so this is how an expected, user-facing
 * failure reaches the client with its real text intact.
 */
export type ActionResult<T = void> = { status: "ok"; data: T } | { status: "error"; message: string };

/**
 * Runs `fn`, converting a thrown `ExpectedError` into a data result
 * instead of letting it escape as a thrown Server Action error. Any other
 * thrown value (a bug, a downstream API failure) still throws — only
 * conditions the user can understand and act on should be downgraded to
 * "just show this text instead of retrying/erroring."
 */
export async function runExpectable<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { status: "ok", data: await fn() };
  } catch (err) {
    if (err instanceof ExpectedError) return { status: "error", message: err.message };
    throw err;
  }
}
