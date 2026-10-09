"use client";

import { useEffect, useState } from "react";

/** Copies the text of a textarea or input (by id) to the clipboard, then shows "Copied" for a moment. */
export function CopyButton({ target, label = "Copy" }: { target: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(t);
  }, [state]);

  async function copy() {
    const el = document.getElementById(target);
    if (!el) return;
    const field = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el : null;
    const text = field ? field.value : (el.textContent ?? "");
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      // Older browsers, or the clipboard blocked: select the text so the person can copy it.
      if (field) {
        field.focus();
        field.select();
      }
      setState("failed");
    }
  }

  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <button type="button" className="btn" onClick={copy} aria-controls={target}>
        {state === "copied" ? "Copied" : label}
      </button>
      <span role="status" className="small muted">
        {state === "failed" ? "Could not copy. The text is selected – press Ctrl+C or ⌘C." : ""}
      </span>
    </span>
  );
}
