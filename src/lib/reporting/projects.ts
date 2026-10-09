/*
 * Projects tracker.
 *
 * Each project is a piece of quoted work done by a subcontractor, linked to one or more
 * ServiceM8 jobs. The rules follow the client's projects spreadsheet:
 *
 *   Price         our price ex VAT: the linked jobs' lines (or an override), with any stage job
 *                 (the job number plus one letter) they lead to. Nil for goodwill work.
 *   Sub cost used completed: what the subcontractor billed, or the estimate if nothing billed yet.
 *                 Otherwise the larger of the two.
 *   Gross profit  price - sub cost used - other costs. Markup is on cost, margin on price.
 *   Billed        Xero sales invoices for the jobs (job number, or job number plus one letter),
 *                 jobs invoiced from ServiceM8 but not in Xero, and deposits on jobs not invoiced.
 */

import { diffDays, round2, ukDate } from "./dates";
import type { Flag, ReportSettings, SmJob, SmLine, SmPayment, XeroInvoice } from "./types";

export type ProjectStatus = "awaiting_price" | "quoted" | "in_progress" | "completed" | "lost";

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  awaiting_price: "Awaiting price",
  quoted: "Quoted",
  in_progress: "In progress",
  completed: "Completed",
  lost: "Lost",
};

export const PROJECT_STATUS_ORDER: ProjectStatus[] = ["completed", "in_progress", "quoted", "awaiting_price", "lost"];

/** Statuses left out of the report totals. */
export const OUT_OF_TOTALS: ProjectStatus[] = ["lost", "awaiting_price"];

export type ProjectRecord = {
  id: string;
  customer: string;
  site: string;
  works: string;
  salesType: string;
  status: ProjectStatus;
  jobNumbers: string[];
  subcontractor: string;
  subSupplier: string;
  subEstimateNo: string;
  subQuoted: number | null;
  subCostOverride: number | null;
  priceOverride: number | null;
  goodwill: boolean;
  notes: string;
};

export type ProjectCost = {
  id: string;
  projectId: string;
  xeroInvoiceId: string | null;
  supplier: string;
  ref: string;
  date: string | null;
  description: string;
  amount: number;
  tie: "tied" | "probable";
  isSub: boolean;
};

export type ProjectInputs = {
  projects: ProjectRecord[];
  costs: ProjectCost[];
  jobs: SmJob[];
  lines: SmLine[];
  payments: SmPayment[];
  invoices: XeroInvoice[];
  settings: Pick<ReportSettings, "vatRate" | "projectCategories" | "lowMarginPct">;
  today: string;
};

export type ProjectJob = {
  jobNo: string;
  /** Null when the job number is not found in ServiceM8. */
  job: SmJob | null;
  categoryName: string;
  /** "RE", "S&M", "IN", "blank" or the category name. */
  categoryCode: string;
  /** The job's lines ex VAT. */
  priceEx: number;
};

export type RevenueLine = {
  source: "xero" | "servicem8" | "deposit";
  jobNo: string;
  ref: string;
  date: string | null;
  description: string;
  ex: number;
  inc: number;
  paid: number;
  due: number;
};

/** `voided` when the Xero bill has since been voided or deleted: the line is then left out of the figures. */
export type ProjectCostRow = ProjectCost & { bill: XeroInvoice | null; voided: boolean; paid: number | null; due: number | null };

export type ProjectTotals = {
  subQuoted: number;
  subInvoiced: number;
  subCostUsed: number;
  otherCosts: number;
  totalCost: number;
  price: number;
  grossProfit: number;
  /** Gross profit / total cost. Null when there is no cost. */
  markupPct: number | null;
  /** Gross profit / price. Null when there is no price. */
  marginPct: number | null;
  billedInc: number;
  clientPaid: number;
  clientOutstanding: number;
  subPaid: number;
  subOutstanding: number;
  costTied: number;
  costProbable: number;
};

export type ProjectRow = ProjectTotals & {
  record: ProjectRecord;
  jobs: ProjectJob[];
  revenue: RevenueLine[];
  costs: ProjectCostRow[];
  /** Invoiced to the client ex VAT, deposits aside. */
  invoicedEx: number;
  /** Deposits taken on jobs not yet invoiced, inc VAT. */
  deposits: number;
  billingStage: string;
  categoryCheck: string;
  flags: Flag[];
};

