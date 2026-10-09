import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJobRows, classifyLine, deductionsFor, mentionsJob, monthReport, suggestedQueries, weekReport, type Money } from "./contractor";
import { isoWeekday } from "./dates";
import { contractorInputs } from "./fixtures/contractor.fixture";
import type { JobAdjustment, XeroInvoice } from "./types";

const input = contractorInputs();
const rows = buildJobRows(input);

// [jobs, units, labour, reimbursed, business materials, charged ex VAT, labour cost, CIS, deductions, net payable, gross margin]
type Week = [number, number, number, number, number, number, number, number, number, number, number];
const pick = (m: Money): Week => [m.jobs, m.units, m.labour, m.reimbursed, m.businessMaterials, m.chargedEx, m.labourCost, m.cis, m.deductions, m.netPayable, m.grossMargin];

test("every job row costs out as the workbook's Job Data tab", () => {
  // [job, labour cost, reimbursed, gross margin] for rows that exercise each rule.
  const expected: [string, number, number, number][] = [
    ["21073", 110, 0, 55], // hourly at the card rate
    ["21143", 80, 11.41, 45], // parking paid back
    ["21148", 56.25, 17, 68.75], // labour share
    ["21242", 162, 13, 271.09], // labour share on a 90 rate, materials bought by the business on a tied bill
    ["21256", 320, 100, 80], // business bought the materials, contractor paid 100 extra
    ["21207", 100, 6.2, 110], // combined boiler service and GSC fee
    ["21226", 80, 0, 45], // boiler service fee
    ["21290", 80, 0, 45], // gas safety certificate fee
    ["21165", 110, 0, 55], // JSD's own bill names the job
    ["20963", 232, 0, 128], // UNLMTD bill typed in
    ["21288", 202.5, 259.1, 247.5], // fixed price, held at the labour share
    ["21262", 84.38, 30, 103.12], // rounding half up
    ["21281", 180, 189.8, 70], // Ray Graham's bill, labour element
    ["20941", 212.36, 0, 259.54],
    ["21277", 148.01, 0, 180.89],
  ];
  for (const [job, cost, reimbursed, margin] of expected) {
    const row = rows.find((r) => r.jobNo === job);
    assert.ok(row, `row ${job}`);
    assert.deepEqual([row.labourCost, row.reimbursed, row.grossMargin], [cost, reimbursed, margin], `job ${job}`);
  }
  assert.equal(rows.length, 68);
  assert.equal(rows.find((r) => r.jobNo === "21242")?.materialsPaidBy, "business");
  assert.equal(rows.find((r) => r.jobNo === "21242")?.businessMaterials, 63.91);
  assert.equal(rows.find((r) => r.jobNo === "20941")?.xeroStatus, "Invoice dated 03/08");
  assert.equal(rows.find((r) => r.jobNo === "21073")?.xeroStatus, "Agrees");
  assert.equal(rows.find((r) => r.jobNo === "21281")?.weekEnding, "2026-09-24");
});

test("week ending 10 Sep matches the workbook's week tab", () => {
  const w = weekReport(rows, input, "2026-09-10");
  assert.equal(w.weekStart, "2026-09-04");
  assert.equal(w.payRun, "2026-10-08");
  const by = Object.fromEntries(w.contractors.map((c) => [c.name, pick(c)]));
  assert.deepEqual(by["Jack Nichols"], [4, 5.5, 687.5, 11.41, 0, 698.91, 440, 88, 0, 363.41, 247.5]);
  assert.deepEqual(by["John Smyth"], [1, 1, 125, 0, 0, 125, 80, 16, 0, 64, 45]);
  assert.deepEqual(by["JSD Drainage"], [2, 2, 330, 0, 0, 330, 220, 44, 0, 176, 110]);
  assert.deepEqual(by["Mohammad Reza"], [3, 6, 750, 17, 0, 767, 337.5, 67.5, 168.75, 118.25, 412.5]);
  assert.deepEqual(by["Robert Moghal"], [2, 2, 250, 0, 0, 250, 160, 32, 0, 128, 90]);
  assert.deepEqual(by["UNLMTD Electrical"], [1, 1, 360, 0, 0, 360, 232, 46.4, 0, 185.6, 128]);
  assert.deepEqual(pick(w.total), [13, 17.5, 2502.5, 28.41, 0, 2530.91, 1469.5, 293.9, 168.75, 1035.26, 1033]);
  const mo = w.contractors.find((c) => c.name === "Mohammad Reza")!;
  assert.equal(mo.deductionLines.length, 4);
  assert.equal(mo.chargedPerUnit, 125);
  assert.equal(mo.costPerUnit, 56.25);
});

