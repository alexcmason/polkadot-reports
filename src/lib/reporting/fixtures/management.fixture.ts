/*
 * Polkadot Property Services' Xero reports, shaped as the raw `Reports[0]` JSON the sync stores.
 *
 * September 2026 is the client's real profit and loss. The other months, the Sales Type
 * split, the payments-only P&L, both balance sheets and the invoices are made up but
 * plausible, chosen so that every total can be checked by hand. June 2026 is deliberately
 * missing so the year to date (April to March year) is incomplete.
 */
import type { XeroInvoice, XeroLine } from "../types";
import type { ManagementInputs } from "../management";

/* Builders for Xero-shaped report JSON */

export type ReportCell = { Value: string; Attributes?: { Id: string; Value: string }[] };
export type ReportRow = {
  RowType: "Header" | "Section" | "Row" | "SummaryRow";
  Title?: string;
  Cells?: ReportCell[];
  Rows?: ReportRow[];
};
export type XeroReport = {
  ReportID: string;
  ReportName: string;
  ReportType: string;
  ReportTitles: string[];
  ReportDate: string;
  Rows: ReportRow[];
};

/** An account line: the account name, then one amount per column. */
export type Line = [string, ...number[]];
export type SectionSpec = { title: string; rows: Line[] };

/** A stable fake Xero account id for an account name, so the same account matches across months. */
export function accountId(name: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const ch of name) {
    h1 = Math.imul(h1 ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ ch.charCodeAt(0), 0x5bd1e995) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")).repeat(2);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Xero writes amounts as strings with two decimals, and leaves zero blank. */
const amount = (n: number) => (Math.abs(n) < 0.005 ? "" : n.toFixed(2));
const round = (n: number) => Math.round(n * 100) / 100;

function header(columns: string[]): ReportRow {
  return { RowType: "Header", Cells: [{ Value: "" }, ...columns.map((c) => ({ Value: c }))] };
}

function accountRow([name, ...values]: Line, width: number): ReportRow {
  const attrs = [{ Id: "account", Value: accountId(name) }];
  return {
    RowType: "Row",
    Cells: [{ Value: name, Attributes: attrs }, ...Array.from({ length: width }, (_, i) => ({ Value: amount(values[i] ?? 0), Attributes: attrs }))],
  };
}

const columnTotals = (rows: Line[], width: number) =>
  Array.from({ length: width }, (_, i) => round(rows.reduce((a, [, ...v]) => a + (v[i] ?? 0), 0)));

function summaryRow(label: string, values: number[]): ReportRow {
  return { RowType: "SummaryRow", Cells: [{ Value: label }, ...values.map((v) => ({ Value: amount(v) }))] };
}

function section(title: string, rows: Line[], width: number, totalLabel: string): ReportRow {
  return { RowType: "Section", Title: title, Rows: [...rows.map((r) => accountRow(r, width)), summaryRow(totalLabel, columnTotals(rows, width))] };
}

/** A single-row untitled section, as Xero shows Gross Profit, Net Profit and Net Assets. */
const untitled = (label: string, values: number[], type: "Row" | "SummaryRow" = "Row"): ReportRow => ({
  RowType: "Section",
  Title: "",
  Rows: [{ RowType: type, Cells: [{ Value: label }, ...values.map((v) => ({ Value: amount(v) }))] }],
});

/**
 * A ProfitAndLoss report. Sections are emitted in the order given, each with its "Total ..."
 * summary row; Gross Profit follows the cost of sales and Net Profit comes last, like Xero.
 */
export function pnlReport({ columns, sections, date = "30 September 2026" }: { columns: string[]; sections: SectionSpec[]; date?: string }): XeroReport {
  const width = columns.length;
  const kind = (title: string) =>
    /cost of sales/i.test(title) ? "cos" : /other income/i.test(title) ? "other" : /expenses/i.test(title) ? "exp" : "income";
  const sums = { income: Array(width).fill(0), cos: Array(width).fill(0), other: Array(width).fill(0), exp: Array(width).fill(0) };
  const rows: ReportRow[] = [header(columns)];
  let grossDone = false;
  const gross = () => sums.income.map((v, i) => round(v - sums.cos[i]));
  for (const s of sections) {
    const k = kind(s.title);
    if (k !== "income" && k !== "cos" && !grossDone && sums.cos.some((v) => v)) {
      rows.push(untitled("Gross Profit", gross()));
      grossDone = true;
    }
    columnTotals(s.rows, width).forEach((v, i) => (sums[k][i] += v));
    rows.push(section(s.title, s.rows, width, `Total ${s.title.replace(/^(Less|Plus)\s+/i, "")}`));
  }
  if (!grossDone && sums.cos.some((v) => v)) rows.push(untitled("Gross Profit", gross()));
  rows.push(untitled("Net Profit", gross().map((v, i) => round(v + sums.other[i] - sums.exp[i]))));
  return {
    ReportID: "ProfitAndLoss",
    ReportName: "Profit and Loss",
    ReportType: "ProfitAndLoss",
    ReportTitles: ["Profit & Loss", "Polkadot Property Services Ltd", `For the month ended ${date}`],
    ReportDate: "8 October 2026",
    Rows: rows,
  };
}

/**
 * A BalanceSheet report. Section titles containing "Liabilities" are liabilities, "Equity" is
 * equity and everything else is an asset. Emits the Assets / Liabilities headings, the
 * Total Assets, Total Liabilities and Net Assets lines and each "Total ..." row.
 */
export function bsReport({ columns, sections, date = "30 September 2026" }: { columns: string[]; sections: SectionSpec[]; date?: string }): XeroReport {
  const width = columns.length;
  const kind = (title: string) => (/liabilit/i.test(title) ? "liab" : /equity/i.test(title) ? "equity" : "asset");
  const assets = sections.filter((s) => kind(s.title) === "asset");
  const liabilities = sections.filter((s) => kind(s.title) === "liab");
  const equity = sections.filter((s) => kind(s.title) === "equity");
  const total = (list: SectionSpec[]) => columnTotals(list.flatMap((s) => s.rows), width);
  const totalAssets = total(assets);
  const totalLiabilities = total(liabilities);
  return {
    ReportID: "BalanceSheet",
    ReportName: "Balance Sheet",
    ReportType: "BalanceSheet",
    ReportTitles: ["Balance Sheet", "Polkadot Property Services Ltd", `As at ${date}`],
    ReportDate: "8 October 2026",
    Rows: [
      header(columns),
      { RowType: "Section", Title: "Assets", Rows: [] },
      ...assets.map((s) => section(s.title, s.rows, width, `Total ${s.title}`)),
      untitled("Total Assets", totalAssets, "SummaryRow"),
      { RowType: "Section", Title: "Liabilities", Rows: [] },
      ...liabilities.map((s) => section(s.title, s.rows, width, `Total ${s.title}`)),
      untitled("Total Liabilities", totalLiabilities, "SummaryRow"),
      untitled("Net Assets", totalAssets.map((v, i) => round(v - totalLiabilities[i]))),
      ...equity.map((s) => section(s.title, s.rows, width, `Total ${s.title}`)),
    ],
  };
}

/* Profit and loss, one column per month */

const SEP_INCOME: Line[] = [
  ["Sales", 96430.15],
  ["SM", 0],
  ["IN", 0],
  ["RE", 0],
  ["Other Revenue", 0],
  ["Interest Income", 0],
  ["Income holding account", 0],
];

const SEP_COS: Line[] = [
  ["CIS Labour Expense", 32157.82],
  ["Installation", 19927.08],
  ["S&M", 4619.78],
  ["CIS Materials Purchased", 2042.37],
  ["Refurbishment works", 650.0],
  ["Direct Expenses", 176.44],
];

const SEP_EXPENSES: Line[] = [
  ["Motor Vehicle Expenses", 2264.77],
  ["IT Software and Consumables", 1380.0],
  ["Audit & Accountancy fees", 1200.0],
  ["Commission", 774.29],
  ["Insurance", 511.43],
  ["Travelling expenses", 489.77],
  ["Subscriptions", 450.69],
  ["Rent", 208.33],
  ["Entertainment-100% business", 169.35],
  ["Advertising & Marketing", 143.34],
  ["Telephone & Internet", 46.07],
  ["Entertainment - 0%", 22.9],
  ["Bank Fees", 9.0],
];

/** The client's real September 2026 P&L. */
export const SEP_PNL = pnlReport({
  columns: ["30 Sep 26"],
  sections: [
    { title: "Income", rows: SEP_INCOME },
    { title: "Less Cost of Sales", rows: SEP_COS },
    { title: "Less Operating Expenses", rows: SEP_EXPENSES },
  ],
});

/** August 2026 (made up). Repairs and Maintenance appears only this month; Entertainment - 0% does not. */
export const AUG_PNL = pnlReport({
  columns: ["31 Aug 26"],
  date: "31 August 2026",
  sections: [
    { title: "Income", rows: [["Sales", 86100.0], ["Interest Income", 0]] },
    {
      title: "Less Cost of Sales",
      rows: [
        ["CIS Labour Expense", 28940.0],
        ["Installation", 13450.5],
        ["S&M", 5120.3],
        ["CIS Materials Purchased", 1889.2],
        ["Refurbishment works", 1280.0],
        ["Direct Expenses", 200.0],
      ],
    },
    {
      title: "Less Operating Expenses",
      rows: [
        ["Motor Vehicle Expenses", 2105.4],
        ["IT Software and Consumables", 1380.0],
        ["Audit & Accountancy fees", 1200.0],
        ["Commission", 640.0],
        ["Insurance", 511.43],
        ["Travelling expenses", 320.15],
        ["Subscriptions", 450.69],
        ["Rent", 208.33],
        ["Entertainment-100% business", 95.2],
        ["Advertising & Marketing", 300.0],
        ["Telephone & Internet", 46.07],
        ["Bank Fees", 9.0],
        ["Repairs and Maintenance", 180.0],
      ],
    },
  ],
});

/** A short P&L for the earlier months: sales, three cost lines, four overheads and optional bank interest. */
function simplePnl(column: string, sales: number, [labour, install, sm]: number[], motor: number, interest = 0): XeroReport {
  const sections: SectionSpec[] = [
    { title: "Income", rows: [["Sales", sales]] },
    { title: "Less Cost of Sales", rows: [["CIS Labour Expense", labour], ["Installation", install], ["S&M", sm]] },
  ];
  if (interest) sections.push({ title: "Plus Other Income", rows: [["Bank interest received", interest]] });
  sections.push({
    title: "Less Operating Expenses",
    rows: [["Motor Vehicle Expenses", motor], ["Audit & Accountancy fees", 1200], ["Rent", 208.33], ["IT Software and Consumables", 1380]],
  });
  return pnlReport({ columns: [column], sections });
}

/** March 2026 belongs to the previous financial year (April to March). */
export const MAR_PNL = simplePnl("31 Mar 26", 74000, [26000, 11500, 4000], 1850);
export const APR_PNL = simplePnl("30 Apr 26", 78200, [27100, 12000, 4200], 1900);
export const MAY_PNL = simplePnl("31 May 26", 81450, [28300, 13100, 4400], 2050);
export const JUL_PNL = simplePnl("31 Jul 26", 90300, [31000, 15500, 4800], 2200, 12.4);

/* September by Sales Type: [account, IN, RE, S&M, Unassigned], with the Total column added */

const withTotal = (rows: Line[]): Line[] => rows.map(([name, ...v]) => [name, ...v, round(v.reduce((a, b) => a + b, 0))] as Line);

export const SEP_TRACKING = pnlReport({
  columns: ["IN", "RE", "S&M", "Unassigned", "Total"],
  sections: [
    { title: "Income", rows: withTotal([["Sales", 30120.4, 14280.0, 50779.75, 1250.0], ["Interest Income", 0, 0, 0, 0]]) },
    {
      title: "Less Cost of Sales",
      rows: withTotal([
        ["CIS Labour Expense", 2400.0, 8940.0, 20817.82, 0],
        ["Installation", 19927.08, 0, 0, 0],
        ["S&M", 0, 0, 4619.78, 0],
        ["CIS Materials Purchased", 0, 400.0, 1642.37, 0],
        ["Refurbishment works", 0, 650.0, 0, 0],
        ["Direct Expenses", 0, 0, 0, 176.44],
      ]),
    },
    { title: "Less Operating Expenses", rows: withTotal(SEP_EXPENSES.map(([name, v]) => [name, 0, 0, 0, v ?? 0] as Line)) },
  ],
});

/* September on a payments-only (cash) basis */

export const SEP_CASH = pnlReport({
  columns: ["30 Sep 26"],
  sections: [
    { title: "Income", rows: [["Sales", 88750.4], ["Interest Income", 0]] },
    {
      title: "Less Cost of Sales",
      rows: [
        ["CIS Labour Expense", 31200.0],
        ["Installation", 18400.0],
        ["S&M", 4300.0],
        ["CIS Materials Purchased", 1950.0],
      ],
    },
    {
      title: "Less Operating Expenses",
      rows: [
        ["Motor Vehicle Expenses", 2264.77],
        ["IT Software and Consumables", 1380.0],
        ["Audit & Accountancy fees", 1200.0],
        ["Insurance", 511.43],
        ["Rent", 208.33],
        ["Bank Fees", 9.0],
      ],
    },
  ],
});

/* Balance sheets: [account, this year, same date last year] */

export const SEP_BS = bsReport({
  columns: ["30 Sep 26", "30 Sep 25"],
  sections: [
    { title: "Bank", rows: [["Business Current Account", 48210.55, 30110.0], ["Business Savings", 20000.0, 10000.0]] },
    { title: "Current Assets", rows: [["Accounts Receivable", 41876.2, 28000.0], ["Prepayments", 1250.0, 900.0]] },
    { title: "Fixed Assets", rows: [["Motor Vehicles", 18500.0, 24000.0], ["Office Equipment", 2150.0, 2600.0]] },
    {
      title: "Current Liabilities",
      rows: [
        ["Accounts Payable", 22314.6, 15000.0],
        ["VAT", 15820.45, 11000.0],
        ["PAYE Payable", 1240.3, 1100.0],
        ["CIS Liability", 6431.56, 5200.0],
        ["Corporation Tax", 9800.0, 7500.0],
        ["Directors' Loan Account", 3000.0, 3000.0],
        ["Wages Payable - Payroll", 850.0, 800.0],
      ],
    },
    { title: "Non-Current Liabilities", rows: [["Bank Loan", 12000.0, 18000.0]] },
    { title: "Equity", rows: [["Share Capital", 100.0, 100.0], ["Retained Earnings", 31243.12, 20000.0], ["Current Year Earnings", 29186.72, 13910.0]] },
  ],
});

export const AUG_BS = bsReport({
  columns: ["31 Aug 26", "31 Aug 25"],
  date: "31 August 2026",
  sections: [
    { title: "Bank", rows: [["Business Current Account", 39870.1, 28000.0], ["Business Savings", 20000.0, 10000.0]] },
    { title: "Current Assets", rows: [["Accounts Receivable", 36540.0, 26000.0], ["Prepayments", 1500.0, 1000.0]] },
    { title: "Fixed Assets", rows: [["Motor Vehicles", 19000.0, 24500.0], ["Office Equipment", 2300.0, 2700.0]] },
    {
      title: "Current Liabilities",
      rows: [
        ["Accounts Payable", 19880.25, 14000.0],
        ["VAT", 12410.8, 10000.0],
        ["PAYE Payable", 1180.0, 1050.0],
        ["CIS Liability", 5960.12, 5000.0],
        ["Corporation Tax", 9800.0, 7500.0],
        ["Directors' Loan Account", 3000.0, 3000.0],
      ],
    },
    { title: "Non-Current Liabilities", rows: [["Bank Loan", 12500.0, 18500.0]] },
    { title: "Equity", rows: [["Share Capital", 100.0, 100.0], ["Retained Earnings", 32093.12, 20000.0], ["Current Year Earnings", 22285.81, 13050.0]] },
  ],
});

/* Sales invoices */

const ST = "Sales Type";

type InvoiceSpec = {
  number: string;
  contact: string;
  date: string;
  status: string;
  /** [line amount ex VAT, Sales Type option or "" for none, other tracking as "Name:Option"] */
  lines: [number, string, string?][];
  total: number;
  paid?: number;
  credited?: number;
  type?: "ACCREC" | "ACCPAY";
};

function invoice(spec: InvoiceSpec): XeroInvoice {
  const lines: XeroLine[] = spec.lines.map(([lineAmount, option, other]) => {
    const tracking: { name: string; option: string }[] = [];
    if (option) tracking.push({ name: ST, option });
    if (other) {
      const [name, opt] = other.split(":");
      tracking.push({ name, option: opt });
    }
    return { description: "Works", quantity: 1, unitAmount: lineAmount, lineAmount, accountCode: "200", taxAmount: 0, tracking };
  });
  const subTotal = round(lines.reduce((a, l) => a + l.lineAmount, 0));
  const paid = spec.paid ?? 0;
  const credited = spec.credited ?? 0;
  return {
    id: `inv-${spec.number}`,
    type: spec.type ?? "ACCREC",
    number: spec.number,
    reference: "",
    contactId: `c-${spec.contact}`,
    contactName: spec.contact,
    date: spec.date,
    dueDate: spec.date,
    status: spec.status,
    subTotal,
    totalTax: round(spec.total - subTotal),
    total: spec.total,
    amountDue: round(spec.total - paid - credited),
    amountPaid: paid,
    amountCredited: credited,
    fullyPaidOn: spec.status === "PAID" ? spec.date : null,
    cisDeduction: 0,
    lines,
  };
}

export const INVOICES: XeroInvoice[] = [
  // Business customers by name
  invoice({ number: "21240", contact: "Bold and Reeves Ltd", date: "2026-09-17", status: "PAID", lines: [[750, "S&M"]], total: 900, paid: 900 }),
  invoice({ number: "21299", contact: "Bold and Reeves Ltd", date: "2026-09-24", status: "AUTHORISED", lines: [[139.38, "S&M"]], total: 167.26 }),
  // Installations
  invoice({ number: "21140", contact: "Danielle Ahearne", date: "2026-09-16", status: "PAID", lines: [[2220, "IN"]], total: 2664, paid: 2664 }),
  invoice({ number: "21106C", contact: "Inessa Taylor", date: "2026-09-23", status: "AUTHORISED", lines: [[10000, "IN"]], total: 10000 }),
  // Only the Sales Type tracking counts: the larger line is tagged with another category
  invoice({ number: "21315", contact: "Wandle Housing Trust", date: "2026-09-29", status: "SUBMITTED", lines: [[600, "", "Region:South"], [100, "IN"]], total: 840 }),
  // Refurbishment
  invoice({ number: "20356", contact: "Simon Kellett", date: "2026-09-10", status: "AUTHORISED", lines: [[14669, "RE"]], total: 17602.8 }),
  invoice({ number: "20290A", contact: "Chris Lonie", date: "2026-09-11", status: "AUTHORISED", lines: [[11345, "RE"]], total: 13614, paid: 8000 }),
  // Mixed tracking: RE has the largest single line, but S&M has the most in total
  invoice({ number: "21310", contact: "Harriet Cole", date: "2026-09-21", status: "AUTHORISED", lines: [[500, "RE"], [300, "S&M"], [300, "S&M"]], total: 1320 }),
  // ServiceM8 overrides the name: Jess Lindvall books for a business, Brixton Lettings is an individual landlord
  invoice({ number: "21275", contact: "Jess Lindvall", date: "2026-09-17", status: "AUTHORISED", lines: [[278, "S&M"]], total: 333.6 }),
  invoice({ number: "21301", contact: "Brixton Lettings", date: "2026-09-25", status: "PAID", lines: [[450, "S&M"]], total: 540, paid: 540 }),
  // No tracking at all, settled by a credit note
  invoice({ number: "21330", contact: "Marion Guimard", date: "2026-09-28", status: "PAID", lines: [[229.5, ""]], total: 275.4, credited: 275.4 }),
  // Left out: voided, draft, August, and a supplier bill
  invoice({ number: "21227", contact: "Isabela Melly", date: "2026-09-17", status: "VOIDED", lines: [[280, "S&M"]], total: 336 }),
  invoice({ number: "21400", contact: "Clapham Estates Ltd", date: "2026-09-30", status: "DRAFT", lines: [[5000, "RE"]], total: 6000 }),
  invoice({ number: "21190", contact: "Bold and Reeves Ltd", date: "2026-08-28", status: "AUTHORISED", lines: [[400, "S&M"]], total: 480 }),
  invoice({ number: "INV-0040", contact: "JN Heating Solutions", date: "2026-09-10", status: "AUTHORISED", lines: [[700, "S&M"]], total: 700, type: "ACCPAY" }),
];

/** Job number -> customer is an individual, as ServiceM8 records it. */
export const CUSTOMER_TYPES = new Map<string, boolean>([
  ["21275", false],
  ["21301", true],
]);

export function managementReports(): Map<string, unknown> {
  return new Map<string, unknown>([
    ["pnl:2026-09", SEP_PNL],
    ["pnl:2026-08", AUG_PNL],
    ["pnl:2026-07", JUL_PNL],
    // no pnl:2026-06
    ["pnl:2026-05", MAY_PNL],
    ["pnl:2026-04", APR_PNL],
    ["pnl:2026-03", MAR_PNL],
    ["pnl-tracking:2026-09", SEP_TRACKING],
    ["pnl-cash:2026-09", SEP_CASH],
    ["bs:2026-09", SEP_BS],
    ["bs:2026-08", AUG_BS],
  ]);
}

/** September 2026 management inputs. The financial year end defaults to December; pass 3 for April to March. */
export function managementInputs(overrides: Partial<ManagementInputs> = {}): ManagementInputs {
  return {
    month: "2026-09",
    reports: managementReports(),
    invoices: INVOICES,
    trackingName: ST,
    fyEndMonth: 12,
    customerTypes: CUSTOMER_TYPES,
    ...overrides,
  };
}
