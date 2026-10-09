import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectRow,
  buildProjects,
  categoryCode,
  invoiceMatchesJob,
  sitePostcode,
  suggestCosts,
  unallocatedBills,
  type ProjectRecord,
  type ProjectRow,
  type ProjectTotals,
} from "./projects";
import { EE, projectsInputs } from "./fixtures/projects.fixture";
import type { XeroInvoice } from "./types";

const input = projectsInputs();
const report = buildProjects(input);
const row = (id: string): ProjectRow => {
  const r = report.rows.find((x) => x.record.id === id);
  assert.ok(r, `no row ${id}`);
  return r;
};
const pct1 = (n: number | null) => (n === null ? null : Math.round(n * 1000) / 10);
const codes = (r: ProjectRow) => r.flags.map((f) => f.code);

// [sub quoted, sub invoiced, sub cost used, price, GP, markup %, margin %, billed inc VAT, client paid, client outstanding, sub paid, sub outstanding]
type Figures = [number, number, number, number, number, number | null, number | null, number, number, number, number, number];
const figures = (t: ProjectTotals): Figures => [
  t.subQuoted,
  t.subInvoiced,
  t.subCostUsed,
  t.price,
  t.grossProfit,
  pct1(t.markupPct),
  pct1(t.marginPct),
  t.billedInc,
  t.clientPaid,
  t.clientOutstanding,
  t.subPaid,
  t.subOutstanding,
];

test("totals match the spreadsheet's total row exactly", () => {
  assert.deepEqual(figures(report.totals), [63900, 31312.86, 68762.86, 95263.34, 26500.48, 38.5, 27.8, 51960.07, 31003.18, 20956.89, 12330, 18982.86]);
  assert.equal(report.totals.otherCosts, 0);
  assert.equal(report.totals.totalCost, 68762.86);
  assert.equal(report.totals.costTied + report.totals.costProbable, 31312.86);
  assert.equal(report.totals.costProbable, 7380);
});

test("every spreadsheet row is reproduced", () => {
  const expected: Record<string, Figures> = {
    kellett: [9200, 9630, 9630, 15284.09, 5654.09, 58.7, 37, 18328.89, 10846, 7482.89, 0, 9630],
    ward: [1350, 1682.86, 1682.86, 2230.98, 548.12, 32.6, 24.6, 2677.18, 2677.18, 0, 1350, 332.86],
    graepel: [1050, 3000, 3000, 1250, -1750, -58.3, -140, 1500, 1500, 0, 1950, 1050],
    fane: [550, 550, 550, 1535, 985, 179.1, 64.2, 1842, 1842, 0, 550, 0],
    corbett: [200, 200, 200, 0, -200, -100, null, 0, 0, 0, 0, 200],
    morton: [0, 1100, 1100, 2440, 1340, 121.8, 54.9, 2928, 0, 2928, 1100, 0],
    maxel: [0, 1050, 1050, 2850, 1800, 171.4, 63.2, 3420, 0, 3420, 0, 1050],
    lonie: [8200, 8200, 8200, 12605, 4405, 53.7, 34.9, 15126, 8000, 7126, 7380, 820],
    "knollys-floor": [2250, 2250, 2250, 2925, 675, 30, 23.1, 0, 0, 0, 0, 2250],
    "knollys-ceiling": [1800, 0, 1800, 2570, 770, 42.8, 30, 0, 0, 0, 0, 0],
    holmes: [3650, 3650, 3650, 3756.27, 106.27, 2.9, 2.8, 0, 0, 0, 0, 3650],
    akdemir: [2500, 0, 2500, 3900, 1400, 56, 35.9, 4680, 4680, 0, 0, 0],
    maclay: [850, 0, 850, 1215, 365, 42.9, 30, 1458, 1458, 0, 0, 0],
    mason: [15200, 0, 15200, 19760, 4560, 30, 23.1, 0, 0, 0, 0, 0],
    shivarova: [8700, 0, 8700, 11310, 2610, 30, 23.1, 0, 0, 0, 0, 0],
    clarke: [6200, 0, 6200, 8200, 2000, 32.3, 24.4, 0, 0, 0, 0, 0],
    carson: [2200, 0, 2200, 3432, 1232, 56, 35.9, 0, 0, 0, 0, 0],
    jopling: [0, 0, 0, 0, 0, null, null, 0, 0, 0, 0, 0],
    semple: [0, 0, 0, 0, 0, null, null, 0, 0, 0, 0, 0],
    bain: [550, 0, 550, 715, 165, 30, 23.1, 0, 0, 0, 0, 0],
    neave: [850, 0, 850, 1150, 300, 35.3, 26.1, 0, 0, 0, 0, 0],
  };
  assert.equal(report.rows.length, Object.keys(expected).length);
  for (const [id, want] of Object.entries(expected)) assert.deepEqual(figures(row(id)), want, id);
});

