"use client";

import { useState, useTransition } from "react";
import { generateInsightsAction } from "./actions";
import { actionErrorMessage } from "@/lib/error-message";

/**
 * On-demand only — the button click is the only thing that triggers a real
 * Anthropic API call (see lib/ai-insights.ts's own comment on why this
 * isn't automatic). `snapshot` is the same data already fetched for the
 * rest of this page, passed straight through rather than re-queried.
 */
export default function AiInsights({ windowDays, snapshot }: { windowDays: number; snapshot: unknown }) {
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await generateInsightsAction(windowDays, snapshot);
        if (res.status === "error") {
          setError(res.message);
          return;
        }
        setResult(res.text);
      } catch (err) {
        setError(actionErrorMessage(err, "Couldn't generate insights — please retry."));
      }
    });
  }

  return (
    <div className="corners bg-paper-panel p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="font-stencil text-lg tracking-wide">AI Business Insights</h2>
          <p className="tag-label !normal-case !tracking-normal text-ink-faint mt-1">
            Sends this page&apos;s current numbers to Claude for prioritized recommendations — costs real tokens, runs only when you click.
          </p>
        </div>
        <button
          type="button"
          onClick={run}
          disabled={isPending}
          className="btn px-3 py-1.5 bg-orange text-paper disabled:opacity-50 shrink-0"
        >
          {isPending ? "Thinking…" : result ? "Regenerate" : "Generate Insights"}
        </button>
      </div>

      {error && <p className="border-l-4 border-red bg-red-dim px-3 py-2 text-red-ink text-sm">{error}</p>}

      {result && <div className="text-sm whitespace-pre-wrap font-condensed border-t border-line pt-3">{result}</div>}
    </div>
  );
}
