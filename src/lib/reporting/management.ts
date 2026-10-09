/*
 * Management accounts.
 *
 * Built from the Xero reports the sync stores as raw JSON (keys "pnl:YYYY-MM",
 * "pnl-tracking:YYYY-MM", "pnl-cash:YYYY-MM", "bs:YYYY-MM") and the sales invoices:
 *
 *   Summary      income, cost of sales, gross profit, other income, overheads, net profit,
 *                worked out from the account lines (Xero's own summary rows are not trusted).
 *   Statement    the month, the month before, the change and the year to date per account.
 *   Segments     the same split by the client's sales tracking category (IN, RE, S&M).
 *   Cash         the P&L on a payments-only basis, as a view of money in and out.
 *   Balance      bank, debtors, creditors, VAT and PAYE/CIS at the month end.
 *   Debtors      the month's sales invoices by segment and customer type (B2B or B2C),
 *                with what has been paid and what has not.
 *
 * Every function is pure and tolerant of missing or malformed reports: a bad report gives
 * zeros, nulls or empty lists, never an exception. Percentages are ratios (0.382 is 38.2%) and
 * are null rather than NaN or Infinity when there is no income. The only throw is
 * managementReport given a month that is not "YYYY-MM".
 */

import { addMonths, monthEnd, monthName, round2 } from "./dates";
import type { XeroInvoice } from "./types";

/* Parsing Xero report JSON */

export type PnlSection = "income" | "cost_of_sales" | "other_income" | "expenses" | "other";

/** The P&L sections in statement order. */
export const PNL_SECTIONS: Exclude<PnlSection, "other">[] = ["income", "cost_of_sales", "other_income", "expenses"];

export type ParsedLine = { section: PnlSection | string; account: string; accountId: string | null; values: number[] };

/**
 * A report as account lines. `columns` are the header titles after the first (blank) one.
 * For a P&L, `section` is the classified PnlSection ("other" when the title is unknown).
 * For a balance sheet it is the section title as Xero gives it, such as "Bank" or
 * "Current Liabilities". Summary rows, and rows in untitled sections (Gross Profit,
 * Net Profit, Total Assets, Net Assets), are left out.
 */
export type ParsedReport = { columns: string[]; lines: ParsedLine[] };

type Obj = Record<string, unknown>;
/** BalanceSheet only: the heading ("Assets", "Liabilities", "Equity") the line sits under. */
type BsGroup = "assets" | "liabilities" | "equity" | "";
/** `titles` runs from the outermost section title to the innermost one. */
type RawLine = { titles: string[]; group: BsGroup; account: string; accountId: string | null; values: number[] };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const AMOUNT_RE = /^[-+]?(\d+\.?\d*|\.\d+)$/;

/** An amount from a report cell: "1,850.00", "-12.50", "(12.50)", "£1,850", "" and garbage (0). */
function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v || 0 : 0;
  if (typeof v !== "string") return 0;
  let s = v.replace(/[,£\s ]/g, "").replace(/[−–]/g, "-");
  let negative = false;
  const bracketed = /^\((.*)\)$/.exec(s);
  if (bracketed) {
    negative = true;
    s = bracketed[1];
  }
  // Only plain decimals: Number() would also accept "0x10", "1e3" and "Infinity".
  if (!AMOUNT_RE.test(s)) return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return (negative ? -n : n) || 0;
}

