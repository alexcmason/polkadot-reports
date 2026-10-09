import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDebtors, chaseEmailText, debtorBucket, ledgerBucket, xeroLedger, type DebtorInputs } from "./debtors";
import { CHASES, DEBTORS_NOW, EMAIL_BUCKETS, EMAIL_ROWS, EMAIL_TOTALS, debtorsInputs, salesInvoice, smJob } from "./fixtures/debtors.fixture";

const input = debtorsInputs();
const report = buildDebtors(input);
const find = (r: ReturnType<typeof buildDebtors>, jobNo: string) => r.rows.find((x) => x.jobNo === jobNo);

test("reproduces the chase email: 75 invoices, £55,615.29", () => {
  assert.equal(report.rows.length, 75);
  assert.deepEqual(report.total, EMAIL_TOTALS);
  assert.deepEqual(
    report.buckets.map((b) => [b.label, b.count, b.amount]),
    EMAIL_BUCKETS
  );
});

test("each row's days, balance and paid match the email, in the email's order", () => {
  assert.deepEqual(
    report.rows.map((r) => r.jobNo),
    EMAIL_ROWS.map((e) => e[0])
  );
  for (const [jobNo, customer, , , total, paid, , invoiced, days, balance] of EMAIL_ROWS) {
    const r = find(report, jobNo);
    assert.ok(r, jobNo);
    assert.equal(r.customer, customer);
    assert.equal(r.invoicedOn, invoiced, jobNo);
    assert.equal(r.days, days, jobNo);
    assert.equal(r.total, total, jobNo);
    assert.equal(r.paid, paid, jobNo);
    assert.equal(r.balance, balance, jobNo);
  }
});

test("whole days elapsed, not calendar dates", () => {
  // Both sent on 25 Sep: one before 12:12 UK time, one after.
  assert.equal(find(report, "21319")?.days, 6);
  assert.equal(find(report, "21276")?.days, 5);
  assert.equal(debtorBucket(29), "Under 30 days");
  assert.equal(debtorBucket(30), "30–59 days");
  assert.equal(debtorBucket(89), "60–89 days");
  assert.equal(debtorBucket(90), "90+ days");
});

test("notes say where part payments were taken", () => {
  assert.equal(find(report, "20238")?.note, "Part-paid via Xero");
  assert.equal(find(report, "20759")?.note, "Part-paid via ServiceM8 Pay");
  assert.equal(find(report, "20356")?.note, "Part-paid via Xero");
  assert.equal(find(report, "20784")?.note, "Part-paid via ServiceM8 Pay");
  assert.equal(find(report, "20286")?.note, "");
  for (const [jobNo, , , , , , paidIn, , , , note] of EMAIL_ROWS) {
    if (paidIn) assert.equal(find(report, jobNo)?.note, note, jobNo);
  }
});

test("paid elsewhere stays listed but is not to chase", () => {
  const r = find(report, "21297");
  assert.equal(r?.status, "paid");
  assert.equal(report.toChase.count, 74);
  assert.equal(report.toChase.amount, 55460.79);
  assert.deepEqual(report.byStatus.paid, { count: 1, amount: 154.5 });
  assert.deepEqual(report.byStatus.to_chase, { count: 74, amount: 55460.79 });
});

test("queried and on-hold invoices are flagged to the director", () => {
  const chases: DebtorInputs["chases"] = [
    ...CHASES,
    { jobNo: "20286", status: "queried", note: "Client disputes the call-out", lastChasedOn: "2026-09-24", chaseCount: 2 },
    { jobNo: "20298", status: "hold", note: "", lastChasedOn: null, chaseCount: 0 },
  ];
  const r = buildDebtors({ ...input, chases });
  const q = find(r, "20286");
  assert.equal(q?.flags.find((f) => f.code === "do_not_chase")?.text, "Do not chase – flag to the director");
  assert.equal(q?.daysSinceChased, 7);
  assert.ok(find(r, "20298")?.flags.some((f) => f.code === "do_not_chase"));
  assert.equal(r.toChase.count, 74);
  assert.equal(r.byStatus.queried.count, 1);
});