test("billing stage and category check per row", () => {
  const expected: Record<string, [string, string]> = {
    kellett: ["Fully invoiced – part paid", "RE / blank"],
    ward: ["Fully invoiced – paid", "RE / blank"],
    graepel: ["Fully invoiced – paid", "RE"],
    fane: ["Fully invoiced – paid", "RE"],
    corbett: ["Not charged (goodwill)", "RE"],
    morton: ["Fully invoiced – unpaid", "Blank"],
    maxel: ["Fully invoiced – unpaid", "Blank"],
    lonie: ["Fully invoiced – part paid", "RE"],
    "knollys-floor": ["Not invoiced – no deposit", "RE"],
    holmes: ["Not invoiced – no deposit", "Blank"],
    akdemir: ["Paid in full up front – not yet invoiced", "RE"],
    maclay: ["Paid in full up front – not yet invoiced", "S&M"],
    mason: ["Quote sent – not invoiced", "RE"],
    jopling: ["Not quoted yet", "RE"],
    bain: ["Not won", "RE"],
  };
  for (const [id, [stage, check]] of Object.entries(expected)) {
    assert.equal(row(id).billingStage, stage, id);
    assert.equal(row(id).categoryCheck, check, id);
  }
});

test("Simon Kellett: two jobs, Xero and ServiceM8 revenue, over the estimate", () => {
  const r = row("kellett");
  assert.equal(r.grossProfit, 5654.09);
  assert.deepEqual(
    r.revenue.map((l) => [l.source, l.ref, l.ex, l.inc, l.paid, l.due]),
    [
      ["xero", "20356", 14579.09, 17482.89, 10000, 7482.89],
      ["servicem8", "20820", 705, 846, 846, 0],
    ]
  );
  assert.deepEqual(codes(r), ["category", "sub_over_estimate"]);
  assert.equal(r.flags[0].text, "Job 20820 has no category – should be RE");
  assert.equal(r.flags[1].text, "Subcontractor billed £430.00 over the estimate");
  assert.deepEqual(
    r.costs.map((c) => [c.ref, c.paid, c.due]),
    [
      ["0237", 0, 9300],
      ["0238", 0, 330],
    ]
  );
});

test("Susanne Graepel: loss flagged", () => {
  const r = row("graepel");
  assert.equal(r.grossProfit, -1750);
  const loss = r.flags.find((f) => f.code === "loss");
  assert.ok(loss);
  assert.equal(loss.severity, "error");
  assert.equal(loss.text, "Loss of £1,750.00");
  // 0231 was settled by credit note: still counts as paid.
  assert.equal(r.subPaid, 1950);
});

test("Jane Corbett: goodwill work is not charged", () => {
  const r = row("corbett");
  assert.equal(r.price, 0);
  assert.equal(r.grossProfit, -200);
  assert.equal(r.markupPct, -1);
  assert.equal(r.marginPct, null);
  assert.equal(r.billingStage, "Not charged (goodwill)");
  assert.ok(!codes(r).includes("client_not_billed"));
});

test("Basak Akdemir and Matt Maclay: deposits count as billed and paid", () => {
  const a = row("akdemir");
  assert.equal(a.billingStage, "Paid in full up front – not yet invoiced");
  assert.deepEqual(
    a.revenue.map((l) => [l.source, l.inc, l.paid, l.due]),
    [["deposit", 4680, 4680, 0]]
  );
  assert.equal(a.deposits, 4680);
  const m = row("maclay");
  assert.equal(m.flags.find((f) => f.code === "category")?.text, "Job 21317 is S&M – should be RE");
});

test("Eleanor Holmes: low markup and subcontractor billed before the client", () => {
  const r = row("holmes");
  const low = r.flags.find((f) => f.code === "low_markup");
  assert.equal(low?.text, "Only 2.9% markup on the subcontract price");
  assert.equal(low?.severity, "warn");
  assert.ok(codes(r).includes("client_not_billed"));
  assert.ok(codes(row("knollys-floor")).includes("client_not_billed"));
});