function cellText(cell: unknown): string {
  if (!isObj(cell)) return "";
  const v = cell.Value;
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

function accountIdOf(cells: unknown[]): string | null {
  for (const cell of cells) {
    if (!isObj(cell) || !Array.isArray(cell.Attributes)) continue;
    for (const a of cell.Attributes) {
      if (isObj(a) && a.Id === "account" && typeof a.Value === "string" && a.Value) return a.Value;
    }
  }
  return null;
}

/**
 * The report object itself, accepting `Reports[0]`, the whole API response, or either one
 * still as JSON text.
 */
function reportRoot(report: unknown): Obj | null {
  if (typeof report === "string") {
    try {
      report = JSON.parse(report);
    } catch {
      return null;
    }
  }
  if (!isObj(report)) return null;
  if (Array.isArray(report.Reports)) return isObj(report.Reports[0]) ? report.Reports[0] : null;
  return report;
}

function isBalanceSheet(root: Obj | null): boolean {
  if (!root) return false;
  const titles = Array.isArray(root.ReportTitles) ? root.ReportTitles.slice(0, 1) : [];
  const kind = [root.ReportType, root.ReportID, root.ReportName, ...titles].filter((v) => typeof v === "string").join(" ");
  return /balance\s*sheet/i.test(kind);
}

/**
 * Which part of a balance sheet a top-level title starts: "Assets" or "Bank" starts the assets,
 * "Liabilities" the liabilities, and "Net Assets" or "Equity" the equity. Null leaves it unchanged.
 */
function headingGroup(title: string): BsGroup | null {
  const t = title.toLowerCase().trim();
  if (t === "net assets" || /equity|capital and reserves/.test(t)) return "equity";
  if (/liabilit|creditors/.test(t)) return "liabilities";
  if (/asset|\bbank\b|\bcash\b|debtors/.test(t)) return "assets";
  return null;
}

/**
 * Every account line with the titles of the sections it sits in. Rows outside a titled section
 * (Gross Profit, Net Profit, Net Assets) and SummaryRows are totals and are skipped. A row with
 * cells but no RowType is read as a Row.
 */
function walk(report: unknown): { root: Obj | null; columns: string[]; lines: RawLine[] } {
  const root = reportRoot(report);
  const rows = root && Array.isArray(root.Rows) ? root.Rows : [];
  let columns: string[] | null = null;
  let group: BsGroup = "";
  const lines: RawLine[] = [];

  const visit = (row: unknown, titles: string[]) => {
    if (!isObj(row)) return;
    const type = typeof row.RowType === "string" ? row.RowType : "";
    const cells = Array.isArray(row.Cells) ? row.Cells : [];
    if (type === "Header") {
      if (columns === null) columns = cells.slice(1).map(cellText);
      return;
    }
    if (type === "Section" || (Array.isArray(row.Rows) && type !== "Row" && type !== "SummaryRow")) {
      const own = typeof row.Title === "string" ? row.Title.trim() : "";
      if (own && !titles.length) group = headingGroup(own) ?? group;
      const inner = own ? [...titles, own] : titles;
      for (const child of Array.isArray(row.Rows) ? row.Rows : []) visit(child, inner);
      return;
    }
    if (type !== "Row" && !(type === "" && cells.length)) return;
    const account = cellText(cells[0]);
    if (!titles.length) {
      // "Net Assets" sits between the liabilities and the equity.
      if (account) group = headingGroup(account) ?? group;
      return;
    }
    if (!account) return;
    lines.push({
      titles,
      group,
      account,
      accountId: accountIdOf(cells),
      values: cells.slice(1).map((c) => num(isObj(c) ? c.Value : undefined)),
    });
  };
  for (const row of rows) visit(row, []);

  const cols = columns ?? [];
  const width = cols.length || lines.reduce((w, l) => Math.max(w, l.values.length), 0);
  for (const l of lines) {
    l.values = Array.from({ length: width }, (_, i) => l.values[i] ?? 0);
  }
  return { root, columns: cols, lines };
}

/**
 * P&L section titles such as "Income", "Less Cost of Sales", "Plus Other Income", "Less Operating Expenses".
 * Anything that reads as a cost or a charge (including tax) is an expense, so it is never added to income.
 */
export function classifySection(title: string): PnlSection {
  const t = String(title ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(less|plus|add|deduct)\s+/, "")
    .trim();
  if (!t) return "other";
  if (t === "cost_of_sales" || t === "other_income" || t === "income" || t === "expenses") return t;
  if (/\bother\b.*\b(income|revenue)\b|non-?operating (income|revenue)|interest (income|received|receivable)|(investment|finance) income/.test(t)) {
    return "other_income";
  }
  if (/costs? of (sales|goods|revenue)|direct costs?|\bpurchases\b/.test(t)) return "cost_of_sales";
  if (/expense|overhead|administrative|\bcosts?\b|charges|\btax(ation)?\b|depreciation|amorti[sz]ation|interest (payable|paid)/.test(t)) {
    return "expenses";
  }
  if (/income|revenue|sales|turnover/.test(t)) return "income";
  return "other";
}

/** A P&L line's section: the outermost section title that is recognised, so a sub-group keeps its parent's place. */
function pnlSectionOf(titles: string[]): PnlSection {
  for (const t of titles) {
    const s = classifySection(t);
    if (s !== "other") return s;
  }
  return "other";
}

/** Account lines of any Xero report. Never throws; garbage gives `{ columns: [], lines: [] }`. */
export function parseReport(report: unknown): ParsedReport {
  const { root, columns, lines } = walk(report);
  const raw = isBalanceSheet(root);
  return {
    columns,
    lines: lines.map((l) => ({
      section: raw ? l.titles[l.titles.length - 1] : pnlSectionOf(l.titles),
      account: l.account,
      accountId: l.accountId,
      values: l.values,
    })),
  };
}

/* P&L summary */

export type PnlSummary = {
  income: number;
  costOfSales: number;
  grossProfit: number;
  otherIncome: number;
  expenses: number;
  netProfit: number;
  /** Gross profit / income, or null when income is zero or negative. A ratio: 0.382 is 38.2%. */
  gpPct: number | null;
  /** Net profit / income, null in the same cases. */
  npPct: number | null;
};

function asPnlSection(section: string): PnlSection {
  return (PNL_SECTIONS as string[]).includes(section) ? (section as PnlSection) : "other";
}

/** A ratio of income, or null when there is no income (a margin on zero or negative sales means nothing). */
const ofIncome = (value: number, income: number): number | null => (income > 0 ? value / income : null);

/**
 * Xero shows income, cost of sales, other income and expenses as positive figures (a refund or
 * credit shows as a negative within its section), so profit is income less costs.
 */
function makeSummary(income: number, costOfSales: number, otherIncome: number, expenses: number): PnlSummary {
  income = round2(income);
  costOfSales = round2(costOfSales);
  otherIncome = round2(otherIncome);
  expenses = round2(expenses);
  const grossProfit = round2(income - costOfSales);
  const netProfit = round2(grossProfit + otherIncome - expenses);
  return {
    income,
    costOfSales,
    grossProfit,
    otherIncome,
    expenses,
    netProfit,
    gpPct: ofIncome(grossProfit, income),
    npPct: ofIncome(netProfit, income),
  };
}

function sectionTotals(parsed: ParsedReport | null | undefined, col: number): Record<PnlSection, number> {
  const t: Record<PnlSection, number> = { income: 0, cost_of_sales: 0, other_income: 0, expenses: 0, other: 0 };
  for (const l of parsed?.lines ?? []) {
    const v = l.values?.[col];
    t[asPnlSection(String(l.section))] += typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  return t;
}

/** The P&L totals of one column (default the first, which is the most recent period), from the account lines. */
export function pnlSummary(parsed: ParsedReport, col = 0): PnlSummary {
  const t = sectionTotals(parsed, col);
  return makeSummary(t.income, t.cost_of_sales, t.other_income, t.expenses);
}

function addSummaries(list: PnlSummary[]): PnlSummary {
  const sum = (f: (s: PnlSummary) => number) => list.reduce((a, s) => a + f(s), 0);
  return makeSummary(
    sum((s) => s.income),
    sum((s) => s.costOfSales),
    sum((s) => s.otherIncome),
    sum((s) => s.expenses),
  );
}

/* Balance sheet */

export type BalanceSummary = {
  bank: number;
  debtors: number;
  otherCurrentAssets: number;
  fixedAssets: number;
  creditors: number;
  vat: number;
  payeCis: number;
  otherCurrentLiabilities: number;
  longTermLiabilities: number;
  netAssets: number;
};

type BsKind = "bank" | "current_assets" | "fixed_assets" | "current_liabilities" | "long_term_liabilities" | "equity" | "other";

function bsKind(title: string): BsKind {
  const t = title.toLowerCase();
  if (/liabilit|creditors|overdraft|borrowings?/.test(t)) {
    return /non[- ]?current|long[- ]?term|after (more than )?one year/.test(t) ? "long_term_liabilities" : "current_liabilities";
  }
  if (/equity|capital and reserves|reserves/.test(t)) return "equity";
  if (/\bbank|\bcash\b/.test(t)) return "bank";
  if (/fixed|non[- ]?current|tangible|intangible|investment/.test(t)) return "fixed_assets";
  if (/asset|debtors|prepayment|stock|inventory/.test(t)) return "current_assets";
  return "other";
}

/**
 * The kind of a balance sheet line: the innermost section title that is recognised (so "Bank"
 * inside "Current Assets" is bank), else the heading it sits under, so an unfamiliar section
 * still counts towards net assets.
 */
function bsKindOf(l: RawLine): BsKind {
  for (let i = l.titles.length - 1; i >= 0; i--) {
    const k = bsKind(l.titles[i]);
    if (k !== "other") return k;
  }
  if (l.group === "assets") return "current_assets";
  if (l.group === "liabilities") return "current_liabilities";
  return "other";
}

const VAT_RE = /\bvat\b/i;
const PAYE_CIS_RE = /\b(paye|cis|nic|nics|ni)\b|national insurance/i;
const CREDITORS_RE = /payable|creditors/i;
const DEBTORS_RE = /receivable|debtors/i;
/**
 * Balances that read as payable or receivable but are not trade creditors or debtors: payroll,
 * taxes, dividends, loans and directors' accounts. They count as other current assets or liabilities.
 */
const NOT_TRADE_RE = /wages|salar|pension|payroll|\btax\b|corporation|hmrc|dividend|loan|director|interest/i;

/**
 * The month-end position from a Xero BalanceSheet report, using its first (most recent) column.
 * Xero shows assets and liabilities as positive balances, so a negative VAT figure is a refund due.
 * `vat` is the net VAT owed: a VAT balance held in current assets reduces it.
 */
export function balanceSummary(report: unknown): BalanceSummary {
  const out: BalanceSummary = {
    bank: 0,
    debtors: 0,
    otherCurrentAssets: 0,
    fixedAssets: 0,
    creditors: 0,
    vat: 0,
    payeCis: 0,
    otherCurrentLiabilities: 0,
    longTermLiabilities: 0,
    netAssets: 0,
  };
  let assets = 0;
  let liabilities = 0;
  for (const l of walk(report).lines) {
    const v = l.values[0] ?? 0;
    switch (bsKindOf(l)) {
      case "bank":
        out.bank += v;
        assets += v;
        break;
      case "current_assets":
        if (VAT_RE.test(l.account)) out.vat -= v;
        else if (DEBTORS_RE.test(l.account) && !NOT_TRADE_RE.test(l.account) && !PAYE_CIS_RE.test(l.account)) out.debtors += v;
        else out.otherCurrentAssets += v;
        assets += v;
        break;
      case "fixed_assets":
        out.fixedAssets += v;
        assets += v;
        break;
      case "current_liabilities":
        if (VAT_RE.test(l.account)) out.vat += v;
        else if (PAYE_CIS_RE.test(l.account)) out.payeCis += v;
        else if (CREDITORS_RE.test(l.account) && !NOT_TRADE_RE.test(l.account)) out.creditors += v;
        else out.otherCurrentLiabilities += v;
        liabilities += v;
        break;
      case "long_term_liabilities":
        out.longTermLiabilities += v;
        liabilities += v;
        break;
      default:
        break;
    }
  }
  out.netAssets = assets - liabilities;
  for (const k of Object.keys(out) as (keyof BalanceSummary)[]) out[k] = round2(out[k]);
  return out;
}

/* Debtors raised */

export type CustomerType = "B2B" | "B2C";
export type DebtorTotals = { count: number; total: number; paid: number; notPaid: number };
export type DebtorRow = DebtorTotals & { segment: string; type: CustomerType };
export type DebtorSegment = DebtorTotals & { segment: string };
export type DebtorsRaised = { rows: DebtorRow[]; bySegment: DebtorSegment[]; total: DebtorTotals };

export const UNASSIGNED = "Unassigned";

const BUSINESS_RE =
  /\b(ltd|limited|llp|plc|group|properties|property|management|estates?|lettings|homes|services|partners|council|housing|associates|trust|developments?|construction|projects)\b/i;

/** Whether a contact name reads as a business. */
export function looksLikeBusiness(contactName: string): boolean {
  return BUSINESS_RE.test(contactName ?? "");
}

/** A finite amount, or 0. */
const money = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** The tracking option carrying most of the invoice's line value, or "Unassigned". */
export function invoiceSegment(inv: XeroInvoice, trackingName: string): string {
  const want = (trackingName ?? "").trim().toLowerCase();
  const sums = new Map<string, number>();
  for (const line of inv.lines ?? []) {
    for (const t of line.tracking ?? []) {
      if ((t.name ?? "").trim().toLowerCase() !== want || !(t.option ?? "").trim()) continue;
      const option = t.option.trim();
      sums.set(option, (sums.get(option) ?? 0) + money(line.lineAmount));
    }
  }
  let best: string | null = null;
  let bestAmount = -Infinity;
  for (const [option, amount] of sums) {
    if (amount > bestAmount) {
      best = option;
      bestAmount = amount;
    }
  }
  return best ?? UNASSIGNED;
}

/**
 * B2C when ServiceM8 says the job's customer is an individual, B2B when it says not.
 * The invoice number is the job number, sometimes with a letter added ("20290A").
 * Without a ServiceM8 answer, the contact name decides.
 */
export function invoiceCustomerType(inv: XeroInvoice, customerTypes?: Map<string, boolean>): CustomerType {
  const number = (inv.number ?? "").trim();
  for (const key of number ? [number, number.replace(/[A-Za-z]$/, "")] : []) {
    // ServiceM8 can leave the customer type unknown (null): fall through to the name.
    const known: unknown = customerTypes?.get(key);
    if (typeof known === "boolean") return known ? "B2C" : "B2B";
  }
  return looksLikeBusiness(inv.contactName) ? "B2B" : "B2C";
}

const NOT_RAISED = new Set(["DRAFT", "VOIDED", "DELETED"]);

function emptyTotals(): DebtorTotals {
  return { count: 0, total: 0, paid: 0, notPaid: 0 };
}

function addTo(t: DebtorTotals, inv: XeroInvoice) {
  t.count += 1;
  t.total = round2(t.total + money(inv.total));
  t.paid = round2(t.paid + money(inv.amountPaid) + money(inv.amountCredited));
  t.notPaid = round2(t.notPaid + money(inv.amountDue));
}

const segmentOrder = (a: string, b: string) =>
  a === UNASSIGNED ? (b === UNASSIGNED ? 0 : 1) : b === UNASSIGNED ? -1 : a.localeCompare(b, "en-GB");

/** Sales invoices dated in the month (not draft, voided or deleted) by segment and customer type. */
export function debtorsRaised(
  invoices: XeroInvoice[],
  month: string,
  trackingName: string,
  customerTypes?: Map<string, boolean>,
): DebtorsRaised {
  const rows = new Map<string, DebtorRow>();
  const segs = new Map<string, DebtorSegment>();
  const total = emptyTotals();
  for (const inv of invoices ?? []) {
    if (inv.type !== "ACCREC" || (inv.date ?? "").slice(0, 7) !== month) continue;
    if (NOT_RAISED.has((inv.status ?? "").toUpperCase())) continue;
    const segment = invoiceSegment(inv, trackingName);
    const type = invoiceCustomerType(inv, customerTypes);
    const key = `${segment}\u0000${type}`;
    if (!rows.has(key)) rows.set(key, { segment, type, ...emptyTotals() });
    if (!segs.has(segment)) segs.set(segment, { segment, ...emptyTotals() });
    addTo(rows.get(key)!, inv);
    addTo(segs.get(segment)!, inv);
    addTo(total, inv);
  }
  return {
    rows: [...rows.values()].sort((a, b) => segmentOrder(a.segment, b.segment) || a.type.localeCompare(b.type)),
    bySegment: [...segs.values()].sort((a, b) => segmentOrder(a.segment, b.segment)),
    total,
  };
}

/* The management report */

export type ManagementInputs = {
  /** "2026-09" */
  month: string;
  /** Raw Xero reports by key: "pnl:YYYY-MM", "pnl-tracking:YYYY-MM", "pnl-cash:YYYY-MM", "bs:YYYY-MM". */
  reports: Map<string, unknown>;
  /** Sales invoices (ACCREC) give the debtors raised in the month. Bills are ignored. */
  invoices: XeroInvoice[];
  /** The Xero tracking category that splits sales, e.g. "Sales Type". */
  trackingName: string;
  /** Xero organisation FinancialYearEndMonth, 1..12. */
  fyEndMonth: number;
  /** Invoice (job) number -> whether the customer is an individual, from ServiceM8. */
  customerTypes?: Map<string, boolean>;
};

export type PnlRowKind = "section" | "account" | "subtotal" | "total";

/** One line of the statement, ready for a table or a spreadsheet. Section headings carry no figures. */
export type PnlRow = {
  kind: PnlRowKind;
  /** The P&L section, or null for the Gross profit and Net profit lines. */
  section: Exclude<PnlSection, "other"> | null;
  label: string;
  accountId: string | null;
  /** Null when the month's report is missing. */
  month: number | null;
  /** Null when the previous month's report is missing. */
  prior: number | null;
  change: number | null;
  /** Null when no month of the financial year has a report. */
  ytd: number | null;
  /** Share of the month's income, null with no income. */
  pctOfIncome: number | null;
};

export type TrendPoint = {
  month: string;
  income: number;
  costOfSales: number;
  grossProfit: number;
  gpPct: number | null;
  expenses: number;
  netProfit: number;
};

export type SegmentResult = {
  name: string;
  income: number;
  costOfSales: number;
  grossProfit: number;
  gpPct: number | null;
  expenses: number;
  netProfit: number;
  /** This segment's income over the income of all segments, null when that is zero or negative. */
  shareOfIncome: number | null;
};

export type CashLine = { section: Exclude<PnlSection, "other">; account: string; amount: number };
export type CashView = { moneyIn: number; moneyOut: number; net: number; lines: CashLine[] };

export type ManagementKpis = {
  income: number;
  grossProfit: number;
  gpPct: number | null;
  netProfit: number;
  cashAtBank: number | null;
  debtors: number | null;
  creditors: number | null;
  vatOwed: number | null;
};

export type ManagementReport = {
  month: string;
  /** Months with a P&L report, newest first. */
  available: string[];
  /** Report keys this report needs that have not been synced. */
  missing: string[];
  /** The month's P&L. All zeros when its report is missing (see `missing`). */
  summary: PnlSummary;
  prior: PnlSummary | null;
  /** First month of the financial year containing `month`. */
  ytdFrom: string;
  ytd: PnlSummary;
  /** How many months of the year to date have a report. */
  ytdMonths: number;
  /** False when any month of the year to date is missing. */
  ytdComplete: boolean;
  pnl: PnlRow[];
  trend: TrendPoint[];
  segments: SegmentResult[] | null;
  cash: CashView | null;
  balance: { now: BalanceSummary; prior: BalanceSummary | null } | null;
  debtorsRaised: DebtorsRaised;
  kpis: ManagementKpis;
  commentary: string[];
};

const SECTION_LABEL: Record<Exclude<PnlSection, "other">, string> = {
  income: "Income",
  cost_of_sales: "Cost of sales",
  other_income: "Other income",
  expenses: "Operating expenses",
};

const SUMMARY_FIELD: Record<Exclude<PnlSection, "other">, "income" | "costOfSales" | "otherIncome" | "expenses"> = {
  income: "income",
  cost_of_sales: "costOfSales",
  other_income: "otherIncome",
  expenses: "expenses",
};

const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 24; m = addMonths(m, 1)) out.push(m);
  return out;
};

