import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { IntegrationError, request } from "./http";
import { cursorPages, openJobPages, pages, sameServiceM8Account, verifyKey } from "./servicem8";
import { connectionChanged, liveStatement } from "./store";
import { errorText, stopsProvider } from "./sync";
import { authEventId, authUrl, bankTransactionPages, invoicePages, openSalesInvoicePages, parseXeroDate, parseXeroTimestamp } from "./xero";
import { londonToIso, normActivity, normBankTransaction, normCompany, normInvoice, normJob, normLine, normPayment, normStaff } from "../reporting/data";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; headers: Headers; method: string };

/** Replaces fetch with a list of canned responses, recording each request. */
function stubFetch(responses: (() => Response)[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers), method: init?.method ?? "GET" });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected request to ${String(input)}`);
    return next();
  }) as typeof fetch;
  return calls;
}

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

/* Dates */

test("parseXeroDate reads both of Xero's date forms", () => {
  assert.equal(parseXeroDate("/Date(1539993600000+0000)/"), "2018-10-20");
  assert.equal(parseXeroDate("/Date(1539993600000)/"), "2018-10-20");
  assert.equal(parseXeroDate("2018-10-20T00:00:00"), "2018-10-20");
  // Midnight in New Zealand is still the 20th, not the 19th in UTC.
  assert.equal(parseXeroDate("/Date(1539946800000+1300)/"), "2018-10-20");
  assert.equal(parseXeroDate("/Date(1540022400000-0800)/"), "2018-10-20");
  assert.equal(parseXeroDate(""), null);
  assert.equal(parseXeroDate(null), null);
  assert.equal(parseXeroDate(1539993600000), null);
  assert.equal(parseXeroDate("next Tuesday"), null);
});

test("parseXeroTimestamp gives ISO UTC times", () => {
  assert.equal(parseXeroTimestamp("/Date(1727777400000+0000)/"), "2024-10-01T10:10:00.000Z");
  assert.equal(parseXeroTimestamp("2024-10-01T10:10:00"), "2024-10-01T10:10:00.000Z");
  assert.equal(parseXeroTimestamp("2024-10-01T11:10:00+01:00"), "2024-10-01T10:10:00.000Z");
  assert.equal(parseXeroTimestamp(undefined), null);
});

test("London local times become UTC, allowing for BST", () => {
  assert.equal(londonToIso("2026-09-04 14:05:00"), "2026-09-04T13:05:00.000Z");
  assert.equal(londonToIso("2026-01-10 09:00:00"), "2026-01-10T09:00:00.000Z");
  assert.equal(londonToIso("2026-03-29 03:00:00"), "2026-03-29T02:00:00.000Z");
  assert.equal(londonToIso("2026-10-25 00:30:00"), "2026-10-24T23:30:00.000Z");
  assert.equal(londonToIso("0000-00-00 00:00:00"), null);
  assert.equal(londonToIso(""), null);
});

/* ServiceM8 normalising */

const categories = new Map([["cat-1", "Boiler Service"]]);
const companies = new Map([
  ["co-1", normCompany({ uuid: "co-1", name: "Mrs J Patel", is_individual: "1" })],
  ["co-2", normCompany({ uuid: "co-2", name: "Acme Lettings Ltd", is_individual: "0" })],
]);

const rawJob = {
  uuid: "job-1",
  active: "1",
  edit_date: "2026-09-04 16:20:11",
  date: "2026-09-02 00:00:00",
  status: "Completed",
  generated_job_id: "21297",
  company_uuid: "co-1",
  category_uuid: "cat-1",
  job_address: "12 High Street,\n Leeds \r\n\nLS1 1AA",
  billing_address: "Flat 2\n12 High Street",
  job_description: "Annual boiler service ",
  work_done_description: "Serviced boiler, all OK",
  completion_date: "2026-09-04 14:00:00",
  completion_actioned_by_uuid: "staff-1",
  total_invoice_amount: "114.00",
  invoice_sent: "1",
  invoice_sent_stamp: "2026-09-04 14:05:00",
  quote_sent: "0",
};

test("normJob reads a completed ServiceM8 job", () => {
  const job = normJob(rawJob, categories, companies);
  assert.deepEqual(job, {
    uuid: "job-1",
    jobNo: "21297",
    status: "Completed",
    active: true,
    date: "2026-09-02",
    completionDate: "2026-09-04",
    completedByUuid: "staff-1",
    categoryUuid: "cat-1",
    categoryName: "Boiler Service",
    companyUuid: "co-1",
    customer: "Mrs J Patel",
    customerIsIndividual: true,
    site: "12 High Street, Leeds, LS1 1AA",
    description: "Annual boiler service",
    workDone: "Serviced boiler, all OK",
    totalIncVat: 114,
    invoiceSent: true,
    invoiceSentAt: "2026-09-04T13:05:00.000Z",
    quoteSent: false,
    editedAt: "2026-09-04T15:20:11.000Z",
  });
});

test("normJob copes with zero dates, missing companies and winter times", () => {
  const job = normJob(
    {
      ...rawJob,
      active: 0,
      status: "Work Order",
      company_uuid: "missing",
      category_uuid: "",
      completion_date: "0000-00-00 00:00:00",
      completion_actioned_by_uuid: "",
      invoice_sent: "0",
      invoice_sent_stamp: "0000-00-00 00:00:00",
      total_invoice_amount: "",
      date: "2026-01-10 09:00:00",
      edit_date: "2026-01-10 09:00:00",
    },
    categories,
    companies
  );
  assert.equal(job.active, false);
  assert.equal(job.completionDate, null);
  assert.equal(job.completedByUuid, null);
  assert.equal(job.categoryUuid, null);
  assert.equal(job.categoryName, "");
  assert.equal(job.customer, "Flat 2");
  assert.equal(job.customerIsIndividual, null);
  assert.equal(job.invoiceSentAt, null);
  assert.equal(job.totalIncVat, 0);
  assert.equal(job.date, "2026-01-10");
  assert.equal(job.editedAt, "2026-01-10T09:00:00.000Z");
  assert.equal(normJob({ ...rawJob, company_uuid: "co-2" }, categories, companies).customerIsIndividual, false);
  assert.equal(normCompany({ uuid: "x", name: "Y", is_individual: "" }).isIndividual, null);
});

test("normLine works out the ex-VAT line total from strings", () => {
  assert.deepEqual(
    normLine({
      uuid: "line-1",
      active: "1",
      job_uuid: "job-1",
      material_uuid: "mat-1",
      name: "Labour (per hour) ",
      quantity: "1.5",
      price: "56.6700",
      cost: "40.00",
      sort_order: "2",
      displayed_amount: "68.00",
    }),
    { uuid: "line-1", jobUuid: "job-1", materialUuid: "mat-1", name: "Labour (per hour)", quantity: 1.5, unitPriceEx: 56.67, totalEx: 85.01, unitCost: 40, sort: 2 }
  );
  const blank = normLine({ uuid: "line-2", job_uuid: "job-1", material_uuid: "", quantity: "", price: "abc" });
  assert.equal(blank.materialUuid, null);
  assert.equal(blank.totalEx, 0);
});

test("normPayment, normActivity and normStaff", () => {
  assert.deepEqual(
    normPayment({ uuid: "pay-1", job_uuid: "job-1", amount: "114.00", timestamp: "2026-09-22 23:30:00", method: "Stripe", note: " card ", is_deposit: "0" }),
    { uuid: "pay-1", jobUuid: "job-1", amount: 114, date: "2026-09-22", method: "Stripe", note: "card", isDeposit: false }
  );
  assert.equal(normPayment({ uuid: "p", is_deposit: "1", timestamp: "0000-00-00 00:00:00" }).isDeposit, true);
  assert.equal(normPayment({ uuid: "p", timestamp: "0000-00-00 00:00:00" }).date, null);
  assert.deepEqual(
    normActivity({
      uuid: "act-1",
      job_uuid: "job-1",
      staff_uuid: "staff-1",
      start_date: "2026-09-04 09:00:00",
      end_date: "0000-00-00 00:00:00",
      activity_was_recorded: "1",
      activity_was_scheduled: "0",
    }),
    { uuid: "act-1", jobUuid: "job-1", staffUuid: "staff-1", start: "2026-09-04 09:00:00", end: null, recorded: true, scheduled: false }
  );
  assert.deepEqual(normStaff({ uuid: "s", first: "Jamie ", last: "", active: "1" }), { uuid: "s", name: "Jamie", active: true });
});

/* Xero normalising */

const rawInvoice = {
  Type: "ACCPAY",
  InvoiceID: "inv-1",
  InvoiceNumber: "JN-0412",
  Reference: "21242",
  Contact: { ContactID: "c-1", Name: "JN Heating Solutions" },
  Date: "/Date(1788566400000+0000)/",
  DateString: "2026-09-05T00:00:00",
  DueDate: "/Date(1790726400000+0000)/",
  DueDateString: "2026-09-30T00:00:00",
  Status: "PAID",
  LineAmountTypes: "Exclusive",
  SubTotal: 300,
  TotalTax: 0,
  Total: 300,
  AmountDue: 0,
  AmountPaid: 240,
  AmountCredited: 0,
  CISDeduction: 60,
  FullyPaidOnDate: "/Date(1790812800000+0000)/",
  UpdatedDateUTC: "/Date(1790816400000+0000)/",
  LineItems: [
    {
      Description: "Labour job 21242",
      Quantity: 1,
      UnitAmount: 240,
      LineAmount: 240,
      AccountCode: "320",
      TaxAmount: 0,
      Tracking: [{ TrackingCategoryID: "t-1", TrackingOptionID: "o-1", Name: "Sales Type", Option: "RE" }],
    },
    { Description: "Materials", Quantity: 2, UnitAmount: 30, LineAmount: 60, AccountCode: "310", TaxAmount: 0 },
  ],
};

test("normInvoice reads a CIS bill with tracking", () => {
  const inv = normInvoice(rawInvoice);
  assert.deepEqual(
    { ...inv, lines: undefined },
    {
      id: "inv-1",
      type: "ACCPAY",
      number: "JN-0412",
      reference: "21242",
      contactId: "c-1",
      contactName: "JN Heating Solutions",
      date: "2026-09-05",
      dueDate: "2026-09-30",
      status: "PAID",
      subTotal: 300,
      totalTax: 0,
      total: 300,
      amountDue: 0,
      amountPaid: 240,
      amountCredited: 0,
      fullyPaidOn: "2026-10-01",
      cisDeduction: 60,
      lines: undefined,
    }
  );
  assert.deepEqual(inv.lines, [
    { description: "Labour job 21242", quantity: 1, unitAmount: 240, lineAmount: 240, accountCode: "320", taxAmount: 0, tracking: [{ name: "Sales Type", option: "RE" }] },
    { description: "Materials", quantity: 2, unitAmount: 30, lineAmount: 60, accountCode: "310", taxAmount: 0, tracking: [] },
  ]);
});

test("normInvoice takes VAT off lines on a VAT-inclusive invoice", () => {
  const inv = normInvoice({
    Type: "ACCREC",
    InvoiceID: "inv-2",
    Date: "/Date(1788566400000+0000)/",
    LineAmountTypes: "Inclusive",
    LineItems: [{ Description: "Service", Quantity: 1, UnitAmount: 120, LineAmount: 120, TaxAmount: 20 }],
  });
  assert.equal(inv.type, "ACCREC");
  assert.equal(inv.date, "2026-09-05");
  assert.equal(inv.dueDate, null);
  assert.equal(inv.cisDeduction, 0);
  assert.equal(inv.lines[0].lineAmount, 100);
});

test("normBankTransaction treats spend money as a paid bill", () => {
  const spend = normBankTransaction({
    BankTransactionID: "9b3c1f0e-1111-2222-3333-444455556666",
    Type: "SPEND",
    Contact: { ContactID: "c-9", Name: "Screwfix" },
    DateString: "2026-09-12T00:00:00",
    Date: "/Date(1789171200000+0000)/",
    Status: "AUTHORISED",
    IsReconciled: false,
    LineAmountTypes: "Inclusive",
    SubTotal: 50,
    TotalTax: 10,
    Total: 60,
    Reference: "",
    LineItems: [{ Description: "Fittings for 21256", Quantity: 1, UnitAmount: 60, LineAmount: 60, TaxAmount: 10, AccountCode: "310" }],
  });
  assert.equal(spend.type, "ACCPAY");
  assert.equal(spend.number, "9b3c1f0e");
  assert.equal(spend.date, "2026-09-12");
  assert.equal(spend.amountPaid, 60);
  assert.equal(spend.amountDue, 0);
  assert.equal(spend.fullyPaidOn, "2026-09-12");
  assert.equal(spend.lines[0].lineAmount, 50);

  const receive = normBankTransaction({ BankTransactionID: "r-1", Type: "RECEIVE", Reference: "21297", Status: "DELETED", Total: 114, Date: "/Date(1789171200000+0000)/" });
  assert.equal(receive.type, "ACCREC");
  assert.equal(receive.number, "21297");
  assert.equal(receive.reference, "21297");
  assert.equal(receive.amountPaid, 0);
  assert.equal(receive.amountDue, 114);
  assert.equal(receive.fullyPaidOn, null);
});

/* HTTP */

test("ServiceM8 pages follow x-next-cursor with a hand-encoded filter", async () => {
  const calls = stubFetch([
    () => json([{ uuid: "a" }, { uuid: "b" }], { "x-next-cursor": "5f1b2c3d-0000-4000-8000-000000000001" }),
    () => json([{ uuid: "c" }]),
  ]);
  const got: string[][] = [];
  for await (const page of pages("key-123", "job", "edit_date gt '2026-10-01 00:00:00'")) got.push(page.map((r) => String(r.uuid)));
  assert.deepEqual(got, [["a", "b"], ["c"]]);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      "https://api.servicem8.com/api_1.0/job.json?%24filter=edit_date%20gt%20'2026-10-01%2000%3A00%3A00'&cursor=-1",
      "https://api.servicem8.com/api_1.0/job.json?%24filter=edit_date%20gt%20'2026-10-01%2000%3A00%3A00'&cursor=5f1b2c3d-0000-4000-8000-000000000001",
    ]
  );
  assert.equal(calls[0].headers.get("x-api-key"), "key-123");
  assert.equal(calls[0].headers.get("accept"), "application/json");
  assert.ok(!calls[0].url.includes("+"));
});

test("ServiceM8 pages stop when the cursor repeats, and can resume part way", async () => {
  const calls = stubFetch([
    () => json([{ uuid: "a" }], { "x-next-cursor": "c-1" }),
    () => json([{ uuid: "b" }], { "x-next-cursor": "c-1" }),
  ]);
  const seen: (string | null)[] = [];
  for await (const page of cursorPages("k", "staff")) seen.push(page.next);
  assert.deepEqual(seen, ["c-1", null]);
  assert.equal(calls[0].url, "https://api.servicem8.com/api_1.0/staff.json?cursor=-1");

  const resumed = stubFetch([() => json([{ uuid: "z" }])]);
  for await (const page of cursorPages("k", "jobmaterial", undefined, "c-9")) assert.equal(page.next, null);
  assert.equal(resumed[0].url, "https://api.servicem8.com/api_1.0/jobmaterial.json?cursor=c-9");
});

test("Xero invoice pages use paging, a date filter and If-Modified-Since", async () => {
  const full = Array.from({ length: 1000 }, (_, i) => ({ InvoiceID: `i${i}` }));
  const calls = stubFetch([
    () => json({ Status: "OK", pagination: { page: 1, pageSize: 1000, pageCount: 2, itemCount: 1003 }, Invoices: full }),
    () => json({ Status: "OK", pagination: { page: 2, pageSize: 1000, pageCount: 2, itemCount: 1003 }, Invoices: full.slice(0, 3) }),
  ]);
  const sizes: number[] = [];
  for await (const rows of invoicePages("tok", "tenant-1", { fromDate: "2026-01-01", modifiedSince: "2026-10-01T09:30:00.000Z" })) {
    sizes.push(rows.length);
  }
  assert.deepEqual(sizes, [1000, 3]);
  assert.equal(calls.length, 2);
  const first = new URL(calls[0].url);
  assert.equal(first.origin + first.pathname, "https://api.xero.com/api.xro/2.0/Invoices");
  assert.equal(first.searchParams.get("page"), "1");
  assert.equal(first.searchParams.get("pageSize"), "1000");
  assert.equal(first.searchParams.get("where"), "Date>=DateTime(2026,1,1)");
  assert.ok(calls[0].url.includes("where=Date%3E%3DDateTime%282026%2C1%2C1%29"), "where is encoded once");
  assert.equal(new URL(calls[1].url).searchParams.get("page"), "2");
  assert.equal(calls[0].headers.get("if-modified-since"), "2026-10-01T09:30:00");
  assert.equal(calls[0].headers.get("authorization"), "Bearer tok");
  assert.equal(calls[0].headers.get("xero-tenant-id"), "tenant-1");
  assert.equal(calls[0].headers.get("accept"), "application/json");
});

test("Xero invoice pages stop at pageCount and send no date filter when none is given", async () => {
  const calls = stubFetch([() => json({ pagination: { page: 1, pageSize: 1000, pageCount: 1 }, Invoices: [{ InvoiceID: "x" }] })]);
  for await (const rows of invoicePages("tok", "t", {})) assert.equal(rows.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get("where"), null);
  assert.equal(calls[0].headers.get("if-modified-since"), null);
});

test("Xero pages keep going when an endpoint sends 100 a page, and never send + for spaces", async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => ({ BankTransactionID: `b${i}` }));
  const calls = stubFetch([
    () => json({ BankTransactions: hundred }),
    () => json({ pagination: { page: 2, pageSize: 100, pageCount: 3 }, BankTransactions: hundred }),
    () => json({ BankTransactions: [] }),
  ]);
  const sizes: number[] = [];
  for await (const rows of bankTransactionPages("tok", "t", {})) sizes.push(rows.length);
  assert.deepEqual(sizes, [100, 100]);
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.includes("order=UpdatedDateUTC%20ASC"));
  assert.ok(!calls[0].url.includes("+"));
});

/** A stand-in for Xero's Invoices listing: If-Modified-Since to the second, oldest change first, numbered pages. */
function fakeXero(records: { id: string; at: number }[], between: (call: number) => void = () => {}) {
  const calls: { page: number; since: string | null }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    between(calls.length);
    const url = new URL(String(input));
    const since = new Headers(init?.headers).get("if-modified-since");
    const page = Number(url.searchParams.get("page"));
    const size = Number(url.searchParams.get("pageSize"));
    calls.push({ page, since });
    const from = since ? Date.parse(`${since}Z`) : -Infinity;
    const list = records.filter((r) => Math.floor(r.at / 1000) * 1000 > from).sort((a, b) => a.at - b.at);
    const rows = list.slice((page - 1) * size, page * size).map((r) => ({ InvoiceID: r.id, UpdatedDateUTC: `/Date(${r.at}+0000)/` }));
    return json({ pagination: { page, pageSize: size, pageCount: Math.ceil(list.length / size), itemCount: list.length }, Invoices: rows });
  }) as typeof fetch;
  return calls;
}

const T0 = Date.parse("2026-09-01T08:00:00Z");

test("Xero pages carry on from the newest change read, so an edit part way cannot hide a record", async () => {
  const records = Array.from({ length: 1500 }, (_, i) => ({ id: `i${i}`, at: T0 + i * 1000 }));
  // Someone pays invoice i10 between the first and second requests, so it moves to the end.
  const calls = fakeXero(records, (n) => {
    if (n === 1) records[10].at = T0 + 10_000_000;
  });
  const seen: string[] = [];
  for await (const rows of invoicePages("tok", "t", {})) seen.push(...rows.map((r) => String(r.InvoiceID)));
  assert.equal(new Set(seen).size, 1500, "every invoice is read");
  assert.ok(seen.includes("i1000"), "the invoice at the page boundary is not skipped");
  assert.equal(seen.filter((id) => id === "i10").length, 2, "the edited invoice is read again");
  assert.deepEqual(
    calls.map((c) => c.page),
    [1, 1]
  );
  assert.equal(calls[0].since, null);
  // A second before the newest change read, so changes in the same second are read again.
  assert.equal(calls[1].since, new Date(T0 + 998_000).toISOString().slice(0, 19));
});

test("Xero pages go by page number when a whole page shares one second, and still finish", async () => {
  const records = Array.from({ length: 2500 }, (_, i) => ({ id: `b${i}`, at: T0 + (i % 7) }));
  const calls = fakeXero(records);
  const sizes: number[] = [];
  for await (const rows of invoicePages("tok", "t", { modifiedSince: "2026-08-31T00:00:00Z" })) sizes.push(rows.length);
  assert.deepEqual(sizes, [1000, 1000, 500]);
  assert.deepEqual(
    calls.map((c) => [c.page, c.since]),
    [
      [1, "2026-08-31T00:00:00"],
      [2, "2026-08-31T00:00:00"],
      [3, "2026-08-31T00:00:00"],
    ]
  );

  // Once a page reaches past that second, it carries on from the newest change again.
  const mixed = [
    ...Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, at: T0 })),
    ...Array.from({ length: 1500 }, (_, i) => ({ id: `m${i}`, at: T0 + 5000 + i * 1000 })),
  ];
  const again = fakeXero(mixed);
  const ids = new Set<string>();
  for await (const rows of invoicePages("tok", "t", {})) for (const r of rows) ids.add(String(r.InvoiceID));
  assert.equal(ids.size, 2500);
  assert.deepEqual(
    again.map((c) => c.page),
    [1, 2, 1]
  );
  assert.equal(again[2].since, new Date(T0 + 5000 + 998_000).toISOString().slice(0, 19));
});

test("Unpaid sales invoices are asked for whatever their date, and others can be read again by id", async () => {
  const calls = stubFetch([
    () => json({ pagination: { page: 1, pageSize: 1000, pageCount: 1 }, Invoices: [{ InvoiceID: "old" }] }),
    () => json({ pagination: { page: 1, pageSize: 1000, pageCount: 1 }, Invoices: [{ InvoiceID: "a" }, { InvoiceID: "b" }] }),
  ]);
  for await (const rows of openSalesInvoicePages("tok", "t")) assert.equal(rows.length, 1);
  const open = new URL(calls[0].url);
  assert.equal(open.searchParams.get("Statuses"), "AUTHORISED,SUBMITTED");
  assert.equal(open.searchParams.get("where"), 'Type=="ACCREC" AND AmountDue>0');
  assert.ok(calls[0].url.includes("where=Type%3D%3D%22ACCREC%22%20AND%20AmountDue%3E0"));
  assert.equal(calls[0].headers.get("if-modified-since"), null);

  for await (const rows of invoicePages("tok", "t", { ids: ["a", "b"] })) assert.equal(rows.length, 2);
  const byId = new URL(calls[1].url);
  assert.equal(byId.searchParams.get("IDs"), "a,b");
  assert.equal(byId.searchParams.get("where"), null);
});

test("ServiceM8 unpaid invoiced jobs are listed whatever their edit date", async () => {
  const calls = stubFetch([() => json([{ uuid: "job-old" }])]);
  for await (const page of openJobPages("k")) assert.equal(page.rows.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.servicem8.com/api_1.0/job.json?%24filter=invoice_sent%20eq%20'1'%20and%20payment_received%20eq%20'0'&cursor=-1"
  );
});

test("A ServiceM8 account is known by its vendor uuid, never by its name", async () => {
  stubFetch([() => json([{ uuid: "v-1", name: " Patel Plumbing " }])]);
  assert.deepEqual(await verifyKey("k"), { accountName: "Patel Plumbing", vendorId: "v-1" });

  // A key that cannot read vendor.json still works, but proves nothing about the account.
  const calls = stubFetch([() => new Response("", { status: 403 }), () => json([])]);
  assert.deepEqual(await verifyKey("k"), { accountName: "ServiceM8", vendorId: "" });
  assert.match(calls[1].url, /taxrate\.json/);

  assert.equal(sameServiceM8Account("v-1", "v-1"), true);
  assert.equal(sameServiceM8Account("v-1", "v-2"), false);
  assert.equal(sameServiceM8Account("", ""), false, "two unknown accounts are not the same one");
  assert.equal(sameServiceM8Account("v-1", ""), false);
  assert.equal(sameServiceM8Account("", "v-1"), false);
  assert.equal(sameServiceM8Account(null, "v-1"), false);
  assert.equal(sameServiceM8Account(undefined, "v-1"), false);
});

test("A write refused because the connection changed stops that system's refresh", () => {
  const changed = connectionChanged();
  assert.ok(stopsProvider(changed));
  assert.ok(stopsProvider(new IntegrationError("reconnect", "x")));
  assert.ok(!stopsProvider(new IntegrationError("provider", "x")), "other problems are noted and the rest carries on");
  assert.equal(errorText("Xero", changed), "Xero: The connection changed during the refresh. Refresh again.");

  const sql = liveStatement("insert into t select $4 where exists (select 1 from live)");
  assert.match(sql, /generation = \$3 for share/);
  assert.match(sql, /id = \$2/);
  assert.match(sql, /w as \(insert into t select \$4 where exists \(select 1 from live\)\)/);
  assert.match(sql, /select exists \(select 1 from live\) as live\s*$/);
});

test("request waits out a 429 and names the system on a rejected key", async () => {
  const calls = stubFetch([() => new Response("slow down", { status: 429, headers: { "Retry-After": "0" } }), () => json({ ok: true })]);
  const res = await request("https://example.test/a", { label: "Xero" });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);

  stubFetch([() => new Response('{"errorCode":"401"}', { status: 401 })]);
  await assert.rejects(request("https://example.test/b", { label: "ServiceM8" }), (err: unknown) => {
    assert.ok(err instanceof IntegrationError);
    assert.equal(err.kind, "reconnect");
    assert.equal(err.message, "ServiceM8 rejected the API key. Add a new key in Settings.");
    return true;
  });

  stubFetch([() => new Response("Number of allowed API requests per day exceeded", { status: 429 })]);
  await assert.rejects(request("https://example.test/c", { label: "ServiceM8" }), (err: unknown) => err instanceof IntegrationError && err.kind === "rate_limit");

  stubFetch([() => new Response("bad filter", { status: 400 })]);
  await assert.rejects(request("https://example.test/d", { label: "Xero" }), (err: unknown) => {
    assert.ok(err instanceof IntegrationError);
    assert.equal(err.kind, "provider");
    assert.match(err.message, /400.*bad filter/);
    return true;
  });
});

test("Xero sign-in link and auth event id", () => {
  process.env.XERO_CLIENT_ID = "abc";
  process.env.XERO_CLIENT_SECRET = "def";
  const url = new URL(authUrl("st", "https://app.example/api/integrations/xero/callback"));
  assert.equal(url.origin + url.pathname, "https://login.xero.com/identity/connect/authorize");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("client_id"), "abc");
  assert.equal(url.searchParams.get("state"), "st");
  assert.ok(url.searchParams.get("scope")?.split(" ").includes("offline_access"));
  assert.ok(!url.search.includes("+"));

  const payload = Buffer.from(JSON.stringify({ authentication_event_id: "evt-1", xero_userid: "u" })).toString("base64url");
  assert.equal(authEventId(`h.${payload}.sig`), "evt-1");
  assert.equal(authEventId("not-a-jwt"), null);
});
