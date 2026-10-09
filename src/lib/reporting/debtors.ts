/*
 * Debtors: invoices sent from ServiceM8 that are still unpaid once the automatic card
 * charge should have gone through (48 hours by default), and the Xero sales ledger.
 * The rules reproduce the client's chase email of 1 Oct 2026:
 *
 *   Paid     the larger of the payments in ServiceM8 and what Xero shows paid or credited.
 *   Days     whole days since the invoice was sent, not calendar dates.
 *   Totals   every outstanding invoice. "To chase" leaves out those paid elsewhere or written off.
 */

import { diffDays, round2, ukDate } from "./dates";
import type { Bucket, Flag, SmJob, SmPayment, XeroInvoice } from "./types";

export type ChaseStatus = "to_chase" | "chased" | "promised" | "queried" | "paid" | "write_off" | "hold";

export const CHASE_LABEL: Record<ChaseStatus, string> = {
  to_chase: "To chase",
  chased: "Chased",
  promised: "Payment promised",
  queried: "Queried by client",
  paid: "Paid elsewhere",
  write_off: "Write off",
  hold: "On hold",
};

export const CHASE_STATUSES = Object.keys(CHASE_LABEL) as ChaseStatus[];

/** Statuses left out of the amount to chase. */
export const NOT_TO_CHASE: ChaseStatus[] = ["paid", "write_off"];
/** Statuses the director handles: do not chase. */
export const DO_NOT_CHASE: ChaseStatus[] = ["queried", "hold"];

export type DebtorChase = { jobNo: string; status: ChaseStatus; note: string; lastChasedOn: string | null; chaseCount: number };

export type DebtorInputs = {
  jobs: SmJob[];
  payments: SmPayment[];
  invoices: XeroInvoice[];
  chases: DebtorChase[];
  chaseAfterHours: number;
  /** ISO timestamp. */
  now: string;
  /** UK date. */
  today: string;
};

export type DebtorRow = {
  jobNo: string;
  jobUuid: string;
  customer: string;
  site: string;
  /** When the invoice was sent, ISO timestamp. */
  sentAt: string;
  /** The UK date it was sent. */
  invoicedOn: string;
  days: number;
  bucket: string;
  total: number;
  smPaid: number;
  xeroPaid: number;
  paid: number;
  balance: number;
  xero: XeroInvoice | null;
  note: string;
  flags: Flag[];
  chase: DebtorChase;
  status: ChaseStatus;
  daysSinceChased: number | null;
};

export type HousekeepingRow = { jobNo: string; jobUuid: string; customer: string; total: number; smPaid: number; xeroPaid: number; xeroNumber: string; text: string };

export type CustomerDebt = { customer: string; count: number; amount: number; oldestDays: number };

export type CountAmount = { count: number; amount: number };

export type DebtorsReport = {
  rows: DebtorRow[];
  housekeeping: HousekeepingRow[];
  /** By age, over every outstanding row. */
  buckets: Bucket[];
  total: CountAmount;
  /** Leaves out rows marked paid elsewhere or written off. */
  toChase: CountAmount;
  byStatus: Record<ChaseStatus, CountAmount>;
  byCustomer: CustomerDebt[];
  chaseAfterHours: number;
  now: string;
};

export const DEBTOR_BUCKETS = ["Under 30 days", "30–59 days", "60–89 days", "90+ days"];

export function debtorBucket(days: number): string {
  return DEBTOR_BUCKETS[days < 30 ? 0 : days < 60 ? 1 : days < 90 ? 2 : 3];
}

const DAY = 86_400_000;
const HOUR = 3_600_000;
const DEAD = new Set(["VOIDED", "DELETED"]);

const money = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sum = (ns: number[]) => round2(ns.reduce((a, b) => a + b, 0));
const norm = (s: string) => s.trim().toUpperCase();

function countAmount(rows: DebtorRow[]): CountAmount {
  return { count: rows.length, amount: sum(rows.map((r) => r.balance)) };
}

