"use client";

import { useState } from "react";
import Link from "next/link";
import { useDismissable } from "./useDismissable";

export default function MobileNav({
  isAdmin,
  operatorName,
}: {
  isAdmin: boolean;
  operatorName: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        className="md:hidden flex flex-col justify-center gap-1 w-8 h-8 -m-1 shrink-0"
      >
        <span className="block h-0.5 w-5 bg-paper" />
        <span className="block h-0.5 w-5 bg-paper" />
        <span className="block h-0.5 w-5 bg-paper" />
      </button>

      {open && (
        <MobileNavDrawer
          isAdmin={isAdmin}
          operatorName={operatorName}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function MobileNavDrawer({
  isAdmin,
  operatorName,
  onClose,
}: {
  isAdmin: boolean;
  operatorName: string;
  onClose: () => void;
}) {
  // Same escape-to-close/focus-restore treatment as every other dialog in
  // the app (SubmitDialog, ConfirmDialog, OrderPanel) — this component only
  // mounts while the drawer is open, matching what the hook expects.
  useDismissable(onClose);

  return (
    <div className="fixed inset-0 z-30 md:hidden" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-ink/60" onClick={onClose} />
      <div className="absolute top-0 right-0 h-full w-64 max-w-[80vw] bg-ink text-paper flex flex-col p-4 gap-1 corners">
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
          <MobileNavLink href="/admin/users" onNavigate={onClose}>
            Admin
          </MobileNavLink>
        )}
        {isAdmin && (
          <MobileNavLink href="/admin/dhl-pickup" onNavigate={onClose}>
            DHL Pickup
          </MobileNavLink>
        )}
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