test("Matthew Mason: quote sent, nothing billed, no flags", () => {
  const r = row("mason");
  assert.equal(r.billingStage, "Quote sent – not invoiced");
  assert.equal(r.price, 19760);
  assert.deepEqual(r.flags, []);
});

test("Chris Lonie: stage and balance invoices both count once; drafts ignored", () => {
  const r = row("lonie");
  assert.deepEqual(
    r.revenue.map((l) => l.ref),
    ["20290A", "20290"]
  );
  assert.equal(r.invoicedEx, 12605);
  assert.equal(r.costProbable, 7380);
  assert.equal(r.costTied, 820);
});

test("Nicola Fane: card payment in ServiceM8 not counted on top of Xero; voided invoice ignored", () => {
  const r = row("fane");
  assert.equal(r.revenue.length, 1);
  assert.equal(r.billedInc, 1842);
  assert.equal(r.clientPaid, 1842);
});

test("unpaid client invoices over 30 days are flagged", () => {
  assert.equal(row("maxel").flags.find((f) => f.code === "client_unpaid")?.text, "Invoice 10 unpaid after 32 days (£3,420.00 due)");
  assert.ok(codes(row("morton")).includes("client_unpaid"));
  assert.ok(!codes(row("kellett")).includes("client_unpaid"));
});

test("lost and awaiting-price rows are listed but left out of the totals", () => {
  const lost = report.groups.find((g) => g.status === "lost");
  assert.ok(lost);
  assert.deepEqual(
    lost.rows.map((r) => r.record.customer),
    ["Alice Neave", "Tiffany Bain"]
  );
  assert.equal(lost.totals.price, 1865);
  const sumOf = (ids: string[]) => Math.round(ids.reduce((a, id) => a + row(id).price, 0) * 100) / 100;
  const live = report.rows.filter((r) => r.record.status !== "lost" && r.record.status !== "awaiting_price").map((r) => r.record.id);
  assert.equal(sumOf(live), report.totals.price);
  assert.equal(row("bain").price, 715);
  assert.deepEqual(
    report.groups.map((g) => [g.label, g.rows.length]),
    [
      ["Completed", 7],
      ["In progress", 6],
      ["Quoted", 4],
      ["Awaiting price", 2],
      ["Lost", 2],
    ]
  );
  assert.deepEqual(report.rows.slice(0, 3).map((r) => r.record.customer), ["Christina Morton", "Jane Corbett", "Maxel Projects Ltd"]);
});

test("group totals add up to the report totals", () => {
  const live = report.groups.filter((g) => g.status !== "lost" && g.status !== "awaiting_price");
  const price = Math.round(live.reduce((a, g) => a + g.totals.price, 0) * 100) / 100;
  assert.equal(price, 95263.34);
  assert.deepEqual(
    live.map((g) => g.totals.price),
    [25590.07, 26971.27, 42702]
  );
});

test("job missing from ServiceM8 and no cost recorded", () => {
  const record: ProjectRecord = { ...input.projects[0], id: "x", jobNumbers: ["99999"], subQuoted: null, status: "in_progress" };
  const r = buildProjectRow(record, { ...input, costs: [] });
  assert.deepEqual(codes(r), ["job_missing", "no_cost"]);
  assert.equal(r.flags[0].severity, "error");
  assert.equal(r.flags[1].text, "No cost recorded yet");
  assert.equal(r.flags[1].ask, "Send the subcontractor's bill");
  assert.equal(r.categoryCheck, "");
});

test("price and sub cost overrides", () => {
  const record: ProjectRecord = { ...input.projects[0], priceOverride: 16000, subCostOverride: 9000 };
  const r = buildProjectRow(record, input);
  assert.equal(r.price, 16000);
  assert.equal(r.subCostUsed, 9000);
  assert.equal(r.grossProfit, 7000);
});

test("invoice numbers match the job or the job plus one letter", () => {
  assert.ok(invoiceMatchesJob("20290", "20290"));
  assert.ok(invoiceMatchesJob("20290A", "20290"));
  assert.ok(invoiceMatchesJob(" 20290a ", "20290"));
  assert.ok(invoiceMatchesJob("20290A", "20290A"));
  assert.ok(!invoiceMatchesJob("20290AB", "20290"));
  assert.ok(!invoiceMatchesJob("202901", "20290"));
  assert.ok(!invoiceMatchesJob("2029", "20290"));
  assert.ok(!invoiceMatchesJob("10", ""));
});

