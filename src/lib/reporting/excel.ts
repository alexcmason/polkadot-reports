/*
 * Excel downloads of the client reports, in the house format of the client's own workbooks:
 * a bold title in A1, a line of description in A2, headers on a pale green fill, panes frozen
 * under the headers, real dates, money in pounds with negatives in brackets, and totals as SUM
 * formulas that carry their values, so a file opens with every figure showing and still adds
 * up if someone edits it.
 *
 * Pure: each builder takes the engines' output and returns the file as a Buffer.
 */

import ExcelJS from "exceljs";
import { deductionsFor, type ContractorWeek, type JobRow, type MonthReport, type WeekReport } from "./contractor";
import { monthName, round2, ukDate } from "./dates";
import {
  CHASE_LABEL,
  LEDGER_BUCKETS,
  type ChaseStatus,
  type CountAmount,
  type CustomerDebt,
  type DebtorRow,
  type DebtorsReport,
  type HousekeepingRow,
  type LedgerInvoice,
  type LedgerReport,
  type LedgerRow,
} from "./debtors";
import { dm, dmy, wdm } from "./format";
import { UNASSIGNED, type ManagementReport, type SegmentResult, type TrendPoint } from "./management";
import { OUT_OF_TOTALS, PROJECT_STATUS_LABEL, type ProjectRow, type ProjectsReport } from "./projects";
import type { ReportQuery } from "./store";
import type { Bucket, Contractor, Deduction, FixedFee, ReportSettings, SmJob, XeroInvoice } from "./types";

export type ExcelContext = {
  clientName: string;
  /** Short name for labels such as "Polkadot materials £". */
  businessName: string;
  settings: ReportSettings;
  contractors?: Contractor[];
  fees?: FixedFee[];
  deductions?: Deduction[];
  /** UK date the file is prepared, YYYY-MM-DD. Defaults to today. */
  today?: string;
  /**
   * False for a viewer: leaves out what the app shows admins and editors only, as the pages do
   * (line names read as materials by guess, contractor notes, who asked a question).
   */
  staff?: boolean;
};

/* Formats */

export const MONEY = '£#,##0.00;(£#,##0.00);"–"';
export const PERCENT = "0.0%";
export const DATE = "dd mmm yyyy";
const UNITS = '#,##0.0;(#,##0.0);"–"';
const COUNT = '#,##0;(#,##0);"–"';
const MONTH = "mmm yyyy";

const HEAD_FILL = "FFE3EAF3";
const BAND_FILL = "FFF1F4F7";
const ANSWER_FILL = "FFFFF2CC";
const GREY = "FF556170";
const RULE = "FF8C98A8";

type Fmt = "text" | "money" | "pct" | "date" | "units" | "int" | "month";
const NUM_FMT: Record<Exclude<Fmt, "text">, string> = { money: MONEY, pct: PERCENT, date: DATE, units: UNITS, int: COUNT, month: MONTH };

type Formula = { formula: string; result: number | string };
type V = string | number | Date | Formula | null | undefined;
type Style = { bold?: boolean; italic?: boolean; grey?: boolean; fill?: string; wrap?: boolean; top?: boolean; head?: boolean };

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** A UK date as a real spreadsheet date (midnight UTC, so it is a whole day number). */
function xd(iso: string | null | undefined): Date | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** "01 Oct", two-digit day, for sheet names such as "WE 01 Oct". */
function ddMon(iso: string): string {
  return `${iso.slice(8, 10)} ${dm(iso).split(" ")[1] ?? ""}`;
}

/** "Fri 4 Sep 2026" */
const wdmy = (iso: string) => `${wdm(iso)} ${iso.slice(0, 4)}`;

/** Column number to letters: 1 is A, 27 is AA. */
export function colLetter(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** Excel sheet names: at most 31 characters, none of \ / ? * [ ] :, and unique in the workbook. */
export function sheetName(raw: string, used: Set<string>): string {
  const base =
    raw
      .replace(/[\\/?*[\]:]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^'+|'+$/g, "")
      .slice(0, 31)
      .trim() || "Sheet";
  let name = base;
  for (let n = 2; used.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    name = `${base.slice(0, 31 - suffix.length).trim()}${suffix}`;
  }
  used.add(name.toLowerCase());
  return name;
}

const numeric = (v: V): number =>
  typeof v === "number" && Number.isFinite(v) ? v : v && typeof v === "object" && "formula" in v && typeof v.result === "number" ? v.result : 0;

const f = (formula: string, result: number | string): Formula => ({ formula, result: typeof result === "number" ? round6(result) : result });
const round6 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : 0);
const div = (a: number, b: number) => (Math.abs(b) > 0.0000001 ? a / b : 0);

/* Workbook and sheet */

class Book {
  readonly wb = new ExcelJS.Workbook();
  private used = new Set<string>();

  constructor(ctx: ExcelContext) {
    this.wb.creator = ctx.clientName;
    this.wb.created = new Date();
    // Excel works every formula out again on opening, so a total that comes to nothing shows as a dash, not a blank.
    this.wb.calcProperties.fullCalcOnLoad = true;
  }

  sheet(name: string, title: string, description: string, widths: number[]): Sheet {
    const ws = this.wb.addWorksheet(sheetName(name, this.used));
    widths.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });
    const t = ws.getCell(1, 1);
    t.value = title;
    t.font = { bold: true, size: 14 };
    const d = ws.getCell(2, 1);
    d.value = description;
    d.font = { italic: true, color: { argb: GREY } };
    return new Sheet(ws);
  }

  async buffer(): Promise<Buffer> {
    return Buffer.from(await this.wb.xlsx.writeBuffer());
  }
}

class Sheet {
  /** The next free row. Content starts on row 4, under the title and description. */
  row = 4;
  constructor(readonly ws: ExcelJS.Worksheet) {}

  put(r: number, c: number, v: V, fmt: Fmt = "text", st: Style = {}) {
    const cell = this.ws.getCell(r, c);
    cell.value = v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? null : (v as ExcelJS.CellValue);
    if (fmt !== "text") cell.numFmt = NUM_FMT[fmt];
    const bold = st.bold || st.head;
    if (bold || st.italic || st.grey) {
      cell.font = { ...(bold ? { bold: true } : {}), ...(st.italic ? { italic: true } : {}), ...(st.grey ? { color: { argb: GREY } } : {}) };
    }
    const fill = st.head ? HEAD_FILL : st.fill;
    if (fill) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    if (st.head) cell.alignment = { wrapText: true, vertical: "bottom" };
    else if (st.wrap) cell.alignment = { wrapText: true, vertical: "top" };
    if (st.top) cell.border = { top: { style: "thin", color: { argb: RULE } } };
    else if (st.head) cell.border = { bottom: { style: "thin", color: { argb: RULE } } };
  }

  /** A bold label on its own row, such as a section heading. */
  label(text: string, st: Style = {}) {
    this.put(this.row++, 1, text, "text", { bold: true, ...st });
  }

  note(text: string) {
    this.put(this.row++, 1, text, "text", { italic: true, grey: true });
  }

  header(cells: (string | Date)[], c0 = 1): number {
    const r = this.row++;
    cells.forEach((h, i) => this.put(r, c0 + i, h, h instanceof Date ? "date" : "text", { head: true }));
    return r;
  }

  gap(n = 1) {
    this.row += n;
  }

  /** Freezes the first `cols` columns and `rows` rows. */
  freeze(cols: number, rows: number) {
    this.ws.views = [{ state: "frozen", xSplit: cols, ySplit: rows }];
  }
}

/* Tables */

type Totals = {
  /** The totals row address of column `i` (0-based within the table). */
  at: (i: number) => string;
  /** The column's total, as the totals row shows it. */
  sum: (i: number) => number;
  /** Every counted data range of column `i`, for formulas: "B6:B12,B14:B20". */
  ranges: (i: number) => string;
};

