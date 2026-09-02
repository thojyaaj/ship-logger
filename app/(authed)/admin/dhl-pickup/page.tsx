import { redirect } from "next/navigation";

// DHL pickup settings moved onto the main Admin page (admin/users/page.tsx)
// — "one place to set those settings" rather than a separate nav
// destination. Redirects rather than 404s for anyone with the old URL
// bookmarked or typed from memory.
export default function DhlPickupSettingsRedirect() {
  redirect("/admin/users");
}
