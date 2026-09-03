"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { switchUser } from "./actions";

// The session *cookie* is deliberately long-lived (see lib/auth.ts's 30-day
// TTL comment — "kiosk tablet stays signed in"), but that's about the device
// staying paired, not about who's acting as whom on a shared tablet. Leaving
// an operator's session live on an untouched screen means the next packer to
// walk up and scan does so under whoever last badged in. This closes that
// gap independently of the cookie's own lifetime.
const IDLE_LOGOUT_MS = 30 * 60 * 1000;

// Keyboard-wedge scanner input arrives as keydown (see ScanClient's
// scan-burst detection), so keydown alone already covers active scanning;
// touchstart/mousedown cover everything else a packer does by hand.
// Deliberately not mousemove — motion near a kiosk (a bumped table, a
// cleaning pass) would keep resetting the timer for a screen nobody is
// actually using, defeating the point.
const ACTIVITY_EVENTS = ["keydown", "mousedown", "touchstart", "scroll"] as const;

/** Mounted once at the authed layout level — no UI, just the timer. */
export default function IdleLogout() {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function logout() {
      // Same two steps SwitchUserButton's click handler runs — this is that
      // action firing on a timeout instead of a click.
      switchUser().then(() => {
        router.replace("/login");
        router.refresh();
      });
    }

    function resetTimer() {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(logout, IDLE_LOGOUT_MS);
    }

    resetTimer();
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, resetTimer, { passive: true });
    }

    return () => {
      if (timer.current) clearTimeout(timer.current);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, resetTimer);
      }
    };
  }, [router]);

  return null;
}
