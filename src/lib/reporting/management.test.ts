import { test } from "node:test";
import assert from "node:assert/strict";
import {
  balanceSummary,
  classifySection,
  debtorsRaised,
  invoiceCustomerType,
  invoiceSegment,
  managementReport,
  parseReport,
  pnlSummary,
  type ManagementReport,
  type PnlRow,
} from "./management";
import {
  AUG_BS,
  AUG_PNL,
  INVOICES,
  SEP_BS,
  SEP_CASH,
  SEP_PNL,
  SEP_TRACKING,
  accountId,
  bsReport,
  managementInputs,
  pnlReport,
} from "./fixtures/management.fixture";

const report = managementReport(managementInputs({ fyEndMonth: 3 }));
const close = (actual: number | null | undefined, expected: number, places = 4) => {
  assert.ok(actual !== null && actual !== undefined, `expected ${expected}, got ${actual}`);
  assert.ok(Math.abs(actual - expected) < 10 ** -places, `expected ${expected}, got ${actual}`);
};
const row = (r: ManagementReport, label: string, kind: PnlRow["kind"] = "account"): PnlRow => {
  const found = r.pnl.find((x) => x.label === label && x.kind === kind);
  assert.ok(found, `no ${kind} row ${label}`);
  return found;
};

/* Parsing */

test("parseReport reads columns, sections, account ids and amounts like Xero sends them", () => {
  const p = parseReport(SEP_PNL);
  assert.deepEqual(p.columns, ["30 Sep 26"]);
  const sales = p.lines.find((l) => l.account === "Sales");
  assert.deepEqual(sales, { section: "income", account: "Sales", accountId: accountId("Sales"), values: [96430.15] });
  assert.equal(p.lines.find((l) => l.account === "Interest Income")?.values[0], 0, "blank cell is zero");
  assert.equal(p.lines.find((l) => l.account === "CIS Labour Expense")?.section, "cost_of_sales");
  assert.equal(p.lines.find((l) => l.account === "Bank Fees")?.section, "expenses");
  // Summary rows and the untitled Gross Profit / Net Profit sections are not account lines
  for (const label of ["Total Income", "Total Cost of Sales", "Gross Profit", "Net Profit"]) {
    assert.ok(!p.lines.some((l) => l.account === label), label);
  }
  assert.equal(p.lines.length, 7 + 6 + 13);
});

test("parseReport keeps balance sheet section titles as Xero gives them", () => {
  const p = parseReport(SEP_BS);
  assert.deepEqual(p.columns, ["30 Sep 26", "30 Sep 25"]);
  assert.equal(p.lines.find((l) => l.account === "Accounts Receivable")?.section, "Current Assets");
  assert.deepEqual(p.lines.find((l) => l.account === "VAT")?.values, [15820.45, 11000]);
  assert.ok(!p.lines.some((l) => /^(Total|Net Assets)/.test(l.account)));
});

test("classifySection knows Xero's P&L titles and sends anything else to other", () => {
  assert.equal(classifySection("Income"), "income");
  assert.equal(classifySection("Trading Income"), "income");
  assert.equal(classifySection("Less Cost of Sales"), "cost_of_sales");
  assert.equal(classifySection("Cost of Sales"), "cost_of_sales");
  assert.equal(classifySection("Plus Other Income"), "other_income");
  assert.equal(classifySection("Other Income"), "other_income");
  assert.equal(classifySection("Less Operating Expenses"), "expenses");
  assert.equal(classifySection("Operating Expenses"), "expenses");
  assert.equal(classifySection(""), "other");
  assert.equal(classifySection("Something new"), "other");
});

test("parsers tolerate empty and garbage input", () => {
  for (const junk of [null, undefined, "", "nonsense", 42, [], {}, { Rows: "nope" }, { Rows: [null, 1, "x", { RowType: "Row" }] }]) {
    assert.deepEqual(parseReport(junk), { columns: [], lines: [] });
    const b = balanceSummary(junk);
    assert.ok(Object.values(b).every((v) => v === 0));
  }
  // The whole API response is accepted as well as Reports[0]
  assert.equal(parseReport({ Reports: [SEP_PNL] }).lines.length, parseReport(SEP_PNL).lines.length);
  // Odd cells: commas, brackets, text, missing cells, and an unknown section
  const odd = parseReport({
    Rows: [
      { RowType: "Header", Cells: [{ Value: "" }, { Value: "A" }, { Value: "B" }] },
      {
        RowType: "Section",
        Title: "Income",
        Rows: [
          { RowType: "Row", Cells: [{ Value: "Sales" }, { Value: "1,850.00" }, { Value: "(12.50)" }] },
          { RowType: "Row", Cells: [{ Value: "Fees" }, { Value: "n/a" }] },
          { RowType: "Row", Cells: [{ Value: "" }, { Value: "5" }] },
        ],
      },
      { RowType: "Section", Title: "Mystery", Rows: [{ RowType: "Row", Cells: [{ Value: "Thing" }, { Value: "7" }] }] },
    ],
  });
  assert.deepEqual(odd.columns, ["A", "B"]);
  assert.deepEqual(
    odd.lines.map((l) => [l.section, l.account, l.accountId, l.values]),
    [
      ["income", "Sales", null, [1850, -12.5]],
      ["income", "Fees", null, [0, 0]],
      ["other", "Thing", null, [7, 0]],
    ],
  );
  assert.equal(pnlSummary(odd).income, 1850);
  assert.equal(pnlSummary(odd, 1).income, -12.5);
  assert.equal(pnlSummary(odd, 5).income, 0);
});

test("a report with nothing synced is empty, not an error", () => {
  const r = managementReport({ month: "2026-09", reports: new Map(), invoices: [], trackingName: "Sales Type", fyEndMonth: 3 });
  assert.equal(r.summary.income, 0);
  assert.equal(r.summary.gpPct, null);
  assert.equal(r.prior, null);
  assert.equal(r.ytdMonths, 0);
  assert.equal(r.ytdComplete, false);
  assert.deepEqual(r.available, []);
  assert.deepEqual(r.trend, []);
  assert.equal(r.segments, null);
  assert.equal(r.cash, null);
  assert.equal(r.balance, null);
  assert.equal(r.kpis.cashAtBank, null);
  assert.deepEqual(r.debtorsRaised.total, { count: 0, total: 0, paid: 0, notPaid: 0 });
  assert.deepEqual(r.missing.slice(0, 6), ["pnl:2026-09", "pnl:2026-08", "pnl-tracking:2026-09", "pnl-cash:2026-09", "bs:2026-09", "bs:2026-08"]);
  assert.ok(r.missing.includes("pnl:2026-04"));
  assert.ok(r.pnl.every((x) => x.kind !== "account"));
  assert.ok(r.pnl.every((x) => x.month === null && x.ytd === null));
  assert.ok(r.commentary.length >= 1);
  assert.match(r.commentary[0], /September 2026/);
});

