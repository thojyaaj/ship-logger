"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { switchUser } from "./actions";
import { searchShipmentsPaletteAction } from "./palette-actions";
import { useCommandPaletteState } from "./CommandPaletteState";
import type { ShipmentPaletteHit } from "@/lib/shiplog";

type NavCommand = {
  id: string;
  label: string;
  hint: string;
  href?: string;
  run?: () => void | Promise<void>;
};

type FlatResult =
  | { kind: "nav"; command: NavCommand; indices: number[] }
  | { kind: "shipment"; shipment: ShipmentPaletteHit };

/**
 * Ordered subsequence match (fzf-style, not substring) — "STG" matches
 * "Settings". Rewards consecutive characters and word-boundary starts so
 * "Shp" ranks "Shipments" above a target where the letters are more spread
 * out, then returns the matched indices for highlighting.
 */
function fuzzyMatch(query: string, target: string): { score: number; indices: number[] } | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const indices: number[] = [];
  let qi = 0;
  let score = 0;
  let lastMatch = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    const consecutive = lastMatch === ti - 1;
    const boundary = ti === 0 || /[\s\-_/]/.test(t[ti - 1]);
    score += consecutive ? 3 : boundary ? 2 : 1;
    lastMatch = ti;
    indices.push(ti);
    qi++;
  }
  if (qi < q.length) return null;
  return { score: score - t.length * 0.01, indices };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const set = new Set(indices);
  return (
    <>
      {[...text].map((ch, i) =>
        set.has(i) ? (
          <span key={i} className="text-orange">
            {ch}
          </span>
        ) : (
          <span key={i}>{ch}</span>
        ),
      )}
    </>
  );
}