export function buildDebtors(input: DebtorInputs): DebtorsReport {
  const nowMs = Date.parse(input.now);
  const paidByJob = new Map<string, number>();
  for (const p of input.payments) paidByJob.set(p.jobUuid, (paidByJob.get(p.jobUuid) ?? 0) + p.amount);
  const sales = new Map<string, XeroInvoice>();
  for (const i of input.invoices) {
    if (i.type !== "ACCREC" || DEAD.has(i.status.toUpperCase())) continue;
    if (!sales.has(norm(i.number))) sales.set(norm(i.number), i);
  }
  const chases = new Map(input.chases.map((c) => [norm(c.jobNo), c]));

  const rows: DebtorRow[] = [];
  const housekeeping: HousekeepingRow[] = [];
  for (const job of input.jobs) {
    if (!job.active || !job.invoiceSent || !job.invoiceSentAt || job.totalIncVat <= 0.005) continue;
    const sentMs = Date.parse(job.invoiceSentAt);
    if (Number.isNaN(sentMs) || (nowMs - sentMs) / HOUR < input.chaseAfterHours) continue;

    const total = round2(job.totalIncVat);
    const smPaid = round2(paidByJob.get(job.uuid) ?? 0);
    const xero = sales.get(norm(job.jobNo)) ?? null;
    const xeroPaid = xero ? round2(xero.amountPaid + xero.amountCredited) : 0;
    const paid = Math.max(smPaid, xeroPaid);
    const balance = round2(total - paid);
    if (balance <= 0.005) {
      if (smPaid < total - 0.005) {
        housekeeping.push({
          jobNo: job.jobNo,
          jobUuid: job.uuid,
          customer: job.customer,
          total,
          smPaid,
          xeroPaid,
          xeroNumber: xero?.number ?? "",
          text: "Paid in Xero – mark paid in ServiceM8",
        });
      }
      continue;
    }

    const notes: string[] = [];
    if (xeroPaid > smPaid && xeroPaid > 0) notes.push("Part-paid via Xero");
    else if (smPaid > 0) notes.push("Part-paid via ServiceM8 Pay");
    if (xero && Math.abs(xero.total - total) > 0.01) notes.push(`Xero total ${money(xero.total)}`);

    const chase = chases.get(norm(job.jobNo)) ?? { jobNo: job.jobNo, status: "to_chase", note: "", lastChasedOn: null, chaseCount: 0 };
    const flags: Flag[] = [];
    if (!xero) flags.push({ code: "not_in_xero", severity: "warn", text: "Not in Xero" });
    if (DO_NOT_CHASE.includes(chase.status)) {
      flags.push({ code: "do_not_chase", severity: "warn", text: "Do not chase – flag to the director" });
    }

    const days = Math.floor((nowMs - sentMs) / DAY);
    rows.push({
      jobNo: job.jobNo,
      jobUuid: job.uuid,
      customer: job.customer,
      site: job.site,
      sentAt: job.invoiceSentAt,
      invoicedOn: ukDate(job.invoiceSentAt) ?? job.invoiceSentAt.slice(0, 10),
      days,
      bucket: debtorBucket(days),
      total,
      smPaid,
      xeroPaid,
      paid,
      balance,
      xero,
      note: notes.join("; "),
      flags,
      chase,
      status: chase.status,
      daysSinceChased: chase.lastChasedOn ? diffDays(chase.lastChasedOn, input.today) : null,
    });
  }

  rows.sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || a.jobNo.localeCompare(b.jobNo, "en-GB", { numeric: true }));
  housekeeping.sort((a, b) => a.jobNo.localeCompare(b.jobNo, "en-GB", { numeric: true }));

  const buckets: Bucket[] = DEBTOR_BUCKETS.map((label) => {
    const inBucket = rows.filter((r) => r.bucket === label);
    return { label, ...countAmount(inBucket) };
  });
  const byStatus = Object.fromEntries(CHASE_STATUSES.map((s) => [s, countAmount(rows.filter((r) => r.status === s))])) as Record<ChaseStatus, CountAmount>;

  const customers = new Map<string, DebtorRow[]>();
  for (const r of rows) {
    const key = r.customer.trim().toLowerCase();
    customers.set(key, [...(customers.get(key) ?? []), r]);
  }
  const byCustomer: CustomerDebt[] = [...customers.values()]
    .map((rs) => ({ customer: rs[0].customer, ...countAmount(rs), oldestDays: Math.max(...rs.map((r) => r.days)) }))
    .sort((a, b) => b.amount - a.amount || a.customer.localeCompare(b.customer, "en-GB"));

  return {
    rows,
    housekeeping,
    buckets,
    total: countAmount(rows),
    toChase: countAmount(rows.filter((r) => !NOT_TO_CHASE.includes(r.status))),
    byStatus,
    byCustomer,
    chaseAfterHours: input.chaseAfterHours,
    now: input.now,
  };
}

