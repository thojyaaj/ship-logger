"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * Debounced, no-submit-button search — typing a tracking number or picking
 * a ship date pushes the new query params via router.replace, which
 * re-renders the server component page with fresh results. Keeps the
 * filter shareable/bookmarkable as a URL, same as the old <form> did.
 */
export default function ShipmentSearchForm({
  initialQuery,
  initialDate,
}: {
  initialQuery: string;
  initialDate: string;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [date, setDate] = useState(initialDate);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function pushParams(nextQuery: string, nextDate: string) {
    const params = new URLSearchParams();
    if (nextQuery.trim()) params.set("q", nextQuery.trim());
    if (nextDate) params.set("date", nextDate);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `/shipments?${qs}` : "/shipments", { scroll: false });
    });
  }

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setQuery(next);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => pushParams(next, date), 300);
  }

  function handleDateChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value;
    setDate(next);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    pushParams(query, next);
  }

  function clear() {
    setQuery("");
    setDate("");
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    startTransition(() => router.replace("/shipments", { scroll: false }));
  }

  const hasFilter = Boolean(query.trim() || date);

  return (
    // Mobile: a real fixed footer, tracking search only — date search is
    // dropped there entirely (searching a tracking number already opens the
    // exact shipment, so date search is redundant, and there's no room for
    // both in a compact footer anyway). Desktop: unchanged, both fields
    // inline in normal page flow.
    <div className="fixed inset-x-0 bottom-0 z-[5] bg-paper border-t border-line-strong p-4 flex items-center gap-2 md:static md:inset-auto md:z-auto md:border-0 md:p-0 md:flex-wrap">
      <input
        type="text"
        value={query}
        onChange={handleQueryChange}
        placeholder="SEARCH BY TRACKING NUMBER…"
        className="data flex-1 md:min-w-[220px] text-lg px-4 py-3 border border-line-strong focus:border-orange outline-none bg-paper-panel"
      />
      <label className="hidden md:flex items-center gap-2 shrink-0">
        <span className="tag-label !text-ink-soft shrink-0">Ship date</span>
        <input
          type="date"
          value={date}
          onChange={handleDateChange}
          className="data flex-none text-lg px-3 py-3 border border-line-strong focus:border-orange outline-none bg-paper-panel"
        />
      </label>
      {isPending && <span className="hidden md:inline tag-label !text-ink-faint">Searching…</span>}
      {hasFilter && (
        <button
          type="button"
          onClick={clear}
          className="btn px-4 py-3 border border-line-strong text-ink-soft hover:bg-paper-dim shrink-0"
        >
          Clear
        </button>
      )}
    </div>
  );
}