type Col<T> = {
  h: string | Date;
  fmt?: Fmt;
  /** The cell value. `at` is the row it is written on, for formulas that refer along the row. */
  v: (r: T, i: number, at: number) => V;
  /** The totals row: "sum", "count", or a function of the other totals. The first column says "Total" unless given. */
  t?: "sum" | "count" | string | ((x: Totals) => V);
  st?: Style;
};

type Group<T> = { label?: string; rows: T[]; /** Whether the rows count in the totals. */ counts?: boolean };

type Placed = { head: number; first: number; last: number; total: number | null };

type GridOptions<T> = {
  /** False for no totals row, or the label for its first cell. */
  total?: boolean | string;
  /** Shown in place of the rows when there are none. */
  empty?: string;
  /** First column, 1-based. */
  c0?: number;
  rowStyle?: (r: T) => Style | undefined;
};

/** Ratio of two totals as an IFERROR formula: margin is gross margin over charged. */
const ratio =
  (num: number, den: number) =>
  (x: Totals): Formula =>
    f(`IFERROR(${x.at(num)}/${x.at(den)},0)`, div(x.sum(num), x.sum(den)));

function grid<T>(
  s: Sheet,
  cols: Col<NoInfer<T>>[],
  groups: Group<T>[],
  o: GridOptions<T> = {}
): Placed {
  const c0 = o.c0 ?? 1;
  const L = (j: number) => colLetter(c0 + j);
  const head = s.header(
    cols.map((c) => c.h),
    c0
  );
  const first = s.row;
  const all = groups.flatMap((g) => g.rows);
  if (!all.length) {
    s.put(s.row++, c0, o.empty ?? "Nothing to show.", "text", { italic: true, grey: true });
    return { head, first, last: first - 1, total: null };
  }
  const sums = cols.map(() => 0);
  const spans: [number, number][] = [];
  for (const g of groups) {
    if (!g.rows.length) continue;
    if (g.label) {
      const r = s.row++;
      cols.forEach((_, j) => s.put(r, c0 + j, j === 0 ? g.label : null, "text", { bold: true, fill: BAND_FILL }));
    }
    const start = s.row;
    g.rows.forEach((row, i) => {
      const rs = o.rowStyle?.(row);
      cols.forEach((c, j) => {
        const v = c.v(row, i, s.row);
        if (g.counts !== false) sums[j] += numeric(v);
        s.put(s.row, c0 + j, v, c.fmt, { ...c.st, ...rs });
      });
      s.row++;
    });
    if (g.counts !== false) spans.push([start, s.row - 1]);
  }
  const last = s.row - 1;
  if (o.total === false || !spans.length) return { head, first, last, total: null };

  const tr = s.row++;
  const x: Totals = {
    at: (j) => `${L(j)}${tr}`,
    sum: (j) => round2(sums[j]),
    ranges: (j) => spans.map(([a, b]) => `${L(j)}${a}:${L(j)}${b}`).join(","),
  };
  const counted = spans.reduce((n, [a, b]) => n + b - a + 1, 0);
  cols.forEach((c, j) => {
    let v: V = null;
    if (c.t === "sum") v = f(`SUM(${x.ranges(j)})`, x.sum(j));
    else if (c.t === "count") v = f(`COUNTA(${x.ranges(j)})`, counted);
    else if (typeof c.t === "function") v = c.t(x);
    else if (typeof c.t === "string") v = c.t;
    else if (j === 0) v = typeof o.total === "string" ? o.total : "Total";
    s.put(tr, c0 + j, v, c.fmt === "date" || c.fmt === "month" ? "text" : c.fmt, { bold: true, top: true });
  });
  return { head, first, last, total: tr };
}

const table = <T>(s: Sheet, cols: Col<NoInfer<T>>[], rows: T[], o: GridOptions<NoInfer<T>> = {}) => grid<T>(s, cols, [{ rows }], o);

/** A money column that sums in the totals row. */
const money = <T>(h: string, v: (r: T) => number | null | undefined, t: Col<T>["t"] | null = "sum"): Col<T> => ({
  h,
  fmt: "money",
  v: (r) => v(r) ?? null,
  t: t ?? undefined,
});
const pctCol = <T>(h: string, v: (r: T) => number | null | undefined, t?: Col<T>["t"]): Col<T> => ({ h, fmt: "pct", v: (r) => v(r) ?? null, t });
const text = <T>(h: string, v: (r: T) => string | null | undefined, st?: Style): Col<T> => ({ h, v: (r) => v(r) || null, st });
const date = <T>(h: string, v: (r: T) => string | null | undefined): Col<T> => ({ h, fmt: "date", v: (r) => xd(v(r)) });

/** Label and value pairs, two columns. */
function pairs(s: Sheet, list: [string, V, Fmt?][], c0 = 1, valueCol = c0 + 1) {
  for (const [k, v, fmt] of list) {
    s.put(s.row, c0, k);
    s.put(s.row, valueCol, v, fmt ?? "text");
    s.row++;
  }
}

/* Contractor pay */

function weekSummaryCols(biz: string): Col<ContractorWeek>[] {
  return [
    { h: "Contractor", v: (c) => c.name, st: { bold: true } },
    { h: "Jobs", fmt: "int", v: (c) => c.jobs, t: "sum" },
    { h: "Units / hrs", fmt: "units", v: (c) => c.units, t: "sum" },
    money("Labour £", (c) => c.labour),
    money("Reimbursed to contractor £", (c) => c.reimbursed),
    money(`${biz} materials £`, (c) => c.businessMaterials),
    money("Charged ex VAT £", (c) => c.chargedEx),
    money("Contractor labour cost £", (c) => c.labourCost),
    money("CIS withheld £", (c) => c.exact?.cis ?? c.cis),
    money("Deductions £", (c) => c.deductions),
    money("Net payable £", (c) => c.exact?.netPayable ?? c.netPayable),
    money("Gross margin £", (c) => c.grossMargin),
    pctCol("Margin %", (c) => c.marginPct, ratio(11, 6)),
    pctCol("Labour margin %", (c) => c.labourMarginPct, (x) => f(`IFERROR((${x.at(3)}-${x.at(7)})/${x.at(3)},0)`, div(x.sum(3) - x.sum(7), x.sum(3)))),
  ];
}

/** A job's flags in words. Line names read as materials by guess are a costing note for staff only. */
const flagText = (staff: boolean) => (r: JobRow) =>
  r.flags
    .filter((x) => staff || x.code !== "unclassified")
    .map((x) => x.text)
    .join(" ");

const isStaff = (ctx: ExcelContext) => ctx.staff !== false;

function jobBlockCols(biz: string, staff: boolean): Col<JobRow>[] {
  return [
    date("Completed", (r) => r.completed),
    { h: "Job no", v: (r) => r.jobNo },
    { h: "Units / hrs", fmt: "units", v: (r) => r.units, t: "sum" },
    money("Rate £", (r) => r.rate, null),
    money("Labour £", (r) => r.labour),
    money("Parking £", (r) => r.parking),
    money("Materials £", (r) => r.materials),
    money("Other £", (r) => r.other),
    money("Charged ex VAT £", (r) => r.chargedEx),
    money("Charged inc VAT £", (r) => r.chargedInc),
    money("Contractor cost £", (r) => r.labourCost),
    money("Reimbursed £", (r) => r.reimbursed),
    money(`${biz} materials £`, (r) => r.businessMaterials),
    money("Gross margin £", (r) => r.grossMargin),
    pctCol("Margin %", (r) => (r.chargedEx ? r.marginPct : null), ratio(13, 8)),
    text("Cost basis", (r) => r.costBasisLabel),
    text("Materials paid by", (r) => (r.materialsPaidBy === "business" ? biz : "Contractor")),
    text("Xero status", (r) => r.xeroStatus),
    text("Customer", (r) => r.customer),
    text("Flag", flagText(staff), { wrap: true }),
  ];
}

