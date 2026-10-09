import { NextResponse } from "next/server";
import { canEdit, getUser } from "@/lib/auth";
import { syncNow } from "@/lib/integrations/sync";

export const maxDuration = 300;

const refuse = (error: string, status: number) => NextResponse.json({ error }, { status });

/** An admin or editor refreshes the ServiceM8 and Xero copies now. Answers with the SyncResult. */
export async function POST(request: Request) {
  const hosts = [request.headers.get("x-forwarded-host")?.split(",")[0].trim(), request.headers.get("host"), new URL(request.url).host];
  let originHost = "";
  try {
    originHost = new URL(request.headers.get("origin") ?? "").host;
  } catch {
    originHost = "";
  }
  if (!originHost || !hosts.includes(originHost)) return refuse("This refresh did not come from the app.", 403);

  const user = await getUser();
  if (!user) return refuse("Sign in again to refresh.", 401);
  if (!canEdit(user)) return refuse("Only admins and editors can refresh the data.", 403);
  return NextResponse.json(await syncNow({ trigger: "manual", userId: user.id }));
}
