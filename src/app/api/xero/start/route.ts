import { NextResponse } from "next/server";
import { getUser, newToken } from "@/lib/auth";
import { hasEncryptionKey } from "@/lib/crypto";
import { appOrigin } from "@/lib/url";
import * as xero from "@/lib/integrations/xero";

/** An admin starts connecting Xero. Sends them to Xero to approve read-only access. */
export async function GET(request: Request) {
  const origin = await appOrigin(request);
  const user = await getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  if (user.role !== "admin") return NextResponse.redirect(`${origin}/`);

  const fail = (message: string) => NextResponse.redirect(`${origin}/settings?error=${encodeURIComponent(message)}`);
  if (!hasEncryptionKey()) return fail("Set ENCRYPTION_KEY in Vercel before connecting Xero.");
  if (!xero.configured()) return fail("Xero sign-in details are not set in Vercel yet. Add XERO_CLIENT_ID and XERO_CLIENT_SECRET.");

  const state = newToken();
  const res = NextResponse.redirect(xero.authUrl(state, `${origin}/api/xero/callback`));
  res.cookies.set(xero.STATE_COOKIE, state, {
    httpOnly: true,
    secure: origin.startsWith("https://"),
    sameSite: "lax",
    path: "/api/xero",
    maxAge: 600,
  });
  return res;
}