const WEEK_WIDTHS = [24, 11, 11, 12, 13, 12, 13, 12, 14, 13, 13, 13, 13, 13, 10, 24, 14, 22, 26, 60];

function writeWeek(book: Book, name: string, w: WeekReport, ctx: ExcelContext) {
  const biz = ctx.businessName;
  const s = book.sheet(
    name,
    `Week ending ${dmy(w.weekEnding)}: contractor detail`,
    `${wdmy(w.weekStart)} to ${wdmy(w.weekEnding)}. Pay run ${wdmy(w.payRun)}. Project work is held out and shown on Projects. All values exclude VAT unless stated.`,
    WEEK_WIDTHS
  );
  s.put(3, 1, "Week ending", "text", { bold: true });
  s.put(3, 2, xd(w.weekEnding), "date");
  s.put(3, 4, "Pay run", "text", { bold: true });
  s.put(3, 5, xd(w.payRun), "date");
  s.row = 5;
  s.label("Week summary");
  table(s, weekSummaryCols(biz), w.contractors, { empty: "No contractor jobs were completed in this week." });

  for (const c of w.contractors) {
    s.gap(2);
    contractorBlock(s, c, ctx);
  }

  if (w.heldOut.length) {
    s.gap(2);
    s.label("Held out of the week");
    table<JobRow>(
      s,
      [
        { h: "Job no", v: (r) => r.jobNo },
        date("Completed", (r) => r.completed),
        text("Customer", (r) => r.customer),
        text("Contractor", (r) => r.contractorName),
        money("Charged ex VAT £", (r) => r.chargedEx),
        text("Why", (r) => (r.treatment === "project" ? "Project, on the Projects tab" : "Left out")),
        text("Note", (r) => r.note, { wrap: true }),
      ],
      w.heldOut
    );
  }
  if (w.xeroOnly.length) {
    s.gap(2);
    s.label("In Xero in the week but not completed in ServiceM8 this week");
    table<XeroInvoice>(
      s,
      [
        { h: "Invoice", v: (i) => i.number },
        text("Contact", (i) => i.contactName),
        date("Date", (i) => i.date),
        money("Ex VAT £", (i) => i.subTotal),
        money("Inc VAT £", (i) => i.total),
      ],
      w.xeroOnly
    );
  }
  if (w.unsuccessful.length) {
    s.gap(2);
    s.label("Unsuccessful in ServiceM8 with money against them");
    table<SmJob>(
      s,
      [{ h: "Job no", v: (j) => j.jobNo }, text("Customer", (j) => j.customer), date("Job date", (j) => j.date), money("Inc VAT £", (j) => j.totalIncVat)],
      w.unsuccessful
    );
  }
  s.freeze(1, 3);
}

/** One contractor's jobs, then the pay build, profitability and key figures, as on the WE sheets. */
function contractorBlock(s: Sheet, c: ContractorWeek, ctx: ExcelContext) {
  const biz = ctx.businessName;
  const cisRate = ctx.settings.cisRate;
  s.label(c.name);
  const placed = table(s, jobBlockCols(biz, isStaff(ctx)), c.rows);
  if (placed.total === null) return;
  const T = placed.total;
  s.gap();

  const h = s.row++;
  for (const [col, label, span] of [
    [1, "Pay build", 4],
    [6, "Profitability", 4],
    [11, "Key figures", 3],
  ] as const) {
    for (let i = 0; i < span; i++) s.put(h, col + i, i === 0 ? label : null, "text", { head: true });
  }
  const r = h + 1;
  const cisExact = c.exact?.cis ?? c.cis;
  const netExact = c.labourCost - cisExact + c.reimbursed - c.deductions;
  const deductionNames = c.deductionLines.map((d) => d.label).join(", ");

  // Pay build: A label, D value.
  s.put(r, 1, "Contractor labour cost");
  s.put(r, 4, f(`K${T}`, c.labourCost), "money");
  s.put(r + 1, 1, cisExact ? `Less CIS at ${Math.round(cisRate * 100)}%` : "No CIS (not paid per job)");
  s.put(r + 1, 4, cisExact ? f(`-K${T}*${cisRate}`, -cisExact) : 0, "money");
  s.put(r + 2, 1, "Reimbursed to contractor");
  s.put(r + 2, 4, f(`L${T}`, c.reimbursed), "money");
  s.put(r + 3, 1, deductionNames ? `Less weekly deductions: ${deductionNames}` : "Less weekly deductions");
  s.put(r + 3, 4, -c.deductions, "money");
  s.put(r + 4, 1, "Net payable", "text", { bold: true, top: true });
  for (const col of [2, 3]) s.put(r + 4, col, null, "text", { top: true });
  s.put(r + 4, 4, f(`SUM(D${r}:D${r + 3})`, netExact), "money", { bold: true, top: true });

  // Profitability: F label, I value.
  s.put(r, 6, "Charged ex VAT");
  s.put(r, 9, f(`I${T}`, c.chargedEx), "money");
  s.put(r + 1, 6, "Less contractor labour cost");
  s.put(r + 1, 9, f(`-K${T}`, -c.labourCost), "money");
  s.put(r + 2, 6, "Less reimbursed to contractor");
  s.put(r + 2, 9, f(`-L${T}`, -c.reimbursed), "money");
  s.put(r + 3, 6, `Less materials bought by ${biz}`);
  s.put(r + 3, 9, f(`-M${T}`, -c.businessMaterials), "money");
  s.put(r + 4, 6, "Gross margin", "text", { bold: true, top: true });
  for (const col of [7, 8]) s.put(r + 4, col, null, "text", { top: true });
  const gm = c.chargedEx - c.labourCost - c.reimbursed - c.businessMaterials;
  s.put(r + 4, 9, f(`SUM(I${r}:I${r + 3})`, gm), "money", { bold: true, top: true });
  s.put(r + 5, 6, "Margin %", "text", { bold: true });
  s.put(r + 5, 9, f(`IFERROR(I${r + 4}/I${r},0)`, div(gm, c.chargedEx)), "pct", { bold: true });

  // Key figures: K label, M value.
  const keys: [string, number, Fmt][] = [
    ["Jobs", c.jobs, "int"],
    ["Units / hrs", c.units, "units"],
    ["Charged per unit £", c.chargedPerUnit, "money"],
    ["Labour cost per unit £", c.costPerUnit, "money"],
    ["Labour margin %", c.labourMarginPct, "pct"],
    ["Share of week revenue %", c.shareOfRevenue, "pct"],
    ["Hourly rate on the card £", c.cardRate, "money"],
  ];
  keys.forEach(([k, v, fmt], i) => {
    s.put(r + i, 11, k);
    s.put(r + i, 13, v, fmt);
  });
  s.row = r + keys.length;
}

/** The week's contractor detail, as the "WE 10 Sep" tab of the month workbook. */
export async function weekWorkbook(week: WeekReport, ctx: ExcelContext): Promise<Buffer> {
  const book = new Book(ctx);
  writeWeek(book, `Week ending ${ddMon(week.weekEnding)}`, week, ctx);
  return book.buffer();
}

/* Job Data */

