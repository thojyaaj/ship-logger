"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { reopenSessionAction } from "../../scan-actions";

export default function ReopenButton({ sessionId }: { sessionId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <button
      type="button"
      disabled={isPending}
      onClick={() => {
        if (!confirm("Reopen this shipment for corrections? This is recorded in the notes.")) return;
        startTransition(async () => {
          try {
            await reopenSessionAction(sessionId);
            router.push("/");
          } catch (err) {
            alert(err instanceof Error ? err.message : "Failed to reopen shipment.");
          }
        });
      }}
      className="btn px-4 py-2 border border-amber text-amber-ink hover:bg-amber-dim disabled:opacity-50"
    >
      {isPending ? "Reopening…" : "Reopen for corrections"}
    </button>
  );
}
