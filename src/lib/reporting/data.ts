import { one, q } from "../db";
import { parseXeroDate } from "../integrations/xero";
import { round2, ukDate } from "./dates";
import type { SmActivity, SmJob, SmLine, SmPayment, SmStaff, XeroAccount, XeroInvoice, XeroLine } from "./types";

/*
 * Turns the raw ServiceM8 and Xero records saved by the sync into the shapes the report
 * engines use. ServiceM8 sends every value as a string, and its times are UK local time.
 */

type Raw = Record<string, unknown>;

export type SmCompany = { uuid: string; name: string; isIndividual: boolean | null };
export type XeroTracking = { id: string; name: string; options: { id: string; name: string }[] };
export type ServiceM8Data = { jobs: SmJob[]; lines: SmLine[]; activities: SmActivity[]; payments: SmPayment[]; staff: SmStaff[] };
export type XeroData = {
  invoices: XeroInvoice[];
  bankTransactions: XeroInvoice[];
  tracking: XeroTracking[];
  accounts: XeroAccount[];
  /** financialYearEndMonth is 1 to 12, or null when Xero does not say. */
  organisation: { name: string; financialYearEndMonth: number | null } | null;
};
export type SyncSummary = {
  id: number;
  trigger: "manual" | "cron";
  status: "running" | "ok" | "error";
  startedAt: string;
  finishedAt: string | null;
  error: string;
  message: string;
  counts: Record<string, number>;
};

const text = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(text(v).trim() || NaN);
  return Number.isFinite(n) ? n : 0;
};
const yes = (v: unknown) => v === "1" || v === 1 || v === true;
const uuidOrNull = (v: unknown) => text(v).trim() || null;
/** "0000-00-00 00:00:00" and empty strings mean no value. */
const stamp = (v: unknown): string | null => {
  const s = text(v).trim();
  return s && !s.startsWith("0000") ? s : null;
};

const londonParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** How far London is ahead of UTC at a moment, in milliseconds. */
function londonOffset(ms: number): number {
  const p = Object.fromEntries(londonParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return local - Math.floor(ms / 1000) * 1000;
}

/** "2026-09-04 14:05:00" in London time as an ISO UTC timestamp, allowing for BST. */
export function londonToIso(v: unknown): string | null {
  const m = text(v)
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m || m[1] === "0000") return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  if (Number.isNaN(asUtc)) return null;
  const guess = asUtc - londonOffset(asUtc);
  return new Date(asUtc - londonOffset(guess)).toISOString();
}

/** An address on one line: "12 High St, Leeds, LS1 1AA". */
function oneLine(v: unknown): string {
  return text(v)
    .split(/\r?\n|\r/)
    .map((l) => l.replace(/\s+/g, " ").trim().replace(/,+$/, "").trim())
    .filter(Boolean)
    .join(", ");
}

const firstLine = (v: unknown) =>
  text(v)
    .split(/\r?\n|\r/)
    .map((l) => l.trim().replace(/,+$/, ""))
    .find(Boolean) ?? "";

export function normCompany(raw: Raw): SmCompany {
  const ind = text(raw.is_individual);
  return {
    uuid: text(raw.uuid),
    name: text(raw.name).trim(),
    isIndividual: ind === "1" ? true : ind === "0" ? false : null,
  };
}

export function normJob(
  raw: Raw,
  categories: Map<string, string>,
  companies: Map<string, { name: string; isIndividual: boolean | null }>
): SmJob {
  const categoryUuid = uuidOrNull(raw.category_uuid);
  const companyUuid = uuidOrNull(raw.company_uuid);
  const company = companyUuid ? companies.get(companyUuid) : undefined;
  return {
    uuid: text(raw.uuid),
    jobNo: text(raw.generated_job_id).trim(),
    status: text(raw.status),
    active: yes(raw.active),
    date: ukDate(stamp(raw.date)),
    completionDate: ukDate(stamp(raw.completion_date)),
    completedByUuid: uuidOrNull(raw.completion_actioned_by_uuid),
    categoryUuid,
    categoryName: (categoryUuid && categories.get(categoryUuid)) || "",
    companyUuid,
    customer: company?.name || firstLine(raw.billing_address),
    customerIsIndividual: company ? company.isIndividual : null,
    site: oneLine(raw.job_address),
    description: text(raw.job_description).trim(),
    workDone: text(raw.work_done_description).trim(),
    totalIncVat: num(raw.total_invoice_amount),
    invoiceSent: yes(raw.invoice_sent),
    invoiceSentAt: londonToIso(raw.invoice_sent_stamp),
    quoteSent: yes(raw.quote_sent),
    editedAt: londonToIso(raw.edit_date),
  };
}

