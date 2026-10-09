import type { Role } from "./types";

/** Today's date in the UK, as YYYY-MM-DD. */
export function todayISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

/** "£1,250.50" gives 1250.5. Empty gives null. Anything else that is not an amount gives undefined. */
export function parseMoney(raw: string): number | null | undefined {
  const s = raw.replace(/[£,\s]/g, "");
  if (!s) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const n = Number(s);
  return Math.abs(n) < 1e10 ? n : undefined;
}

export function initials(name: string | null | undefined): string {
  const parts = (name ?? "").split(/\s+/).filter((p) => /^\p{L}/u.test(p));
  if (!parts.length) return "?";
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export const ROLE_LABEL: Record<Role, string> = {
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
};

/** Where to go after a save: the page the form came from, or `fallback`. Only paths inside the app are followed. */
export const safeReturn = (to: string, fallback: string) =>
  to.startsWith("/") && !to.includes("//") && !to.includes("\\") ? to : fallback;

/** Form helpers */
export function str(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
}

export function isUuid(v: string | null | undefined): v is string {
  return !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export function isDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
}