test("weeks ending 17 and 24 Sep match the master's week by week table", () => {
  const w17 = weekReport(rows, input, "2026-09-17");
  assert.deepEqual(pick(w17.total), [30, 53.5, 7185.8, 1811.66, 2663.8, 11691.34, 4049, 809.8, 168.75, 4882.11, 3166.88]);
  assert.equal(w17.total.parking, 147.58);
  assert.equal(w17.total.materials, 4357.96);
  assert.equal(w17.total.chargedInc, 14029.62);
  const w24 = weekReport(rows, input, "2026-09-24");
  assert.deepEqual(pick(w24.total), [25, 31, 5805.8, 1892.18, 0, 7697.98, 3092.13, 618.43, 168.75, 4197.13, 2713.67]);
  assert.equal(w24.total.chargedInc, 9237.57);
});

test("September master by contractor, matrices and controls", () => {
  const m = monthReport(rows, input, "2026-09", "2026-09-28");
  assert.deepEqual(m.weeks.map((w) => w.weekEnding), ["2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01"]);
  assert.deepEqual(m.weeks.map((w) => w.status), ["loaded", "loaded", "loaded", "to_come"]);
  assert.deepEqual(m.weeks.map((w) => w.payRun), ["2026-10-08", "2026-10-15", "2026-10-22", "2026-10-29"]);
  const by = Object.fromEntries(m.contractors.map((c) => [c.name, c]));
  const row = (name: string) => {
    const c = by[name];
    return [c.jobs, c.units, c.labour, c.parking, c.materials, c.chargedEx, c.chargedInc, c.labourCost, c.cis, c.reimbursed, c.deductions, c.netPayable, c.businessMaterials, c.grossMargin];
  };
  assert.deepEqual(row("Felix Cairns"), [3, 6, 750, 21.12, 90, 861.12, 1033.34, 480, 96, 111.12, 0, 495.12, 0, 270]);
  assert.deepEqual(row("Jack Nichols"), [15, 27.5, 3437.5, 95.39, 2888, 6420.89, 7705.08, 2200, 440, 609.51, 0, 2369.51, 2473.88, 1137.5]);
  assert.deepEqual(row("John Smyth"), [1, 1, 125, 0, 0, 125, 150, 80, 16, 0, 0, 64, 0, 45]);
  assert.deepEqual(row("JSD Drainage"), [3, 3, 495, 0, 0, 495, 594, 330, 66, 0, 0, 264, 0, 165]);
  assert.deepEqual(row("Julian Giles"), [4, 4, 1550, 12.01, 543.1, 2105.11, 2526.13, 765, 153, 555.11, 0, 1167.11, 0, 785]);
  assert.deepEqual(row("Mohammad Reza"), [24, 39, 5025, 110, 2132.99, 7267.99, 8721.59, 2261.26, 452.25, 1922.99, 506.25, 3225.75, 189.92, 2893.82]);
  assert.deepEqual(row("Ray Graham"), [1, 2, 250, 9.8, 180, 439.8, 527.76, 180, 36, 189.8, 0, 333.8, 0, 70]);
  assert.deepEqual(row("Robert Moghal"), [11, 13.5, 1772.5, 29.25, 250.27, 2052.02, 2462.42, 1100, 220, 279.52, 0, 1159.52, 0, 672.5]);
  assert.deepEqual(row("UNLMTD Electrical"), [6, 6, 2089.1, 7, 57.2, 2153.3, 2583.96, 1214.37, 242.87, 64.2, 0, 1035.7, 0, 874.73]);
  const t = m.total;
  assert.deepEqual(
    [t.jobs, t.units, t.labour, t.parking, t.materials, t.chargedEx, t.chargedInc, t.labourCost, t.cis, t.reimbursed, t.deductions, t.netPayable, t.businessMaterials, t.grossMargin],
    [68, 102, 15494.1, 284.57, 6141.56, 21920.23, 26304.28, 8610.63, 1722.13, 3732.25, 506.25, 10114.5, 2663.8, 6913.55]
  );
  assert.equal(Math.round(t.marginPct * 100), 32);
  const charged = Object.fromEntries(m.charged.map((c) => [c.name, c.byWeek]));
  assert.deepEqual(charged["Mohammad Reza"], [767, 4101.99, 2399, 0]);
  const margin = Object.fromEntries(m.margin.map((c) => [c.name, c.byWeek]));
  assert.deepEqual(margin["UNLMTD Electrical"], [128, 306.3, 440.43, 0]);
  for (const c of m.controls.slice(0, 4)) assert.equal(c.value, 0, c.label);
  assert.equal(m.controls[5].value, 0);
});