test("records that are not debtors are left out", () => {
  for (const jobNo of ["21001", "21002", "21003", "21004"]) assert.equal(find(report, jobNo), undefined, jobNo);
  assert.deepEqual(report.housekeeping, []);
});

test("a job paid in Xero but not in ServiceM8 goes to housekeeping", () => {
  const extra = { ...input };
  extra.jobs = [...input.jobs, smJob("21400", "Paid By Bacs", "5 High St, SW1A 1AA", "2026-09-20T09:00:00Z", 240)];
  extra.invoices = [...input.invoices, salesInvoice("21400", "Paid By Bacs", "2026-09-20", 240, 240)];
  const r = buildDebtors(extra);
  assert.equal(find(r, "21400"), undefined);
  assert.deepEqual(
    r.housekeeping.map((h) => [h.jobNo, h.smPaid, h.xeroPaid, h.text]),
    [["21400", 0, 240, "Paid in Xero – mark paid in ServiceM8"]]
  );
  assert.equal(r.total.count, 75);
});

test("a job sent 47 hours ago is not yet a debtor; at 48 hours it is", () => {
  const at = (hoursAgo: number) => new Date(Date.parse(DEBTORS_NOW) - hoursAgo * 3_600_000).toISOString();
  const r = buildDebtors({ ...input, jobs: [smJob("21500", "Recent", "", at(47), 100), smJob("21501", "Due", "", at(48), 100)] });
  assert.deepEqual(
    r.rows.map((x) => [x.jobNo, x.days, x.bucket]),
    [["21501", 2, "Under 30 days"]]
  );
  assert.ok(r.rows[0].flags.some((f) => f.code === "not_in_xero"));
});

test("Xero total that differs from ServiceM8 is noted", () => {
  const jobs = [smJob("21600", "Mismatch", "", "2026-09-01T09:00:00Z", 300)];
  const invoices = [salesInvoice("21600", "Mismatch", "2026-09-01", 360, 0)];
  const r = buildDebtors({ ...input, jobs, invoices, payments: [] });
  assert.equal(r.rows[0].note, "Xero total £360.00");
  assert.deepEqual(r.rows[0].flags, []);
});

test("by customer, largest first", () => {
  assert.deepEqual(report.byCustomer[0], { customer: "Inessa Taylor", count: 1, amount: 10000, oldestDays: 7 });
  const clarke = report.byCustomer.find((c) => c.customer === "Paula Clarke");
  assert.deepEqual(clarke, { customer: "Paula Clarke", count: 2, amount: 1001.88, oldestDays: 58 });
  const total = Math.round(report.byCustomer.reduce((a, c) => a + c.amount, 0) * 100) / 100;
  assert.equal(total, 55615.29);
});

test("chase email text", () => {
  const text = chaseEmailText(report, { businessName: "Polkadot", asAt: "1 Oct 2026 12:12" });
  const lines = text.split("\n");
  assert.ok(lines[0].startsWith("Polkadot – unpaid invoices as at 1 Oct 2026 12:12"));
  assert.ok(text.includes("48 hours after they went out. 75 invoices, £55,615.29 outstanding."));
  assert.ok(lines.includes("Under 30 days\t29\t£34,286.48"));
  assert.ok(lines.includes("90+ days\t11\t£5,072.14"));
  assert.ok(lines.includes("Total\t75\t£55,615.29"));
  assert.ok(lines.includes("20238\t48 Harley House, NW1 5HL\t48 Harley House, NW1 5HL\t2026-06-24\t99\t£369.50\t£275.75\t£93.75\tPart-paid via Xero"));
  assert.ok(lines.includes("20286\tJames Allum\t25 Elm Park, , SW2 2TX\t2026-06-11\t111\t£162.00\t\t£162.00\t"));
  assert.ok(lines.some((l) => l.startsWith("21297\t") && l.endsWith("Paid by card 22 Sep per Stripe – mark paid, do not chase")));
  assert.equal(lines.filter((l) => /^\w+\t/.test(l) && /\t20\d\d-\d\d-\d\d\t/.test(l)).length, 75);
});

