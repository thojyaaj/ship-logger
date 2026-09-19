"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actionErrorMessage } from "@/lib/error-message";
import { uploadEpgInvoiceAction } from "./actions";

/**
 * Manual intake — collapsed by default, since the Gmail Apps Script
 * (scripts/apps-script/) brings invoices in on its own. Uploading an
 * invoice that's already been audited re-runs it from scratch.
 */
export default function UploadInvoiceClient() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [hasFile, setHasFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Opening moves focus into the form; closing returns it to the toggle, so
  // keyboard users aren't dropped at the top of the page either way.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) fileRef.current?.focus();
    else if (wasOpen.current) toggleRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  function close() {
    setOpen(false);
    setHasFile(false);
    setError(null);
  }

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

  if (!open) {
    return (
      <div className="flex items-center justify-between gap-3 flex-wrap border border-line bg-paper-panel px-4 py-3">
        <p className="text-sm text-ink-soft">
          New EPG invoices arrive automatically from Gmail. Upload one by hand only if it didn&apos;t come through.
        </p>
        <button
          ref={toggleRef}
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-controls="upload-invoice-form"
          className="btn px-3 py-2 border border-line-strong bg-paper hover:bg-paper-dim text-sm shrink-0"
        >
          Upload an invoice
        </button>
      </div>
    );
  }

  return (
    <form
      id="upload-invoice-form"
      onSubmit={submit}
      className="flex flex-col gap-3 border border-line bg-paper-panel p-4"
    >
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
          ref={fileRef}
          id="invoice-file"
          name="file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => setHasFile(!!e.target.files?.length)}
          className="text-sm text-ink-soft file:mr-3 file:font-condensed file:font-semibold file:uppercase file:tracking-wider file:text-xs file:cursor-pointer file:px-3 file:py-2 file:border file:border-line-strong file:bg-paper file:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-orange"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!hasFile || isPending}
          className="btn px-4 py-2 bg-orange text-paper disabled:opacity-50"
        >
          {isPending ? "Auditing invoice…" : "Audit invoice"}
        </button>
        <button
          type="button"
          onClick={close}
          disabled={isPending}
          aria-expanded={true}
          aria-controls="upload-invoice-form"
          className="btn px-4 py-2 border border-line-strong bg-paper hover:bg-paper-dim disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
      {error && <p role="alert" className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}
    </form>
  );
}