test("jobs held out, flagged and asked about", () => {
  const base = contractorInputs();
  base.jobs.push({
    ...base.jobs[0],
    uuid: "job-21274",
    jobNo: "21274",
    categoryName: "Refurbishment Works",
    completionDate: "2026-09-23",
    totalIncVat: 6890.62,
  });
  base.jobs.push({ ...base.jobs[0], uuid: "job-21299", jobNo: "21299", completedByUuid: "staff-jack-ronan", completionDate: "2026-09-23", totalIncVat: 0 });
  base.jobs.push({ ...base.jobs[0], uuid: "job-21216", jobNo: "21216", status: "Unsuccessful", completionDate: null, date: "2026-09-08", totalIncVat: 150 });
  const all = buildJobRows(base);
  const w = weekReport(all, base, "2026-09-24");
  assert.equal(w.heldOut.map((r) => r.jobNo).join(), "21274");
  assert.equal(w.rows.length, 26);
  const ronan = w.rows.find((r) => r.jobNo === "21299")!;
  assert.ok(ronan.flags.some((f) => f.code === "staff_job" && f.ask === "Who did it?"));
  assert.ok(ronan.flags.some((f) => f.code === "nil_value"));
  assert.ok(ronan.flags.some((f) => f.code === "not_in_xero") === false, "a nil value job is not chased for an invoice");
  const qs = suggestedQueries(w);
  assert.ok(qs.some((q) => q.jobNo === "21299" && q.ask.includes("Who did it?")));
  assert.ok(qs.some((q) => q.jobNo === "21288" && q.ask === "Their bill."));
  const w10 = weekReport(all, base, "2026-09-10");
  assert.equal(w10.unsuccessful.map((j) => j.jobNo).join(), "21216");
  assert.ok(suggestedQueries(w10).some((q) => q.jobNo === "21216" && q.ask === "Is it chargeable?"));
});

test("helpers", () => {
  assert.equal(classifyLine({ name: "Congestion charge", materialUuid: null }, []).cls, "parking");
  assert.equal(classifyLine({ name: "Labour - per hour", materialUuid: null }, []).cls, "labour_hourly");
  assert.equal(classifyLine({ name: "Fixed price works", materialUuid: null }, []).cls, "labour_fixed");
  assert.equal(classifyLine({ name: "Copper pipe 15mm", materialUuid: null }, []).cls, "materials");
  assert.equal(classifyLine({ name: "Copper pipe 15mm", materialUuid: null }, [{ id: "r", match: "copper", lineClass: "other", sort: 0 }]).cls, "other");
  assert.equal(mentionsJob("Job 21234, flat 2", "21234"), true);
  assert.equal(mentionsJob("Job 212345", "21234"), false);
  assert.equal(mentionsJob("ref 21227a", "21227A"), true);
  assert.equal(mentionsJob("ref 21227", "21227A"), false);
  const d = [
    { id: "a", contractorId: "c", label: "Uniform", amount: 50, startsOn: "2026-09-10", endsOn: "2026-10-01", weekEnding: null },
    { id: "b", contractorId: "c", label: "One-off", amount: 20, startsOn: null, endsOn: null, weekEnding: "2026-09-17" },
  ];
  assert.deepEqual(deductionsFor(d, "c", "2026-09-17", 4).map((x) => x.amount), [50, 20]);
  assert.deepEqual(deductionsFor(d, "c", "2026-10-08", 4).map((x) => x.amount), []);
  // Dates saved while weeks ended on Thursday still count once weeks end on Friday.
  assert.deepEqual(deductionsFor(d, "c", "2026-09-18", 5).map((x) => x.amount), [50, 20]);
  assert.deepEqual(deductionsFor(d, "c", "2026-10-02", 5).map((x) => x.amount), [50]);
  assert.deepEqual(deductionsFor(d, "c", "2026-10-09", 5).map((x) => x.amount), []);
  // A date typed mid-week stands for its week.
  const midWeek = [{ ...d[0], startsOn: "2026-09-14", endsOn: "2026-09-21" }];
  assert.deepEqual(["2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01"].map((w) => deductionsFor(midWeek, "c", w, 4).length), [0, 1, 1, 0]);
});