function jobDataCols(biz: string, staff: boolean): Col<JobRow>[] {
  return [
    date("Week ending", (r) => r.weekEnding),
    text("Contractor", (r) => r.contractorName),
    date("Completed", (r) => r.completed),
    { h: "Job no", v: (r) => r.jobNo, t: "count" },
    { h: "Units / hrs", fmt: "units", v: (r) => r.units, t: "sum" },
    money("Rate £", (r) => r.rate, null),
    money("Labour £", (r) => r.labour),
    money("Parking £", (r) => r.parking),
    money("Materials £", (r) => r.materials),
    money("Other £", (r) => r.other),
    money("Charged ex VAT £", (r) => r.chargedEx),
    money("Charged inc VAT £", (r) => r.chargedInc),
    text("Xero invoice", (r) => r.xeroNumber),
    money("Xero ex VAT £", (r) => r.xeroEx),
    text("Status", (r) => r.xeroStatus),
    text("Cost basis", (r) => r.costBasisLabel),
    money("Cost rate £", (r) => r.costRate, null),
    money("Actual bill £", (r) => r.actualBill),
    text("Bill ref", (r) => r.billRef),
    money("Contractor labour cost £", (r) => r.labourCost),
    text("Materials paid by", (r) => (r.materialsPaidBy === "business" ? biz : "Contractor")),
    money(`${biz} materials cost £`, (r) => r.businessMaterials),
    money("Contractor extra £", (r) => r.contractorExtra),
    money("Reimbursed to contractor £", (r) => r.reimbursed),
    money("Gross margin £", (r) => r.grossMargin),
    pctCol("Margin %", (r) => (r.chargedEx ? r.marginPct : null), ratio(24, 10)),
    text("Customer", (r) => r.customer),
    text("Category", (r) => r.category),
    text("Treatment", (r) => (r.treatment === "include" ? "Included" : r.treatment === "project" ? "Project" : "Left out")),
    text("Flags", flagText(staff)),
  ];
}

const JOB_WIDTHS = [12, 22, 12, 10, 9, 11, 12, 11, 12, 10, 14, 14, 12, 13, 22, 26, 11, 12, 26, 14, 12, 14, 12, 14, 13, 10, 26, 20, 11, 60];

/**
 * The Job Data sheet: one row per included job, then the totals. Held-out jobs (projects and
 * jobs left out) follow in their own table, outside the totals, as on the Job data page.
 */
function jobDataSheet(book: Book, rows: JobRow[], ctx: ExcelContext, description: string) {
  const s = book.sheet("Job Data", "Job Data", description, JOB_WIDTHS);
  const cols = jobDataCols(ctx.businessName, isStaff(ctx));
  const included = rows.filter((r) => r.treatment === "include");
  const heldOut = rows.filter((r) => r.treatment !== "include");
  const placed = table(s, cols, included, { empty: heldOut.length ? "No jobs count towards the totals." : "No completed jobs." });
  if (placed.last >= placed.first) {
    s.ws.autoFilter = { from: { row: placed.head, column: 1 }, to: { row: placed.last, column: JOB_WIDTHS.length } };
  }
  if (heldOut.length) {
    s.gap(2);
    s.label("Held out of the totals: projects and jobs left out");
    table(s, cols, heldOut, { total: false });
  }
  s.freeze(4, placed.head);
}

/** Job Data only: one row per completed job. */
export async function jobsWorkbook(rows: JobRow[], ctx: ExcelContext & { period?: string }): Promise<Buffer> {
  const book = new Book(ctx);
  const s = ctx.settings;
  jobDataSheet(
    book,
    rows,
    ctx,
    `${ctx.period ? `${ctx.period}. ` : ""}Every completed ServiceM8 job, one row each, costed as on the contractor pay report. Weeks run ${DAYS[s.weekEndsOn % 7].slice(0, 3)} to ${DAYS[s.weekEndsOn - 1]?.slice(0, 3) ?? ""}. All values exclude VAT unless stated.`
  );
  return book.buffer();
}

/* Month workbook */

type MonthMoney = MonthReport["contractors"][number];

function monthMoneyCols<T extends Omit<MonthMoney, "name" | "contractorId">>(first: Col<T>, biz: string): Col<T>[] {
  return [
    first,
    { h: "Jobs", fmt: "int", v: (c) => c.jobs, t: "sum" },
    { h: "Units / hrs", fmt: "units", v: (c) => c.units, t: "sum" },
    money("Labour £", (c) => c.labour),
    money("Parking £", (c) => c.parking),
    money("Materials £", (c) => c.materials),
    money("Other £", (c) => c.other),
    money("Charged ex VAT £", (c) => c.chargedEx),
    money("Charged inc VAT £", (c) => c.chargedInc),
    money("Contractor labour cost £", (c) => c.labourCost),
    money("CIS withheld £", (c) => c.exact?.cis ?? c.cis),
    money("Reimbursed to contractor £", (c) => c.reimbursed),
    money("Deductions £", (c) => c.deductions),
    money("Net payable £", (c) => c.exact?.netPayable ?? c.netPayable),
    money(`${biz} materials £`, (c) => c.businessMaterials),
    money("Gross margin £", (c) => c.grossMargin),
    pctCol("Margin %", (c) => c.marginPct, ratio(15, 7)),
  ];
}

const WEEK_STATUS: Record<MonthReport["weeks"][number]["status"], string> = { loaded: "Loaded", to_come: "To come", no_jobs: "No jobs" };

function matrix(s: Sheet, list: MonthReport["charged"], weeks: string[]) {
  const cols: Col<MonthReport["charged"][number]>[] = [
    { h: "Contractor", v: (r) => r.name, st: { bold: true } },
    ...weeks.map((w, i): Col<MonthReport["charged"][number]> => ({ h: xd(w)!, fmt: "money", v: (r) => r.byWeek[i] ?? 0, t: "sum" })),
  ];
  const n = weeks.length;
  cols.push({
    h: "Total £",
    fmt: "money",
    v: (r, _i, at) => (n ? f(`SUM(B${at}:${colLetter(n + 1)}${at})`, r.byWeek.reduce((a, b) => a + b, 0)) : 0),
    t: "sum",
  });
  table(s, cols, list, { empty: "No contractor jobs in this month." });
}

function masterSheet(book: Book, m: MonthReport, ctx: ExcelContext) {
  const biz = ctx.businessName;
  const st = ctx.settings;
  const weeks = m.weeks.map((w) => w.weekEnding);
  const loaded = m.weeks.filter((w) => w.status === "loaded").length;
  const span = weeks.length
    ? `Weeks ending ${dm(weeks[0])} to ${dmy(weeks[weeks.length - 1])} (${DAYS[st.weekEndsOn % 7].slice(0, 3)} to ${DAYS[st.weekEndsOn - 1]?.slice(0, 3) ?? ""}). ${loaded} of ${weeks.length} weeks loaded. `
    : "";
  const s = book.sheet(
    `${monthName(m.month).split(" ")[0]} Master`,
    `${monthName(m.month)} Master`,
    `${span}Built from the Job Data sheet. Project work is held out and shown on Projects. All values exclude VAT unless stated.`,
    [24, 9, 11, 13, 12, 13, 12, 14, 14, 15, 13, 15, 13, 13, 14, 13, 10, 13, 11]
  );
  s.label("Month to date by contractor");
  const firstHead = s.row;
  table(s, monthMoneyCols<MonthMoney>({ h: "Contractor", v: (c) => c.name, st: { bold: true } }, biz), m.contractors, {
    empty: "No contractor jobs in this month.",
  });

  s.gap(2);
  s.label("Week by week");
  type W = MonthReport["weeks"][number];
  table<W>(s, [...monthMoneyCols<W>(date("Week ending", (w) => w.weekEnding), biz), date("Pay run", (w) => w.payRun), text("Status", (w) => WEEK_STATUS[w.status])], m.weeks);

  s.gap(2);
  s.label("Charged ex VAT by contractor and week");
  matrix(s, m.charged, weeks);
  s.gap(2);
  s.label("Gross margin by contractor and week");
  matrix(s, m.margin, weeks);

  s.gap(2);
  s.label("Controls");
  for (const c of m.controls) {
    s.put(s.row, 1, c.label);
    s.put(s.row, 8, c.value, /^Jobs/.test(c.label) ? "int" : "money");
    s.put(s.row, 9, c.ok ? "OK" : "Check", "text", { bold: !c.ok });
    s.row++;
  }
  s.note("The first four should read nil. Anything else means a job sits outside the weeks or is counted twice.");
  s.freeze(1, firstHead);
}