export function normLine(raw: Raw): SmLine {
  const quantity = num(raw.quantity);
  const unitPriceEx = num(raw.price);
  return {
    uuid: text(raw.uuid),
    jobUuid: text(raw.job_uuid),
    materialUuid: uuidOrNull(raw.material_uuid),
    name: text(raw.name).trim(),
    quantity,
    unitPriceEx,
    totalEx: round2(quantity * unitPriceEx),
    unitCost: num(raw.cost),
    sort: num(raw.sort_order),
  };
}

/** Start and end stay as ServiceM8's local "YYYY-MM-DD HH:MM:SS". */
export function normActivity(raw: Raw): SmActivity {
  return {
    uuid: text(raw.uuid),
    jobUuid: text(raw.job_uuid),
    staffUuid: text(raw.staff_uuid),
    start: stamp(raw.start_date),
    end: stamp(raw.end_date),
    recorded: yes(raw.activity_was_recorded),
    scheduled: yes(raw.activity_was_scheduled),
  };
}

export function normPayment(raw: Raw): SmPayment {
  return {
    uuid: text(raw.uuid),
    jobUuid: text(raw.job_uuid),
    amount: num(raw.amount),
    date: ukDate(stamp(raw.timestamp)),
    method: text(raw.method).trim(),
    note: text(raw.note).trim(),
    isDeposit: yes(raw.is_deposit),
  };
}

export function normStaff(raw: Raw): SmStaff {
  return { uuid: text(raw.uuid), name: `${text(raw.first).trim()} ${text(raw.last).trim()}`.trim(), active: yes(raw.active) };
}

/* Xero */

const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): Raw[] => (Array.isArray(v) ? v.map(obj) : []);

/** Line amounts are returned ex VAT, whatever the invoice's LineAmountTypes. */
function normLines(raw: Raw): XeroLine[] {
  const inclusive = text(raw.LineAmountTypes) === "Inclusive";
  return arr(raw.LineItems).map((l) => {
    const taxAmount = num(l.TaxAmount);
    const amount = num(l.LineAmount);
    return {
      description: text(l.Description),
      quantity: num(l.Quantity),
      unitAmount: num(l.UnitAmount),
      lineAmount: inclusive ? round2(amount - taxAmount) : amount,
      accountCode: text(l.AccountCode),
      taxAmount,
      tracking: arr(l.Tracking).map((t) => ({ name: text(t.Name), option: text(t.Option) })),
    };
  });
}

export function normInvoice(raw: Raw): XeroInvoice {
  const contact = obj(raw.Contact);
  return {
    id: text(raw.InvoiceID),
    type: text(raw.Type) === "ACCPAY" ? "ACCPAY" : "ACCREC",
    number: text(raw.InvoiceNumber),
    reference: text(raw.Reference),
    contactId: text(contact.ContactID),
    contactName: text(contact.Name),
    date: parseXeroDate(raw.DateString ?? raw.Date) ?? "",
    dueDate: parseXeroDate(raw.DueDateString ?? raw.DueDate),
    status: text(raw.Status),
    subTotal: num(raw.SubTotal),
    totalTax: num(raw.TotalTax),
    total: num(raw.Total),
    amountDue: num(raw.AmountDue),
    amountPaid: num(raw.AmountPaid),
    amountCredited: num(raw.AmountCredited),
    fullyPaidOn: parseXeroDate(raw.FullyPaidOnDate),
    cisDeduction: num(raw.CISDeduction),
    lines: normLines(raw),
  };
}

/** Spend and receive money in the bank, shaped like a bill or a sales invoice. */
export function normBankTransaction(raw: Raw): XeroInvoice {
  const contact = obj(raw.Contact);
  const id = text(raw.BankTransactionID);
  const status = text(raw.Status);
  const total = num(raw.Total);
  const date = parseXeroDate(raw.DateString ?? raw.Date) ?? "";
  const amountPaid = yes(raw.IsReconciled) || status === "AUTHORISED" ? total : 0;
  return {
    id,
    type: text(raw.Type).startsWith("SPEND") ? "ACCPAY" : "ACCREC",
    number: text(raw.Reference).trim() || id.slice(0, 8),
    reference: text(raw.Reference),
    contactId: text(contact.ContactID),
    contactName: text(contact.Name),
    date,
    dueDate: null,
    status,
    subTotal: num(raw.SubTotal),
    totalTax: num(raw.TotalTax),
    total,
    amountDue: round2(total - amountPaid),
    amountPaid,
    amountCredited: 0,
    fullyPaidOn: amountPaid ? date || null : null,
    cisDeduction: 0,
    lines: normLines(raw),
  };
}

