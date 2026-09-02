import "server-only";
import { purgeExpiredTrash } from "./shiplog";

/** Daily entry point for the purge-trash cron — see app/api/cron/purge-trash. */
export async function runPurgeTrashCron(): Promise<{ purgedCount: number }> {
  return purgeExpiredTrash();
}
