/**
 * Marks a thrown error as an expected, user-facing business condition — a
 * state conflict ("Cannot delete the open session"), a stale-client
 * validation failure ("Box not found in this session"), a permission check
 * — as opposed to a bug or an infra failure.
 *
 * Server Action wrappers (see `runExpectable` in `lib/action-result.ts`)
 * catch specifically this and return it as data instead of letting it
 * throw, because Next.js strips the message off anything a Server Action
 * throws before it crosses the wire in production — only a digest
 * survives (see `lib/error-message.ts`). An error that isn't user-
 * actionable should stay a plain `Error` so it keeps throwing and surfaces
 * as a genuine failure, rather than being silently downgraded to "just
 * show this text."
 */
export class ExpectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpectedError";
  }
}
