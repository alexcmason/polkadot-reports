import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { syncNow } from "@/lib/integrations/sync";

export const maxDuration = 300;

const digest = (s: string) => createHash("sha256").update(s).digest();

function authorised(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return timingSafeEqual(digest(request.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
}

/** Vercel Cron calls this every morning to refresh ServiceM8 and Xero. */
export async function GET(request: Request) {
  if (!authorised(request)) return NextResponse.json({ error: "Not allowed." }, { status: 401 });
  // Leaves room inside the 300 second limit for a slow last request to finish.
  return NextResponse.json(await syncNow({ trigger: "cron", budgetMs: 240_000 }));
}
