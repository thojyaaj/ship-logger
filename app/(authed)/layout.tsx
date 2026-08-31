import Link from "next/link";
import { pageRequireUser } from "@/lib/auth";
import SwitchUserButton from "./SwitchUserButton";
import CommandPalette from "./CommandPalette";

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const user = await pageRequireUser();

  return (
    <div className="flex flex-col min-h-screen">
      <header className="sticky top-0 z-10 bg-ink text-paper">
        <div className="flex items-center justify-between gap-4 px-4 md:px-6 py-3 flex-wrap">
          <div className="flex items-center gap-6 md:gap-8">
            <Link href="/" className="flex items-baseline gap-2 shrink-0">
              <span className="font-stencil text-xl tracking-wide">SHIP LOGGER</span>
              <span className="tag-label text-orange hidden sm:inline">MANIFEST SYS.</span>
            </Link>
            <nav className="flex gap-1 text-sm">
              <NavLink href="/">Scan</NavLink>
              <NavLink href="/shipments">Shipments</NavLink>
              {user.isAdmin && <NavLink href="/admin/users">Admin</NavLink>}
            </nav>
          </div>
          <div className="flex items-center gap-3 text-sm shrink-0">
            <span className="hidden sm:flex items-baseline gap-1.5 data text-xs text-paper/60">
              <span className="tag-label !text-paper/40">OPERATOR</span>
              <span className="text-paper font-semibold">{user.name}</span>
            </span>
            <CommandPalette isAdmin={user.isAdmin} />
            <SwitchUserButton />
          </div>
        </div>
        <div className="barcode h-1" />
      </header>
      <main className="flex-1 flex flex-col">{children}</main>
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="px-3 py-1.5 text-paper/70 hover:text-paper hover:bg-paper/10 transition-colors font-condensed font-semibold uppercase text-xs tracking-widest"
    >
      {children}
    </Link>
  );
}
