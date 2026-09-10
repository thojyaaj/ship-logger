import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { verifyCallbackHmac, exchangeCodeForOfflineToken, storeOfflineToken } from "@/lib/shopify-oauth";

const STATE_COOKIE = "shopify_oauth_state";

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const shop = params.get("shop");
  const code = params.get("code");
  const state = params.get("state");

  if (!shop || !code || !state) {
    return new NextResponse("Missing required OAuth parameters.", { status: 400 });
  }

  const expectedShop = process.env.SHOPIFY_STORE;
  if (expectedShop && shop !== expectedShop) {
    return new NextResponse("Unexpected shop domain.", { status: 401 });
  }

  if (!verifyCallbackHmac(params)) {
    return new NextResponse("Invalid signature.", { status: 401 });
  }

  const cookieStore = await cookies();
  const expectedState = cookieStore.get(STATE_COOKIE)?.value;
  cookieStore.delete(STATE_COOKIE);
  if (!expectedState || expectedState !== state) {
    // Diagnostic only — never logs the actual state value, just whether the
    // round-trip cookie survived at all. The two failure shapes point at
    // very different causes: "MISSING" means the browser never sent the
    // cookie back (third-party cookie blocking, a domain mismatch between
    // /install and /callback, or the install link opened in a different
    // browser/profile than the one that completed Shopify's consent
    // screen); "present but mismatched" means two installs raced (e.g. the
    // link opened twice) and a later one's cookie overwrote an earlier
    // one's in-flight state.
    console.warn(
      `[auth/callback] state check failed — cookie ${expectedState ? "present but mismatched" : "MISSING"}, ` +
        `request had ${cookieStore.getAll().length} cookie(s) total.`,
    );
    return new NextResponse(
      "Invalid or expired install session — restart from /api/auth/install.",
      { status: 401 },
    );
  }

  try {
    const { accessToken, scope } = await exchangeCodeForOfflineToken(code);
    await storeOfflineToken(accessToken, scope);
  } catch (err) {
    console.error("[auth/callback] offline token exchange failed:", err);
    return new NextResponse("Token exchange failed — check server logs.", { status: 502 });
  }

  return new NextResponse(
    "Shopify app installed. Offline access token stored — you can close this tab.",
    { status: 200, headers: { "Content-Type": "text/plain" } },
  );
}
