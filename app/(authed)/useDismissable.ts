"use client";

import { useEffect, useRef } from "react";

/**
 * Escape-to-close plus focus restoration for the app's modals.
 *
 * None of them handled Escape, and SubmitDialog had no backdrop click either,
 * so it was exitable only by finding the Cancel button — a keyboard user could
 * open a dialog and have no way out of it. Restoring focus to whatever was
 * focused before the dialog opened also stops focus falling back to the top of
 * the document on close, which on the scan screen meant the next barcode went
 * nowhere.
 */
export function useDismissable(onDismiss: () => void) {
  // Held in a ref so the effect doesn't re-run (and re-capture focus) every
  // time the parent re-renders with a fresh callback identity.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        dismissRef.current();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // The scan input's own focus management may legitimately have moved
      // focus on by now; only restore if focus wasn't deliberately placed.
      if (previouslyFocused?.isConnected && document.activeElement === document.body) {
        previouslyFocused.focus();
      }
    };
  }, []);
}
