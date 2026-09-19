"use server";

import { requireAdmin } from "@/lib/auth";
import { runExpectable, type ActionResult } from "@/lib/action-result";
import { ExpectedError } from "@/lib/expected-error";
import { auditEpgInvoice, type AuditOutcome } from "@/lib/invoice-audit/audit";

// The extended function duration this needs (live ShipStation lookups) is
// declared on invoice-audits/page.tsx — a "use server" file may only export
// async functions. See admin/backfill-actions.ts for the same arrangement.
export async function uploadEpgInvoiceAction(formData: FormData): Promise<ActionResult<AuditOutcome>> {
  const admin = await requireAdmin();
  return runExpectable(async () => {
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) throw new ExpectedError("Choose an invoice .xlsx file first.");
    return auditEpgInvoice({
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name.slice(0, 200),
      source: "upload",
      createdBy: admin.id,
    });
  });
}
