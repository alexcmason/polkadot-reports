import { initials } from "@/lib/format";

export function Avatar({ name }: { name: string | null | undefined }) {
  return (
    <span className="avatar" title={name ?? "Unassigned"} aria-hidden="true">
      {name ? initials(name) : "?"}
    </span>
  );
}

export function Banner({ kind, children }: { kind: "ok" | "err" | "note"; children: React.ReactNode }) {
  return (
    <div className={`banner ${kind}`} role={kind === "err" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={`field ${className ?? ""}`}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

/** First value of a search param that may be repeated. */
export function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export type Search = Promise<Record<string, string | string[] | undefined>>;
