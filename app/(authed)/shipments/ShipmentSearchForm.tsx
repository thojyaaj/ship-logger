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
    <div className="flex flex-col sm:flex-row sm:items-center sm:flex-wrap gap-2">
      <input
        type="text"
        value={query}
        onChange={handleQueryChange}
        placeholder="SEARCH BY TRACKING NUMBER…"
        className="data flex-1 sm:min-w-[220px] text-lg px-4 py-3 border border-line-strong focus:border-orange outline-none bg-paper-panel"
      />
      <label className="flex items-center gap-2 sm:shrink-0">
        <span className="tag-label !text-ink-soft shrink-0">Ship date</span>
        <input
          type="date"
          value={date}
          onChange={handleDateChange}
          className="data flex-1 sm:flex-none text-lg px-3 py-3 border border-line-strong focus:border-orange outline-none bg-paper-panel"
        />
      </label>
      {isPending && <span className="tag-label !text-ink-faint">Searching…</span>}
      {hasFilter && (
        <button
          type="button"
          onClick={clear}
          className="btn w-full sm:w-auto px-4 py-3 border border-line-strong text-ink-soft hover:bg-paper-dim"
        >
          Clear
        </button>
      )}
    </div>
  );
}