/** The first month of the financial year containing `month`. A year end Xero sends as text ("3") is accepted; anything else invalid means December. */
function fyStart(month: string, fyEndMonth: unknown): string {
  const n = typeof fyEndMonth === "string" && fyEndMonth.trim() ? Number(fyEndMonth) : fyEndMonth;
  const end = typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 12 ? n : 12;
  const startMonth = (end % 12) + 1;
  const m = Number(month.slice(5, 7));
  return addMonths(month, -((m - startMonth + 12) % 12));
}

type Account = {
  section: Exclude<PnlSection, "other">;
  label: string;
  accountId: string | null;
  month: number;
  prior: number;
  ytd: number;
};

/** Statement lines: accounts matched across months by Xero account id, falling back to the name. */
function statementRows(
  current: ParsedReport | null,
  prior: ParsedReport | null,
  ytdReports: ParsedReport[],
  summary: PnlSummary,
  priorSummary: PnlSummary | null,
  ytd: PnlSummary | null,
): PnlRow[] {
  const accounts: Account[] = [];
  const byId = new Map<string, Account>();
  const byName = new Map<string, Account>();
  const find = (section: Exclude<PnlSection, "other">, line: ParsedLine): Account => {
    const idKey = line.accountId ? `${section}|${line.accountId}` : null;
    const nameKey = `${section}|${line.account.toLowerCase()}`;
    let acc = (idKey && byId.get(idKey)) || byName.get(nameKey);
    if (!acc) {
      acc = { section, label: line.account, accountId: line.accountId, month: 0, prior: 0, ytd: 0 };
      accounts.push(acc);
    }
    if (idKey) byId.set(idKey, acc);
    byName.set(nameKey, acc);
    if (!acc.accountId && line.accountId) acc.accountId = line.accountId;
    return acc;
  };
  const each = (report: ParsedReport | null, fn: (acc: Account, v: number) => void) => {
    for (const line of report?.lines ?? []) {
      const section = asPnlSection(String(line.section));
      if (section === "other") continue;
      fn(find(section, line), line.values[0] ?? 0);
    }
  };
  each(current, (acc, v) => (acc.month += v));
  each(prior, (acc, v) => (acc.prior += v));
  for (const r of ytdReports) each(r, (acc, v) => (acc.ytd += v));

  const hasMonth = current !== null;
  const hasPrior = prior !== null;
  const hasYtd = ytd !== null;
  const pct = (v: number | null) => (v !== null && hasMonth ? ofIncome(v, summary.income) : null);
  const figures = (month: number, priorValue: number, ytdValue: number) => {
    const m = hasMonth ? round2(month) : null;
    const p = hasPrior ? round2(priorValue) : null;
    return {
      month: m,
      prior: p,
      change: m !== null && p !== null ? round2(m - p) : null,
      ytd: hasYtd ? round2(ytdValue) : null,
      pctOfIncome: pct(m),
    };
  };

  const rows: PnlRow[] = [];
  const section = (s: Exclude<PnlSection, "other">, always: boolean) => {
    const lines = accounts.filter((a) => a.section === s && (round2(a.month) || round2(a.prior) || round2(a.ytd)));
    if (!lines.length && !always) return;
    rows.push({ kind: "section", section: s, label: SECTION_LABEL[s], accountId: null, month: null, prior: null, change: null, ytd: null, pctOfIncome: null });
    for (const a of lines) rows.push({ kind: "account", section: s, label: a.label, accountId: a.accountId, ...figures(a.month, a.prior, a.ytd) });
    const f = SUMMARY_FIELD[s];
    rows.push({
      kind: "subtotal",
      section: s,
      label: `Total ${SECTION_LABEL[s].toLowerCase()}`,
      accountId: null,
      ...figures(summary[f], priorSummary?.[f] ?? 0, ytd?.[f] ?? 0),
    });
  };
  const total = (label: string, f: "grossProfit" | "netProfit") =>
    rows.push({ kind: "total", section: null, label, accountId: null, ...figures(summary[f], priorSummary?.[f] ?? 0, ytd?.[f] ?? 0) });

  section("income", true);
  section("cost_of_sales", true);
  total("Gross profit", "grossProfit");
  section("other_income", false);
  section("expenses", true);
  total("Net profit", "netProfit");
  return rows;
}

