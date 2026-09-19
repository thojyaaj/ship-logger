"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actionErrorMessage } from "@/lib/error-message";
import { uploadEpgInvoiceAction } from "./actions";

/**
 * Manual intake — the Gmail Apps Script (scripts/apps-script/) covers the
 * normal case automatically. Uploading an invoice that's already been
 * audited re-runs it, picking up any ShipStation costs backfilled since.
 */
export default function UploadInvoiceClient() {
  const router = useRouter();
  const [hasFile, setHasFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      try {
        const result = await uploadEpgInvoiceAction(formData);
        if (result.status === "error") {
          setError(result.message);
          return;
        }
        router.push(`/admin/invoice-audits/${result.data.auditId}`);
      } catch (err) {
        setError(actionErrorMessage(err, "Upload failed — please retry."));
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 border border-line bg-paper-panel p-4">
      <div>
        <h2 className="tag-label !text-base">Upload an EPG invoice</h2>
        <p className="text-sm text-ink-soft mt-1">
          The &ldquo;AWB Package Detail&rdquo; .xlsx EPG emails with each invoice. Checking parcels ShipStation
          hasn&apos;t costed yet can take up to a minute.
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="invoice-file" className="tag-label !text-ink-faint">
          Invoice file (.xlsx)
        </label>
        <input
          id="invoice-file"
          name="file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => setHasFile(!!e.target.files?.length)}
          className="text-sm text-ink-soft file:mr-3 file:font-condensed file:font-semibold file:uppercase file:tracking-wider file:text-xs file:cursor-pointer file:px-3 file:py-2 file:border file:border-line-strong file:bg-paper file:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange"
        />
      </div>
      <button
        type="submit"
        disabled={!hasFile || isPending}
        className="btn self-start px-4 py-2 bg-orange text-paper disabled:opacity-50"
      >
        {isPending ? "Auditing invoice…" : "Audit invoice"}
      </button>
      {error && <p role="alert" className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}
    </form>
  );
}