export type ProjectGroup = { status: ProjectStatus; label: string; rows: ProjectRow[]; totals: ProjectTotals };

export type ProjectsReport = {
  rows: ProjectRow[];
  groups: ProjectGroup[];
  /** Excludes lost projects and those awaiting a price. */
  totals: ProjectTotals;
  unallocatedBills: XeroInvoice[];
};

export type CostSuggestion = { bill: XeroInvoice; reason: string; tie: "tied" | "probable" };

const DEAD = new Set(["VOIDED", "DELETED"]);
const NOT_BILLED = new Set(["VOIDED", "DELETED", "DRAFT"]);

const money = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const sum = (ns: number[]) => round2(ns.reduce((a, b) => a + b, 0));

export const normJobNo = (s: string) => s.trim().toUpperCase();

/** A sales invoice belongs to a job when its number is the job number, or the job number plus one letter: 20290 and 20290A for job 20290. */
export function invoiceMatchesJob(invoiceNumber: string, jobNo: string): boolean {
  const n = normJobNo(invoiceNumber);
  const j = normJobNo(jobNo);
  if (!j || !n) return false;
  return n === j || (n.length === j.length + 1 && n.startsWith(j) && /[A-Z]$/.test(n));
}

/** The linked job an invoice is for: the job with its exact number, else the job it adds a letter to. */
function invoiceJob(invoiceNumber: string, jobNos: string[]): string | undefined {
  const n = normJobNo(invoiceNumber);
  return jobNos.find((no) => no === n) ?? jobNos.find((no) => invoiceMatchesJob(n, no));
}

/** "RE" for a project category, "S&M", "IN", "blank", otherwise the category name. */
export function categoryCode(name: string, projectCategories: string[]): string {
  const n = name.trim();
  if (!n) return "blank";
  if (projectCategories.some((c) => c.trim().toLowerCase() === n.toLowerCase())) return "RE";
  if (n.toUpperCase().includes("S&M")) return "S&M";
  if (/\bIN\b/.test(n) || /install/i.test(n)) return "IN";
  return n;
}