function segmentsOf(parsed: ParsedReport | null): SegmentResult[] | null {
  if (!parsed) return null;
  const list = parsed.columns
    .map((name, col) => ({ name, col }))
    .filter((c) => !/^total$/i.test(c.name.trim()))
    .map(({ name, col }) => ({ name: name.trim() || UNASSIGNED, ...pnlSummary(parsed, col) }));
  const allIncome = round2(list.reduce((a, s) => a + s.income, 0));
  return list.map((s) => ({
    name: s.name,
    income: s.income,
    costOfSales: s.costOfSales,
    grossProfit: s.grossProfit,
    gpPct: s.gpPct,
    expenses: s.expenses,
    netProfit: s.netProfit,
    shareOfIncome: ofIncome(s.income, allIncome),
  }));
}

function cashOf(parsed: ParsedReport | null): CashView | null {
  if (!parsed) return null;
  const lines: CashLine[] = [];
  let moneyIn = 0;
  let moneyOut = 0;
  for (const l of parsed.lines) {
    const section = asPnlSection(String(l.section));
    const amount = round2(l.values[0] ?? 0);
    if (section === "other" || !amount) continue;
    lines.push({ section, account: l.account, amount });
    if (section === "income" || section === "other_income") moneyIn += amount;
    else moneyOut += amount;
  }
  moneyIn = round2(moneyIn);
  moneyOut = round2(moneyOut);
  return { moneyIn, moneyOut, net: round2(moneyIn - moneyOut), lines };
}