test("stage invoice lines are read as fixed-price labour on both jobs", () => {
  for (const name of ["Less stage invoice 20290A", "Stage invoice – 90% complete", "Less invoice 21239A", "Invoice 1234A", "Invoice no. 1234B balance"]) {
    assert.deepEqual(classifyLine({ name, materialUuid: null }, []), { cls: "labour_fixed", guessed: true }, name);
  }
  assert.equal(classifyLine({ name: "Unless stated, copper pipe", materialUuid: null }, []).cls, "materials");
  assert.equal(classifyLine({ name: "Invoice copy", materialUuid: null }, []).cls, "materials");

  const base = contractorInputs();
  const felix = base.jobs.find((j) => j.jobNo === "21341")!;
  const line = (jobUuid: string, n: number, name: string, ex: number) => ({ ...base.lines[0], uuid: `${jobUuid}-l${n}`, jobUuid, name, quantity: 1, unitPriceEx: ex, totalEx: ex, sort: n });
  base.jobs.push({ ...felix, uuid: "job-29992", jobNo: "29992" }, { ...felix, uuid: "job-29992A", jobNo: "29992A" });
  base.lines.push(line("job-29992", 1, "Fixed price works", 5000), line("job-29992", 2, "Less stage invoice 29992A", -3000), line("job-29992A", 1, "Stage invoice – 90% complete", 3000));
  const all = buildJobRows(base);
  const pair = ["29992", "29992A"].map((no) => all.find((r) => r.jobNo === no)!);
  assert.deepEqual(
    pair.map((r) => [r.labour, r.materials, r.labourCost, r.reimbursed, r.unclassified.length]),
    [
      [2000, 0, 900, 0, 0],
      [3000, 0, 1350, 0, 0],
    ]
  );
  // Nothing is paid back for the stage invoice: the week's reimbursement is still 20833's parking and materials.
  const felixWeek = weekReport(all, base, "2026-09-24").contractors.find((c) => c.name === "Felix Cairns")!;
  assert.deepEqual([felixWeek.reimbursed, felixWeek.labourCost], [111.12, 480 + 2250]);
});

const xeroBill = (number: string, supplier: string, reference: string, lines: [string, number][]): XeroInvoice => {
  const net = lines.reduce((n, [, a]) => n + a, 0);
  return {
    id: `bill-${number}`,
    type: "ACCPAY",
    number,
    reference,
    contactId: `contact-${supplier}`,
    contactName: supplier,
    date: "2026-09-15",
    dueDate: null,
    status: "AUTHORISED",
    subTotal: net,
    totalTax: 0,
    total: net,
    amountDue: net,
    amountPaid: 0,
    amountCredited: 0,
    fullyPaidOn: null,
    cisDeduction: 0,
    lines: lines.map(([description, amount]) => ({ description, quantity: 1, unitAmount: amount, lineAmount: amount, accountCode: "", taxAmount: 0, tracking: [] })),
  };
};