/* The month */

test("September 2026 summary matches the client's Xero P&L", () => {
  const s = pnlSummary(parseReport(SEP_PNL));
  assert.equal(s.income, 96430.15);
  assert.equal(s.costOfSales, 59573.49);
  assert.equal(s.grossProfit, 36856.66);
  assert.equal(s.otherIncome, 0);
  assert.equal(s.expenses, 7669.94);
  assert.equal(s.netProfit, 29186.72);
  close(s.gpPct, 0.3822);
  close(s.npPct, 0.3027);
  assert.deepEqual(report.summary, s);
  assert.equal(report.month, "2026-09");
});

test("prior month and the change on it", () => {
  assert.ok(report.prior);
  assert.equal(report.prior.income, 86100);
  assert.equal(report.prior.costOfSales, 50880);
  assert.equal(report.prior.grossProfit, 35220);
  assert.equal(report.prior.expenses, 7446.27);
  assert.equal(report.prior.netProfit, 27773.73);

  const sales = row(report, "Sales");
  assert.deepEqual([sales.month, sales.prior, sales.change], [96430.15, 86100, 10330.15]);
  close(sales.pctOfIncome, 1);
  const labour = row(report, "CIS Labour Expense");
  assert.deepEqual([labour.month, labour.prior, labour.change], [32157.82, 28940, 3217.82]);
  // Only in September, and only in August
  const ent = row(report, "Entertainment - 0%");
  assert.deepEqual([ent.month, ent.prior, ent.change], [22.9, 0, 22.9]);
  const repairs = row(report, "Repairs and Maintenance");
  assert.deepEqual([repairs.month, repairs.prior, repairs.change, repairs.ytd], [0, 180, -180, 180]);
  assert.equal(repairs.section, "expenses");
});

test("year to date runs April to September for a March year end, with June missing", () => {
  assert.equal(report.ytdFrom, "2026-04");
  assert.equal(report.ytdMonths, 5);
  assert.equal(report.ytdComplete, false);
  assert.equal(report.ytd.income, 432480.15);
  assert.equal(report.ytd.costOfSales, 250853.49);
  assert.equal(report.ytd.grossProfit, 181626.66);
  assert.equal(report.ytd.otherIncome, 12.4);
  assert.equal(report.ytd.expenses, 29631.2);
  assert.equal(report.ytd.netProfit, 152007.86);
  assert.deepEqual(report.missing, ["pnl:2026-06"]);
  // March is in the previous financial year
  assert.equal(row(report, "Sales").ytd, 432480.15);
  assert.equal(row(report, "CIS Labour Expense").ytd, 147497.82);
});

test("year to date with a December year end, and when every month is there", () => {
  const dec = managementReport(managementInputs());
  assert.equal(dec.ytdFrom, "2026-01");
  assert.equal(dec.ytdMonths, 6);
  assert.equal(dec.ytdComplete, false);
  assert.equal(dec.ytd.income, 432480.15 + 74000);
  assert.deepEqual(dec.missing, ["pnl:2026-01", "pnl:2026-02", "pnl:2026-06"]);

  // A year starting in August (July year end): August and September, both present
  const jul = managementReport(managementInputs({ fyEndMonth: 7 }));
  assert.equal(jul.ytdFrom, "2026-08");
  assert.equal(jul.ytdMonths, 2);
  assert.equal(jul.ytdComplete, true);
  assert.equal(jul.ytd.income, 96430.15 + 86100);
  assert.deepEqual(jul.missing, []);

  // October is the first month of an October to September year
  const oct = managementReport(managementInputs({ month: "2026-10", fyEndMonth: 9 }));
  assert.equal(oct.ytdFrom, "2026-10");
});

test("the statement lists sections in order with subtotals, and omits accounts that are zero throughout", () => {
  const shape = report.pnl.filter((x) => x.kind !== "account").map((x) => `${x.kind}:${x.label}`);
  assert.deepEqual(shape, [
    "section:Income",
    "subtotal:Total income",
    "section:Cost of sales",
    "subtotal:Total cost of sales",
    "total:Gross profit",
    "section:Other income",
    "subtotal:Total other income",
    "section:Operating expenses",
    "subtotal:Total operating expenses",
    "total:Net profit",
  ]);
  for (const zero of ["SM", "IN", "RE", "Other Revenue", "Interest Income", "Income holding account"]) {
    assert.ok(!report.pnl.some((x) => x.label === zero), `${zero} should be omitted`);
  }
  const incomeAccounts = report.pnl.filter((x) => x.kind === "account" && x.section === "income").map((x) => x.label);
  assert.deepEqual(incomeAccounts, ["Sales"]);
  // Bank interest is only in July, so it shows with a year-to-date figure alone
  const interest = row(report, "Bank interest received");
  assert.deepEqual([interest.month, interest.prior, interest.ytd], [0, 0, 12.4]);

  const heading = row(report, "Income", "section");
  assert.deepEqual([heading.month, heading.prior, heading.change, heading.ytd, heading.pctOfIncome], [null, null, null, null, null]);
  const cos = row(report, "Total cost of sales", "subtotal");
  assert.deepEqual([cos.month, cos.prior, cos.change, cos.ytd], [59573.49, 50880, 8693.49, 250853.49]);
  const gp = row(report, "Gross profit", "total");
  assert.deepEqual([gp.month, gp.prior, gp.change, gp.ytd], [36856.66, 35220, 1636.66, 181626.66]);
  close(gp.pctOfIncome, 0.3822);
  const np = row(report, "Net profit", "total");
  assert.deepEqual([np.month, np.prior, np.ytd], [29186.72, 27773.73, 152007.86]);

  // The account lines add up to their subtotals
  for (const s of ["income", "cost_of_sales", "expenses"] as const) {
    const sum = report.pnl.filter((x) => x.kind === "account" && x.section === s).reduce((a, x) => a + (x.month ?? 0), 0);
    const sub = report.pnl.find((x) => x.kind === "subtotal" && x.section === s);
    close(sum, sub?.month ?? NaN, 2);
  }
});

