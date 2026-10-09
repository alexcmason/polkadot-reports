import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getUser } from "@/lib/auth";
import { appOrigin } from "@/lib/url";
import { IntegrationError } from "@/lib/integrations/http";
import { saveXero } from "@/lib/integrations/store";
import * as xero from "@/lib/integrations/xero";
import { settingsFor } from "@/lib/reporting/context";

const simple = (s: string) => s.toLowerCase().replace(/\b(ltd|limited|llp|plc)\b/g, "").replace(/[^a-z0-9]+/g, "");

/** Xero sends the admin back here after they approve access. */
export async function GET(request: Request) {
  const origin = await appOrigin(request);
  const user = await getUser();
  if (!user) return NextResponse.redirect(`${origin}/login`);
  if (user.role !== "admin") return NextResponse.redirect(`${origin}/`);

  const state = (await cookies()).get(xero.STATE_COOKIE)?.value ?? "";
  const finish = (url: string) => {
    const res = NextResponse.redirect(url);
    res.cookies.set(xero.STATE_COOKIE, "", { path: "/api/xero", maxAge: 0 });
    return res;
  };
  const settings = `${origin}/settings`;
  const fail = (message: string) => finish(`${settings}?error=${encodeURIComponent(message)}`);

  const query = new URL(request.url).searchParams;
  if (!state || query.get("state") !== state) {
    return fail("That Xero sign-in could not be matched to a request from this browser. Start again.");
  }
  if (query.get("error")) return fail(`Xero was not connected: ${(query.get("error_description") ?? query.get("error") ?? "").slice(0, 200)}`);
  const code = query.get("code");
  if (!code) return fail("Xero was not connected. Start again.");

  try {
    const tokens = await xero.exchangeCode(code, `${origin}/api/xero/callback`);
    const all = await xero.connections(tokens.accessToken);
    const eventId = xero.authEventId(tokens.accessToken);
    const fromThisSignIn = eventId ? all.filter((c) => c.authEventId === eventId) : [];
    const orgs = fromThisSignIn.length ? fromThisSignIn : all;
    if (!orgs.length) return fail("No Xero organisation was chosen. Start again and tick the business's organisation.");

    // Prefer the organisation named like the business. Settings can switch to another one.
    const want = simple((await settingsFor()).businessName);
    const pick = (want && orgs.find((o) => simple(o.tenantName).startsWith(want))) || orgs[0];
    const tenants = orgs.map((o) => ({ tenantId: o.tenantId, name: o.tenantName }));
    await saveXero(tokens, { tenantId: pick.tenantId, name: pick.tenantName }, tenants, user.id);
    return finish(`${settings}?connected=xero`);
  } catch (err) {
    if (!(err instanceof IntegrationError)) console.error("Xero connect failed", err);
    return fail(err instanceof IntegrationError ? err.message : "Xero was not connected. Try again.");
  }
}