test("xeroLedger ages unpaid sales invoices by days past due", () => {
  const today = "2026-10-01";
  const invoices = [
    salesInvoice("A1", "Alpha Ltd", "2026-09-20", 120, 0, "2026-10-05"), // not yet due
    salesInvoice("A2", "Alpha Ltd", "2026-09-01", 240, 40, "2026-09-01"), // 30 days
    salesInvoice("B1", "Beta Ltd", "2026-07-01", 600, 0, null), // 92 days from the invoice date
    salesInvoice("B2", "Beta Ltd", "2026-08-01", 360, 0, "2026-08-01"), // 61 days
    salesInvoice("C1", "Gamma Ltd", "2026-08-15", 90, 0, "2026-08-31"), // 31 days
    salesInvoice("P1", "Paid Ltd", "2026-08-15", 500, 500),
    { ...salesInvoice("V1", "Void Ltd", "2026-08-15", 500, 0), status: "VOIDED" },
    { ...salesInvoice("D1", "Draft Ltd", "2026-08-15", 500, 0), status: "DRAFT" },
    { ...salesInvoice("S1", "Gamma Ltd", "2026-09-30", 60, 0, "2026-10-01"), status: "SUBMITTED" }, // due today
    { ...salesInvoice("BILL", "Supplier", "2026-08-15", 500, 0), type: "ACCPAY" as const },
  ];
  const l = xeroLedger(invoices, today);
  assert.deepEqual(
    l.buckets.map((b) => [b.label, b.count, b.amount]),
    [
      ["Not yet due", 2, 180],
      ["1–30 days", 1, 200],
      ["31–60 days", 1, 90],
      ["61–90 days", 1, 360],
      ["Over 90 days", 1, 600],
    ]
  );
  assert.equal(l.total, 1430);
  assert.equal(l.count, 6);
  assert.deepEqual(
    l.rows.map((r) => [r.contactName, r.amounts, r.total]),
    [
      ["Beta Ltd", [0, 0, 0, 360, 600], 960],
      ["Alpha Ltd", [120, 200, 0, 0, 0], 320],
      ["Gamma Ltd", [60, 0, 90, 0, 0], 150],
    ]
  );
  assert.equal(ledgerBucket(0), 0);
  assert.equal(ledgerBucket(1), 1);
  assert.equal(ledgerBucket(90), 3);
  assert.equal(ledgerBucket(91), 4);
});

test("edge cases: no input, job numbers matched to Xero whatever the case", () => {
  const none = buildDebtors({ ...input, jobs: [], payments: [], invoices: [], chases: [] });
  assert.deepEqual([none.rows, none.housekeeping, none.byCustomer, none.total, none.toChase], [[], [], [], { count: 0, amount: 0 }, { count: 0, amount: 0 }]);
  assert.ok(none.buckets.every((b) => b.count === 0 && b.amount === 0));
  const ledger = xeroLedger([], "2026-10-01");
  assert.deepEqual([ledger.rows, ledger.total, ledger.count], [[], 0, 0]);

  const jobs = [smJob("21700a", "Lower Case", "", "2026-09-01T09:00:00Z", 100.1)];
  const invoices = [salesInvoice("21700A", "Lower Case", "2026-09-01", 100.1, 30.03)];
  const voided = { ...salesInvoice("21700a", "Lower Case", "2026-09-01", 100.1, 100.1), id: "void", status: "VOIDED" };
  const r = buildDebtors({ ...input, jobs, invoices: [voided, ...invoices], payments: [], chases: [{ ...CHASES[0], jobNo: "21700A", status: "write_off" }] });
  assert.deepEqual(
    r.rows.map((x) => [x.jobNo, x.paid, x.balance, x.note, x.status]),
    [["21700a", 30.03, 70.07, "Part-paid via Xero", "write_off"]]
  );
  assert.deepEqual(r.toChase, { count: 0, amount: 0 });
});