test("a statement without Other income anywhere leaves that section out", () => {
  const reports = new Map<string, unknown>([["pnl:2026-09", SEP_PNL]]);
  const r = managementReport({ month: "2026-09", reports, invoices: [], trackingName: "", fyEndMonth: 9 });
  assert.ok(!r.pnl.some((x) => x.section === "other_income"));
  assert.ok(r.pnl.filter((x) => x.kind === "account").every((x) => x.prior === null && x.change === null));
  assert.ok(!r.missing.some((k) => k.startsWith("pnl-tracking:")), "no tracking category, so no tracking report needed");
});

test("accounts match across months by Xero account id, even when renamed", () => {
  const sep = pnlReport({ columns: ["30 Sep 26"], sections: [{ title: "Income", rows: [["Sales", 100]] }] });
  const aug = pnlReport({ columns: ["31 Aug 26"], sections: [{ title: "Income", rows: [["Sales", 80]] }] });
  // Rename August's account but keep its id
  const augRows = JSON.parse(JSON.stringify(aug).replaceAll('"Value":"Sales"', '"Value":"Sales (old name)"'));
  const r = managementReport({
    month: "2026-09",
    reports: new Map<string, unknown>([["pnl:2026-09", sep], ["pnl:2026-08", augRows]]),
    invoices: [],
    trackingName: "",
    fyEndMonth: 3,
  });
  const accounts = r.pnl.filter((x) => x.kind === "account");
  assert.equal(accounts.length, 1);
  assert.deepEqual([accounts[0].label, accounts[0].month, accounts[0].prior, accounts[0].ytd], ["Sales", 100, 80, 180]);
});

test("available months and the trend, oldest first, skipping months with no report", () => {
  assert.deepEqual(report.available, ["2026-09", "2026-08", "2026-07", "2026-05", "2026-04", "2026-03"]);
  assert.deepEqual(
    report.trend.map((t) => t.month),
    ["2026-03", "2026-04", "2026-05", "2026-07", "2026-08", "2026-09"],
  );
  const last = report.trend[report.trend.length - 1];
  assert.deepEqual(
    [last.income, last.costOfSales, last.grossProfit, last.expenses, last.netProfit],
    [96430.15, 59573.49, 36856.66, 7669.94, 29186.72],
  );
  close(last.gpPct, 0.3822);
  const jul = report.trend.find((t) => t.month === "2026-07");
  assert.equal(jul?.netProfit, 34024.07, "July's bank interest counts in net profit");

  // Only twelve months back: September 2025 falls outside October 2025 to September 2026
  const reports = new Map<string, unknown>([["pnl:2025-09", SEP_PNL], ["pnl:2025-10", SEP_PNL], ["pnl:2026-09", SEP_PNL]]);
  const r = managementReport({ month: "2026-09", reports, invoices: [], trackingName: "", fyEndMonth: 3 });
  assert.deepEqual(r.trend.map((t) => t.month), ["2025-10", "2026-09"]);
});

/* Segments */

test("segments from the Sales Type tracking report: every column but Total", () => {
  const segs = report.segments;
  assert.ok(segs);
  assert.deepEqual(segs.map((s) => s.name), ["IN", "RE", "S&M", "Unassigned"]);
  const by = Object.fromEntries(segs.map((s) => [s.name, s]));
  assert.deepEqual([by.IN.income, by.IN.costOfSales, by.IN.grossProfit], [30120.4, 22327.08, 7793.32]);
  assert.deepEqual([by.RE.income, by.RE.costOfSales, by.RE.grossProfit], [14280, 9990, 4290]);
  assert.deepEqual([by["S&M"].income, by["S&M"].costOfSales, by["S&M"].grossProfit], [50779.75, 27079.97, 23699.78]);
  assert.deepEqual([by.Unassigned.income, by.Unassigned.expenses, by.Unassigned.netProfit], [1250, 7669.94, -6596.38]);
  close(by.IN.gpPct, 0.2587);
  close(by.RE.gpPct, 0.3004);
  close(by["S&M"].gpPct, 0.4667);
  close(by["S&M"].shareOfIncome, 0.5266);
  close(segs.reduce((a, s) => a + (s.shareOfIncome ?? 0), 0), 1, 9);
  // Segments add back to the month
  close(segs.reduce((a, s) => a + s.grossProfit, 0), report.summary.grossProfit, 2);
  close(segs.reduce((a, s) => a + s.netProfit, 0), report.summary.netProfit, 2);
});

test("segments with no income have no margin or share", () => {
  const tracking = pnlReport({
    columns: ["IN", "RE", "Total"],
    sections: [
      { title: "Income", rows: [["Sales", 0, 0, 0]] },
      { title: "Less Operating Expenses", rows: [["Rent", 0, 100, 100]] },
    ],
  });
  const r = managementReport({
    month: "2026-09",
    reports: new Map<string, unknown>([["pnl-tracking:2026-09", tracking]]),
    invoices: [],
    trackingName: "Sales Type",
    fyEndMonth: 3,
  });
  assert.deepEqual(
    r.segments?.map((s) => [s.name, s.gpPct, s.shareOfIncome, s.netProfit]),
    [
      ["IN", null, null, 0],
      ["RE", null, null, -100],
    ],
  );
});

/* Cash and balance sheet */

test("cash view from the payments-only P&L", () => {
  assert.ok(report.cash);
  assert.equal(report.cash.moneyIn, 88750.4);
  assert.equal(report.cash.moneyOut, 61423.53);
  assert.equal(report.cash.net, 27326.87);
  assert.equal(report.cash.lines.length, 11, "zero lines are left out");
  assert.deepEqual(report.cash.lines[0], { section: "income", account: "Sales", amount: 88750.4 });
  assert.equal(pnlSummary(parseReport(SEP_CASH)).netProfit, report.cash.net);
});

