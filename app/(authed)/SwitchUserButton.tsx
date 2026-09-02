"use client";

import { useRouter } from "next/navigation";
import { switchUser } from "./actions";

// Content and sizing come entirely from the caller (children/className) —
// the desktop header passes plain "Switch" text, the mobile header passes
// an icon-only padlock (see layout.tsx), and `label` covers the
// accessible name an icon-only variant doesn't get for free from its text.
export default function SwitchUserButton({
  className,
  label,
  children,
}: {
  className?: string;
  label?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <button
      type="button"
      onClick={async () => {
        await switchUser();
        router.replace("/login");
        router.refresh();
      }}
      aria-label={label}
      title={label}
      className={`btn border border-paper/30 text-paper/70 hover:text-paper hover:border-paper/60 ${className ?? ""}`}
    >
      {children}
    </button>
  );
}
