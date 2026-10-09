/*
 * Week and month arithmetic for the reports. Dates are plain YYYY-MM-DD strings.
 * A week is named by the day it ends on. With weeks ending Thursday, Fri 4 Sep to Thu 10 Sep
 * is "week ending 10 Sep". A week belongs to the month its first day falls in, so the week
 * ending Thu 1 Oct (Fri 25 Sep to Thu 1 Oct) is part of September.
 */

const DAY = 86_400_000;

function toUtc(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`);
}

function fromUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function plusDays(iso: string, days: number): string {
  return fromUtc(new Date(toUtc(iso).getTime() + days * DAY));
}

export function diffDays(fromIso: string, toIso: string): number {
  return Math.round((toUtc(toIso).getTime() - toUtc(fromIso).getTime()) / DAY);
}

/** ISO weekday: 1 Monday ... 7 Sunday. */
export function isoWeekday(iso: string): number {
  const d = toUtc(iso).getUTCDay();
  return d === 0 ? 7 : d;
}

/** The last day of the week containing `iso`. */
export function weekEnding(iso: string, weekEndsOn: number): string {
  return plusDays(iso, (weekEndsOn - isoWeekday(iso) + 7) % 7);
}

export const weekStart = (weekEndingIso: string) => plusDays(weekEndingIso, -6);

export const payRunDate = (weekEndingIso: string, lagDays: number) => plusDays(weekEndingIso, lagDays);

/** "2026-09" for a date. */
export const monthOf = (iso: string) => iso.slice(0, 7);

/** The month a week is reported in: the month of its first day. */
export const weekMonth = (weekEndingIso: string) => monthOf(weekStart(weekEndingIso));

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return fromUtc(new Date(Date.UTC(y, m, 0)));
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return fromUtc(d).slice(0, 7);
}

/** Every week ending whose week starts in `month`, in date order. */
export function weeksInMonth(month: string, weekEndsOn: number): string[] {
  const out: string[] = [];
  let we = weekEnding(monthStart(month), weekEndsOn);
  if (weekMonth(we) !== month) we = plusDays(we, 7);
  while (weekMonth(we) === month) {
    out.push(we);
    we = plusDays(we, 7);
  }
  return out;
}

/** The most recent week that has fully ended before `today`. On the last day of a week, that week is still open. */
export function lastCompleteWeek(today: string, weekEndsOn: number): string {
  return plusDays(weekEnding(today, weekEndsOn), -7);
}

/** A timestamp as a UK calendar date. Accepts ISO strings and "YYYY-MM-DD HH:MM:SS" (taken as UK local time). */
export function ukDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const s = value.trim();
  if (!s || s.startsWith("0000")) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ServiceM8 sends "2026-09-04 14:05:00" in the account's local time already.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date(t));
}

/** Three-letter months as the client's spreadsheets write them ("Sep", never "Sept"). */
export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "10 Sep" */
export function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS_SHORT[Number(iso.slice(5, 7)) - 1]}`;
}

/** "September 2026" */
export function monthName(month: string): string {
  return `${MONTHS_LONG[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
}

/** "Sep 26" */
export function monthShort(month: string): string {
  return `${MONTHS_SHORT[Number(month.slice(5, 7)) - 1]} ${month.slice(2, 4)}`;
}

/** Round to pennies the way a spreadsheet does, avoiding 1.005 rounding down. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