test("balance sheet summary", () => {
  const b = balanceSummary(SEP_BS);
  assert.deepEqual(b, {
    bank: 68210.55,
    debtors: 41876.2,
    otherCurrentAssets: 1250,
    fixedAssets: 20650,
    creditors: 22314.6,
    vat: 15820.45,
    payeCis: 7671.86,
    otherCurrentLiabilities: 13650,
    longTermLiabilities: 12000,
    netAssets: 60529.84,
  });
  assert.ok(report.balance);
  assert.deepEqual(report.balance.now, b);
  assert.deepEqual(report.balance.prior, balanceSummary(AUG_BS));
  assert.equal(report.balance.prior?.netAssets, 54478.93);
  assert.deepEqual(report.kpis, {
    income: 96430.15,
    grossProfit: 36856.66,
    gpPct: report.summary.gpPct,
    netProfit: 29186.72,
    cashAtBank: 68210.55,
    debtors: 41876.2,
    creditors: 22314.6,
    vatOwed: 15820.45,
  });
});

test("balance sheet with UK statutory wording", () => {
  const b = balanceSummary(
    bsReport({
      columns: ["30 Sep 26"],
      sections: [
        { title: "Cash at bank and in hand", rows: [["Current account", 1000]] },
        { title: "Debtors", rows: [["Trade Debtors", 500], ["CIS Deductions Suffered", 40]] },
        { title: "Tangible Assets", rows: [["Van", 3000]] },
        {
          title: "Creditors: amounts falling due within one year",
          rows: [["Trade Creditors", 200], ["VAT Control", 150], ["National Insurance", 30], ["Corporation Tax", 90]],
        },
        { title: "Creditors: amounts falling due after more than one year", rows: [["Loan", 400]] },
        { title: "Equity", rows: [["Reserves", 3670]] },
      ],
    }),
  );
  assert.deepEqual(b, {
    bank: 1000,
    debtors: 500,
    otherCurrentAssets: 40,
    fixedAssets: 3000,
    creditors: 200,
    vat: 150,
    payeCis: 30,
    otherCurrentLiabilities: 90,
    longTermLiabilities: 400,
    netAssets: 3670,
  });
});

test("no balance sheet means null balance figures", () => {
  const inputs = managementInputs({ fyEndMonth: 3 });
  inputs.reports.delete("bs:2026-09");
  const r = managementReport(inputs);
  assert.equal(r.balance, null);
  assert.deepEqual([r.kpis.cashAtBank, r.kpis.debtors, r.kpis.creditors, r.kpis.vatOwed], [null, null, null, null]);
  assert.ok(r.missing.includes("bs:2026-09"));
  // Without last month's balance sheet, this month's still shows
  const noPrior = managementInputs({ fyEndMonth: 3 });
  noPrior.reports.delete("bs:2026-08");
  const r2 = managementReport(noPrior);
  assert.equal(r2.balance?.prior, null);
  assert.equal(r2.balance?.now.bank, 68210.55);
});

/* Debtors raised */

test("debtors raised in September by segment and customer type", () => {
  const d = report.debtorsRaised;
  assert.deepEqual(
    d.rows.map((r) => [r.segment, r.type, r.count, r.total, r.paid, r.notPaid]),
    [
      ["IN", "B2B", 1, 840, 0, 840],
      ["IN", "B2C", 2, 12664, 2664, 10000],
      ["RE", "B2C", 2, 31216.8, 8000, 23216.8],
      ["S&M", "B2B", 3, 1400.86, 900, 500.86],
      ["S&M", "B2C", 2, 1860, 540, 1320],
      ["Unassigned", "B2C", 1, 275.4, 275.4, 0],
    ],
  );
  assert.deepEqual(
    d.bySegment.map((r) => [r.segment, r.count, r.total, r.paid, r.notPaid]),
    [
      ["IN", 3, 13504, 2664, 10840],
      ["RE", 2, 31216.8, 8000, 23216.8],
      ["S&M", 5, 3260.86, 1440, 1820.86],
      ["Unassigned", 1, 275.4, 275.4, 0],
    ],
  );
  assert.deepEqual(d.total, { count: 11, total: 48257.06, paid: 12379.4, notPaid: 35877.66 });
});

test("voided, draft, other-month invoices and supplier bills are not debtors raised", () => {
  const counted = (number: string) =>
    debtorsRaised(
      INVOICES.filter((i) => i.number === number),
      "2026-09",
      "Sales Type",
    ).total.count;
  assert.equal(counted("21227"), 0, "voided");
  assert.equal(counted("21400"), 0, "draft");
  assert.equal(counted("21190"), 0, "August");
  assert.equal(counted("INV-0040"), 0, "bill");
  assert.equal(counted("21315"), 1, "submitted counts");
  const deleted = { ...INVOICES[0], status: "DELETED" };
  assert.equal(debtorsRaised([deleted], "2026-09", "Sales Type").total.count, 0);
});

test("an invoice's segment is the Sales Type option with the most line value", () => {
  const inv = (n: string) => {
    const found = INVOICES.find((i) => i.number === n);
    assert.ok(found);
    return found;
  };
  assert.equal(invoiceSegment(inv("21310"), "Sales Type"), "S&M", "two S&M lines beat one larger RE line");
  assert.equal(invoiceSegment(inv("21315"), "Sales Type"), "IN", "other tracking categories are ignored");
  assert.equal(invoiceSegment(inv("21330"), "Sales Type"), "Unassigned");
  assert.equal(invoiceSegment(inv("21140"), "sales type"), "IN", "category name is not case sensitive");
  assert.equal(invoiceSegment(inv("21140"), "Region"), "Unassigned");
});

test("customer type: ServiceM8 first, then the contact name", () => {
  const inv = (n: string) => {
    const found = INVOICES.find((i) => i.number === n);
    assert.ok(found);
    return found;
  };
  const types = new Map([["21275", false], ["21301", true], ["20290", false]]);
  assert.equal(invoiceCustomerType(inv("21275")), "B2C", "a person's name");
  assert.equal(invoiceCustomerType(inv("21275"), types), "B2B", "ServiceM8 says business");
  assert.equal(invoiceCustomerType(inv("21301")), "B2B", "lettings reads as a business");
  assert.equal(invoiceCustomerType(inv("21301"), types), "B2C", "ServiceM8 says individual");
  assert.equal(invoiceCustomerType(inv("20290A"), types), "B2B", "job number with a letter added");
  assert.equal(invoiceCustomerType(inv("21240")), "B2B", "Ltd");
  assert.equal(invoiceCustomerType(inv("21315")), "B2B", "Housing Trust");
  assert.equal(invoiceCustomerType({ ...inv("21240"), contactName: "Lambeth Council" }), "B2B");
  assert.equal(invoiceCustomerType({ ...inv("21240"), contactName: "Holly Group" }), "B2B");
  assert.equal(invoiceCustomerType({ ...inv("21240"), contactName: "Grouper Smith" }), "B2C", "whole words only");
});

