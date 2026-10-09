/*
 * Weekly contractor report.
 *
 * Every completed ServiceM8 job becomes one Job Data row: what was charged, what the
 * contractor costs, what is paid back to them, and the margin left. Rows roll up into a
 * week per contractor (with the pay build: CIS, reimbursements, deductions) and into a
 * month master. The rules follow the client's September 2026 master workbook:
 *
 *   Labour cost   hourly: units x card rate. Fixed fee: the fee. Labour share: labour charged x share.
 *                 Actual bill: the labour on the contractor's bill.
 *   Reimbursed    parking + other + materials the contractor bought + any extra paid to them.
 *   Gross margin  charged ex VAT - labour cost - reimbursed - materials the business bought.
 *   Net payable   labour cost - CIS on labour + reimbursed - weekly deductions.
 */

import { payRunDate, plusDays, round2, weekEnding, weekMonth, weekStart, weeksInMonth } from "./dates";
import type {
  Contractor,
  CostBasis,
  Deduction,
  FixedFee,
  Flag,
  JobAdjustment,
  LineClass,
  LineRule,
  PaidBy,
  ReportSettings,
  SmActivity,
  SmJob,
  SmLine,
  SmStaff,
  Treatment,
  XeroInvoice,
  XeroLine,
} from "./types";

export type ContractorInputs = {
  settings: ReportSettings;
  contractors: Contractor[];
  fixedFees: FixedFee[];
  deductions: Deduction[];
  lineRules: LineRule[];
  adjustments: JobAdjustment[];
  jobs: SmJob[];
  lines: SmLine[];
  activities: SmActivity[];
  staff: SmStaff[];
  invoices: XeroInvoice[];
};

export type TiedBill = { id: string; supplier: string; number: string; date: string; net: number; labour: number };

export type JobRow = {
  weekEnding: string;
  completed: string;
  jobNo: string;
  jobUuid: string;
  customer: string;
  site: string;
  category: string;
  description: string;
  contractorId: string | null;
  contractorName: string;
  units: number;
  rate: number;
  labour: number;
  parking: number;
  materials: number;
  other: number;
  chargedEx: number;
  chargedInc: number;
  xeroNumber: string | null;
  xeroEx: number | null;
  xeroStatus: string;
  costBasis: CostBasis;
  costBasisLabel: string;
  costRate: number | null;
  actualBill: number | null;
  billRef: string;
  labourCost: number;
  materialsPaidBy: PaidBy;
  businessMaterials: number;
  contractorExtra: number;
  reimbursed: number;
  grossMargin: number;
  marginPct: number;
  treatment: Treatment;
  adjusted: boolean;
  note: string;
  bills: TiedBill[];
  unclassified: string[];
  flags: Flag[];
};

export type Money = {
  jobs: number;
  units: number;
  labour: number;
  parking: number;
  materials: number;
  other: number;
  chargedEx: number;
  chargedInc: number;
  labourCost: number;
  cis: number;
  reimbursed: number;
  deductions: number;
  netPayable: number;
  businessMaterials: number;
  grossMargin: number;
  marginPct: number;
  /** CIS and net pay before rounding, so totals round once as the workbook does. */
  exact?: { cis: number; netPayable: number };
};

export type ContractorWeek = Money & {
  contractorId: string | null;
  name: string;
  rows: JobRow[];
  deductionLines: { label: string; amount: number }[];
  labourMarginPct: number;
  chargedPerUnit: number;
  costPerUnit: number;
  shareOfRevenue: number;
  cardRate: number;
};

export type WeekReport = {
  weekEnding: string;
  weekStart: string;
  payRun: string;
  month: string;
  contractors: ContractorWeek[];
  total: Money;
  rows: JobRow[];
  heldOut: JobRow[];
  flagged: JobRow[];
  xeroOnly: XeroInvoice[];
  unsuccessful: SmJob[];
};

export type MonthWeek = Money & { weekEnding: string; payRun: string; status: "loaded" | "to_come" | "no_jobs" };

export type MonthReport = {
  month: string;
  weeks: MonthWeek[];
  contractors: (Money & { contractorId: string | null; name: string })[];
  charged: { name: string; byWeek: number[]; total: number }[];
  margin: { name: string; byWeek: number[]; total: number }[];
  total: Money;
  controls: { label: string; value: number; ok: boolean }[];
  rows: JobRow[];
};

/* Line classification */