/** The UK postcode at the end of an address, without spaces: "SW163AZ". */
export function sitePostcode(site: string): string | null {
  const s = site.replace(/,?\s*(UK|United Kingdom)\s*$/i, "");
  const m = /([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\s*$/i.exec(s);
  return m ? `${m[1]}${m[2]}`.toUpperCase() : null;
}

function mentionsWord(text: string, word: string): boolean {
  if (!text || !word) return false;
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^0-9a-z])${esc}($|[^0-9a-z])`, "i").test(text);
}

// Xero holds what is typed in a bill's Reference box as its number.
const billText = (b: XeroInvoice) => [b.reference, b.number, ...b.lines.map((l) => l.description)].join(" \n ");

function allocatedIds(costs: ProjectCost[]): Set<string> {
  return new Set(costs.map((c) => c.xeroInvoiceId).filter((id): id is string => !!id));
}

const byDate = (a: XeroInvoice, b: XeroInvoice) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number);

/** Bills from the named suppliers that are not allocated to any project. */
export function unallocatedBills(invoices: XeroInvoice[], costs: ProjectCost[], supplierNames: string[]): XeroInvoice[] {
  const names = supplierNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (!names.length) return [];
  const used = allocatedIds(costs);
  return invoices
    .filter((i) => i.type === "ACCPAY" && !DEAD.has(i.status.toUpperCase()) && !used.has(i.id))
    .filter((i) => names.some((n) => i.contactName.toLowerCase().includes(n)))
    .sort(byDate);
}

/** Unallocated bills that look like they belong to a project: tied when they name a job or the site postcode, probable when from the subcontractor. */
export function suggestCosts(project: ProjectRecord, invoices: XeroInvoice[], costs: ProjectCost[]): CostSuggestion[] {
  const used = allocatedIds(costs);
  const jobNos = [...new Set(project.jobNumbers.map(normJobNo).filter(Boolean))];
  const postcode = sitePostcode(project.site);
  const supplier = project.subSupplier.trim().toLowerCase();
  const tied: CostSuggestion[] = [];
  const probable: CostSuggestion[] = [];
  for (const bill of invoices) {
    if (bill.type !== "ACCPAY" || DEAD.has(bill.status.toUpperCase()) || used.has(bill.id)) continue;
    const text = billText(bill);
    const job = jobNos.find((no) => mentionsWord(text, no));
    if (job) {
      tied.push({ bill, reason: `Mentions job ${job}`, tie: "tied" });
    } else if (postcode && text.replace(/\s+/g, "").toUpperCase().includes(postcode)) {
      tied.push({ bill, reason: `Mentions the site postcode ${postcode.slice(0, -3)} ${postcode.slice(-3)}`, tie: "tied" });
    } else if (supplier && bill.contactName.toLowerCase().includes(supplier)) {
      probable.push({ bill, reason: "From the subcontractor", tie: "probable" });
    }
  }
  const order = (a: CostSuggestion, b: CostSuggestion) => byDate(a.bill, b.bill);
  return [...tied.sort(order), ...probable.sort(order)];
}

type Indexes = {
  jobsByNo: Map<string, SmJob>;
  /** Lettered jobs by the job they add a letter to: 20290A under 20290. */
  stagesByBase: Map<string, string[]>;
  /** The projects that list each job number. */
  linkedBy: Map<string, string[]>;
  linesByJob: Map<string, SmLine[]>;
  paymentsByJob: Map<string, SmPayment[]>;
  billsById: Map<string, XeroInvoice>;
  sales: XeroInvoice[];
  costs: ProjectCost[];
};

function indexInputs(input: ProjectInputs): Indexes {
  const jobsByNo = new Map<string, SmJob>();
  for (const j of input.jobs) {
    const no = normJobNo(j.jobNo);
    if (j.active && no && !jobsByNo.has(no)) jobsByNo.set(no, j);
  }
  const stagesByBase = new Map<string, string[]>();
  for (const no of jobsByNo.keys()) {
    const base = no.slice(0, -1);
    if (base && invoiceMatchesJob(no, base)) stagesByBase.set(base, [...(stagesByBase.get(base) ?? []), no]);
  }
  const linkedBy = new Map<string, string[]>();
  for (const p of input.projects) {
    for (const no of new Set(p.jobNumbers.map(normJobNo).filter(Boolean))) linkedBy.set(no, [...(linkedBy.get(no) ?? []), p.id]);
  }
  const linesByJob = new Map<string, SmLine[]>();
  for (const l of input.lines) linesByJob.set(l.jobUuid, [...(linesByJob.get(l.jobUuid) ?? []), l]);
  const paymentsByJob = new Map<string, SmPayment[]>();
  for (const p of input.payments) paymentsByJob.set(p.jobUuid, [...(paymentsByJob.get(p.jobUuid) ?? []), p]);
  const billsById = new Map(input.invoices.filter((i) => i.type === "ACCPAY").map((i) => [i.id, i]));
  const seen = new Set<string>();
  const sales = input.invoices
    .filter((i) => {
      if (i.type !== "ACCREC" || NOT_BILLED.has(i.status.toUpperCase()) || seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    })
    .sort(byDate);
  // A Xero bill goes on one cost line only (the database enforces it), so a repeat is a duplicate.
  const allocated = new Set<string>();
  const costs = input.costs.filter((c) => {
    const key = c.xeroInvoiceId ? `bill:${c.xeroInvoiceId}` : `cost:${c.id}`;
    if (allocated.has(key)) return false;
    allocated.add(key);
    return true;
  });
  return { jobsByNo, stagesByBase, linkedBy, linesByJob, paymentsByJob, billsById, sales, costs };
}

function jobPriceEx(job: SmJob, ix: Indexes, vat: number): number {
  const lines = ix.linesByJob.get(job.uuid) ?? [];
  return lines.length ? sum(lines.map((l) => l.totalEx)) : round2(job.totalIncVat / (1 + vat));
}

function revenueFor(jobNos: string[], jobs: ProjectJob[], ix: Indexes, vat: number, theirs: (jobNo: string) => boolean): RevenueLine[] {
  const out: RevenueLine[] = [];
  for (const i of ix.sales) {
    const jobNo = invoiceJob(i.number, jobNos);
    if (!jobNo || (normJobNo(i.number) !== jobNo && theirs(normJobNo(i.number)))) continue;
    out.push({
      source: "xero",
      jobNo,
      ref: i.number,
      date: i.date,
      description: i.reference || i.lines[0]?.description || "",
      ex: round2(i.subTotal),
      inc: round2(i.total),
      paid: round2(i.amountPaid + i.amountCredited),
      due: round2(i.amountDue),
    });
  }
  // A job's ServiceM8 invoice is in Xero under the job's own number: a stage invoice (20290A) is not its balance.
  const inXero = new Set(out.map((l) => normJobNo(l.ref)));
  const invoiced = new Set(out.map((l) => l.jobNo));
  for (const { job, jobNo } of jobs) {
    if (!job) continue;
    const payments = ix.paymentsByJob.get(job.uuid) ?? [];
    if (job.invoiceSent) {
      if (inXero.has(jobNo)) continue;
      const inc = round2(job.totalIncVat);
      const paid = sum(payments.map((p) => p.amount));
      if (Math.abs(inc) < 0.005 && Math.abs(paid) < 0.005) continue;
      out.push({
        source: "servicem8",
        jobNo,
        ref: job.jobNo,
        date: ukDate(job.invoiceSentAt) ?? job.completionDate ?? job.date,
        description: job.description,
        ex: jobPriceEx(job, ix, vat),
        inc,
        paid,
        due: round2(Math.max(0, inc - paid)),
      });
    } else if (!invoiced.has(jobNo)) {
      for (const p of payments) {
        out.push({
          source: "deposit",
          jobNo,
          ref: job.jobNo,
          date: p.date,
          description: p.note || (p.isDeposit ? "Deposit" : "Payment before invoice"),
          ex: round2(p.amount / (1 + vat)),
          inc: round2(p.amount),
          paid: round2(p.amount),
          due: 0,
        });
      }
    }
  }
  return out;
}

function billingStage(r: ProjectRecord, revenue: RevenueLine[], price: number, vat: number, paid: number, outstanding: number): string {
  if (r.goodwill) return "Not charged (goodwill)";
  if (r.status === "lost") return "Not won";
  if (r.status === "awaiting_price") return "Not quoted yet";
  const invoices = revenue.filter((l) => l.source !== "deposit");
  const deposits = sum(revenue.filter((l) => l.source === "deposit").map((l) => l.inc));
  if (!revenue.length) return r.status === "quoted" ? "Quote sent – not invoiced" : "Not invoiced – no deposit";
  if (!invoices.length) {
    return deposits >= price * (1 + vat) - 0.01 ? "Paid in full up front – not yet invoiced" : "Deposit paid – not yet invoiced";
  }
  const invoicedEx = sum(invoices.map((l) => l.ex));
  const head = invoicedEx >= price - 0.01 ? "Fully invoiced" : "Part invoiced";
  const tail = outstanding <= 0.01 ? "paid" : paid > 0 ? "part paid" : "unpaid";
  return `${head} – ${tail}`;
}

function categoryCheck(jobs: ProjectJob[]): string {
  const codes = [...new Set(jobs.filter((j) => j.job).map((j) => j.categoryCode))];
  if (!codes.length) return "";
  if (codes.every((c) => c === "blank")) return "Blank";
  return codes.join(" / ");
}

function ratios(gp: number, cost: number, price: number) {
  return {
    markupPct: Math.abs(cost) < 0.005 ? null : gp / cost,
    marginPct: Math.abs(price) < 0.005 ? null : gp / price,
  };
}

function projectFlags(row: Omit<ProjectRow, "flags">, settings: ProjectInputs["settings"], today: string): Flag[] {
  const r = row.record;
  const flags: Flag[] = [];
  const shouldBe = r.salesType || settings.projectCategories[0] || "a project category";
  for (const c of row.costs) {
    if (c.voided) flags.push({ code: "bill_voided", severity: "warn", text: `Bill ${c.ref || c.bill?.number} is voided in Xero – left out of the cost` });
  }
  for (const j of row.jobs) {
    if (!j.job) {
      flags.push({ code: "job_missing", severity: "error", text: `Job ${j.jobNo} not found in ServiceM8`, ask: `Which ServiceM8 job is ${j.jobNo}?` });
    } else if (j.categoryCode !== "RE") {
      const text = j.categoryCode === "blank" ? `Job ${j.jobNo} has no category – should be ${shouldBe}` : `Job ${j.jobNo} is ${j.categoryCode} – should be ${shouldBe}`;
      flags.push({ code: "category", severity: "warn", text });
    }
  }
  if (row.grossProfit < -0.005) {
    flags.push({ code: "loss", severity: "error", text: `Loss of ${money(-row.grossProfit)}`, ask: "Is the price or the cost wrong?" });
  } else if (row.markupPct !== null && row.price > 0 && row.markupPct < settings.lowMarginPct) {
    const on = row.otherCosts ? "cost" : "subcontract price";
    flags.push({ code: "low_markup", severity: "warn", text: `Only ${pct(row.markupPct)} markup on the ${on}`, ask: "Is this the agreed price?" });
  }
  if (r.subQuoted !== null && row.subInvoiced > r.subQuoted + 0.005) {
    flags.push({
      code: "sub_over_estimate",
      severity: "warn",
      text: `Subcontractor billed ${money(row.subInvoiced - r.subQuoted)} over the estimate`,
      ask: "Was the extra agreed, and should it be passed on to the client?",
    });
  }
  if (!r.goodwill && row.subInvoiced > 0.005 && row.subInvoiced >= (r.subQuoted ?? 0) - 0.005 && row.billedInc < 0.005) {
    flags.push({
      code: "client_not_billed",
      severity: "warn",
      text: `Subcontractor has billed ${money(row.subInvoiced)} – client not invoiced yet`,
      ask: "When will the client be invoiced?",
    });
  }
  for (const l of row.revenue) {
    if (l.source === "deposit" || l.due <= 0.005 || !l.date) continue;
    const days = diffDays(l.date, today);
    if (days > 30) {
      flags.push({ code: "client_unpaid", severity: "warn", text: `Invoice ${l.ref} unpaid after ${days} days (${money(l.due)} due)`, ask: `Has invoice ${l.ref} been paid?` });
    }
  }
  if ((r.status === "completed" || r.status === "in_progress") && Math.abs(row.totalCost) < 0.005) {
    flags.push({ code: "no_cost", severity: "warn", text: "No cost recorded yet", ask: "Send the subcontractor's bill" });
  }
  return flags;
}

/** One project on its own. buildProjects does every project at once. */
export function buildProjectRow(record: ProjectRecord, input: ProjectInputs): ProjectRow {
  return projectRow(record, input, indexInputs(input));
}

function projectRow(record: ProjectRecord, input: ProjectInputs, ix: Indexes): ProjectRow {
  const vat = input.settings.vatRate;
  const linked = [...new Set(record.jobNumbers.map(normJobNo).filter(Boolean))];
  // A stage invoice moves part of a job's price to a lettered job (20290A), which is part of the
  // project too unless another project lists it.
  const theirs = (no: string) => (ix.linkedBy.get(no) ?? []).some((id) => id !== record.id);
  const stages = linked.flatMap((no) => ix.stagesByBase.get(no) ?? []).filter((no) => !linked.includes(no) && !theirs(no));
  const jobNos = [...linked, ...stages];
  const jobs: ProjectJob[] = jobNos.map((jobNo) => {
    const job = ix.jobsByNo.get(jobNo) ?? null;
    const categoryName = job?.categoryName ?? "";
    return {
      jobNo,
      job,
      categoryName,
      categoryCode: categoryCode(categoryName, input.settings.projectCategories),
      priceEx: job ? jobPriceEx(job, ix, vat) : 0,
    };
  });

  const found = jobs.filter((j) => j.job);
  const live = found.filter((j) => j.job?.status !== "Unsuccessful");
  // A lost project's jobs are usually marked Unsuccessful: price it on the quote that was lost.
  const priced = live.length || record.status !== "lost" ? live : found;
  const price = record.goodwill ? 0 : (record.priceOverride ?? sum(priced.map((j) => j.priceEx)));

  const costs: ProjectCostRow[] = ix.costs
    .filter((c) => c.projectId === record.id)
    .map((c) => {
      const bill = c.xeroInvoiceId ? (ix.billsById.get(c.xeroInvoiceId) ?? null) : null;
      if (!bill) return { ...c, bill: null, voided: false, paid: null, due: null };
      if (DEAD.has(bill.status.toUpperCase())) return { ...c, bill, voided: true, paid: null, due: null };
      const paid = round2(bill.total ? (c.amount * (bill.amountPaid + bill.amountCredited)) / bill.total : 0);
      return { ...c, bill, voided: false, paid, due: round2(c.amount - paid) };
    });
  const counted = costs.filter((c) => !c.voided);
  const sub = counted.filter((c) => c.isSub);
  const subQuoted = record.subQuoted ?? 0;
  const subInvoiced = sum(sub.map((c) => c.amount));
  const otherCosts = sum(counted.filter((c) => !c.isSub).map((c) => c.amount));
  const subCostUsed = round2(
    record.subCostOverride ?? (record.status === "completed" ? (subInvoiced > 0 ? subInvoiced : subQuoted) : Math.max(subInvoiced, subQuoted))
  );
  const totalCost = round2(subCostUsed + otherCosts);
  const grossProfit = round2(price - totalCost);

  const revenue = revenueFor(jobNos, jobs, ix, vat, theirs);
  const billedInc = sum(revenue.map((l) => l.inc));
  const clientPaid = sum(revenue.map((l) => l.paid));
  const clientOutstanding = sum(revenue.map((l) => l.due));

  const row: Omit<ProjectRow, "flags"> = {
    record,
    jobs,
    revenue,
    costs,
    invoicedEx: sum(revenue.filter((l) => l.source !== "deposit").map((l) => l.ex)),
    deposits: sum(revenue.filter((l) => l.source === "deposit").map((l) => l.inc)),
    subQuoted,
    subInvoiced,
    subCostUsed,
    otherCosts,
    totalCost,
    price,
    grossProfit,
    ...ratios(grossProfit, totalCost, price),
    billedInc,
    clientPaid,
    clientOutstanding,
    subPaid: sum(sub.map((c) => c.paid ?? 0)),
    subOutstanding: sum(sub.map((c) => c.due ?? 0)),
    costTied: sum(counted.filter((c) => c.tie === "tied").map((c) => c.amount)),
    costProbable: sum(counted.filter((c) => c.tie === "probable").map((c) => c.amount)),
    billingStage: billingStage(record, revenue, price, vat, clientPaid, clientOutstanding),
    categoryCheck: categoryCheck(jobs),
  };
  return { ...row, flags: projectFlags(row, input.settings, input.today) };
}

const MONEY_KEYS = [
  "subQuoted",
  "subInvoiced",
  "subCostUsed",
  "otherCosts",
  "totalCost",
  "price",
  "grossProfit",
  "billedInc",
  "clientPaid",
  "clientOutstanding",
  "subPaid",
  "subOutstanding",
  "costTied",
  "costProbable",
] as const;

export function projectTotals(rows: ProjectTotals[]): ProjectTotals {
  const t = Object.fromEntries(MONEY_KEYS.map((k) => [k, sum(rows.map((r) => r[k]))])) as Record<(typeof MONEY_KEYS)[number], number>;
  return { ...t, ...ratios(t.grossProfit, t.totalCost, t.price) };
}

export function buildProjects(input: ProjectInputs): ProjectsReport {
  const ix = indexInputs(input);
  const rank = (s: ProjectStatus) => PROJECT_STATUS_ORDER.indexOf(s);
  const rows = input.projects
    .map((p) => projectRow(p, input, ix))
    .sort(
      (a, b) =>
        rank(a.record.status) - rank(b.record.status) ||
        a.record.customer.localeCompare(b.record.customer, "en-GB") ||
        (a.jobs[0]?.jobNo ?? "").localeCompare(b.jobs[0]?.jobNo ?? "")
    );
  const groups = PROJECT_STATUS_ORDER.map((status) => {
    const inGroup = rows.filter((r) => r.record.status === status);
    return { status, label: PROJECT_STATUS_LABEL[status], rows: inGroup, totals: projectTotals(inGroup) };
  }).filter((g) => g.rows.length);
  const suppliers = [...new Set(input.projects.map((p) => p.subSupplier || p.subcontractor).filter(Boolean))];
  return {
    rows,
    groups,
    totals: projectTotals(rows.filter((r) => !OUT_OF_TOTALS.includes(r.record.status))),
    unallocatedBills: unallocatedBills(input.invoices, input.costs, suppliers),
  };
}
