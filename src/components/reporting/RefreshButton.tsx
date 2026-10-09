"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Result = { status: "ok" | "error" | "skipped"; message?: string; errors?: string[] };

/** Pulls fresh data from ServiceM8 and Xero, then re-renders the page. A first refresh can take a few minutes. */
export function RefreshButton({ label = "Refresh data" }: { label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; err: boolean } | null>(null);
  const [, startTransition] = useTransition();

  async function run() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/sync", { method: "POST" });
      const body = (await res.json().catch(() => null)) as Result | null;
      if (!res.ok || !body) {
        setMessage({ text: "The refresh did not finish. Try again in a minute.", err: true });
      } else if (body.status === "error") {
        setMessage({ text: body.errors?.[0] ?? body.message ?? "The refresh failed.", err: true });
      } else {
        setMessage({ text: body.message || "Up to date.", err: false });
        startTransition(() => router.refresh());
      }
    } catch {
      setMessage({ text: "Could not reach the app. Check your connection.", err: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <button type="button" className="btn" onClick={run} disabled={busy} aria-busy={busy}>
        {busy ? (
          <>
            <span className="spin" aria-hidden="true" style={{ marginRight: 8 }} />
            Refreshing…
          </>
        ) : (
          label
        )}
      </button>
      {message ? (
        <span role="status" className={message.err ? "late small" : "small muted"}>
          {message.text}
        </span>
      ) : null}
    </span>
  );
}
