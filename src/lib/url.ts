import { headers } from "next/headers";

/** Public address of the app, with no trailing slash. APP_URL wins when set. */
export async function appOrigin(request?: Request): Promise<string> {
  const fixed = process.env.APP_URL?.trim().replace(/\/+$/, "");
  if (fixed) return fixed;
  if (request) return new URL(request.url).origin;
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
