import { test } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { buildJobRows, monthReport, weekReport } from "./contractor";
import { weeksInMonth } from "./dates";
import { colLetter, MONEY, monthWorkbook, sheetName, weekWorkbook, type ExcelContext } from "./excel";
import { contractorInputs } from "./fixtures/contractor.fixture";
import type { ReportQuery } from "./store";

const input = contractorInputs();
const rows = buildJobRows(input);
const ctx: ExcelContext = {
  clientName: "Polkadot Property Services Ltd",
  businessName: "Polkadot",
  settings: input.settings,
  contractors: input.contractors,
  fees: input.fixedFees,
  deductions: input.deductions,
  today: "2026-10-08",
};

async function load(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
  return wb;
}

/** The first row at or after `from` whose first cell reads `text`. */
function rowOf(ws: ExcelJS.Worksheet, text: string, from = 1): number {
  for (let r = from; r <= ws.rowCount; r++) if (ws.getCell(r, 1).value === text) return r;
  throw new Error(`"${text}" not found in ${ws.name}`);
}

function formula(ws: ExcelJS.Worksheet, address: string): { formula: string; result: unknown } {
  const v = ws.getCell(address).value as ExcelJS.CellFormulaValue;
  assert.ok(v && typeof v === "object" && "formula" in v, `${ws.name}!${address} is a formula`);
  return { formula: v.formula, result: v.result };
}

const query = (over: Partial<ReportQuery>): ReportQuery => ({
  id: "q",
  topic: "contractors",
  weekEnding: "2026-09-10",
  jobNo: "21107",
  subject: "Marked sent in ServiceM8. Not in Xero.",
  detail: "",
  actionTaken: "",
  ask: "Hours and materials, and raise the invoice.",
  answer: "",
  status: "open",
  askedBy: "Alex",
  answeredBy: null,
  answeredAt: null,
  createdAt: "2026-09-12T10:00:00Z",
  ...over,
});

test("helpers name columns and sheets the way Excel allows", () => {
  assert.equal(colLetter(1), "A");
  assert.equal(colLetter(26), "Z");
  assert.equal(colLetter(27), "AA");
  const used = new Set<string>();
  assert.equal(sheetName("Week ending 10/09: [draft]?", used), "Week ending 10 09 draft");
  assert.equal(sheetName("Week ending 10/09: [draft]?", used), "Week ending 10 09 draft (2)");
  assert.ok(sheetName("A".repeat(40), used).length <= 31);
});

test("the week workbook mirrors the WE 10 Sep tab", async () => {
  const week = weekReport(rows, input, "2026-09-10");
  const wb = await load(await weekWorkbook(week, ctx));
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ["Week ending 10 Sep"]
  );
  const ws = wb.worksheets[0];
  assert.equal(ws.getCell("A1").value, "Week ending 10 Sep 2026: contractor detail");
  assert.equal(ws.getCell("A1").font?.bold, true);
  assert.equal(ws.getCell("A1").font?.size, 14);
  assert.ok((ws.getCell("B3").value as Date) instanceof Date, "week ending is a real date");
  assert.equal(ws.getCell("A6").value, "Contractor");
  assert.equal(ws.getCell("G6").value, "Charged ex VAT £");
  assert.equal(ws.getCell("F6").value, "Polkadot materials £");
  assert.equal((ws.getCell("A6").fill as ExcelJS.FillPattern).fgColor?.argb, "FFE3EAF3");
  assert.equal(ws.views[0]?.state, "frozen");

  const total = rowOf(ws, "Total", 7);
  assert.equal(total, 7 + week.contractors.length);
  const charged = formula(ws, `G${total}`);
  assert.equal(charged.formula, `SUM(G7:G${total - 1})`);
  assert.equal(charged.result, week.total.chargedEx);
  assert.equal(ws.getCell(`G${total}`).numFmt, MONEY);
  assert.equal(formula(ws, `M${total}`).formula, `IFERROR(L${total}/G${total},0)`);

  // One block per contractor, each with its pay build.
  for (const c of week.contractors) {
    const at = rowOf(ws, c.name, total + 1);
    assert.equal(ws.getCell(at + 1, 2).value, "Job no");
    const blockTotal = rowOf(ws, "Total", at + 2);
    assert.equal(blockTotal - at - 2, c.rows.length);
    assert.equal(formula(ws, `I${blockTotal}`).result, c.chargedEx);
    const net = rowOf(ws, "Net payable", blockTotal);
    assert.ok(Math.abs(Number(formula(ws, `D${net}`).result) - c.netPayable) < 0.006, `${c.name} net payable`);
  }
});