test("category codes and site postcodes", () => {
  const cats = ["Refurbishment Works"];
  assert.equal(categoryCode("Refurbishment Works", cats), "RE");
  assert.equal(categoryCode("Service & Maintenance (S&M)", cats), "S&M");
  assert.equal(categoryCode("Boiler Install", cats), "IN");
  assert.equal(categoryCode("IN - Heat pumps", cats), "IN");
  assert.equal(categoryCode("", cats), "blank");
  assert.equal(categoryCode("Recall", cats), "Recall");
  assert.equal(sitePostcode("52 Strathbrook Rd, SW16 3AZ"), "SW163AZ");
  assert.equal(sitePostcode("26 Cheyne Row, London SW3 5HL, UK"), "SW35HL");
  assert.equal(sitePostcode("Flat 2, 62 Cumberland St, SW1V 4LZ"), "SW1V4LZ");
  assert.equal(sitePostcode("Chelsea Bridge Wharf Car Wash"), null);
});

const bill = (id: string, contactName: string, reference: string, description: string, date = "2026-10-01", status = "AUTHORISED"): XeroInvoice => ({
  id,
  type: "ACCPAY",
  number: id,
  reference,
  contactId: contactName,
  contactName,
  date,
  dueDate: null,
  status,
  subTotal: 100,
  totalTax: 0,
  total: 100,
  amountDue: 100,
  amountPaid: 0,
  amountCredited: 0,
  fullyPaidOn: null,
  cisDeduction: 0,
  lines: [{ description, quantity: 1, unitAmount: 100, lineAmount: 100, accountCode: "320", taxAmount: 0, tracking: [] }],
});

test("unallocatedBills lists the subcontractor's bills not on any project", () => {
  assert.deepEqual(
    report.unallocatedBills.map((b) => b.number),
    ["0243"]
  );
  const extra = [bill("b2", "ee building supplies ltd", "", "x", "2026-09-01"), bill("b3", "Other Ltd", "", "x"), bill("b4", EE, "", "x", "2026-09-01", "DELETED")];
  assert.deepEqual(
    unallocatedBills([...input.invoices, ...extra], input.costs, [EE]).map((b) => b.id),
    ["b2", "bill-0243"]
  );
  assert.deepEqual(unallocatedBills(input.invoices, input.costs, [""]), []);
});

test("suggestCosts finds bills naming a job or the site postcode, and the subcontractor's other bills", () => {
  const lonie = input.projects.find((p) => p.id === "lonie")!;
  const invoices = [
    ...input.invoices,
    bill("named", "Lavender Hill Plumbing", "Job 20290 fittings", "Fittings", "2026-09-30"),
    bill("not-whole-word", "Lavender Hill Plumbing", "202901", "Fittings"),
    bill("voided", "Lavender Hill Plumbing", "20290", "Fittings", "2026-09-30", "VOIDED"),
    bill("line", "Pump Sales Direct", "", "Hoses for job 20290A", "2026-09-29"),
  ];
  const got = suggestCosts(lonie, invoices, input.costs);
  assert.deepEqual(
    got.map((s) => [s.bill.id, s.tie, s.reason]),
    [
      ["bill-wink246", "tied", "Mentions the site postcode SW4 8JW"],
      ["line", "tied", "Mentions job 20290A"],
      ["named", "tied", "Mentions job 20290"],
      ["bill-0243", "probable", "From the subcontractor"],
    ]
  );
  // Once allocated, a bill is no longer suggested.
  const allocated = [...input.costs, { ...input.costs[0], id: "c-new", xeroInvoiceId: "bill-wink246" }];
  assert.ok(!suggestCosts(lonie, invoices, allocated).some((s) => s.bill.id === "bill-wink246"));
});