const QUERY_STATUS: Record<ReportQuery["status"], string> = { open: "Open", answered: "Answered", resolved: "Resolved" };
const QUERY_TOPIC: Record<ReportQuery["topic"], string> = {
  contractors: "Contractor pay",
  projects: "Projects",
  debtors: "Debtors",
  management: "Management accounts",
  general: "General",
};

const whereItStands = (q: ReportQuery) => [q.subject, q.detail, q.actionTaken].map((x) => x?.trim()).filter(Boolean).join(" ");

function forSheet(book: Book, m: MonthReport, queries: ReportQuery[], rows: JobRow[], ctx: ExcelContext) {
  const biz = ctx.businessName;
  const weeks = new Set(m.weeks.map((w) => w.weekEnding));
  const customers = new Map(rows.map((r) => [r.jobNo.trim().toUpperCase(), r.customer]));
  const list = queries
    .filter((q) => q.status !== "resolved" && (!q.weekEnding || weeks.has(q.weekEnding)))
    .sort((a, b) => (a.weekEnding ?? "9999").localeCompare(b.weekEnding ?? "9999") || a.createdAt.localeCompare(b.createdAt));
  const s = book.sheet(
    `For ${biz}`,
    `For ${biz}`,
    `Everything we need from you for ${monthName(m.month)}. Type your answers in the yellow cells and send the file back, or answer in the app under Questions for you.`,
    [5, 12, 14, 26, 60, 40, 60]
  );
  const placed = table<ReportQuery>(
    s,
    [
      { h: "#", fmt: "int", v: (_, i) => i + 1 },
      date("Week", (q) => q.weekEnding),
      text("Job", (q) => q.jobNo),
      text("Customer", (q) => customers.get(q.jobNo.trim().toUpperCase())),
      text("Where it stands", whereItStands, { wrap: true }),
      text("What we need", (q) => q.ask, { wrap: true }),
      { h: "Their answer", v: (q) => q.answer || null, st: { wrap: true, fill: ANSWER_FILL } },
    ],
    list,
    { total: false, empty: "No open questions for this month." }
  );
  s.freeze(0, placed.head);
}

function ratesSheet(book: Book, weeks: string[], ctx: ExcelContext) {
  const st = ctx.settings;
  const contractors = [...(ctx.contractors ?? [])].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const s = book.sheet("Rates", "Rates and inputs", "The rates and settings these figures use, as held in Settings.", [34, 14, 16, 14, 14, 26, 50]);
  s.label("Defaults");
  pairs(s, [
    ["Labour share where no rate, fee or bill applies", st.labourShare, "pct"],
    ["CIS rate", st.cisRate, "pct"],
    ["VAT rate", st.vatRate, "pct"],
    ["Weeks end on", DAYS[st.weekEndsOn - 1] ?? ""],
    ["Pay run, days after the week ends", st.payRunLagDays, "int"],
    ["ServiceM8 categories held out as projects", st.projectCategories.join(", ")],
    ["ServiceM8 categories read as recalls", st.recallCategories.join(", ")],
  ]);

  s.gap();
  s.label("Cost rates");
  table<Contractor>(
    s,
    [
      text("Contractor", (c) => c.name),
      money("Rate £", (c) => c.hourlyRate, null),
      text("Basis", (c) => (c.kind === "staff" ? "Not paid per job" : c.costBasis === "labour_share" ? "Labour share" : "Per hour")),
      text("Costed from bills", (c) => (c.useBills ? "Yes" : "No")),
      text("Active", (c) => (c.active ? "Yes" : "No")),
      text("Bill supplier", (c) => c.billSupplier),
      // Notes typed in Settings are for staff.
      ...(isStaff(ctx) ? [text<Contractor>("Notes", (c) => c.notes, { wrap: true })] : []),
    ],
    contractors,
    { total: false, empty: "No contractors set up." }
  );

  s.gap();
  s.label("Fixed fees");
  table<FixedFee>(
    s,
    [
      text("Fee", (x) => x.name),
      money("Fee £", (x) => x.amount, null),
      text("Basis", () => "Fixed fee"),
      { h: "Matches lines containing", v: (x) => x.keywords.join(", ") || null },
      text("Notes", (x) => x.notes),
    ],
    ctx.fees ?? [],
    { total: false, empty: "No fixed fees set up." }
  );

  const deductions = ctx.deductions ?? [];
  if (weeks.length) {
    s.gap();
    s.label("Weekly deductions £");
    type DeductionRow = { c: Contractor; byWeek: { label: string; amount: number }[][] };
    const withAny: DeductionRow[] = contractors
      .map((c) => ({ c, byWeek: weeks.map((w) => deductionsFor(deductions, c.id, w, st.weekEndsOn)) }))
      .filter((x) => x.byWeek.some((l) => l.length));
    table<DeductionRow>(
      s,
      [
        text("Contractor", (x) => x.c.name),
        ...weeks.map((w, i): Col<DeductionRow> => ({ h: xd(w)!, fmt: "money", v: (x) => round2(x.byWeek[i].reduce((n, d) => n + d.amount, 0)), t: "sum" })),
        text("Make up", (x) => [...new Set(x.byWeek.flat().map((d) => `${d.label} ${d.amount}`))].join(", ")),
      ],
      withAny,
      { empty: "No deductions in these weeks." }
    );
  }

  if (deductions.length) {
    s.gap();
    s.label("Deductions set up");
    const names = new Map(contractors.map((c) => [c.id, c.name]));
    table<Deduction>(
      s,
      [
        text("Contractor", (d) => names.get(d.contractorId) ?? ""),
        text("Label", (d) => d.label),
        money("£ a week", (d) => d.amount, null),
        date("From week", (d) => d.startsOn),
        date("To week", (d) => d.endsOn),
        date("One-off week", (d) => d.weekEnding),
      ],
      deductions,
      { total: false }
    );
  }
}

/**
 * The month workbook: the month master, the questions for the business, one sheet per week,
 * then Job Data and the rates for admins and editors. `rows` are the month's Job Data rows.
 */
export async function monthWorkbook(month: MonthReport, weeks: WeekReport[], rows: JobRow[], queries: ReportQuery[], ctx: ExcelContext): Promise<Buffer> {
  const book = new Book(ctx);
  masterSheet(book, month, ctx);
  forSheet(book, month, queries, rows, ctx);
  for (const w of weeks) {
    if (w.rows.length || w.heldOut.length) writeWeek(book, `WE ${ddMon(w.weekEnding)}`, w, ctx);
  }
  // Viewers cannot open Job data or Settings in the app, so their copy leaves both out.
  if (isStaff(ctx)) {
    jobDataSheet(
      book,
      rows,
      ctx,
      `${monthName(month.month)}. Every costed job, one row each. The month and week sheets are built from these rows. All values exclude VAT unless stated.`
    );
    ratesSheet(
      book,
      month.weeks.map((w) => w.weekEnding),
      ctx
    );
  }
  return book.buffer();
}

/* Projects */

const subInvoices = (r: ProjectRow) =>
  [...new Set(r.costs.filter((c) => c.isSub && !c.voided).map((c) => c.ref || c.bill?.number || ""))].filter(Boolean).join(", ");