test("the month workbook has the master, the questions, the weeks, Job Data and the rates", async () => {
  const month = monthReport(rows, input, "2026-09", "2026-10-08");
  const weeks = weeksInMonth("2026-09", input.settings.weekEndsOn).map((w) => weekReport(rows, input, w));
  const queries = [
    query({ id: "a", answer: "Invoice has been approved to Xero", status: "answered" }),
    query({ id: "b", jobNo: "21223", weekEnding: "2026-09-17", subject: "Nil value. Return visit.", ask: "Is it chargeable?" }),
    query({ id: "c", status: "resolved" }),
  ];
  const wb = await load(await monthWorkbook(month, weeks, month.rows, queries, ctx));
  assert.deepEqual(
    wb.worksheets.map((w) => w.name),
    ["September Master", "For Polkadot", "WE 10 Sep", "WE 17 Sep", "WE 24 Sep", "Job Data", "Rates"]
  );

  const master = wb.getWorksheet("September Master")!;
  assert.equal(master.getCell("A1").value, "September 2026 Master");
  assert.equal(master.getCell("A5").value, "Contractor");
  assert.equal(master.getCell("H5").value, "Charged ex VAT £");
  const total = rowOf(master, "Total", 6);
  assert.equal(total, 6 + month.contractors.length);
  const charged = formula(master, `H${total}`);
  assert.equal(charged.formula, `SUM(H6:H${total - 1})`);
  assert.equal(charged.result, 21920.23);
  assert.equal(charged.result, month.total.chargedEx);
  assert.equal(formula(master, `P${total}`).result, month.total.grossMargin);
  assert.deepEqual(master.views[0], { ...master.views[0], state: "frozen", xSplit: 1, ySplit: 5 });

  const byWeek = rowOf(master, "Week by week");
  assert.equal(master.getCell(byWeek + 1, 1).value, "Week ending");
  assert.ok(master.getCell(byWeek + 2, 1).value instanceof Date);
  const weekTotal = rowOf(master, "Total", byWeek + 2);
  assert.equal(formula(master, `H${weekTotal}`).result, 21920.23);

  const forBiz = wb.getWorksheet("For Polkadot")!;
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map((c) => forBiz.getCell(4, c).value),
    ["#", "Week", "Job", "Customer", "Where it stands", "What we need", "Their answer"]
  );
  assert.equal(forBiz.getCell("C5").value, "21107");
  assert.equal(forBiz.getCell("D5").value, "Customer 21107");
  assert.equal(forBiz.getCell("G5").value, "Invoice has been approved to Xero");
  assert.equal((forBiz.getCell("G5").fill as ExcelJS.FillPattern).fgColor?.argb, "FFFFF2CC");
  assert.equal(forBiz.getCell("C6").value, "21223");
  assert.equal(forBiz.getCell("C7").value, null, "resolved questions are left out");

  const jobs = wb.getWorksheet("Job Data")!;
  assert.equal(jobs.getCell("A4").value, "Week ending");
  assert.equal(jobs.getCell("D4").value, "Job no");
  assert.equal(jobs.getCell("V4").value, "Polkadot materials cost £");
  assert.equal(jobs.getCell("Z4").value, "Margin %");
  const jobsTotal = rowOf(jobs, "Total", 5);
  assert.equal(jobsTotal - 5, 68);
  assert.equal(formula(jobs, `D${jobsTotal}`).result, 68);
  assert.equal(formula(jobs, `K${jobsTotal}`).result, 21920.23);
  assert.ok(jobs.getCell("A5").value instanceof Date);
  assert.equal(jobs.getCell("A5").numFmt, "dd mmm yyyy");

  const we17 = wb.getWorksheet("WE 17 Sep")!;
  const t17 = rowOf(we17, "Total", 7);
  assert.equal(formula(we17, `G${t17}`).result, 11691.34);

  const rates = wb.getWorksheet("Rates")!;
  assert.equal(rates.getCell("A4").value, "Defaults");
  assert.equal(rates.getCell("B5").value, 0.45);
  const deductions = rowOf(rates, "Weekly deductions £");
  const mo = rowOf(rates, "Mohammad Reza", deductions + 1);
  assert.equal(rates.getCell(mo, 2).value, 168.75);
});
