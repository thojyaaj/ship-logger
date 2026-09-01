import type { NextConfig } from "next";

/**
 * The app previously set no security headers at all. It's a warehouse tool,
 * but it is internet-exposed (ship.otcshoppeexpress.com) and its session is a
 * long-lived cookie, so the cheap defensive headers are worth having.
 *
 * No CSP here on purpose: Next injects inline bootstrap scripts, so a correct
 * policy needs nonce plumbing through the document. Shipping a broken or
 * `unsafe-inline` CSP would be worse than shipping none — it reads as
 * protection without providing any. Called out rather than silently skipped.
 */
const securityHeaders = [
  // The app never legitimately renders inside a frame; this blocks clickjacking
  // against the destructive admin controls (delete shipment, reset day).
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Don't leak shipment ids in the Referer when a packer follows a carrier
  // tracking link out to ups.com / dhl.com.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  // Vercel terminates TLS and already redirects to HTTPS; this makes the
  // browser refuse plaintext for the domain on its own.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