test("edge cases: no input, lower-case job numbers, a bill allocated twice, a voided bill", () => {
  const none = buildProjects({ ...input, projects: [], costs: [], jobs: [], lines: [], payments: [], invoices: [] });
  assert.deepEqual([none.rows, none.groups, none.unallocatedBills], [[], [], []]);
  assert.equal(none.totals.price, 0);
  assert.equal(none.totals.markupPct, null);
  assert.equal(none.totals.marginPct, null);

  const kellett = input.projects.find((p) => p.id === "kellett")!;
  const lower = buildProjectRow({ ...kellett, jobNumbers: [" 20356 ", "20820"] }, input);
  assert.deepEqual([lower.price, lower.billedInc], [15284.09, 18328.89]);

  const twice = buildProjectRow(kellett, { ...input, costs: [...input.costs, { ...input.costs[0], id: "again" }] });
  assert.deepEqual([twice.subInvoiced, twice.subOutstanding], [9630, 9630]);

  const voided = input.invoices.map((i) => (i.id === "bill-0238" ? { ...i, status: "VOIDED" } : i));
  const v = buildProjectRow(kellett, { ...input, invoices: voided });
  assert.deepEqual([v.subInvoiced, v.subOutstanding, v.costTied], [9300, 9300, 9300]);
  assert.equal(v.flags.find((f) => f.code === "bill_voided")?.text, "Bill 0238 is voided in Xero – left out of the cost");
});

test("a suffixed invoice belongs to the job with that exact number when it is linked", () => {
  const lonie = input.projects.find((p) => p.id === "lonie")!;
  const reversed = buildProjectRow({ ...lonie, jobNumbers: ["20290", "20290A"] }, input);
  assert.deepEqual(
    reversed.revenue.map((l) => [l.ref, l.jobNo]),
    [
      ["20290A", "20290A"],
      ["20290", "20290"],
    ]
  );
  // The balance invoice not yet in Xero is taken from ServiceM8, not hidden by 20290A.
  const invoices = input.invoices.filter((i) => !(i.type === "ACCREC" && i.number === "20290"));
  const r = buildProjectRow(lonie, { ...input, invoices });
  assert.deepEqual(
    r.revenue.map((l) => [l.source, l.ref, l.inc]),
    [
      ["xero", "20290A", 13614],
      ["servicem8", "20290", 1512],
    ]
  );
  assert.equal(r.billedInc, 15126);
});

test("a project listed by its base job number prices and bills its stage job too", () => {
  const lonie = { ...input.projects.find((p) => p.id === "lonie")!, jobNumbers: ["20290"] };
  const projects = input.projects.map((p) => (p.id === "lonie" ? lonie : p));
  const r = buildProjectRow(lonie, { ...input, projects });
  assert.deepEqual(figures(r), figures(row("lonie")));
  assert.deepEqual(
    r.jobs.map((j) => [j.jobNo, j.priceEx]),
    [
      ["20290", 1260],
      ["20290A", 11345],
    ]
  );
  assert.equal(r.billingStage, "Fully invoiced – part paid");
  assert.ok(!codes(r).includes("loss"));

  // The balance invoice not yet in Xero still counts from ServiceM8 beside the stage invoice.
  const invoices = input.invoices.filter((i) => !(i.type === "ACCREC" && i.number === "20290"));
  const balance = buildProjectRow(lonie, { ...input, projects, invoices });
  assert.deepEqual(
    balance.revenue.map((l) => [l.source, l.ref, l.jobNo, l.inc]),
    [
      ["xero", "20290A", "20290A", 13614],
      ["servicem8", "20290", "20290", 1512],
    ]
  );
  assert.equal(balance.billedInc, 15126);

  // A stage job another project lists is that project's, invoice and all.
  const stage = { ...lonie, id: "lonie-stage", jobNumbers: ["20290A"] };
  const split = { ...input, projects: [...projects, stage] };
  const base = buildProjectRow(lonie, split);
  assert.deepEqual([base.jobs.map((j) => j.jobNo), base.price, base.revenue.map((l) => l.ref)], [["20290"], 1260, ["20290"]]);
  assert.deepEqual(buildProjectRow(stage, split).revenue.map((l) => l.ref), ["20290A"]);
});

test("suggestCosts reads the job number from a bill's number, where Xero keeps a bill's reference", () => {
  const lonie = input.projects.find((p) => p.id === "lonie")!;
  const typed = { ...bill("bill-ref", "Lavender Hill Plumbing", "", "Copper fittings", "2026-09-30"), number: "20290" };
  const got = suggestCosts(lonie, [...input.invoices, typed], input.costs);
  assert.deepEqual(
    got.filter((s) => s.bill.id === "bill-ref").map((s) => [s.tie, s.reason]),
    [["tied", "Mentions job 20290"]]
  );
});