/** One sheet like the client's projects tracker: rows grouped by status, then the total. */
export async function projectsWorkbook(report: ProjectsReport, ctx: ExcelContext): Promise<Buffer> {
  const book = new Book(ctx);
  const s = book.sheet(
    "Projects",
    `${ctx.clientName} – projects: costs, prices, margins and billing`,
    `Prepared ${dmy(ctx.today ?? todayUk())} from ServiceM8 and Xero. All prices ex VAT unless stated. The total leaves out lost projects and those awaiting a price.`,
    [18, 12, 14, 14, 22, 30, 34, 13, 13, 13, 13, 12, 14, 13, 10, 10, 30, 14, 13, 13, 12, 13, 14, 60]
  );
  const cols: Col<ProjectRow>[] = [
    text("Subcontractor", (r) => r.record.subcontractor),
    text("Estimate no", (r) => r.record.subEstimateNo),
    text("Sub invoice no(s)", subInvoices),
    text("Job no(s)", (r) => r.record.jobNumbers.join(", ")),
    text("Client", (r) => r.record.customer),
    text("Site address", (r) => r.record.site),
    text("Works", (r) => r.record.works, { wrap: true }),
    text("Status", (r) => PROJECT_STATUS_LABEL[r.record.status]),
    money("Sub quoted £ ex VAT", (r) => (r.record.subQuoted === null ? null : r.subQuoted)),
    money("Sub invoiced to date £", (r) => r.subInvoiced),
    money("Sub cost used £", (r) => r.subCostUsed),
    money("Other costs £", (r) => r.otherCosts),
    money("Our price to client £ ex VAT", (r) => r.price),
    money("Gross profit £", (r) => r.grossProfit),
    pctCol("Markup %", (r) => r.markupPct, (x) => f(`IFERROR(${x.at(13)}/(${x.at(10)}+${x.at(11)}),0)`, div(x.sum(13), x.sum(10) + x.sum(11)))),
    pctCol("Margin %", (r) => r.marginPct, ratio(13, 12)),
    text("Client billing stage", (r) => r.billingStage),
    money("Invoiced to client £ inc VAT", (r) => r.billedInc),
    money("Client paid £", (r) => r.clientPaid),
    money("Client outstanding £", (r) => r.clientOutstanding),
    money("Sub paid £", (r) => r.subPaid),
    money("Sub outstanding £", (r) => r.subOutstanding),
    text("Xero type in ServiceM8", (r) => r.categoryCheck),
    text("Checks / notes", (r) => [r.record.notes, ...r.flags.map((x) => x.text)].filter(Boolean).join(" "), { wrap: true }),
  ];
  const placed = grid<ProjectRow>(
    s,
    cols,
    report.groups.map((g) => ({ label: g.label.toUpperCase(), rows: g.rows, counts: !OUT_OF_TOTALS.includes(g.status) })),
    { total: "Total – completed, in progress and quoted (leaves out lost and awaiting price)", empty: "No projects yet." }
  );
  s.freeze(0, placed.head);
  return book.buffer();
}

/* Debtors */

const debtorNote = (r: DebtorRow) =>
  [r.note, r.chase.note, ...r.flags.map((x) => x.text)].map((x) => x?.trim()).filter(Boolean).join("; ");

/** Summary by age, the chase list and the Xero sales ledger. */
export async function debtorsWorkbook(report: DebtorsReport, ledger: LedgerReport, ctx: ExcelContext): Promise<Buffer> {
  const book = new Book(ctx);
  const biz = ctx.businessName;
  const asAt = ctx.today ?? todayUk();
  const intro = `Invoices sent from ServiceM8 that are still unpaid more than ${report.chaseAfterHours} hours after they went out. Balances are inc VAT and allow for payments recorded in ServiceM8 or Xero.`;

  const sum = book.sheet("Summary", `${biz} – unpaid invoices as at ${dmy(asAt)}`, intro, [34, 12, 16, 14]);
  sum.label("By age");
  const age = table<Bucket>(
    sum,
    [text("Age", (b) => b.label), { h: "Invoices", fmt: "int", v: (b) => b.count, t: "sum" }, money("Outstanding £", (b) => b.amount)],
    report.buckets
  );
  sum.gap();
  pairs(
    sum,
    [
      ["To chase (leaves out paid elsewhere and written off)", report.toChase.count, "int"],
      ["To chase £", report.toChase.amount, "money"],
    ],
    1,
    2
  );
  sum.gap();
  sum.label("By status");
  type StatusEntry = [ChaseStatus, CountAmount];
  table<StatusEntry>(
    sum,
    [text("Status", (x) => CHASE_LABEL[x[0]]), { h: "Invoices", fmt: "int", v: (x) => x[1].count, t: "sum" }, money("Outstanding £", (x) => x[1].amount)],
    (Object.entries(report.byStatus) as StatusEntry[]).filter(([, v]) => v.count > 0)
  );
  sum.gap();
  sum.label("Who owes most");
  table<CustomerDebt>(
    sum,
    [
      text("Customer", (c) => c.customer),
      { h: "Invoices", fmt: "int", v: (c) => c.count, t: "sum" },
      money("Outstanding £", (c) => c.amount),
      { h: "Oldest, days", fmt: "int", v: (c) => c.oldestDays },
    ],
    report.byCustomer.slice(0, 15),
    { total: false }
  );
  sum.freeze(0, age.head);

  const chase = book.sheet("Chase list", `${biz} – chase list as at ${dmy(asAt)}`, intro, [10, 28, 34, 13, 8, 14, 12, 13, 18, 13, 9, 60]);
  const placed = table<DebtorRow>(
    chase,
    [
      { h: "Job", v: (r) => r.jobNo },
      text("Client", (r) => r.customer),
      text("Site", (r) => r.site),
      date("Invoiced", (r) => r.invoicedOn),
      { h: "Days", fmt: "int", v: (r) => r.days },
      money("Invoice £ inc VAT", (r) => r.total),
      money("Paid £", (r) => r.paid),
      money("Balance £", (r) => r.balance),
      text("Status", (r) => CHASE_LABEL[r.status]),
      date("Last chased", (r) => r.chase.lastChasedOn),
      { h: "Times chased", fmt: "int", v: (r) => r.chase.chaseCount || null },
      text("Note", debtorNote, { wrap: true }),
    ],
    report.rows,
    { empty: "Nothing to chase." }
  );
  if (report.housekeeping.length) {
    chase.gap(2);
    chase.label("Paid in Xero but not marked paid in ServiceM8");
    table<HousekeepingRow>(
      chase,
      [
        { h: "Job", v: (r) => r.jobNo },
        text("Client", (r) => r.customer),
        text("Xero invoice", (r) => r.xeroNumber),
        money("Total £", (r) => r.total, null),
        money("Paid in ServiceM8 £", (r) => r.smPaid, null),
        money("Paid in Xero £", (r) => r.xeroPaid, null),
        text("What to do", (r) => r.text),
      ],
      report.housekeeping,
      { total: false }
    );
  }
  chase.freeze(0, placed.head);

  const led = book.sheet(
    "Xero ledger",
    `${biz} – Xero sales ledger as at ${dmy(asAt)}`,
    "Every authorised sales invoice in Xero with money still due, aged by days past the due date. Inc VAT.",
    [34, 14, 14, 14, 14, 14, 14, 14]
  );
  const byContact = table<LedgerRow>(
    led,
    [
      text("Contact", (r) => r.contactName),
      ...LEDGER_BUCKETS.map((b, i) => money<LedgerRow>(`${b} £`, (r) => r.amounts[i] ?? 0)),
      money("Total £", (r) => r.total),
    ],
    ledger.rows,
    { empty: "Nothing owed in Xero." }
  );
  led.gap(2);
  led.label("Invoices");
  table<LedgerInvoice>(
    led,
    [
      text("Contact", (li) => li.invoice.contactName),
      text("Invoice", (li) => li.invoice.number),
      date("Date", (li) => li.invoice.date),
      date("Due", (li) => li.invoice.dueDate),
      { h: "Days overdue", fmt: "int", v: (li) => Math.max(0, li.daysOverdue) },
      money("Amount due £", (li) => li.due),
    ],
    ledger.rows.flatMap((r) => r.invoices),
    { empty: "No invoices." }
  );
  led.freeze(1, byContact.head);
  return book.buffer();
}