test("a merchant bill naming several jobs is shared between them, not charged in full to each", () => {
  const base = contractorInputs();
  // Nothing on a line names a job: split by charged ex VAT, 192 on 21239 and 510 on 21242.
  base.invoices.push(xeroBill("LHP999", "Lavender Hill Plumbing", "21239 / 21242", [["Fittings", 120]]));
  let all = buildJobRows(base);
  let job = (no: string) => all.find((r) => r.jobNo === no)!;
  assert.deepEqual(
    ["21239", "21242"].map((no) => [job(no).businessMaterials, job(no).grossMargin, job(no).bills.find((b) => b.number === "LHP999")?.net]),
    [
      [88.91, 46.84, 32.82],
      [151.09, 183.91, 87.18],
    ]
  );
  const flag = job("21239").flags.find((f) => f.code === "shared_bill");
  assert.deepEqual(flag, { code: "shared_bill", severity: "info", text: "Bill LHP999 names 2 jobs; £32.82 of it is on this job." });

  // Lines that name a job go to it; the delivery is split.
  base.invoices.pop();
  base.invoices.push(xeroBill("LHP998", "Lavender Hill Plumbing", "21239 / 21242", [["Valve for 21239", 50], ["Cartridges, job 21242", 70], ["Delivery", 12]]));
  all = buildJobRows(base);
  job = (no: string) => all.find((r) => r.jobNo === no)!;
  assert.deepEqual([job("21239").businessMaterials, job("21242").businessMaterials], [56.09 + 53.28, 63.91 + 78.72].map((n) => Math.round(n * 100) / 100));

  // Jobs with nothing charged share equally; amounts on a bill are not job numbers.
  base.invoices.pop();
  const blank = base.jobs.find((j) => j.jobNo === "21341")!;
  base.jobs.push({ ...blank, uuid: "job-29990", jobNo: "29990" }, { ...blank, uuid: "job-29991", jobNo: "29991" }, { ...blank, uuid: "job-150", jobNo: "150", status: "Work Order" });
  base.invoices.push(xeroBill("LHP997", "Lavender Hill Plumbing", "29990 29991", [["Valves at £150 each", 100], ["Delivery 150.00", 0]]));
  all = buildJobRows(base);
  assert.deepEqual(["29990", "29991"].map((no) => all.find((r) => r.jobNo === no)?.businessMaterials), [50, 50]);
});

test("a contractor's bill for several jobs pays each job's labour once", () => {
  const base = contractorInputs();
  base.invoices.push(xeroBill("JSD-W1", "JSD Solutions 24/7 Ltd", "Week to 10 Sep", [["Job 21073 labour", 150], ["Job 21217 labour", 150], ["Parking", 20]]));
  const all = buildJobRows(base);
  const jsd = all.filter((r) => r.jobNo === "21073" || r.jobNo === "21217");
  assert.deepEqual(
    jsd.map((r) => [r.costBasis, r.actualBill, r.labourCost, r.bills[0]?.net, r.bills[0]?.labour]),
    [
      ["actual_bill", 150, 150, 160, 150],
      ["actual_bill", 150, 150, 160, 150],
    ]
  );
  const week = weekReport(all, base, "2026-09-10").contractors.find((c) => c.name === "JSD Drainage")!;
  assert.deepEqual([week.labourCost, week.cis, week.netPayable], [300, 60, 240]);
});

test("a deleted job sharing a live job's number does not hide it", () => {
  const base = contractorInputs();
  base.jobs.push({ ...base.jobs.find((j) => j.jobNo === "21239")!, uuid: "job-21239-deleted", active: false });
  const all = buildJobRows(base);
  assert.equal(all.length, 68);
  assert.deepEqual(weekReport(all, base, "2026-09-17").xeroOnly, []);
  assert.equal(all.find((r) => r.jobNo === "21239")?.businessMaterials, 56.09);
});

test("a moved job stays in the reports after the day weeks end on changes", () => {
  const base = contractorInputs();
  const moved: JobAdjustment = {
    jobNo: "21073",
    contractorId: null,
    costBasis: null,
    fixedFeeId: null,
    actualBill: null,
    billRef: "",
    materialsPaidBy: null,
    businessMaterials: null,
    contractorExtra: null,
    treatment: "include",
    // Saved while weeks ended on Thursday.
    weekEnding: "2026-09-17",
    note: "",
    updatedAt: null,
  };
  base.adjustments = [...base.adjustments, moved];
  base.settings = { ...base.settings, weekEndsOn: 5 };
  const all = buildJobRows(base);
  assert.equal(all.find((r) => r.jobNo === "21073")?.weekEnding, "2026-09-18");
  assert.ok(all.every((r) => isoWeekday(r.weekEnding) === 5));
  assert.ok(monthReport(all, base, "2026-09", "2026-10-08").rows.some((r) => r.jobNo === "21073"));
});

test("default week falls back to the latest week with jobs", async () => {
  const { defaultWeek } = await import("./contractor");
  assert.equal(defaultWeek(rows, "2026-10-08"), "2026-09-24");
  assert.equal(defaultWeek(rows, "2026-09-17"), "2026-09-17");
  assert.equal(defaultWeek([], "2026-10-08"), "2026-10-08");
});
