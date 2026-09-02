"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { loginWithPin } from "./actions";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "back"];

export default function PinPad() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // `press` only ever computes the next `pin` string. Triggering the login
  // attempt has to live outside the setState updater below — updaters must
  // stay pure, and calling startTransition from inside one throws "Cannot
  // call startTransition while rendering" (React treats an updater's
  // invocation as render-phase, and it can even run more than once).
  const press = useCallback(
    (key: string) => {
      if (isPending) return;
      setError(null);
      if (key === "back") {
        setPin((p) => p.slice(0, -1));
        return;
      }
      setPin((p) => (p.length >= 4 ? p : p + key));
    },
    [isPending],
  );

  useEffect(() => {
    if (pin.length !== 4) return;
    startTransition(async () => {
      const result = await loginWithPin(pin);
      if (result.ok) {
        router.replace("/");
        router.refresh();
      } else {
        setError(result.error);
        setPin("");
      }
    });
  }, [pin, router]);

  // This runs on a warehouse desktop with a real keyboard, not a touchscreen
  // — packers type the PIN, they don't tap the on-screen pad. Accept digit
  // keys (top row and numpad) plus Backspace/Delete alongside the on-click
  // handlers below, which stay for anyone who does want to click.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (/^[0-9]$/.test(e.key)) {
        press(e.key);
      } else if (e.key === "Backspace" || e.key === "Delete") {
        press("back");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [press]);

  return (
    <div className="flex flex-col items-center gap-5 md:gap-8">
      <div className="flex gap-3" aria-label="PIN entry" role="status">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={`h-3 w-8 border border-paper/40 transition-colors ${
              i < pin.length ? "bg-orange border-orange" : "bg-transparent"
            }`}
          />
        ))}
      </div>

      <div className="h-6">
        {error && (
          <p className="text-red font-semibold text-sm data tracking-wide" role="alert">
            ⚠ {error}
          </p>
        )}
        {isPending && !error && (
          <p className="text-paper/50 text-sm data tracking-widest">VERIFYING…</p>
        )}
      </div>

      <p className="tag-label !text-paper/40">Type your PIN, or select below</p>

      <div className="corners grid grid-cols-3 gap-px bg-paper/15 p-px w-full max-w-xs">
        {KEYS.map((key, i) =>
          key === "" ? (
            <div key={i} className="bg-ink" />
          ) : (
            <button
              key={i}
              type="button"
              disabled={isPending}
              onClick={() => press(key)}
              className="h-20 bg-ink hover:bg-paper/10 active:bg-orange/20 text-3xl font-mono font-medium text-paper flex items-center justify-center disabled:opacity-40 transition-colors"
            >
              {key === "back" ? "⌫" : key}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