/* Management accounts */

/** The P&L with SUM formulas on the subtotals and the profit lines worked from them. */
function pnlSheet(book: Book, r: ManagementReport, ctx: ExcelContext, fyNote: string) {
  const s = book.sheet(
    "Profit and loss",
    `${ctx.clientName} – management accounts, ${monthName(r.month)}`,
    `From Xero. ${fyNote} All figures ex VAT.`,
    [40, 15, 15, 15, 15, 12]
  );
  s.header([`Account`, monthName(r.month), monthName(addMonth(r.month, -1)), "Change", "Year to date", "% of income"]);
  const head = s.row - 1;
  const keys = ["month", "prior", "change", "ytd"] as const;
  const spans = new Map<string, [number, number]>();
  const subtotalRow = new Map<string, number>();
  let sectionStart = 0;
  const written = new Map<number, Record<(typeof keys)[number], number | null>>();

  for (const row of r.pnl) {
    const at = s.row++;
    if (row.kind === "section") {
      for (let c = 1; c <= 6; c++) s.put(at, c, c === 1 ? row.label : null, "text", { bold: true, fill: BAND_FILL });
      sectionStart = at + 1;
      continue;
    }
    const st: Style = row.kind === "account" ? {} : { bold: true, top: true };
    s.put(at, 1, row.label, "text", st);
    if (row.kind === "account") {
      keys.forEach((k, i) => s.put(at, 2 + i, row[k], "money"));
      written.set(at, { month: row.month, prior: row.prior, change: row.change, ytd: row.ytd });
    } else if (row.kind === "subtotal" && row.section) {
      const span: [number, number] = [sectionStart, at - 1];
      spans.set(row.section, span);
      subtotalRow.set(row.section, at);
      keys.forEach((k, i) => {
        const col = colLetter(2 + i);
        const total = sumWritten(written, span, k);
        s.put(at, 2 + i, row[k] === null ? null : span[1] >= span[0] ? f(`SUM(${col}${span[0]}:${col}${span[1]})`, total) : 0, "money", st);
      });
      const totals = { month: null, prior: null, change: null, ytd: null } as Record<(typeof keys)[number], number | null>;
      for (const k of keys) totals[k] = row[k] === null ? null : sumWritten(written, span, k);
      written.set(at, totals);
    } else {
      // Gross profit: income less cost of sales. Net profit: gross profit plus other income less expenses.
      const parts: [string, number][] =
        row.label === "Gross profit"
          ? [
              ["income", 1],
              ["cost_of_sales", -1],
            ]
          : [
              ["gross", 1],
              ["other_income", 1],
              ["expenses", -1],
            ];
      keys.forEach((k, i) => {
        const col = colLetter(2 + i);
        if (row[k] === null) return s.put(at, 2 + i, null, "money", st);
        let formula = "";
        let result = 0;
        for (const [sec, sign] of parts) {
          const sr = sec === "gross" ? subtotalRow.get("gross") : subtotalRow.get(sec);
          if (!sr) continue;
          formula += `${sign < 0 ? "-" : formula ? "+" : ""}${col}${sr}`;
          result += sign * (written.get(sr)?.[k] ?? 0);
        }
        s.put(at, 2 + i, formula ? f(formula, result) : 0, "money", st);
        written.set(at, { ...(written.get(at) ?? { month: null, prior: null, change: null, ytd: null }), [k]: result });
      });
      if (row.label === "Gross profit") subtotalRow.set("gross", at);
    }
    s.put(at, 6, row.pctOfIncome, "pct", st);
  }
  if (r.missing.includes(`pnl:${r.month}`)) {
    s.gap();
    s.note(`The profit and loss for ${monthName(r.month)} has not been read from Xero yet, so its column is blank.`);
  }
  s.freeze(1, head);
}

function sumWritten(written: Map<number, Record<string, number | null>>, [a, b]: [number, number], k: string): number {
  let n = 0;
  for (let i = a; i <= b; i++) n += written.get(i)?.[k] ?? 0;
  return n;
}

