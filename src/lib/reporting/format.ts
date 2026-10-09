/* Number and date formats for the reports. Pure, so client components can use them too. */

const gbpFmt = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const gbp0Fmt = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
const numFmt = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });

/** "£1,234.56"; negatives in brackets like the client's spreadsheets: "(£1,750.00)". Zero shows "–" when `dashZero`. */
export function gbp(v: number | null | undefined, opts: { dashZero?: boolean; brackets?: boolean } = {}): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (opts.dashZero && Math.abs(v) < 0.005) return "–";
  const s = gbpFmt.format(Math.abs(v));
  return v < -0.004 ? (opts.brackets === false ? `-${s}` : `(${s})`) : s;
}

/** Whole pounds, for headline figures: "£96,430". */
export function gbp0(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  const s = gbp0Fmt.format(Math.abs(v));
  return v < -0.5 ? `(${s})` : s;
}

/** 0.278 as "27.8%". Null shows "–". */
export function pct(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "–";
  const s = `${(Math.abs(v) * 100).toFixed(dp)}%`;
  return v < 0 ? `(${s})` : s;
}

export function num(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  return numFmt.format(v);
}

/** Change between two values as a signed percentage, or null when there is no base. */
export function change(now: number, before: number | null | undefined): number | null {
  if (before === null || before === undefined || Math.abs(before) < 0.005) return null;
  return (now - before) / Math.abs(before);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const parts = (iso: string) => ({ y: iso.slice(0, 4), m: MONTHS[Number(iso.slice(5, 7)) - 1], d: Number(iso.slice(8, 10)) });

/** "10 Sep" */
export const dm = (iso: string | null | undefined) => {
  if (!iso) return "";
  const p = parts(iso);
  return `${p.d} ${p.m}`;
};

/** "10 Sep 2026" */
export const dmy = (iso: string | null | undefined) => {
  if (!iso) return "";
  const p = parts(iso);
  return `${p.d} ${p.m} ${p.y}`;
};

/** "Thu 10 Sep" */
export const wdm = (iso: string | null | undefined) => {
  if (!iso) return "";
  const p = parts(iso);
  return `${DAYS[new Date(`${iso.slice(0, 10)}T00:00:00Z`).getUTCDay()]} ${p.d} ${p.m}`;
};

/** "8 Oct, 14:05" in UK time, for when data was last refreshed. */
export function stamp(isoTime: string | null | undefined): string {
  if (!isoTime) return "never";
  const t = new Date(isoTime);
  if (Number.isNaN(t.getTime())) return "never";
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(t);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
  return `${dm(day)}, ${time}`;
}

/** Class for a money cell: red when negative. */
export const tone = (v: number | null | undefined) => (v !== null && v !== undefined && v < -0.004 ? "num neg" : "num");
