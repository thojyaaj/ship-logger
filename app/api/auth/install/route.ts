import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { getCurrentUser } from "@/lib/auth";
import { buildAuthorizeUrl } from "@/lib/shopify-oauth";

/**
 * Starts the one-time OAuth install (see lib/shopify-oauth.ts for why this
 * exists at all — orderCreate needs a real offline token, not the
 * client-credentials token the rest of this app uses). Admin-gated so a
 * random visitor can't repeatedly kick off the Shopify authorize redirect;
 * completing it still requires being logged into Shopify Admin as staff who
 * can approve the app's scopes on the store.
 */
const STATE_COOKIE = "shopify_oauth_state";
const STATE_TTL_SECONDS = 600; // just long enough for the redirect round trip

export async function GET() {
  const user = await getCurrentUser();
  if (!user?.isAdmin) {
    return new NextResponse("Admin access required.", { status: 403 });
  }

  const state = crypto.randomBytes(24).toString("hex");
  const res = NextResponse.redirect(buildAuthorizeUrl(state));
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: STATE_TTL_SECONDS,
  });
  return res;
}