/* Commentary */

test("commentary: short factual sentences with the month and the figures", () => {
  const c = report.commentary;
  assert.ok(c.length >= 3 && c.length <= 6, `${c.length} sentences`);
  assert.equal(c[0], "Income was £96,430 in September, up 12% on August.");
  assert.ok(c.includes("Gross margin was 38.2%, down from 40.9%."));
  assert.ok(c.includes("Net profit was £29,187 after £7,670 of overheads."));
  assert.ok(c.includes("S&M brought in 53% of income at a 47% gross margin."));
  assert.ok(c.includes("£35,878 of September's invoices is still unpaid."));
  assert.ok(c.some((s) => s.startsWith("Year to date (April to September, June missing)")));
  for (const s of c) {
    assert.match(s, /\.$/);
    assert.doesNotMatch(s, /£\d+\.\d/, "whole pounds only");
  }
});

test("commentary without a prior month, segments or invoices still reads well", () => {
  const r = managementReport({
    month: "2026-09",
    reports: new Map<string, unknown>([["pnl:2026-09", SEP_PNL], ["bs:2026-09", SEP_BS], ["pnl-tracking:2026-09", SEP_TRACKING]]),
    invoices: [],
    trackingName: "Sales Type",
    fyEndMonth: 9,
  });
  assert.equal(r.commentary[0], "Income was £96,430 in September.");
  assert.ok(r.commentary.includes("Gross margin was 38.2%."));
  assert.ok(r.commentary.includes("Cash at bank was £68,211 at 30 September."));
  assert.ok(r.commentary.includes("£1,250 of income is not tagged with a Sales Type."));
  assert.ok(!r.commentary.some((s) => /Year to date|unpaid/.test(s)));
  assert.ok(r.commentary.length >= 3 && r.commentary.length <= 6);
});

test("commentary reports a loss as a loss", () => {
  const loss = pnlReport({
    columns: ["31 Jan 27"],
    sections: [
      { title: "Income", rows: [["Sales", 1000]] },
      { title: "Less Cost of Sales", rows: [["CIS Labour Expense", 900]] },
      { title: "Less Operating Expenses", rows: [["Rent", 1234.4]] },
    ],
  });
  const prev = pnlReport({ columns: ["31 Dec 26"], sections: [{ title: "Income", rows: [["Sales", 1000]] }] });
  const r = managementReport({
    month: "2027-01",
    reports: new Map<string, unknown>([["pnl:2027-01", loss], ["pnl:2026-12", prev]]),
    invoices: [],
    trackingName: "",
    fyEndMonth: 12,
  });
  assert.equal(r.commentary[0], "Income was £1,000 in January, level with December.");
  assert.ok(r.commentary.includes("Gross margin was 10.0%, down from 100.0%."));
  assert.ok(r.commentary.includes("There was a net loss of £1,134 after £1,234 of overheads."));
});

/* Raw Xero JSON written out by hand (not from the fixture builders), as the API returns it */

const acct = (id: string) => [{ Value: id, Id: "account" }];
const XERO_PNL_RESPONSE = {
  Id: "5d3d6f6e-0000-4000-8000-000000000001",
  Status: "OK",
  ProviderName: "Practice Manager",
  DateTimeUTC: "/Date(1791446400000)/",
  Reports: [
    {
      ReportID: "ProfitAndLoss",
      ReportName: "Profit and Loss",
      ReportType: "ProfitAndLoss",
      ReportTitles: ["Profit and Loss", "Polkadot Property Services Ltd", "1 September 2026 to 30 September 2026"],
      ReportDate: "8 October 2026",
      UpdatedDateUTC: "/Date(1791446400000)/",
      Fields: [],
      Rows: [
        { RowType: "Header", Cells: [{ Value: "" }, { Value: "30 Sep 26" }] },
        {
          RowType: "Section",
          Title: "Income",
          Rows: [
            { RowType: "Row", Cells: [{ Value: "Sales", Attributes: acct("a-sales") }, { Value: "1,000.00", Attributes: acct("a-sales") }] },
            { RowType: "Row", Cells: [{ Value: "Interest Income", Attributes: acct("a-int") }, { Value: "", Attributes: acct("a-int") }] },
            { RowType: "SummaryRow", Cells: [{ Value: "Total Income" }, { Value: "1000.00" }] },
          ],
        },
        {
          RowType: "Section",
          Title: "Less Cost of Sales",
          Rows: [
            { RowType: "Row", Cells: [{ Value: "CIS Labour Expense", Attributes: acct("a-cis") }, { Value: "400.00", Attributes: acct("a-cis") }] },
            // A supplier credit note: a negative cost reduces cost of sales
            { RowType: "Row", Cells: [{ Value: "Direct Expenses", Attributes: acct("a-dir") }, { Value: "-25.00", Attributes: acct("a-dir") }] },
            { RowType: "SummaryRow", Cells: [{ Value: "Total Cost of Sales" }, { Value: "375.00" }] },
          ],
        },
        // Xero's own totals are deliberately wrong here: the figures must come from the account lines
        { RowType: "Section", Title: "", Rows: [{ RowType: "Row", Cells: [{ Value: "Gross Profit" }, { Value: "999.99" }] }] },
        {
          RowType: "Section",
          Title: "Plus Other Income",
          Rows: [
            { RowType: "Row", Cells: [{ Value: "Bank interest received", Attributes: acct("a-bir") }, { Value: "12.50", Attributes: acct("a-bir") }] },
            { RowType: "SummaryRow", Cells: [{ Value: "Total Other Income" }, { Value: "12.50" }] },
          ],
        },
        {
          RowType: "Section",
          Title: "Less Operating Expenses",
          Rows: [
            { RowType: "Row", Cells: [{ Value: "Rent", Attributes: acct("a-rent") }, { Value: "208.33", Attributes: acct("a-rent") }] },
            { RowType: "Row", Cells: [{ Value: "Insurance", Attributes: acct("a-ins") }, { Value: "-11.43", Attributes: acct("a-ins") }] },
            { RowType: "SummaryRow", Cells: [{ Value: "Total Operating Expenses" }, { Value: "196.90" }] },
          ],
        },
        { RowType: "Section", Title: "", Rows: [{ RowType: "Row", Cells: [{ Value: "Net Profit" }, { Value: "0.00" }] }] },
      ],
    },
  ],
};