/* Commentary */

const wholePounds = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

/** "£96,430" */
function pounds(n: number): string {
  const r = Math.round(n);
  return `${r < 0 ? "-" : ""}£${wholePounds.format(Math.abs(r))}`;
}

const pct0 = (ratio: number) => `${Math.round(ratio * 100)}%`;
const pct1 = (ratio: number) => `${(Math.round(ratio * 1000) / 10).toFixed(1)}%`;

/** "September" */
const monthWord = (month: string) => monthName(month).split(" ")[0];

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "June missing", "June and July missing", or "5 months missing" when more than three are. */
const missingWords = (months: string[]) =>
  months.length > 3 ? `${months.length} months missing` : `${listWords(months.map(monthWord))} missing`;

function commentaryFor(
  r: Omit<ManagementReport, "commentary">,
  hasMonth: boolean,
  ytdMissing: string[],
  trackingName: string,
): string[] {
  const out: string[] = [];
  const name = monthWord(r.month);
  const priorName = monthWord(addMonths(r.month, -1));
  const s = r.summary;

  if (!hasMonth) {
    out.push(`The profit and loss report for ${monthName(r.month)} has not been loaded yet.`);
  } else {
    let income = `Income was ${pounds(s.income)} in ${name}`;
    if (r.prior && r.prior.income > 0) {
      const change = Math.round(((s.income - r.prior.income) / Math.abs(r.prior.income)) * 100);
      income += change === 0 ? `, level with ${priorName}` : `, ${change > 0 ? "up" : "down"} ${Math.abs(change)}% on ${priorName}`;
    }
    out.push(`${income}.`);

    if (s.gpPct !== null) {
      let gp = `Gross margin was ${pct1(s.gpPct)}`;
      if (r.prior && r.prior.gpPct !== null) {
        const now = Math.round(s.gpPct * 1000);
        const before = Math.round(r.prior.gpPct * 1000);
        gp += now === before ? `, the same as in ${priorName}` : `, ${now > before ? "up" : "down"} from ${pct1(r.prior.gpPct)}`;
      }
      out.push(`${gp}.`);
    }

    const after = s.expenses > 0 ? ` after ${pounds(s.expenses)} of overheads` : "";
    out.push(s.netProfit >= 0 ? `Net profit was ${pounds(s.netProfit)}${after}.` : `There was a net loss of ${pounds(-s.netProfit)}${after}.`);
  }

  const named = (r.segments ?? []).filter((g) => g.name !== UNASSIGNED && g.income > 0 && g.shareOfIncome !== null);
  if (named.length) {
    const top = named.reduce((a, b) => (b.income > a.income ? b : a));
    const margin = top.gpPct !== null ? ` at a ${pct0(top.gpPct)} gross margin` : "";
    out.push(`${top.name} brought in ${pct0(top.shareOfIncome!)} of income${margin}.`);
  }

  const d = r.debtorsRaised.total;
  if (d.count) {
    out.push(d.notPaid >= 0.5 ? `${pounds(d.notPaid)} of ${name}'s invoices is still unpaid.` : `All of ${name}'s invoices have been paid.`);
  }

  if (r.ytdMonths >= 2) {
    const gaps = ytdMissing.length ? `, ${missingWords(ytdMissing)}` : "";
    const result = r.ytd.netProfit >= 0 ? `net profit is ${pounds(r.ytd.netProfit)}` : `the net loss is ${pounds(-r.ytd.netProfit)}`;
    out.push(`Year to date (${monthWord(r.ytdFrom)} to ${name}${gaps}), income is ${pounds(r.ytd.income)} and ${result}.`);
  }

  if (r.balance) {
    const day = Number(monthEnd(r.month).slice(8, 10));
    const bank = r.balance.now.bank;
    out.push(
      Math.round(bank) < 0
        ? `The bank accounts were ${pounds(-bank)} overdrawn at ${day} ${name}.`
        : `Cash at bank was ${pounds(bank)} at ${day} ${name}.`,
    );
  }

  const unassigned = (r.segments ?? []).find((g) => g.name === UNASSIGNED);
  if (unassigned && Math.round(unassigned.income) > 0 && trackingName) {
    out.push(`${pounds(unassigned.income)} of income is not tagged with a ${trackingName}.`);
  }

  return out.slice(0, 6);
}

