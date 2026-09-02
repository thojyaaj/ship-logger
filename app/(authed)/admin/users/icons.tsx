// Small stroke icons for the Crew Roster row actions (UsersClient.tsx) — no
// icon library is installed in this app, so these are hand-drawn rather than
// pulling in a new dependency for five icons.

type IconProps = { className?: string };

export function KeyIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="8" cy="15" r="4" />
      <path d="M10.8 12.2 20 3" />
      <path d="M16 7l3 3" />
      <path d="M19 4l1 1" />
    </svg>
  );
}

/** Make admin — pairs with ShieldOffIcon as its "opposite" for the toggle. */
export function ShieldIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

/** Remove admin — same shield outline as ShieldIcon, slashed. */
export function ShieldOffIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <path d="M12 3l7 3v6c0 5-3.5 8-7 9-3.5-1-7-4-7-9V6l7-3z" />
      <line x1="4" y1="4" x2="20" y2="20" />
    </svg>
  );
}

/** Deactivate — pairs with UserCheckIcon as its "opposite" for the toggle. */
export function UserXIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="9" cy="7" r="4" />
      <path d="M2 21v-2a4 4 0 0 1 4-4h3a4 4 0 0 1 4 4v2" />
      <line x1="17" y1="8" x2="22" y2="13" />
      <line x1="22" y1="8" x2="17" y2="13" />
    </svg>
  );
}

/** Reactivate — same person glyph as UserXIcon, checked instead of crossed. */
export function UserCheckIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      <circle cx="9" cy="7" r="4" />
      <path d="M2 21v-2a4 4 0 0 1 4-4h3a4 4 0 0 1 4 4v2" />
      <polyline points="16 11 18 13 22 9" />
    </svg>
  );
}