/* Loaders */

async function records(source: "servicem8" | "xero", kind: string, activeOnly = false): Promise<Raw[]> {
  const rows = await q<{ data: Raw }>(
    `select data from source_records
      where source = $1 and kind = $2 ${activeOnly ? "and coalesce(data ->> 'active', '1') <> '0'" : ""}`,
    [source, kind]
  );
  return rows.map((r) => r.data);
}

/** Jobs include inactive ones, flagged, so the engines can drop them. Lines, time and payments are active ones only. */
export async function loadServiceM8(): Promise<ServiceM8Data> {
  const [categories, companies, jobs, lines, activities, payments, staff] = await Promise.all([
    records("servicem8", "category"),
    records("servicem8", "company"),
    records("servicem8", "job"),
    records("servicem8", "jobmaterial", true),
    records("servicem8", "jobactivity", true),
    records("servicem8", "jobpayment", true),
    records("servicem8", "staff"),
  ]);
  const catMap = new Map(categories.map((c) => [text(c.uuid), text(c.name).trim()]));
  const coMap = new Map(companies.map((c) => normCompany(c)).map((c) => [c.uuid, c]));
  return {
    jobs: jobs.map((j) => normJob(j, catMap, coMap)),
    lines: lines.map(normLine).sort((a, b) => a.jobUuid.localeCompare(b.jobUuid) || a.sort - b.sort),
    activities: activities.map(normActivity),
    payments: payments.map(normPayment),
    staff: staff.map(normStaff),
  };
}

export async function loadXero(): Promise<XeroData> {
  const [invoices, bank, tracking, accounts, orgs] = await Promise.all([
    records("xero", "invoice"),
    records("xero", "banktransaction"),
    records("xero", "tracking"),
    records("xero", "account"),
    records("xero", "organisation"),
  ]);
  const org = orgs[0];
  return {
    invoices: invoices.map(normInvoice),
    bankTransactions: bank.map(normBankTransaction),
    tracking: tracking.map((t) => ({
      id: text(t.TrackingCategoryID),
      name: text(t.Name),
      options: arr(t.Options).map((o) => ({ id: text(o.TrackingOptionID), name: text(o.Name) })),
    })),
    accounts: accounts.map((a) => ({
      code: text(a.Code),
      name: text(a.Name),
      type: text(a.Type),
      ...(text(a.ReportingCode) ? { reportingCode: text(a.ReportingCode) } : {}),
    })),
    organisation: org
      ? {
          name: text(org.Name) || text(org.LegalName),
          financialYearEndMonth: num(org.FinancialYearEndMonth) >= 1 && num(org.FinancialYearEndMonth) <= 12 ? num(org.FinancialYearEndMonth) : null,
        }
      : null,
  };
}

/** Saved Xero reports by id, such as "pnl:2026-09" or "bs:2026-09". */
export async function loadReports(prefix?: string): Promise<Map<string, unknown>> {
  const rows = await q<{ ext_id: string; data: unknown }>(
    `select ext_id, data from source_records
      where source = 'xero' and kind = 'report' and ($1::text is null or left(ext_id, length($1::text)) = $1::text)`,
    [prefix ?? null]
  );
  return new Map(rows.map((r) => [r.ext_id, r.data]));
}

/** The latest refresh, finished or not. */
export async function lastSync(): Promise<SyncSummary | null> {
  const row = await one<{
    id: number;
    trigger: SyncSummary["trigger"];
    status: SyncSummary["status"];
    started_at: string;
    finished_at: string | null;
    error: string;
    detail: { message?: string; counts?: Record<string, number> } | null;
  }>(
    `select id, trigger, status, error, detail,
            to_char(started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as started_at,
            to_char(finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as finished_at
       from sync_runs order by started_at desc, id desc limit 1`
  );
  if (!row) return null;
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    message: row.detail?.message ?? "",
    counts: row.detail?.counts ?? {},
  };
}