const DEFAULT_RULES: [RegExp, LineClass][] = [
  // A progress invoice moves part of the price to a new job (1234A) and leaves a negative line
  // on the original. Read both sides as fixed-price labour so the two jobs net to the full price.
  [/partial\s*invoice|progress\s*(invoice|claim|payment)|stage\s*(invoice|payment)|deposit\s*invoice|\bless\b.*\binvoice\b|\binvoice\s*(no\.?\s*|#\s*)?\d+[a-z]\b/i, "labour_fixed"],
  [/parking|congestion|ulez|toll\b|pcn\b/i, "parking"],
  [/fixed\s*price|day\s*rate|half\s*day|price\s*as\s*quoted|agreed\s*price/i, "labour_fixed"],
  [/labou?r|per\s*hour|hourly|\bhrs?\b|call[\s-]*out|attendance|diagnos|engineer/i, "labour_hourly"],
  [/\b(boiler\s*service|gas\s*safety|gsc|cp12|eicr|powerflush)\b/i, "labour_fixed"],
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a job line is read. Typed-in rules win, in their order; then the built-in guesses; then materials. */
export function classifyLine(line: Pick<SmLine, "name" | "materialUuid">, rules: LineRule[]): { cls: LineClass; guessed: boolean } {
  const name = line.name.toLowerCase();
  for (const r of rules) {
    const m = r.match.trim().toLowerCase();
    if (!m) continue;
    if (UUID.test(m) ? line.materialUuid?.toLowerCase() === m : name.includes(m)) return { cls: r.lineClass, guessed: false };
  }
  for (const [re, cls] of DEFAULT_RULES) if (re.test(line.name)) return { cls, guessed: true };
  return { cls: "materials", guessed: true };
}

export type LineTotals = {
  units: number;
  rate: number;
  labour: number;
  hourlyUnits: number;
  hourlyLabour: number;
  fixedLabour: number;
  parking: number;
  materials: number;
  other: number;
  chargedEx: number;
  unclassified: string[];
  labourNames: string[];
};

export function lineTotals(lines: SmLine[], rules: LineRule[]): LineTotals {
  const t: LineTotals = {
    units: 0, rate: 0, labour: 0, hourlyUnits: 0, hourlyLabour: 0, fixedLabour: 0,
    parking: 0, materials: 0, other: 0, chargedEx: 0, unclassified: [], labourNames: [],
  };
  for (const line of [...lines].sort((a, b) => a.sort - b.sort)) {
    const { cls, guessed } = classifyLine(line, rules);
    const amount = line.totalEx;
    if (cls === "ignore") continue;
    if (guessed && cls === "materials" && amount !== 0) t.unclassified.push(line.name);
    if (cls === "labour_hourly") {
      t.hourlyUnits += line.quantity;
      t.hourlyLabour += amount;
      t.labourNames.push(line.name);
    } else if (cls === "labour_fixed") {
      t.units += line.quantity || 1;
      t.fixedLabour += amount;
      t.labourNames.push(line.name);
    } else if (cls === "parking") t.parking += amount;
    else if (cls === "other") t.other += amount;
    else t.materials += amount;
  }
  t.units = round2(t.units + t.hourlyUnits);
  t.hourlyUnits = round2(t.hourlyUnits);
  t.hourlyLabour = round2(t.hourlyLabour);
  t.fixedLabour = round2(t.fixedLabour);
  t.labour = round2(t.hourlyLabour + t.fixedLabour);
  t.rate = t.units ? round2(t.labour / t.units) : 0;
  t.parking = round2(t.parking);
  t.materials = round2(t.materials);
  t.other = round2(t.other);
  t.chargedEx = round2(t.labour + t.parking + t.materials + t.other);
  return t;
}

/* Matching helpers */

const norm = (s: string) => s.trim().toLowerCase();
const live = (inv: XeroInvoice) => !["VOIDED", "DELETED"].includes(inv.status.toUpperCase());
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `text` names the job number as a whole token, so 2123 does not match 21234. */
export function mentionsJob(text: string, jobNo: string): boolean {
  if (!text || !jobNo) return false;
  return new RegExp(`(^|[^0-9a-z])${escape(jobNo.toLowerCase())}($|[^0-9a-z])`, "i").test(text);
}

const billText = (b: XeroInvoice) => [b.reference, b.number, ...b.lines.map((l) => l.description)].join(" \n ");

// Amounts (£150, 302.73) are not job numbers.
const AMOUNT = /£\s*\d[\d,]*(\.\d+)?|\b\d[\d,]*\.\d{2}\b/g;

/** The job-number-like tokens in some text: runs of letters and digits that contain a digit. */
const jobTokens = (text: string) => new Set(text.toLowerCase().replace(AMOUNT, " ").split(/[^0-9a-z]+/).filter((t) => /\d/.test(t)));

const LABOUR_LINE = /labou?r|install|fit(ting)?\b|work(s)?\b|service|attend|call[\s-]*out|hours?\b|day\s*rate/i;
const NOT_LABOUR = /material|parts?\b|parking|congestion|ulez|supply|supplied/i;
const isLabour = (l: XeroLine) => LABOUR_LINE.test(l.description) && !NOT_LABOUR.test(l.description);

/** True when the whole bill counts as labour: no line, or every line, reads as labour. */
function allLabour(bill: XeroInvoice): boolean {
  const n = bill.lines.filter(isLabour).length;
  return n === 0 || n === bill.lines.length;
}

/** The labour on a contractor's bill: lines that read as labour, or the whole bill when nothing is split out. */
export function billLabour(bill: XeroInvoice): number {
  if (allLabour(bill)) return round2(bill.subTotal);
  return round2(bill.lines.filter(isLabour).reduce((s, l) => s + l.lineAmount, 0));
}

const supplierMatches = (bill: XeroInvoice, c: Contractor) => {
  const names = [c.billSupplier, c.name].map(norm).filter(Boolean);
  const contact = norm(bill.contactName);
  return names.some((n) => contact.includes(n) || n.includes(contact));
};

const COST_LABEL: Record<CostBasis, string> = {
  hourly: "Hourly",
  labour_share: "Labour share",
  fixed_fee: "Fixed fee",
  actual_bill: "Actual bill",
};

const pct = (n: number) => `${(n * 100).toFixed(n !== 0 && Math.abs(n) < 0.1 ? 1 : 0)}%`;
const money = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

/* Job rows */

type Index = {
  contractorsByStaff: Map<string, Contractor>;
  contractorsById: Map<string, Contractor>;
  staffNames: Map<string, string>;
  linesByJob: Map<string, SmLine[]>;
  activitiesByJob: Map<string, SmActivity[]>;
  sales: Map<string, XeroInvoice>;
  bills: XeroInvoice[];
  /** Bills by every job-number-like token in their text, so each job finds its bills without scanning them all. */
  billTokens: Map<string, XeroInvoice[]>;
  /** The live jobs each bill names. */
  billJobs: Map<XeroInvoice, string[]>;
  jobsByNo: Map<string, SmJob>;
  chargedEx: (jobNo: string) => number;
  adjustments: Map<string, JobAdjustment>;
  fees: FixedFee[];
};

function index(input: ContractorInputs): Index {
  const contractorsByStaff = new Map<string, Contractor>();
  for (const c of input.contractors) for (const u of c.sm8StaffUuids) contractorsByStaff.set(u, c);
  const group = <T extends { jobUuid: string }>(items: T[]) => {
    const m = new Map<string, T[]>();
    for (const i of items) m.set(i.jobUuid, [...(m.get(i.jobUuid) ?? []), i]);
    return m;
  };
  const sales = new Map<string, XeroInvoice>();
  for (const inv of input.invoices) if (inv.type === "ACCREC" && live(inv)) sales.set(norm(inv.number), inv);
  const bills = input.invoices.filter((i) => i.type === "ACCPAY" && live(i));
  // A deleted job can share its number with a live one: the live one wins.
  const jobsByNo = new Map<string, SmJob>();
  for (const j of input.jobs) if (j.active && !jobsByNo.has(norm(j.jobNo))) jobsByNo.set(norm(j.jobNo), j);
  const billTokens = new Map<string, XeroInvoice[]>();
  const billJobs = new Map<XeroInvoice, string[]>();
  for (const b of bills) {
    const tokens = jobTokens(billText(b));
    for (const t of tokens) billTokens.set(t, [...(billTokens.get(t) ?? []), b]);
    billJobs.set(b, [...tokens].filter((t) => jobsByNo.has(t)));
  }
  const linesByJob = group(input.lines);
  const charged = new Map<string, number>();
  const chargedEx = (jobNo: string) => {
    if (!charged.has(jobNo)) {
      const job = jobsByNo.get(jobNo);
      charged.set(jobNo, job ? lineTotals(linesByJob.get(job.uuid) ?? [], input.lineRules).chargedEx : 0);
    }
    return charged.get(jobNo) ?? 0;
  };
  return {
    contractorsByStaff,
    contractorsById: new Map(input.contractors.map((c) => [c.id, c])),
    staffNames: new Map(input.staff.map((s) => [s.uuid, s.name])),
    linesByJob,
    activitiesByJob: group(input.activities),
    sales,
    bills,
    billTokens,
    billJobs,
    jobsByNo,
    chargedEx,
    adjustments: new Map(input.adjustments.map((a) => [norm(a.jobNo), a])),
    fees: [...input.fixedFees].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)),
  };
}

/**
 * A job's part of a bill. A bill naming several jobs is shared out: each line goes to the jobs it
 * names, and lines naming none (or the whole bill, when no line names a job) are split by each
 * job's charged ex VAT, or equally when none is charged.
 */
function billShare(bill: XeroInvoice, jobNo: string, ix: Index): { net: number; labour: number; jobs: number } {
  const named = [...new Set([jobNo, ...(ix.billJobs.get(bill) ?? [])])];
  if (named.length < 2) return { net: round2(bill.subTotal), labour: billLabour(bill), jobs: 1 };
  const weight = (no: string) => Math.max(0, ix.chargedEx(no));
  const part = (among: string[]) => {
    if (!among.includes(jobNo)) return 0;
    const total = among.reduce((n, no) => n + weight(no), 0);
    return total > 0 ? weight(jobNo) / total : 1 / among.length;
  };
  const lineJobs = bill.lines.map((l) => {
    const tokens = jobTokens(l.description);
    return named.filter((no) => tokens.has(no));
  });
  if (!lineJobs.some((js) => js.length)) {
    const p = part(named);
    return { net: round2(bill.subTotal * p), labour: round2(billLabour(bill) * p), jobs: named.length };
  }
  const whole = allLabour(bill);
  let net = 0;
  let labour = 0;
  bill.lines.forEach((l, i) => {
    const p = part(lineJobs[i].length ? lineJobs[i] : named);
    net += l.lineAmount * p;
    if (whole || isLabour(l)) labour += l.lineAmount * p;
  });
  return { net: round2(net), labour: round2(labour), jobs: named.length };
}

/** Who did the job: a typed-in choice, then the person who completed it, then whoever logged most time. */
function whoDidIt(job: SmJob, ix: Index, adj: JobAdjustment | undefined): { contractor: Contractor | null; staffName: string } {
  if (adj?.contractorId) {
    const c = ix.contractorsById.get(adj.contractorId) ?? null;
    return { contractor: c, staffName: c?.name ?? "" };
  }
  const candidates: string[] = [];
  if (job.completedByUuid) candidates.push(job.completedByUuid);
  const minutes = new Map<string, number>();
  for (const a of ix.activitiesByJob.get(job.uuid) ?? []) {
    const span = a.start && a.end ? Math.max(0, Date.parse(a.end.replace(" ", "T")) - Date.parse(a.start.replace(" ", "T"))) / 60000 : 0;
    minutes.set(a.staffUuid, (minutes.get(a.staffUuid) ?? 0) + (a.recorded ? span + 1e6 : span));
  }
  candidates.push(...[...minutes.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u));
  for (const uuid of candidates) {
    const c = ix.contractorsByStaff.get(uuid);
    if (c) return { contractor: c, staffName: c.name };
  }
  return { contractor: null, staffName: candidates.map((u) => ix.staffNames.get(u)).find(Boolean) ?? "" };
}

function matchFee(fees: FixedFee[], texts: string[]): FixedFee | null {
  const hay = texts.join(" \n ").toLowerCase();
  for (const f of fees) if (f.keywords.some((k) => k.trim() && hay.includes(k.trim().toLowerCase()))) return f;
  return null;
}

export function buildJobRow(job: SmJob, input: ContractorInputs, ix: Index = index(input)): JobRow {
  const s = input.settings;
  const adj = ix.adjustments.get(norm(job.jobNo));
  const t = lineTotals(ix.linesByJob.get(job.uuid) ?? [], input.lineRules);
  const { contractor, staffName } = whoDidIt(job, ix, adj);
  const flags: Flag[] = [];
  const completed = job.completionDate ?? job.date ?? "";
  // A moved week is snapped again, in case the day weeks end on has changed since it was saved.
  const week = weekEnding(adj?.weekEnding || completed, s.weekEndsOn);
  const isProject = s.projectCategories.some((c) => norm(c) === norm(job.categoryName));
  const isRecall = s.recallCategories.some((c) => norm(c) === norm(job.categoryName));
  const treatment: Treatment = adj && adj.treatment !== "include" ? adj.treatment : isProject ? "project" : "include";

  // Bills that name this job, at this job's share: the contractor's own, and merchants' for materials.
  const no = norm(job.jobNo);
  const tied = (ix.billTokens.get(no) ?? []).map((bill) => ({ bill, ...billShare(bill, no, ix) }));
  const isContractorBill = (b: XeroInvoice) => input.contractors.some((c) => supplierMatches(b, c));
  const ownBills = contractor ? tied.filter((x) => supplierMatches(x.bill, contractor)) : [];
  const merchantBills = tied.filter((x) => !isContractorBill(x.bill));
  const bills: TiedBill[] = tied.map(({ bill: b, net, labour }) => ({ id: b.id, supplier: b.contactName, number: b.number, date: b.date, net, labour }));

  // Cost basis.
  let basis: CostBasis;
  let label: string;
  let costRate: number | null = null;
  let actualBill: number | null = null;
  let billRef = adj?.billRef ?? "";
  let labourCost: number;
  const share = (amount: number) => amount * s.labourShare;
  const fee = matchFee(ix.fees, t.labourNames.length ? t.labourNames : [job.description]);

  if (adj?.costBasis) {
    basis = adj.costBasis;
  } else if (!contractor || contractor.kind === "staff") {
    basis = "labour_share";
  } else if (contractor.useBills && ownBills.length) {
    basis = "actual_bill";
  } else if (contractor.costBasis === "labour_share") {
    basis = "labour_share";
  } else if (fee) {
    basis = "fixed_fee";
  } else if (contractor.hourlyRate && t.hourlyUnits > 0) {
    basis = "hourly";
  } else {
    basis = "labour_share";
  }

  if (basis === "actual_bill") {
    if (adj?.costBasis === "actual_bill" && adj.actualBill !== null) {
      actualBill = adj.actualBill;
    } else {
      actualBill = round2(ownBills.reduce((n, x) => n + x.labour, 0));
      billRef ||= ownBills.map((x) => `${x.bill.contactName} ${x.bill.number}`).join(", ");
    }
    labourCost = actualBill;
    label = COST_LABEL.actual_bill;
  } else if (basis === "fixed_fee") {
    const chosen = (adj?.fixedFeeId && ix.fees.find((f) => f.id === adj.fixedFeeId)) || fee;
    if (chosen) {
      costRate = chosen.amount;
      labourCost = chosen.amount;
      label = chosen.name;
    } else {
      basis = "labour_share";
      labourCost = share(t.labour);
      label = COST_LABEL.labour_share;
    }
  } else if (basis === "hourly" && contractor?.hourlyRate) {
    costRate = contractor.hourlyRate;
    labourCost = t.hourlyUnits * contractor.hourlyRate + share(t.fixedLabour);
    // A job charged on fixed lines only, but typed in as hourly, is costed on its units.
    if (t.hourlyUnits === 0) labourCost = t.units * contractor.hourlyRate;
    label = COST_LABEL.hourly;
  } else {
    basis = "labour_share";
    labourCost = share(t.labour);
    label = COST_LABEL.labour_share;
  }
  labourCost = round2(labourCost);

  // Materials: bought by the business when a merchant's bill names the job.
  const merchantNet = round2(merchantBills.reduce((n, x) => n + x.net, 0));
  const paidBy: PaidBy = adj?.materialsPaidBy ?? (merchantBills.length ? "business" : "contractor");
  let businessMaterials = 0;
  if (paidBy === "business") {
    businessMaterials = adj?.businessMaterials ?? (merchantBills.length ? merchantNet : t.materials);
  }
  const extra = adj?.contractorExtra ?? 0;
  const reimbursed = round2(t.parking + t.other + (paidBy === "business" ? 0 : t.materials) + extra);
  const grossMargin = round2(t.chargedEx - labourCost - reimbursed - businessMaterials);

  // Xero.
  const sale = ix.sales.get(norm(job.jobNo)) ?? null;
  let xeroStatus = "Not in Xero";
  if (sale) {
    const diff = round2(sale.subTotal - t.chargedEx);
    if (sale.date < plusDays(weekStart(week), -14)) xeroStatus = `Invoice dated ${ddmm(sale.date)}`;
    else if (Math.abs(diff) <= 0.01) xeroStatus = "Agrees";
    else xeroStatus = `Xero ${money(sale.subTotal)}`;
  }

  // Flags.
  const who = contractor?.name ?? staffName;
  if (treatment === "include") {
    if (!contractor) {
      flags.push({ code: "no_contractor", severity: "error", text: who ? `Under ${who}, who is not set up as a contractor.` : "No engineer on the job.", ask: "Who did it?" });
    } else if (contractor.kind === "staff") {
      flags.push({ code: "staff_job", severity: "warn", text: `Under ${contractor.name}.`, ask: "Who did it?" });
    } else if (contractor.costBasis === "hourly" && !contractor.hourlyRate && basis === "labour_share") {
      flags.push({ code: "no_rate", severity: "warn", text: `${contractor.name} has no hourly rate, so the labour share was used.` });
    }
    if (t.chargedEx === 0) {
      flags.push({
        code: "nil_value",
        severity: "warn",
        text: isRecall ? "Nil value. Recall." : "Nil value.",
        ask: "Is the labour paid?",
      });
    }
    if (!sale && t.chargedEx !== 0) {
      flags.push({ code: "not_in_xero", severity: "warn", text: job.invoiceSent ? "Marked sent in ServiceM8. Not in Xero." : "Not invoiced yet.", ask: "Hours and materials, and raise the invoice." });
    } else if (sale && xeroStatus.startsWith("Xero")) {
      flags.push({ code: "xero_differs", severity: "warn", text: `ServiceM8 ${money(t.chargedEx)}, Xero ${money(sale.subTotal)} ex VAT.`, ask: "Which is right?" });
    } else if (sale && xeroStatus.startsWith("Invoice dated")) {
      flags.push({ code: "xero_date", severity: "info", text: `${xeroStatus}, completed ${ddmm(completed)}.`, ask: "Was it done in this week?" });
    }
    if (contractor && contractor.kind === "contractor" && contractor.costBasis === "hourly" && basis === "labour_share" && !adj?.costBasis && t.fixedLabour > 0) {
      flags.push({ code: "fixed_price", severity: "info", text: `Fixed price job, costed at ${pct(s.labourShare)} until a bill arrives.`, ask: "Their bill." });
    }
    if (paidBy === "business" && !merchantBills.length && adj?.businessMaterials == null && t.materials > 0) {
      flags.push({ code: "no_purchase", severity: "warn", text: `Materials bought by the business, no purchase invoice found. Held at the charged ${money(t.materials)}.`, ask: "The purchase invoice." });
    }
    for (const x of tied) {
      if (x.jobs > 1) flags.push({ code: "shared_bill", severity: "info", text: `Bill ${x.bill.number} names ${x.jobs} jobs; ${money(x.net)} of it is on this job.` });
    }
    if (grossMargin < 0) flags.push({ code: "loss", severity: "error", text: `Loss of ${money(-grossMargin)}.` });
    else if (t.chargedEx > 0 && grossMargin / t.chargedEx < s.lowMarginPct) {
      flags.push({ code: "low_margin", severity: "info", text: `Margin ${pct(grossMargin / t.chargedEx)}.` });
    }
    if (t.unclassified.length) {
      flags.push({ code: "unclassified", severity: "info", text: `Read as materials: ${[...new Set(t.unclassified)].join(", ")}.` });
    }
  }

  return {
    weekEnding: week,
    completed,
    jobNo: job.jobNo,
    jobUuid: job.uuid,
    customer: job.customer,
    site: job.site,
    category: job.categoryName,
    description: job.description,
    contractorId: contractor?.id ?? null,
    contractorName: contractor?.name ?? (staffName || "Unassigned"),
    units: t.units,
    rate: t.rate,
    labour: t.labour,
    parking: t.parking,
    materials: t.materials,
    other: t.other,
    chargedEx: t.chargedEx,
    chargedInc: round2(job.totalIncVat || t.chargedEx * (1 + s.vatRate)),
    xeroNumber: sale?.number ?? null,
    xeroEx: sale ? round2(sale.subTotal) : null,
    xeroStatus,
    costBasis: basis,
    costBasisLabel: label,
    costRate,
    actualBill,
    billRef,
    labourCost,
    materialsPaidBy: paidBy,
    businessMaterials: round2(businessMaterials),
    contractorExtra: round2(extra),
    reimbursed,
    grossMargin,
    marginPct: t.chargedEx ? grossMargin / t.chargedEx : 0,
    treatment,
    adjusted: !!adj,
    note: adj?.note ?? "",
    bills,
    unclassified: t.unclassified,
    flags,
  };
}

/** Job Data: one row per completed job, every week. */
export function buildJobRows(input: ContractorInputs): JobRow[] {
  const ix = index(input);
  return input.jobs
    .filter((j) => j.active && j.status === "Completed" && (j.completionDate || j.date))
    .map((j) => buildJobRow(j, input, ix))
    .sort((a, b) => a.weekEnding.localeCompare(b.weekEnding) || a.contractorName.localeCompare(b.contractorName) || a.completed.localeCompare(b.completed) || a.jobNo.localeCompare(b.jobNo));
}

/* Roll-ups */

function emptyMoney(): Money {
  return {
    jobs: 0, units: 0, labour: 0, parking: 0, materials: 0, other: 0, chargedEx: 0, chargedInc: 0,
    labourCost: 0, cis: 0, reimbursed: 0, deductions: 0, netPayable: 0, businessMaterials: 0, grossMargin: 0, marginPct: 0,
  };
}

function addRows(m: Money, rows: JobRow[]): Money {
  for (const r of rows) {
    m.jobs += 1;
    m.units += r.units;
    m.labour += r.labour;
    m.parking += r.parking;
    m.materials += r.materials;
    m.other += r.other;
    m.chargedEx += r.chargedEx;
    m.chargedInc += r.chargedInc;
    m.labourCost += r.labourCost;
    m.reimbursed += r.reimbursed;
    m.businessMaterials += r.businessMaterials;
    m.grossMargin += r.grossMargin;
  }
  return m;
}

type Amount = Exclude<keyof Money, "exact" | "marginPct">;
const AMOUNTS: Amount[] = ["jobs", "units", "labour", "parking", "materials", "other", "chargedEx", "chargedInc", "labourCost", "cis", "reimbursed", "deductions", "netPayable", "businessMaterials", "grossMargin"];

function finish(m: Money): Money {
  const keys: Amount[] = ["units", "labour", "parking", "materials", "other", "chargedEx", "chargedInc", "labourCost", "cis", "reimbursed", "deductions", "netPayable", "businessMaterials", "grossMargin"];
  for (const k of keys) m[k] = round2(m[k]);
  m.marginPct = m.chargedEx ? m.grossMargin / m.chargedEx : 0;
  return m;
}

function sumMoney(list: Money[]): Money {
  const m = emptyMoney();
  const exact = { cis: 0, netPayable: 0 };
  for (const x of list) {
    for (const k of AMOUNTS) m[k] += x[k];
    exact.cis += x.exact?.cis ?? x.cis;
    exact.netPayable += x.exact?.netPayable ?? x.netPayable;
  }
  m.cis = exact.cis;
  m.netPayable = exact.netPayable;
  return { ...finish(m), exact };
}

/** Deductions that apply to a contractor in a given week. Their dates count as the weeks they fall in. */
export function deductionsFor(deductions: Deduction[], contractorId: string, week: string, weekEndsOn: number): { label: string; amount: number }[] {
  const snap = (d: string | null) => (d ? weekEnding(d, weekEndsOn) : null);
  return deductions
    .filter((d) => d.contractorId === contractorId)
    .filter((d) => {
      if (d.weekEnding) return snap(d.weekEnding) === week;
      const from = snap(d.startsOn);
      const to = snap(d.endsOn);
      return (!from || from <= week) && (!to || week <= to);
    })
    .map((d) => ({ label: d.label, amount: d.amount }));
}

const byName = (a: { name: string }, b: { name: string }) =>
  (a.name === "Unassigned" ? 1 : 0) - (b.name === "Unassigned" ? 1 : 0) || a.name.localeCompare(b.name);

export function weekReport(allRows: JobRow[], input: ContractorInputs, week: string): WeekReport {
  const s = input.settings;
  const inWeek = allRows.filter((r) => r.weekEnding === week);
  const rows = inWeek.filter((r) => r.treatment === "include");
  const groups = new Map<string, JobRow[]>();
  for (const r of rows) {
    const key = r.contractorId ?? `name:${r.contractorName}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const weekCharged = rows.reduce((n, r) => n + r.chargedEx, 0);
  const contractors: ContractorWeek[] = [...groups.values()].map((list) => {
    const c = list[0].contractorId ? input.contractors.find((x) => x.id === list[0].contractorId) ?? null : null;
    const m = addRows(emptyMoney(), list);
    const deductionLines = c ? deductionsFor(input.deductions, c.id, week, s.weekEndsOn) : [];
    const cis = c?.kind === "staff" ? 0 : m.labourCost * s.cisRate;
    m.deductions = deductionLines.reduce((n, d) => n + d.amount, 0);
    const netPayable = m.labourCost - cis + m.reimbursed - m.deductions;
    m.cis = cis;
    m.netPayable = netPayable;
    finish(m);
    m.exact = { cis, netPayable };
    return {
      ...m,
      contractorId: c?.id ?? null,
      name: list[0].contractorName,
      rows: list,
      deductionLines,
      labourMarginPct: m.labour ? (m.labour - m.labourCost) / m.labour : 0,
      chargedPerUnit: m.units ? round2(m.labour / m.units) : 0,
      costPerUnit: m.units ? round2(m.labourCost / m.units) : 0,
      shareOfRevenue: weekCharged ? m.chargedEx / weekCharged : 0,
      cardRate: c?.hourlyRate ?? 0,
    };
  });
  contractors.sort(byName);

  const ix = index(input);
  const start = weekStart(week);
  const xeroOnly = [...ix.sales.values()].filter((inv) => {
    if (inv.date < start || inv.date > week) return false;
    const job = ix.jobsByNo.get(norm(inv.number)) ?? ix.jobsByNo.get(norm(inv.number.replace(/[a-z]$/i, "")));
    if (!job) return true;
    const row = allRows.find((r) => r.jobUuid === job.uuid);
    return !row || (row.treatment === "include" && Math.abs(Date.parse(row.weekEnding) - Date.parse(week)) > 7 * 86_400_000);
  });
  const unsuccessful = input.jobs.filter(
    (j) => j.active && j.status === "Unsuccessful" && j.totalIncVat > 0 && !!j.date && weekEnding(j.date, s.weekEndsOn) === week
  );

  return {
    weekEnding: week,
    weekStart: start,
    payRun: payRunDate(week, s.payRunLagDays),
    month: weekMonth(week),
    contractors,
    total: sumMoney(contractors),
    rows,
    heldOut: inWeek.filter((r) => r.treatment !== "include"),
    flagged: rows.filter((r) => r.flags.some((f) => f.severity !== "info" || f.ask)),
    xeroOnly,
    unsuccessful,
  };
}

export function monthReport(allRows: JobRow[], input: ContractorInputs, month: string, today: string): MonthReport {
  const weeksList = weeksInMonth(month, input.settings.weekEndsOn);
  const weekReports = weeksList.map((w) => weekReport(allRows, input, w));
  const weeks: MonthWeek[] = weekReports.map((w) => ({
    ...w.total,
    weekEnding: w.weekEnding,
    payRun: w.payRun,
    status: w.rows.length ? "loaded" : w.weekEnding >= today ? "to_come" : "no_jobs",
  }));

  const names = new Map<string, { contractorId: string | null; name: string; weeks: (ContractorWeek | null)[] }>();
  weekReports.forEach((w, i) => {
    for (const c of w.contractors) {
      const key = c.contractorId ?? `name:${c.name}`;
      const entry = names.get(key) ?? { contractorId: c.contractorId, name: c.name, weeks: weeksList.map(() => null) };
      entry.weeks[i] = c;
      names.set(key, entry);
    }
  });
  const list = [...names.values()].sort(byName);
  const contractors = list.map((e) => ({ contractorId: e.contractorId, name: e.name, ...sumMoney(e.weeks.filter((x): x is ContractorWeek => !!x)) }));
  const matrix = (pick: (c: ContractorWeek) => number) =>
    list.map((e) => {
      const byWeek = e.weeks.map((c) => (c ? pick(c) : 0));
      return { name: e.name, byWeek, total: round2(byWeek.reduce((n, v) => n + v, 0)) };
    });
  const rows = weekReports.flatMap((w) => w.rows);
  const total = sumMoney(weeks);
  const rowsCharged = round2(rows.reduce((n, r) => n + r.chargedEx, 0));
  const rowsMargin = round2(rows.reduce((n, r) => n + r.grossMargin, 0));
  const xeroGap = round2(rows.reduce((n, r) => n + (r.xeroEx === null ? r.chargedEx : r.chargedEx - r.xeroEx), 0));
  const unassigned = rows.filter((r) => !r.contractorId).length;
  const controls = [
    { label: "Charged ex VAT: contractor table less Job Data", value: round2(sumMoney(contractors).chargedEx - rowsCharged) },
    { label: "Charged ex VAT: week table less Job Data", value: round2(total.chargedEx - rowsCharged) },
    { label: "Gross margin: contractor table less Job Data", value: round2(sumMoney(contractors).grossMargin - rowsMargin) },
    { label: "Jobs: week table less Job Data rows", value: total.jobs - rows.length },
    { label: "Charged ex VAT not matched in Xero", value: xeroGap },
    { label: "Jobs with no contractor", value: unassigned },
  ].map((c) => ({ ...c, ok: c.value === 0 }));

  return {
    month,
    weeks,
    contractors,
    charged: matrix((c) => c.chargedEx),
    margin: matrix((c) => c.grossMargin),
    total,
    controls,
    rows,
  };
}

/** Questions to put to the client for a week, one per flagged job. */
export function suggestedQueries(week: WeekReport): { jobNo: string; customer: string; subject: string; ask: string; inc: number; ex: number }[] {
  const out: { jobNo: string; customer: string; subject: string; ask: string; inc: number; ex: number }[] = [];
  for (const r of week.rows) {
    const asks = r.flags.filter((f) => f.ask);
    if (!asks.length) continue;
    out.push({
      jobNo: r.jobNo,
      customer: r.customer,
      subject: asks.map((f) => f.text).join(" "),
      ask: [...new Set(asks.map((f) => f.ask))].join(" "),
      inc: r.chargedInc,
      ex: r.chargedEx,
    });
  }
  for (const j of week.unsuccessful) {
    out.push({ jobNo: j.jobNo, customer: j.customer, subject: `Unsuccessful in ServiceM8 with ${money(j.totalIncVat)} against it.`, ask: "Is it chargeable?", inc: j.totalIncVat, ex: 0 });
  }
  if (week.xeroOnly.length) {
    const ex = round2(week.xeroOnly.reduce((n, i) => n + i.subTotal, 0));
    out.push({
      jobNo: week.xeroOnly.length === 1 ? week.xeroOnly[0].number : `${week.xeroOnly.length} invoices`,
      customer: week.xeroOnly.length === 1 ? week.xeroOnly[0].contactName : "Various",
      subject: `In Xero in the week but not completed in ServiceM8 this week: ${week.xeroOnly.map((i) => i.number).join(", ")}.`,
      ask: "Next week, or missed?",
      inc: round2(week.xeroOnly.reduce((n, i) => n + i.total, 0)),
      ex,
    });
  }
  return out;
}

/**
 * The week a report should open on: the last complete week, or the latest earlier week that has
 * jobs when the last complete week has none yet (for example before the first refresh of the week).
 */
export function defaultWeek(rows: JobRow[], lastComplete: string): string {
  let best = "";
  for (const r of rows) if (r.treatment === "include" && r.weekEnding <= lastComplete && r.weekEnding > best) best = r.weekEnding;
  return best || lastComplete;
}