export default function CommandPalette({ isAdmin }: { isAdmin: boolean }) {
  const { open, setOpen } = useCommandPaletteState();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [shipmentHits, setShipmentHits] = useState<ShipmentPaletteHit[]>([]);
  const [loadingShipments, setLoadingShipments] = useState(false);
  const requestId = useRef(0);
  const router = useRouter();

  const openFresh = useCallback(() => {
    setQuery("");
    setShipmentHits([]);
    setSelectedIndex(0);
    setOpen(true);
  }, [setOpen]);

  const navCommands = useMemo<NavCommand[]>(() => {
    const cmds: NavCommand[] = [
      { id: "nav-scan", label: "Scan station", hint: "go to the scan screen", href: "/" },
      { id: "nav-shipments", label: "Shipments log", hint: "browse shipment history", href: "/shipments" },
    ];
    if (isAdmin) {
      cmds.push({ id: "nav-admin", label: "Crew roster", hint: "manage operators", href: "/admin/users" });
    }
    cmds.push({
      id: "switch-user",
      label: "Switch user",
      hint: "sign out and pick a different operator",
      run: async () => {
        await switchUser();
        router.replace("/login");
        router.refresh();
      },
    });
    return cmds;
  }, [isAdmin, router]);

  // Global Cmd+K / Ctrl+K toggle works from anywhere in the authed app —
  // proficient operators shouldn't need to find a button first. Resetting
  // query/results happens right here, at the moment the palette opens, not
  // via a separate effect keyed on `open` (which just mirrors this state).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) setOpen(false);
        else openFresh();
        return;
      }
      // Fallback for setups where the OS/browser claims Cmd+K/Ctrl+K before
      // the page ever sees it (a real, documented conflict — Chrome on Mac
      // has a setting that does exactly this). "/" is the same convention
      // Slack and Discord use, and is skipped while typing in any field —
      // the scan station's always-focused input, name/PIN fields, etc. —
      // so it still just types a literal "/" there instead of hijacking it.
      if (!open && e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)) {
        e.preventDefault();
        openFresh();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, openFresh, setOpen]);

  // Empty query never renders a blank palette — it falls back to the static
  // nav list below, which the (query-independent) matchedNav also produces
  // for an empty string.
  const matchedNav = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return navCommands.map((command) => ({ command, indices: [] as number[], score: 0 }));
    return navCommands
      .map((command) => {
        const m = fuzzyMatch(trimmed, command.label);
        return m ? { command, indices: m.indices, score: m.score } : null;
      })
      .filter((x): x is { command: NavCommand; indices: number[]; score: number } => x !== null)
      .sort((a, b) => b.score - a.score);
  }, [query, navCommands]);

  // Shipment lookup hits the database, so it's debounced and async — it
  // shows an inline "searching…" label on its own group heading rather than
  // blocking the input or the nav results above it. Below 2 characters the
  // group isn't rendered at all (see JSX), so a shorter query just skips the
  // fetch — no need to reset shipmentHits back to empty here too.
  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    const myRequestId = ++requestId.current;
    // Every setState call lives inside this timer callback, not the effect
    // body itself — the effect only subscribes to (schedules/cancels) the
    // debounce timer, which is what makes this a legitimate external-system
    // subscription rather than a synchronous derived-state mirror.
    const timer = setTimeout(() => {
      setLoadingShipments(true);
      searchShipmentsPaletteAction(term)
        .then((hits) => {
          if (myRequestId === requestId.current) setShipmentHits(hits);
        })
        .finally(() => {
          if (myRequestId === requestId.current) setLoadingShipments(false);
        });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const flatResults = useMemo<FlatResult[]>(
    () => [
      ...matchedNav.map(({ command, indices }): FlatResult => ({ kind: "nav", command, indices })),
      ...(query.trim().length >= 2 ? shipmentHits.map((shipment): FlatResult => ({ kind: "shipment", shipment })) : []),
    ],
    [matchedNav, shipmentHits, query],
  );

  // Derived from render inputs rather than synced via its own effect —
  // arrow keys move the raw index and this just keeps it in range whenever
  // the result count changes (e.g. new shipment hits arrive).
  const activeIndex = flatResults.length === 0 ? -1 : Math.min(selectedIndex, flatResults.length - 1);

  const runResult = useCallback(
    (result: FlatResult) => {
      setOpen(false);
      if (result.kind === "nav") {
        if (result.command.href) router.push(result.command.href);
        else result.command.run?.();
      } else {
        router.push(`/shipments/${result.shipment.id}`);
      }
    },
    [router, setOpen],
  );

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex(Math.min(activeIndex + 1, flatResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const result = flatResults[activeIndex];
      if (result) runResult(result);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={openFresh}
        className="btn border border-paper/30 text-paper/70 hover:text-paper hover:border-paper/60 px-3 py-1.5 flex items-center gap-1.5"
        title="Open command palette (⌘K / Ctrl+K, or / when not typing in a field)"
      >
        <span className="tag-label !text-inherit">⌘K</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-ink/60 flex items-start justify-center pt-[12vh] p-4 z-40"
          onClick={() => setOpen(false)}
        >
          <div
            // The palette is mounted inside the header (bg-ink text-paper),
            // so without resetting color here every unstyled span here would
            // inherit that near-white text onto this light panel — unreadable.
            className="corners bg-paper-panel text-ink w-full max-w-lg flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <input
              // The whole modal only mounts once `open` is true, so autoFocus
              // fires exactly when the palette appears — no ref/effect needed.
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Jump to a page or a shipment…"
              className="data text-lg px-4 py-4 bg-paper-panel outline-none border-b border-line placeholder:text-ink-faint placeholder:text-base placeholder:font-condensed"
            />

            <div className="max-h-[50vh] overflow-y-auto">
              {(() => {
                let cursor = -1;
                return (
                  <>
                    {matchedNav.length > 0 && (
                      <div>
                        <div className="tag-label px-4 pt-3 pb-1 !text-ink-faint">Navigation</div>
                        {matchedNav.map(({ command, indices }) => {
                          cursor++;
                          const idx = cursor;
                          return (
                            <ResultRow
                              key={command.id}
                              active={idx === activeIndex}
                              onMouseEnter={() => setSelectedIndex(idx)}
                              onClick={() => runResult({ kind: "nav", command, indices })}
                            >
                              <span className="font-condensed font-semibold">
                                <Highlighted text={command.label} indices={indices} />
                              </span>
                              <span className="tag-label !normal-case !tracking-normal !text-ink-faint ml-auto">
                                {command.hint}
                              </span>
                            </ResultRow>
                          );
                        })}
                      </div>
                    )}

                    {query.trim().length >= 2 && (
                      <div>
                        <div className="tag-label px-4 pt-3 pb-1 !text-ink-faint flex items-center gap-2">
                          <span>Shipments</span>
                          {loadingShipments && <span className="text-ink-faint normal-case">searching…</span>}
                        </div>
                        {shipmentHits.map((s) => {
                          cursor++;
                          const idx = cursor;
                          return (
                            <ResultRow
                              key={s.id}
                              active={idx === activeIndex}
                              onMouseEnter={() => setSelectedIndex(idx)}
                              onClick={() => runResult({ kind: "shipment", shipment: s })}
                            >
                              <span className="data font-semibold">{s.shipDate}</span>
                              <span className="tag-label !normal-case !tracking-normal !text-ink-soft">
                                {s.awbNumber
                                  ? `AWB ${s.awbNumber}`
                                  : `${s.totals.total} scan${s.totals.total === 1 ? "" : "s"}`}
                              </span>
                              <span
                                className={`tag-label !text-[0.6rem] ml-auto ${
                                  s.status === "submitted" ? "!text-green-ink" : "!text-amber-ink"
                                }`}
                              >
                                {s.status}
                              </span>
                            </ResultRow>
                          );
                        })}
                        {!loadingShipments && shipmentHits.length === 0 && (
                          <p className="text-ink-faint text-sm px-4 py-3 data">NO MATCHING SHIPMENTS</p>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            <div className="route-line px-4 py-2 flex items-center gap-3 text-[0.65rem] tag-label !text-ink-faint">
              <span>↑↓ navigate</span>
              <span>⏎ select</span>
              <span>esc close</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ResultRow({
  active,
  onMouseEnter,
  onClick,
  children,
}: {
  active: boolean;
  onMouseEnter: () => void;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm border-l-4 transition-colors ${
        active ? "border-orange bg-paper-dim" : "border-transparent hover:bg-paper-dim"
      }`}
    >
      {children}
    </button>
  );
}