/**
 * The management accounts for one month. Missing or malformed reports give nulls, zeros and
 * entries in `missing`; only a `month` that is not "YYYY-MM" throws.
 */
export function managementReport(input: ManagementInputs): ManagementReport {
  const month = String(input.month ?? "").trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error(`managementReport: month must be YYYY-MM, not "${input.month}"`);
  const reports = input.reports instanceof Map ? input.reports : new Map<string, unknown>();
  const trackingName = (input.trackingName ?? "").trim();
  const priorMonth = addMonths(month, -1);

  /** A key stored with no report (null or undefined) counts as missing. */
  const has = (key: string) => reports.get(key) != null;
  const parsed = new Map<string, ParsedReport | null>();
  const get = (key: string): ParsedReport | null => {
    if (!parsed.has(key)) parsed.set(key, has(key) ? parseReport(reports.get(key)) : null);
    return parsed.get(key)!;
  };
  const pnlOf = (m: string) => get(`pnl:${m}`);

  const available = [...reports.keys()]
    .filter((k) => /^pnl:\d{4}-\d{2}$/.test(k) && has(k))
    .map((k) => k.slice(4))
    .sort()
    .reverse();

  const current = pnlOf(month);
  const priorReport = pnlOf(priorMonth);
  const summary = current ? pnlSummary(current) : makeSummary(0, 0, 0, 0);
  const prior = priorReport ? pnlSummary(priorReport) : null;

  const ytdFrom = fyStart(month, input.fyEndMonth);
  const ytdAll = monthsBetween(ytdFrom, month);
  const ytdPresent = ytdAll.filter((m) => pnlOf(m) !== null);
  const ytdMissing = ytdAll.filter((m) => pnlOf(m) === null);
  const ytdReports = ytdPresent.map((m) => pnlOf(m)!);
  const ytd = addSummaries(ytdReports.map((p) => pnlSummary(p)));

  const missing: string[] = [];
  const need = (key: string) => {
    if (!has(key) && !missing.includes(key)) missing.push(key);
  };
  need(`pnl:${month}`);
  need(`pnl:${priorMonth}`);
  if (trackingName) need(`pnl-tracking:${month}`);
  need(`pnl-cash:${month}`);
  need(`bs:${month}`);
  need(`bs:${priorMonth}`);
  for (const m of ytdMissing) need(`pnl:${m}`);

  const trend: TrendPoint[] = [];
  for (let i = 11; i >= 0; i--) {
    const m = addMonths(month, -i);
    const p = pnlOf(m);
    if (!p) continue;
    const t = pnlSummary(p);
    trend.push({ month: m, income: t.income, costOfSales: t.costOfSales, grossProfit: t.grossProfit, gpPct: t.gpPct, expenses: t.expenses, netProfit: t.netProfit });
  }

  const bsNow = has(`bs:${month}`) ? balanceSummary(reports.get(`bs:${month}`)) : null;
  const bsPrior = has(`bs:${priorMonth}`) ? balanceSummary(reports.get(`bs:${priorMonth}`)) : null;
  const balance = bsNow ? { now: bsNow, prior: bsPrior } : null;

  const report: Omit<ManagementReport, "commentary"> = {
    month,
    available,
    missing,
    summary,
    prior,
    ytdFrom,
    ytd,
    ytdMonths: ytdPresent.length,
    ytdComplete: ytdMissing.length === 0,
    pnl: statementRows(current, priorReport, ytdReports, summary, prior, ytdReports.length ? ytd : null),
    trend,
    segments: segmentsOf(get(`pnl-tracking:${month}`)),
    cash: cashOf(get(`pnl-cash:${month}`)),
    balance,
    debtorsRaised: debtorsRaised(input.invoices ?? [], month, trackingName, input.customerTypes),
    kpis: {
      income: summary.income,
      grossProfit: summary.grossProfit,
      gpPct: summary.gpPct,
      netProfit: summary.netProfit,
      cashAtBank: bsNow ? bsNow.bank : null,
      debtors: bsNow ? bsNow.debtors : null,
      creditors: bsNow ? bsNow.creditors : null,
      vatOwed: bsNow ? bsNow.vat : null,
    },
  };
  return { ...report, commentary: commentaryFor(report, current !== null, ytdMissing, trackingName) };
}