const addMonth = (month: string, n: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

type BsKey = keyof NonNullable<ManagementReport["balance"]>["now"];
const BS_LINES: [BsKey, string, 1 | -1][] = [
  ["bank", "Cash at bank", 1],
  ["debtors", "Debtors", 1],
  ["otherCurrentAssets", "Other current assets", 1],
  ["fixedAssets", "Fixed assets", 1],
  ["creditors", "Creditors", -1],
  ["vat", "VAT", -1],
  ["payeCis", "PAYE and CIS", -1],
  ["otherCurrentLiabilities", "Other current liabilities", -1],
  ["longTermLiabilities", "Long-term liabilities", -1],
];

/** P&L, by sales type, trend, balance sheet, invoices raised and contractor profitability. */
export async function managementWorkbook(
  report: ManagementReport,
  contractorMonth: MonthReport | null,
  ctx: ExcelContext & { fyNote?: string }
): Promise<Buffer> {
  const book = new Book(ctx);
  const biz = ctx.businessName;
  const tracking = ctx.settings.salesTypeTracking;
  const name = monthName(report.month);
  const fyNote = ctx.fyNote ?? `Year to date from ${monthName(report.ytdFrom)}.`;
  pnlSheet(book, report, ctx, fyNote);

  // By sales type
  const seg = book.sheet(
    "By sales type",
    `By sales type, ${name}`,
    `From the Xero tracking category ${tracking || "(not set)"}. Costs not tagged with a sales type show under ${UNASSIGNED}. Ex VAT.`,
    [24, 15, 15, 15, 10, 15, 15, 12]
  );
  type Seg = SegmentResult;
  const segPlaced = table<Seg>(
    seg,
    [
      text("Sales type", (g) => g.name),
      money("Income £", (g) => g.income),
      money("Cost of sales £", (g) => g.costOfSales),
      money("Gross profit £", (g) => g.grossProfit),
      pctCol("GP %", (g) => g.gpPct, ratio(3, 1)),
      money("Overheads £", (g) => g.expenses),
      money("Net profit £", (g) => g.netProfit),
      pctCol("Share of income", (g) => g.shareOfIncome, (x) => (x.sum(1) > 0 ? 1 : null)),
    ],
    report.segments ?? [],
    { empty: `The profit and loss by ${tracking || "sales type"} for ${name} has not been read from Xero yet.` }
  );
  seg.freeze(1, segPlaced.head);

  // Trend
  const trend = book.sheet("Trend", "Month by month", "The last 12 months with a profit and loss report in Xero. Ex VAT.", [14, 15, 15, 15, 10, 15, 15]);
  const trendPlaced = table<TrendPoint>(
    trend,
    [
      { h: "Month", fmt: "month", v: (t) => xd(`${t.month}-01`) },
      money("Income £", (t) => t.income),
      money("Cost of sales £", (t) => t.costOfSales),
      money("Gross profit £", (t) => t.grossProfit),
      pctCol("GP %", (t) => t.gpPct, ratio(3, 1)),
      money("Overheads £", (t) => t.expenses),
      money("Net profit £", (t) => t.netProfit),
    ],
    report.trend,
    { empty: "No months have a profit and loss report yet.", total: "Total" }
  );
  trend.freeze(1, trendPlaced.head);

  // Balance sheet
  const bs = book.sheet(
    "Balance sheet",
    `Balance sheet at ${dmy(monthEndIso(report.month))}`,
    "From Xero, compared with the month before. Liabilities are shown as positive balances owed.",
    [30, 16, 16, 16]
  );
  if (report.balance) {
    const { now, prior } = report.balance;
    const h = bs.header(["", dmy(monthEndIso(report.month)), dmy(monthEndIso(addMonth(report.month, -1))), "Change"]);
    const rowsAt: number[] = [];
    BS_LINES.forEach(([k, label], i) => {
      if (i === 4) {
        bs.put(bs.row++, 1, "What it owes", "text", { bold: true, fill: BAND_FILL });
      }
      if (i === 0) bs.put(bs.row++, 1, "What it has", "text", { bold: true, fill: BAND_FILL });
      const at = bs.row++;
      rowsAt.push(at);
      bs.put(at, 1, label);
      bs.put(at, 2, now[k], "money");
      bs.put(at, 3, prior ? prior[k] : null, "money");
      bs.put(at, 4, prior ? f(`B${at}-C${at}`, now[k] - prior[k]) : null, "money");
    });
    const at = bs.row++;
    const net = (b: typeof now) => BS_LINES.reduce((n, [k, , sign]) => n + sign * b[k], 0);
    const formula = (col: string) => BS_LINES.map(([, , sign], i) => `${sign < 0 ? "-" : i ? "+" : ""}${col}${rowsAt[i]}`).join("");
    bs.put(at, 1, "Net assets", "text", { bold: true, top: true });
    bs.put(at, 2, f(formula("B"), net(now)), "money", { bold: true, top: true });
    bs.put(at, 3, prior ? f(formula("C"), net(prior)) : null, "money", { bold: true, top: true });
    bs.put(at, 4, prior ? f(`B${at}-C${at}`, net(now) - net(prior)) : null, "money", { bold: true, top: true });
    bs.freeze(1, h);
  } else {
    bs.note(`The balance sheet for ${name} has not been read from Xero yet.`);
  }

  // Invoices raised
  const inv = book.sheet(
    "Invoices raised",
    `Invoices raised in ${name}`,
    "Sales invoices dated in the month, not drafts or voided, by sales type and customer. Customer type from ServiceM8, else read from the name. Inc VAT.",
    [24, 20, 10, 16, 16, 16]
  );
  const d = report.debtorsRaised;
  const ih = inv.header(["Sales type", "Customer", "Invoices", "Total £ inc VAT", "Paid £", "Not paid £"]);
  if (!d.rows.length) inv.note(`No sales invoices dated in ${name}.`);
  const subRows: number[] = [];
  for (const g of d.bySegment) {
    const rows = d.rows.filter((x) => x.segment === g.segment);
    const start = inv.row;
    for (const x of rows) {
      const at = inv.row++;
      inv.put(at, 1, x.segment);
      inv.put(at, 2, x.type === "B2B" ? "Business (B2B)" : "Individual (B2C)");
      inv.put(at, 3, x.count, "int");
      inv.put(at, 4, x.total, "money");
      inv.put(at, 5, x.paid, "money");
      inv.put(at, 6, x.notPaid, "money");
    }
    const at = inv.row++;
    subRows.push(at);
    inv.put(at, 1, `${g.segment} total`, "text", { bold: true });
    inv.put(at, 2, null);
    const vals = [rows.reduce((n, x) => n + x.count, 0), ...(["total", "paid", "notPaid"] as const).map((k) => rows.reduce((n, x) => n + x[k], 0))];
    vals.forEach((v, i) => inv.put(at, 3 + i, f(`SUM(${colLetter(3 + i)}${start}:${colLetter(3 + i)}${at - 1})`, v), i === 0 ? "int" : "money", { bold: true }));
  }
  if (subRows.length) {
    const at = inv.row++;
    inv.put(at, 1, "Total", "text", { bold: true, top: true });
    inv.put(at, 2, null, "text", { top: true });
    const vals = [d.total.count, d.total.total, d.total.paid, d.total.notPaid];
    vals.forEach((v, i) =>
      inv.put(at, 3 + i, f(`SUM(${subRows.map((r) => `${colLetter(3 + i)}${r}`).join(",")})`, v), i === 0 ? "int" : "money", { bold: true, top: true })
    );
  }
  inv.freeze(0, ih);

  // Contractor profitability
  const cp = book.sheet(
    "Contractor profitability",
    `Contractor profitability, ${name}`,
    "Service and maintenance work only, from the contractor pay report. Projects are on the Projects report. Ex VAT.",
    [24, 9, 15, 15, 15, 15, 15, 10, 15, 15]
  );
  const cpPlaced = table<MonthMoney>(
    cp,
    [
      text("Contractor", (c) => c.name),
      { h: "Jobs", fmt: "int", v: (c) => c.jobs, t: "sum" },
      money("Charged ex VAT £", (c) => c.chargedEx),
      money("Labour cost £", (c) => c.labourCost),
      money("Reimbursed £", (c) => c.reimbursed),
      money(`${biz} materials £`, (c) => c.businessMaterials),
      money("Gross margin £", (c) => c.grossMargin),
      pctCol("Margin %", (c) => c.marginPct, ratio(6, 2)),
      money("Deductions recovered £", (c) => c.deductions),
      money("CIS withheld £", (c) => c.exact?.cis ?? c.cis),
    ],
    contractorMonth?.contractors ?? [],
    { empty: contractorMonth ? "No contractor jobs in this month." : "ServiceM8 is not connected." }
  );
  cp.freeze(1, cpPlaced.head);

  return book.buffer();
}

/* Questions */

export async function queriesWorkbook(queries: ReportQuery[], ctx: ExcelContext): Promise<Buffer> {
  const book = new Book(ctx);
  const biz = ctx.businessName;
  const s = book.sheet(
    "Questions",
    `Questions for ${biz}`,
    `Every question raised with ${biz}, open ones first. Type answers in the yellow cells, or answer in the app under Questions for you.`,
    isStaff(ctx) ? [5, 18, 13, 12, 50, 40, 40, 60, 11, 18, 13, 18, 13] : [5, 18, 13, 12, 50, 40, 40, 60, 11, 13, 18, 13]
  );
  const placed = table<ReportQuery>(
    s,
    [
      { h: "#", fmt: "int", v: (_, i) => i + 1 },
      text("Topic", (q) => QUERY_TOPIC[q.topic]),
      date("Week ending", (q) => q.weekEnding),
      text("Job", (q) => q.jobNo),
      text("Where it stands", (q) => [q.subject, q.detail].filter(Boolean).join(" "), { wrap: true }),
      text("What we did", (q) => q.actionTaken, { wrap: true }),
      text("What we need", (q) => q.ask, { wrap: true }),
      { h: "Answer", v: (q) => q.answer || null, st: { wrap: true, fill: ANSWER_FILL } },
      text("Status", (q) => QUERY_STATUS[q.status]),
      // The Questions page names who asked only to staff.
      ...(isStaff(ctx) ? [text<ReportQuery>("Asked by", (q) => q.askedBy)] : []),
      date("Raised", (q) => ukDate(q.createdAt)),
      text("Answered by", (q) => q.answeredBy),
      date("Answered", (q) => ukDate(q.answeredAt)),
    ],
    queries,
    { total: false, empty: "No questions yet." }
  );
  s.freeze(0, placed.head);
  return book.buffer();
}

/* Small helpers */

function todayUk(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
}

function monthEndIso(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