const XERO_BS = {
  ReportID: "BalanceSheet",
  ReportName: "Balance Sheet",
  ReportType: "BalanceSheet",
  ReportTitles: ["Balance Sheet", "Polkadot Property Services Ltd", "As at 30 September 2026"],
  ReportDate: "8 October 2026",
  UpdatedDateUTC: "/Date(1791446400000)/",
  Fields: [],
  Rows: [
    { RowType: "Header", Cells: [{ Value: "" }, { Value: "30 Sep 2026" }, { Value: "30 Sep 2025" }] },
    { RowType: "Section", Title: "Assets", Rows: [] },
    {
      RowType: "Section",
      Title: "Bank",
      Rows: [
        { RowType: "Row", Cells: [{ Value: "Business Current Account" }, { Value: "12,500.00" }, { Value: "9000.00" }] },
        { RowType: "Row", Cells: [{ Value: "Company Credit Card" }, { Value: "-400.00" }, { Value: "" }] },
        { RowType: "SummaryRow", Cells: [{ Value: "Total Bank" }, { Value: "12100.00" }, { Value: "9000.00" }] },
      ],
    },
    {
      RowType: "Section",
      Title: "Current Assets",
      Rows: [
        { RowType: "Row", Cells: [{ Value: "Accounts Receivable" }, { Value: "8,000.00" }, { Value: "6000.00" }] },
        { RowType: "Row", Cells: [{ Value: "Directors' Loan Receivable" }, { Value: "1500.00" }, { Value: "" }] },
        { RowType: "SummaryRow", Cells: [{ Value: "Total Current Assets" }, { Value: "9500.00" }, { Value: "6000.00" }] },
      ],
    },
    {
      RowType: "Section",
      Title: "Fixed Assets",
      Rows: [
        { RowType: "Row", Cells: [{ Value: "Motor Vehicles" }, { Value: "15000.00" }, { Value: "15000.00" }] },
        { RowType: "Row", Cells: [{ Value: "Less Accumulated Depreciation on Motor Vehicles" }, { Value: "-3000.00" }, { Value: "" }] },
        { RowType: "SummaryRow", Cells: [{ Value: "Total Fixed Assets" }, { Value: "12000.00" }, { Value: "15000.00" }] },
      ],
    },
    { RowType: "Section", Title: "", Rows: [{ RowType: "SummaryRow", Cells: [{ Value: "Total Assets" }, { Value: "33600.00" }, { Value: "30000.00" }] }] },
    { RowType: "Section", Title: "Liabilities", Rows: [] },
    {
      RowType: "Section",
      Title: "Current Liabilities",
      Rows: [
        { RowType: "Row", Cells: [{ Value: "Accounts Payable" }, { Value: "4,200.00" }, { Value: "" }] },
        // VAT reclaimable: a refund is due from HMRC
        { RowType: "Row", Cells: [{ Value: "VAT" }, { Value: "-1,250.00" }, { Value: "" }] },
        { RowType: "Row", Cells: [{ Value: "PAYE Payable" }, { Value: "900.00" }, { Value: "" }] },
        { RowType: "Row", Cells: [{ Value: "CIS Liability" }, { Value: "1100.00" }, { Value: "" }] },
        { RowType: "Row", Cells: [{ Value: "Wages Payable - Payroll" }, { Value: "2000.00" }, { Value: "" }] },
        { RowType: "Row", Cells: [{ Value: "Corporation Tax Payable" }, { Value: "3000.00" }, { Value: "" }] },
        { RowType: "SummaryRow", Cells: [{ Value: "Total Current Liabilities" }, { Value: "9950.00" }, { Value: "" }] },
      ],
    },
    {
      RowType: "Section",
      Title: "Non-Current Liabilities",
      Rows: [
        { RowType: "Row", Cells: [{ Value: "Bank Loan" }, { Value: "6000.00" }, { Value: "" }] },
        { RowType: "SummaryRow", Cells: [{ Value: "Total Non-Current Liabilities" }, { Value: "6000.00" }, { Value: "" }] },
      ],
    },
    { RowType: "Section", Title: "", Rows: [{ RowType: "SummaryRow", Cells: [{ Value: "Total Liabilities" }, { Value: "15950.00" }, { Value: "" }] }] },
    { RowType: "Section", Title: "", Rows: [{ RowType: "Row", Cells: [{ Value: "Net Assets" }, { Value: "17650.00" }, { Value: "30000.00" }] }] },
    {
      RowType: "Section",
      Title: "Equity",
      Rows: [
        { RowType: "Row", Cells: [{ Value: "Retained Earnings" }, { Value: "17650.00" }, { Value: "30000.00" }] },
        { RowType: "SummaryRow", Cells: [{ Value: "Total Equity" }, { Value: "17650.00" }, { Value: "30000.00" }] },
      ],
    },
  ],
};

test("a hand-written Xero P&L response: figures come from the account lines, not Xero's totals", () => {
  const p = parseReport(XERO_PNL_RESPONSE);
  assert.deepEqual(p.columns, ["30 Sep 26"]);
  assert.deepEqual(
    p.lines.map((l) => [l.section, l.account, l.accountId, l.values[0]]),
    [
      ["income", "Sales", "a-sales", 1000],
      ["income", "Interest Income", "a-int", 0],
      ["cost_of_sales", "CIS Labour Expense", "a-cis", 400],
      ["cost_of_sales", "Direct Expenses", "a-dir", -25],
      ["other_income", "Bank interest received", "a-bir", 12.5],
      ["expenses", "Rent", "a-rent", 208.33],
      ["expenses", "Insurance", "a-ins", -11.43],
    ],
  );
  const s = pnlSummary(p);
  assert.deepEqual(
    [s.income, s.costOfSales, s.grossProfit, s.otherIncome, s.expenses, s.netProfit],
    [1000, 375, 625, 12.5, 196.9, 440.6],
  );
  close(s.gpPct, 0.625);
  close(s.npPct, 0.4406);
  // The same report stored as JSON text reads the same
  assert.deepEqual(parseReport(JSON.stringify(XERO_PNL_RESPONSE.Reports[0])), p);

  const r = managementReport({
    month: "2026-09",
    reports: new Map<string, unknown>([["pnl:2026-09", XERO_PNL_RESPONSE.Reports[0]], ["bs:2026-09", XERO_BS]]),
    invoices: [],
    trackingName: "",
    fyEndMonth: 3,
  });
  assert.equal(row(r, "Net profit", "total").month, 440.6);
  assert.equal(row(r, "Total other income", "subtotal").month, 12.5);
  assert.equal(row(r, "Insurance").month, -11.43);
});