/* Xero sales ledger, aged by days past the due date */

export const LEDGER_BUCKETS = ["Not yet due", "1–30 days", "31–60 days", "61–90 days", "Over 90 days"];

/** Index into LEDGER_BUCKETS for a number of days past due. */
export function ledgerBucket(daysOverdue: number): number {
  return daysOverdue <= 0 ? 0 : daysOverdue <= 30 ? 1 : daysOverdue <= 60 ? 2 : daysOverdue <= 90 ? 3 : 4;
}

export type LedgerInvoice = { invoice: XeroInvoice; daysOverdue: number; bucket: number; due: number };

export type LedgerRow = {
  contactId: string;
  contactName: string;
  /** Amount due in each of LEDGER_BUCKETS. */
  amounts: number[];
  total: number;
  invoices: LedgerInvoice[];
};

export type LedgerReport = { rows: LedgerRow[]; buckets: Bucket[]; total: number; count: number };

export function xeroLedger(invoices: XeroInvoice[], today: string): LedgerReport {
  const open: LedgerInvoice[] = invoices
    .filter((i) => i.type === "ACCREC" && ["AUTHORISED", "SUBMITTED"].includes(i.status.toUpperCase()) && i.amountDue > 0.005)
    .map((invoice) => {
      const daysOverdue = diffDays(invoice.dueDate ?? invoice.date, today);
      return { invoice, daysOverdue, bucket: ledgerBucket(daysOverdue), due: round2(invoice.amountDue) };
    });

  const contacts = new Map<string, LedgerInvoice[]>();
  for (const li of open) {
    const key = li.invoice.contactId || li.invoice.contactName;
    contacts.set(key, [...(contacts.get(key) ?? []), li]);
  }
  const rows: LedgerRow[] = [...contacts.values()]
    .map((lis) => {
      lis.sort((a, b) => a.invoice.date.localeCompare(b.invoice.date) || a.invoice.number.localeCompare(b.invoice.number));
      return {
        contactId: lis[0].invoice.contactId,
        contactName: lis[0].invoice.contactName,
        amounts: LEDGER_BUCKETS.map((_, b) => sum(lis.filter((li) => li.bucket === b).map((li) => li.due))),
        total: sum(lis.map((li) => li.due)),
        invoices: lis,
      };
    })
    .sort((a, b) => b.total - a.total || a.contactName.localeCompare(b.contactName, "en-GB"));

  const buckets: Bucket[] = LEDGER_BUCKETS.map((label, b) => {
    const inBucket = open.filter((li) => li.bucket === b);
    return { label, count: inBucket.length, amount: sum(inBucket.map((li) => li.due)) };
  });
  return { rows, buckets, total: sum(open.map((li) => li.due)), count: open.length };
}

/* The chase list as plain text for an email */

export function chaseEmailText(report: DebtorsReport, opts: { businessName: string; asAt: string }): string {
  const { count, amount } = report.total;
  const tab = (cells: (string | number)[]) => cells.join("\t");
  const out = [
    `${opts.businessName} – unpaid invoices as at ${opts.asAt}`,
    "",
    `Invoices sent from ServiceM8 that are still unpaid more than ${report.chaseAfterHours} hours after they went out. ${count} invoice${count === 1 ? "" : "s"}, ${money(amount)} outstanding.`,
    "",
    tab(["Age", "Invoices", "Outstanding"]),
    ...report.buckets.map((b) => tab([b.label, b.count, money(b.amount)])),
    tab(["Total", count, money(amount)]),
    "",
    tab(["Job", "Client", "Site", "Invoiced", "Days", "Invoice (inc VAT)", "Paid", "Balance", "Note"]),
    ...report.rows.map((r) => {
      const note = [r.note, r.chase.note, ...r.flags.filter((f) => f.code === "do_not_chase").map((f) => f.text)].filter(Boolean).join("; ");
      return tab([r.jobNo, r.customer, r.site, r.invoicedOn, r.days, money(r.total), r.paid ? money(r.paid) : "", money(r.balance), note]);
    }),
    "",
    "Balances are inc VAT and allow for payments recorded in ServiceM8 or Xero.",
  ];
  return out.join("\n");
}
