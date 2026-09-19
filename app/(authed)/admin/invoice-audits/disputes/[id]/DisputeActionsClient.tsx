"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { actionErrorMessage } from "@/lib/error-message";
import { deleteDraftDisputeAction, markDisputeSentAction } from "../../actions";

/**
 * The send step of a dispute: get the report to EPG (Gmail draft or CSV),
 * then confirm it went out. Marking as sent is what unlocks recording
 * EPG's answer; a draft can still be deleted, which frees its parcels.
 */
export default function DisputeActionsClient({
  disputeId,
  status,
  csvHref,
  gmailHref,
}: {
  disputeId: string;
  status: "draft" | "sent" | "resolved";
  csvHref: string;
  gmailHref: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run(action: () => Promise<{ status: "ok" } | { status: "error"; message: string }>, after: () => void) {
    setError(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.status === "error") setError(result.message);
        else after();
      } catch (err) {
        setError(actionErrorMessage(err, "That didn't work — please retry."));
      }
    });
  }

  const sendButtons = (
    <div className="flex items-center gap-2 flex-wrap">
      {gmailHref && (
        <a href={gmailHref} target="_blank" rel="noopener noreferrer" className="btn px-3 py-2 bg-orange text-paper text-sm">
          Create Gmail draft
        </a>
      )}
      <a
        href={csvHref}
        className={`btn px-3 py-2 text-sm ${gmailHref ? "border border-line-strong bg-paper hover:bg-paper-dim" : "bg-orange text-paper"}`}
      >
        Download CSV
      </a>
    </div>
  );

  return (
    <section className="flex flex-col gap-3 border border-line bg-paper-panel p-4" aria-label="Send this dispute">
      {status === "draft" ? (
        <>
          <ol className="flex flex-col gap-3 text-sm">
            <li className="flex flex-col gap-2">
              <span>
                <strong>1. Send it to ePost Global.</strong>{" "}
                {gmailHref
                  ? "Create Gmail draft saves a draft in your Gmail with the CSV attached and the email written — review it and send it."
                  : "Download the CSV and email it to EPG's billing team."}
              </span>
              {sendButtons}
            </li>
            <li className="flex flex-col gap-2">
              <span>
                <strong>2. Once it&apos;s sent, mark it as sent</strong> so you can record EPG&apos;s answer for each parcel.
              </span>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => run(() => markDisputeSentAction(disputeId), () => router.refresh())}
                  className="btn px-3 py-2 border border-ink bg-ink text-paper text-sm disabled:opacity-50"
                >
                  Mark as sent to EPG
                </button>
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => {
                    if (!window.confirm("Delete this draft dispute? Its parcels go back to 'not disputed' and can be put in a new dispute.")) return;
                    run(() => deleteDraftDisputeAction(disputeId), () => router.push("/admin/invoice-audits"));
                  }}
                  className="btn px-3 py-2 text-sm text-red-ink hover:underline disabled:opacity-50"
                >
                  Delete draft
                </button>
              </div>
            </li>
          </ol>
        </>
      ) : (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-sm text-ink-soft">
            {status === "resolved"
              ? "EPG has answered for every parcel."
              : "When EPG replies, select parcels below and record whether they were credited or rejected."}
          </p>
          {sendButtons}
        </div>
      )}
      {error && <p role="alert" className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}
    </section>
  );
}