test("a hand-written Xero balance sheet: VAT, PAYE/CIS, payroll and tax are not trade creditors", () => {
  assert.deepEqual(balanceSummary(XERO_BS), {
    bank: 12100,
    debtors: 8000,
    otherCurrentAssets: 1500,
    fixedAssets: 12000,
    creditors: 4200,
    vat: -1250,
    payeCis: 2000,
    otherCurrentLiabilities: 5000,
    longTermLiabilities: 6000,
    netAssets: 17650,
  });
  const p = parseReport(XERO_BS);
  assert.equal(p.lines.find((l) => l.account === "VAT")?.section, "Current Liabilities");
  assert.deepEqual(p.lines.find((l) => l.account === "Business Current Account")?.values, [12500, 9000]);
});

test("classifySection: costs, charges and tax are never income", () => {
  assert.equal(classifySection("Turnover"), "income");
  assert.equal(classifySection("Sales"), "income");
  assert.equal(classifySection("Less Income Tax Expense"), "expenses");
  assert.equal(classifySection("Taxation"), "expenses");
  assert.equal(classifySection("Interest Payable and Similar Charges"), "expenses");
  assert.equal(classifySection("Distribution Costs"), "expenses");
  assert.equal(classifySection("Less Other Expenses"), "expenses");
  assert.equal(classifySection("Administrative Expenses"), "expenses");
  assert.equal(classifySection("Direct Costs"), "cost_of_sales");
  assert.equal(classifySection("Other Operating Income"), "other_income");
  assert.equal(classifySection("Plus Interest Income"), "other_income");
  assert.equal(classifySection("Other Revenue"), "other_income");
  assert.equal(classifySection("Gross Profit"), "other");
});

test("parser: nested sections keep their parent's place, rows may lack RowType, and the Header may be missing", () => {
  const p = parseReport({
    Rows: [
      { RowType: "Section", Title: "Income", Rows: [{ Cells: [{ Value: "Sales" }, { Value: "500" }] }] },
      {
        RowType: "Section",
        Title: "Less Operating Expenses",
        Rows: [
          {
            RowType: "Section",
            Title: "Motor",
            Rows: [
              { RowType: "Row", Cells: [{ Value: "Fuel" }, { Value: "120.00" }] },
              { RowType: "SummaryRow", Cells: [{ Value: "Total Motor" }, { Value: "120.00" }] },
            ],
          },
          { RowType: "Row", Cells: [{ Value: "Rent" }, { Value: "80" }] },
        ],
      },
    ],
  });
  assert.deepEqual(p.columns, []);
  assert.deepEqual(
    p.lines.map((l) => [l.section, l.account, l.values]),
    [
      ["income", "Sales", [500]],
      ["expenses", "Fuel", [120]],
      ["expenses", "Rent", [80]],
    ],
  );
  assert.equal(pnlSummary(p).netProfit, 300);
});

