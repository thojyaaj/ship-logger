"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDismissable } from "./useDismissable";
import { useScanHeaderState } from "./ScanHeaderState";
import { switchUser } from "./actions";

export default function MobileNav({
  isAdmin,
  operatorName,
}: {
  isAdmin: boolean;
  operatorName: string;
}) {
  // Two states, not one: `mounted` controls whether the drawer subtree
  // exists in the DOM at all, `open` controls its animated position. They
  // have to be separate — conditionally mounting on `open` alone unmounts
  // the drawer the instant it's told to close, before the slide-out
  // transition ever gets a frame to play.
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  // The scan page shows its own shipment-logs/Submit pair in this slot on
  // mobile instead — see ScanHeaderMobileActions. Desktop is untouched.
  const { submit } = useScanHeaderState();

  function openDrawer() {
    setMounted(true);
    // Mount in the closed position first, then flip to open on a later
    // frame — otherwise the browser can coalesce both style states into
    // one paint and the drawer just snaps open with no visible slide.
    requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)));
  }

  function closeDrawer() {
    // Unmounting happens in onExited, once the slide-out transition
    // actually finishes (see MobileNavDrawer's onTransitionEnd).
    setOpen(false);
  }

  return (
    <>
      <button
        type="button"
        onClick={openDrawer}
        aria-label="Open menu"
        aria-expanded={open}
        className={submit ? "hidden" : "md:hidden flex flex-col justify-center gap-1 w-8 h-8 -m-1 shrink-0"}
      >
        <span className="block h-0.5 w-5 bg-paper" />
        <span className="block h-0.5 w-5 bg-paper" />
        <span className="block h-0.5 w-5 bg-paper" />
      </button>

      {mounted && (
        <MobileNavDrawer
          isAdmin={isAdmin}
          operatorName={operatorName}
          open={open}
          onClose={closeDrawer}
          onExited={() => setMounted(false)}
        />
      )}
    </>
  );
}

function MobileNavDrawer({
  isAdmin,
  operatorName,
  open,
  onClose,
  onExited,
}: {
  isAdmin: boolean;
  operatorName: string;
  open: boolean;
  onClose: () => void;
  onExited: () => void;
}) {
  // Same escape-to-close/focus-restore treatment as every other dialog in
  // the app (SubmitDialog, ConfirmDialog, OrderPanel) — this component now
  // stays mounted through the close animation too, but the hook only cares
  // about intercepting Escape/outside-click while the drawer is up, which
  // holds for its entire mounted lifetime here regardless of `open`.
  useDismissable(onClose);
  const router = useRouter();

  return (
    <div className="fixed inset-0 z-30 md:hidden" role="dialog" aria-modal="true">
      <div
        className={`absolute inset-0 bg-ink/60 transition-opacity duration-300 ${open ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />
      <div
        className={`absolute top-0 right-0 h-full w-64 max-w-[80vw] bg-ink text-paper flex flex-col p-4 gap-1 corners transition-transform duration-300 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        onTransitionEnd={(e) => {
          if (e.propertyName === "transform" && !open) onExited();
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="tag-label !text-paper/40">Menu</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close menu"
            className="text-paper text-xl leading-none px-1"
          >
            ✕
          </button>
        </div>
        <div className="tag-label !text-paper/40 px-3 pb-1">
          Operator: <span className="text-paper">{operatorName}</span>
        </div>
        <MobileNavLink href="/" onNavigate={onClose}>
          Scan
        </MobileNavLink>
        <MobileNavLink href="/shipments" onNavigate={onClose}>
          Shipments
        </MobileNavLink>
        {isAdmin && (
          <MobileNavLink href="/analytics" onNavigate={onClose}>
            Analytics
          </MobileNavLink>
        )}
        {isAdmin && (
          <MobileNavLink href="/admin/users" onNavigate={onClose}>
            Admin
          </MobileNavLink>
        )}
        {isAdmin && (
          <MobileNavLink href="/admin/dhl-pickup" onNavigate={onClose}>
            DHL Pickup
          </MobileNavLink>
        )}
        {/* Desktop keeps this as its own header button — here on mobile it's
            just another drawer action, same treatment as the nav links. */}
        <button
          type="button"
          onClick={async () => {
            onClose();
            await switchUser();
            router.replace("/login");
            router.refresh();
          }}
          className="px-3 py-2.5 text-left text-paper/70 hover:text-paper hover:bg-paper/10 transition-colors font-condensed font-semibold uppercase text-sm tracking-widest"
        >
          Switch user
        </button>
      </div>
    </div>
  );
}

function MobileNavLink({
  href,
  onNavigate,
  children,
}: {
  href: string;
  onNavigate: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNavigate}
      className="px-3 py-2.5 text-paper/70 hover:text-paper hover:bg-paper/10 transition-colors font-condensed font-semibold uppercase text-sm tracking-widest"
    >
      {children}
    </Link>
  );
}
