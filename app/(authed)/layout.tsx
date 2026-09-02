import Link from "next/link";
import { pageRequireUser } from "@/lib/auth";
import SwitchUserButton from "./SwitchUserButton";
import MobileSwitchUserButton from "./MobileSwitchUserButton";
import CommandPalette from "./CommandPalette";
import { CommandPaletteStateProvider } from "./CommandPaletteState";
import ScanHeaderMobileActions from "./ScanHeaderMobileActions";
import ShipmentsHeaderMobileActions from "./ShipmentsHeaderMobileActions";
import ShipmentDetailHeaderMobileActions from "./ShipmentDetailHeaderMobileActions";
import { ScanHeaderStateProvider } from "./ScanHeaderState";

export default async function AuthedLayout({ children }: { children: React.ReactNode }) {
  const user = await pageRequireUser();

  return (
    <ScanHeaderStateProvider>
      <CommandPaletteStateProvider>
        <div className="flex flex-col min-h-screen">
          <header id="app-header" className="sticky top-0 z-10 bg-ink text-paper">
            <div className="flex items-center justify-between gap-4 px-4 md:px-6 py-3 flex-wrap">
              {/* flex-wrap here too, not just on the outer row — otherwise the
                  logo+nav group overflows the phone's viewport as one rigid
                  unrelated to whether the outer row wraps around it. */}
              <div className="flex items-center gap-3 sm:gap-6 md:gap-8 flex-wrap">
                <Link href="/" className="flex items-baseline gap-2 shrink-0">
                  <span className="font-stencil text-xl tracking-wide">SHIP LOGGER</span>
                  <span className="tag-label !text-orange hidden sm:inline">MANIFEST SYS.</span>
                </Link>
                <nav className="hidden md:flex flex-wrap gap-1 text-sm">
                  <NavLink href="/">Scan</NavLink>
                  <NavLink href="/shipments">Shipments</NavLink>
                  {user.isAdmin && <NavLink href="/analytics">Analytics</NavLink>}
                  {user.isAdmin && <NavLink href="/admin/users">Admin</NavLink>}
                  {user.isAdmin && <NavLink href="/admin/dhl-pickup">DHL Pickup</NavLink>}
                  {user.isAdmin && <NavLink href="/admin/trash">Trash</NavLink>}
                </nav>
              </div>
              <div className="flex items-center gap-3 text-sm shrink-0">
                <span className="hidden sm:flex items-baseline gap-1.5 data text-xs text-paper/60">
                  <span className="tag-label !text-paper/40">OPERATOR</span>
                  <span className="text-paper font-semibold">{user.name}</span>
                </span>
                <CommandPalette isAdmin={user.isAdmin} />
                {/* Scan page only: swaps in for the search icon above while
                    ScanClient is mounted — see ScanHeaderState. Its own
                    padlock replaces MobileSwitchUserButton below there. */}
                <ScanHeaderMobileActions />
                {/* Shipments log only: swaps in for the search icon above
                    on that one page — see ShipmentsHeaderMobileActions. */}
                <ShipmentsHeaderMobileActions />
                {/* A shipment's detail page only — see
                    ShipmentDetailHeaderMobileActions. */}
                <ShipmentDetailHeaderMobileActions />
                <SwitchUserButton className="hidden md:inline-flex px-3 py-1.5">Switch</SwitchUserButton>
                {/* Mobile: icon-only, hides itself on the scan page where
                    ScanHeaderMobileActions renders its own copy instead. */}
                <MobileSwitchUserButton />
              </div>
            </div>
            <div className="barcode h-1" />
          </header>
          <main className="flex-1 flex flex-col">{children}</main>
        </div>
      </CommandPaletteStateProvider>
    </ScanHeaderStateProvider>
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