test("parser: amounts are plain decimals; anything else is zero", () => {
  const cells = ["£1,234.50", "-£12.00", "(1,000.00)", " 7 ", "0x10", "1e3", "Infinity", "NaN", "12%", "-", "-0.00"];
  const p = parseReport({
    Rows: [{ RowType: "Section", Title: "Income", Rows: [{ RowType: "Row", Cells: [{ Value: "Sales" }, ...cells.map((Value) => ({ Value }))] }] }],
  });
  assert.deepEqual(p.lines[0].values, [1234.5, -12, -1000, 7, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(Object.is(p.lines[0].values[10], 0), "no negative zero");
});

test("no income means no margins, and negative income is not given a margin either", () => {
  const refunds = pnlReport({
    columns: ["30 Sep 26"],
    sections: [
      { title: "Income", rows: [["Sales", -200]] },
      { title: "Less Cost of Sales", rows: [["Installation", 50]] },
      { title: "Less Operating Expenses", rows: [["Rent", 100]] },
    ],
  });
  const s = pnlSummary(parseReport(refunds));
  assert.deepEqual([s.income, s.grossProfit, s.netProfit, s.gpPct, s.npPct], [-200, -250, -350, null, null]);
  const r = managementReport({
    month: "2026-09",
    reports: new Map<string, unknown>([["pnl:2026-09", refunds], ["pnl:2026-08", refunds]]),
    invoices: [],
    trackingName: "",
    fyEndMonth: 3,
  });
  assert.ok(r.pnl.every((x) => x.pctOfIncome === null));
  assert.ok(!r.commentary.some((c) => /margin|up|down/.test(c)), r.commentary.join(" "));
  assert.ok(r.commentary.includes("There was a net loss of £350 after £100 of overheads."));
});

test("balance sheet: unfamiliar sections still count, VAT held as an asset nets off, NI is PAYE", () => {
  const b = balanceSummary(
    bsReport({
      columns: ["30 Sep 26"],
      sections: [
        { title: "Bank", rows: [["Current", 1000]] },
        { title: "Current Assets", rows: [["Accounts Receivable", 500], ["VAT Receivable", 30], ["Interest Receivable", 5]] },
        { title: "Goodwill", rows: [["Goodwill", 2000]] },
        {
          title: "Current Liabilities",
          rows: [["Accounts Payable", 100], ["VAT", 80], ["Employers NI", 20], ["Dividends Payable", 300], ["Directors Loan Payable", 40]],
        },
        { title: "Equity", rows: [["Retained Earnings", 2995]] },
      ],
    }),
  );
  assert.deepEqual(b, {
    bank: 1000,
    debtors: 500,
    otherCurrentAssets: 2005,
    fixedAssets: 0,
    creditors: 100,
    vat: 50,
    payeCis: 20,
    otherCurrentLiabilities: 340,
    longTermLiabilities: 0,
    netAssets: 2995,
  });
});

test("inputs: stored nulls count as missing, the year end may be text, and a bad month is a clear error", () => {
  const r = managementReport({
    month: "2026-09",
    reports: new Map<string, unknown>([["pnl:2026-09", null], ["pnl:2026-08", AUG_PNL], ["bs:2026-09", undefined]]),
    invoices: [],
    trackingName: "",
    fyEndMonth: "3" as unknown as number,
  });
  assert.equal(r.ytdFrom, "2026-04");
  assert.ok(r.missing.includes("pnl:2026-09"));
  assert.ok(r.missing.includes("bs:2026-09"));
  assert.deepEqual(r.available, ["2026-08"]);
  assert.equal(r.balance, null);
  assert.equal(r.commentary[0], "The profit and loss report for September 2026 has not been loaded yet.");
  assert.throws(
    () => managementReport({ month: "Sept 2026", reports: new Map(), invoices: [], trackingName: "", fyEndMonth: 3 }),
    /month must be YYYY-MM/,
  );
  // ServiceM8 not knowing the customer type falls back to the contact name
  const unknown = new Map<string, boolean>([["21240", null as unknown as boolean]]);
  assert.equal(invoiceCustomerType(INVOICES[0], unknown), "B2B");
});

test("year to date across the turn of the calendar year, with the next year's April left out", () => {
  const months = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-04"];
  const reports = new Map<string, unknown>(
    months.map((m, i) => [`pnl:${m}`, pnlReport({ columns: [m], sections: [{ title: "Income", rows: [["Sales", 100 * (i + 1)]] }] })]),
  );
  const feb = managementReport({ month: "2027-02", reports, invoices: [], trackingName: "", fyEndMonth: 3 });
  assert.equal(feb.ytdFrom, "2026-04");
  assert.equal(feb.ytdMonths, 11);
  assert.equal(feb.ytdComplete, true);
  // April 2026 (200) to February 2027 (1,200)
  assert.equal(feb.ytd.income, 7700);
  assert.equal(row(feb, "Sales").ytd, 7700);

  const mar = managementReport({ month: "2027-03", reports, invoices: [], trackingName: "", fyEndMonth: 3 });
  assert.equal(mar.ytdMonths, 11);
  assert.equal(mar.ytdComplete, false);
  assert.ok(mar.missing.includes("pnl:2027-03"));

  const apr = managementReport({ month: "2027-04", reports, invoices: [], trackingName: "", fyEndMonth: 3 });
  assert.equal(apr.ytdFrom, "2027-04");
  assert.equal(apr.ytd.income, 1300);

  const jan = managementReport({ month: "2027-01", reports, invoices: [], trackingName: "", fyEndMonth: 12 });
  assert.equal(jan.ytdFrom, "2027-01");
  assert.equal(jan.ytd.income, 1100);
  assert.equal(jan.ytdMonths, 1);
});

test("commentary: falling income, rising margin, a year-to-date loss and an overdrawn bank", () => {
  const sep = pnlReport({
    columns: ["30 Sep 26"],
    sections: [
      { title: "Income", rows: [["Sales", 1000]] },
      { title: "Less Cost of Sales", rows: [["Installation", 600]] },
      { title: "Less Operating Expenses", rows: [["Rent", 2000]] },
    ],
  });
  const aug = pnlReport({
    columns: ["31 Aug 26"],
    sections: [
      { title: "Income", rows: [["Sales", 1250]] },
      { title: "Less Cost of Sales", rows: [["Installation", 800]] },
      { title: "Less Operating Expenses", rows: [["Rent", 100]] },
    ],
  });
  const bs = bsReport({ columns: ["30 Sep 26"], sections: [{ title: "Bank", rows: [["Current", -2500.4]] }] });
  const r = managementReport({
    month: "2026-09",
    reports: new Map<string, unknown>([["pnl:2026-09", sep], ["pnl:2026-08", aug], ["bs:2026-09", bs]]),
    invoices: [],
    trackingName: "",
    fyEndMonth: 12,
  });
  assert.deepEqual(r.commentary, [
    "Income was £1,000 in September, down 20% on August.",
    "Gross margin was 40.0%, up from 36.0%.",
    "There was a net loss of £1,600 after £2,000 of overheads.",
    "Year to date (January to September, 7 months missing), income is £2,250 and the net loss is £1,250.",
    "The bank accounts were £2,500 overdrawn at 30 September.",
  ]);
});

/** Every number in a value, with its path. */
function numbersIn(value: unknown, path: string, out: [string, number][] = []): [string, number][] {
  if (typeof value === "number") out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => numbersIn(v, `${path}[${i}]`, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) numbersIn(v, `${path}.${k}`, out);
  return out;
}

test("no NaN or Infinity anywhere, whatever the reports hold", () => {
  const junk = (key: string) =>
    [
      "garbage",
      { Reports: [] },
      { Rows: [{ RowType: "Section", Title: "Income", Rows: [{ RowType: "Row", Cells: [{ Value: "Sales" }, { Value: "NaN" }] }] }] },
      { Rows: [{ RowType: "Header", Cells: [{ Value: "" }, { Value: "Total" }] }] },
    ][key.length % 4];
  const keys = ["pnl:2026-09", "pnl:2026-08", "pnl-tracking:2026-09", "pnl-cash:2026-09", "bs:2026-09", "bs:2026-08", "pnl:2026-04"];
  const zeroIncome = pnlReport({ columns: ["IN", "Total"], sections: [{ title: "Less Operating Expenses", rows: [["Rent", 100, 100]] }] });
  const scenarios: [string, ManagementReport][] = [
    ["full", report],
    ["december year end", managementReport(managementInputs())],
    ["nothing", managementReport({ month: "2026-09", reports: new Map(), invoices: [], trackingName: "Sales Type", fyEndMonth: 0 })],
    ["junk", managementReport({ month: "2026-09", reports: new Map(keys.map((k) => [k, junk(k)])), invoices: [], trackingName: "Sales Type", fyEndMonth: 13 })],
    [
      "zero income",
      managementReport({
        month: "2026-09",
        reports: new Map<string, unknown>([["pnl:2026-09", zeroIncome], ["pnl:2026-08", zeroIncome], ["pnl-tracking:2026-09", zeroIncome], ["pnl-cash:2026-09", zeroIncome]]),
        invoices: [{ ...INVOICES[0], total: Number.NaN, amountPaid: Number.NaN, amountDue: Number.POSITIVE_INFINITY }],
        trackingName: "Sales Type",
        fyEndMonth: 3,
      }),
    ],
  ];
  for (const [name, r] of scenarios) {
    for (const [path, n] of numbersIn(r, name)) assert.ok(Number.isFinite(n), `${path} is ${n}`);
    for (const c of r.commentary) assert.doesNotMatch(c, /NaN|Infinity|undefined|null/, `${name}: ${c}`);
  }
});
