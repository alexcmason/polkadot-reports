import { one, q } from "../db";
import type { ChaseStatus, DebtorChase } from "./debtors";
import type { ProjectCost, ProjectRecord, ProjectStatus } from "./projects";
import type { Contractor, CostBasis, Deduction, FixedFee, JobAdjustment, LineClass, LineRule, PaidBy, ReportSettings, Treatment } from "./types";

/** A timestamp column as an ISO string, so callers never receive Date objects. */
const iso = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/*
 * Everything people type in: settings, rates, adjustments, projects, chasing notes and
 * questions. Callers check access first; these functions do not.
 */

type SettingsRow = {
  business_name: string;
  sync_from: string;
  labour_share: number;
  cis_rate: number;
  vat_rate: number;
  week_ends_on: number;
  pay_run_lag_days: number;
  project_categories: string[];
  recall_categories: string[];
  sales_type_tracking: string;
  chase_after_hours: number;
  low_margin_pct: number;
};

function toSettings(r: SettingsRow): ReportSettings {
  return {
    businessName: r.business_name,
    syncFrom: r.sync_from,
    labourShare: r.labour_share,
    cisRate: r.cis_rate,
    vatRate: r.vat_rate,
    weekEndsOn: r.week_ends_on,
    payRunLagDays: r.pay_run_lag_days,
    projectCategories: r.project_categories,
    recallCategories: r.recall_categories,
    salesTypeTracking: r.sales_type_tracking,
    chaseAfterHours: r.chase_after_hours,
    lowMarginPct: r.low_margin_pct,
  };
}

/** The report settings, created with defaults the first time. */
export async function getSettings(): Promise<ReportSettings> {
  let row = await one<SettingsRow>("select * from report_settings where id");
  if (!row) {
    row = await one<SettingsRow>(
      "insert into report_settings (id) values (true) on conflict (id) do update set id = excluded.id returning *"
    );
  }
  return toSettings(row!);
}

export async function saveSettings(s: ReportSettings) {
  await getSettings();
  await q(
    `update report_settings set business_name = $1, sync_from = $2, labour_share = $3, cis_rate = $4, vat_rate = $5,
            week_ends_on = $6, pay_run_lag_days = $7, project_categories = $8, recall_categories = $9,
            sales_type_tracking = $10, chase_after_hours = $11, low_margin_pct = $12, updated_at = now()
      where id`,
    [
      s.businessName, s.syncFrom, s.labourShare, s.cisRate, s.vatRate, s.weekEndsOn, s.payRunLagDays,
      s.projectCategories, s.recallCategories, s.salesTypeTracking, s.chaseAfterHours, s.lowMarginPct,
    ]
  );
}

/* Contractors, fees, deductions, line rules */

type ContractorRow = {
  id: string;
  name: string;
  sm8_staff_uuids: string[];
  kind: "contractor" | "staff";
  cost_basis: "hourly" | "labour_share";
  hourly_rate: number | null;
  use_bills: boolean;
  bill_supplier: string;
  active: boolean;
  notes: string;
};

export async function listContractors(): Promise<Contractor[]> {
  const rows = await q<ContractorRow>("select * from contractors order by kind, name");
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sm8StaffUuids: r.sm8_staff_uuids,
    kind: r.kind,
    costBasis: r.cost_basis,
    hourlyRate: r.hourly_rate,
    useBills: r.use_bills,
    billSupplier: r.bill_supplier,
    active: r.active,
    notes: r.notes,
  }));
}

export type ContractorInput = Omit<Contractor, "id"> & { id?: string };

export async function saveContractor(c: ContractorInput): Promise<string> {
  const values = [c.name, c.sm8StaffUuids, c.kind, c.costBasis, c.hourlyRate, c.useBills, c.billSupplier, c.active, c.notes];
  if (c.id) {
    await q(
      `update contractors set name = $1, sm8_staff_uuids = $2, kind = $3, cost_basis = $4, hourly_rate = $5, use_bills = $6,
              bill_supplier = $7, active = $8, notes = $9 where id = $10`,
      [...values, c.id]
    );
    return c.id;
  }
  const row = await one<{ id: string }>(
    `insert into contractors (name, sm8_staff_uuids, kind, cost_basis, hourly_rate, use_bills, bill_supplier, active, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    values
  );
  return row!.id;
}

export async function deleteContractor(id: string) {
  await q("delete from contractors where id = $1", [id]);
}

export async function listFees(): Promise<FixedFee[]> {
  return q<FixedFee>("select id, name, amount, keywords, notes, sort from fixed_fees order by sort, name");
}

export async function saveFee(f: Omit<FixedFee, "id"> & { id?: string }) {
  if (f.id) {
    await q("update fixed_fees set name = $2, amount = $3, keywords = $4, notes = $5, sort = $6 where id = $1", [
      f.id, f.name, f.amount, f.keywords, f.notes, f.sort,
    ]);
  } else {
    await q("insert into fixed_fees (name, amount, keywords, notes, sort) values ($1, $2, $3, $4, $5)", [
      f.name, f.amount, f.keywords, f.notes, f.sort,
    ]);
  }
}

export async function deleteFee(id: string) {
  await q("delete from fixed_fees where id = $1", [id]);
}

export async function listDeductions(): Promise<Deduction[]> {
  return q<Deduction>(
    `select d.id, d.contractor_id as "contractorId", d.label, d.amount, d.starts_on as "startsOn", d.ends_on as "endsOn",
            d.week_ending as "weekEnding"
       from deductions d join contractors c on c.id = d.contractor_id
      order by c.name, d.week_ending nulls first, d.label`
  );
}

export async function saveDeduction(d: Omit<Deduction, "id">) {
  await q(
    `insert into deductions (contractor_id, label, amount, starts_on, ends_on, week_ending)
     select id, $2, $3, $4, $5, $6 from contractors where id = $1`,
    [d.contractorId, d.label, d.amount, d.startsOn, d.endsOn, d.weekEnding]
  );
}

export async function deleteDeduction(id: string) {
  await q("delete from deductions where id = $1", [id]);
}

export async function listLineRules(): Promise<LineRule[]> {
  return q<LineRule>(`select id, match, line_class as "lineClass", sort from line_rules order by sort, match`);
}

export async function saveLineRule(match: string, lineClass: LineClass, sort: number) {
  await q("insert into line_rules (match, line_class, sort) values ($1, $2, $3)", [match, lineClass, sort]);
}

export async function deleteLineRule(id: string) {
  await q("delete from line_rules where id = $1", [id]);
}

/* Job adjustments */

type AdjustmentRow = {
  job_no: string;
  contractor_id: string | null;
  cost_basis: CostBasis | null;
  fixed_fee_id: string | null;
  actual_bill: number | null;
  bill_ref: string;
  materials_paid_by: PaidBy | null;
  business_materials: number | null;
  contractor_extra: number | null;
  treatment: Treatment;
  week_ending: string | null;
  note: string;
  updated_at: string;
};

export async function listAdjustments(): Promise<JobAdjustment[]> {
  const rows = await q<AdjustmentRow>(`select *, ${iso("updated_at")} as updated_at from job_adjustments`);
  return rows.map((r) => ({
    jobNo: r.job_no,
    contractorId: r.contractor_id,
    costBasis: r.cost_basis,
    fixedFeeId: r.fixed_fee_id,
    actualBill: r.actual_bill,
    billRef: r.bill_ref,
    materialsPaidBy: r.materials_paid_by,
    businessMaterials: r.business_materials,
    contractorExtra: r.contractor_extra,
    treatment: r.treatment,
    weekEnding: r.week_ending,
    note: r.note,
    updatedAt: r.updated_at,
  }));
}

export async function saveAdjustment(a: Omit<JobAdjustment, "updatedAt">, userId: string) {
  const empty =
    !a.contractorId && !a.costBasis && !a.fixedFeeId && a.actualBill === null && !a.billRef && !a.materialsPaidBy &&
    a.businessMaterials === null && a.contractorExtra === null && a.treatment === "include" && !a.weekEnding && !a.note;
  if (empty) {
    await q("delete from job_adjustments where job_no = $1", [a.jobNo]);
    return;
  }
  await q(
    `insert into job_adjustments (job_no, contractor_id, cost_basis, fixed_fee_id, actual_bill, bill_ref, materials_paid_by,
                                  business_materials, contractor_extra, treatment, week_ending, note, updated_by, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
     on conflict (job_no) do update set
       contractor_id = excluded.contractor_id, cost_basis = excluded.cost_basis, fixed_fee_id = excluded.fixed_fee_id,
       actual_bill = excluded.actual_bill, bill_ref = excluded.bill_ref, materials_paid_by = excluded.materials_paid_by,
       business_materials = excluded.business_materials, contractor_extra = excluded.contractor_extra,
       treatment = excluded.treatment, week_ending = excluded.week_ending, note = excluded.note,
       updated_by = excluded.updated_by, updated_at = now()`,
    [
      a.jobNo, a.contractorId, a.costBasis, a.fixedFeeId, a.actualBill, a.billRef, a.materialsPaidBy,
      a.businessMaterials, a.contractorExtra, a.treatment, a.weekEnding, a.note, userId,
    ]
  );
}

/* Projects */

type ProjectRow = {
  id: string;
  customer: string;
  site: string;
  works: string;
  sales_type: string;
  status: ProjectStatus;
  job_numbers: string[];
  subcontractor: string;
  sub_supplier: string;
  sub_estimate_no: string;
  sub_quoted: number | null;
  sub_cost_override: number | null;
  price_override: number | null;
  goodwill: boolean;
  notes: string;
};

const toProject = (r: ProjectRow): ProjectRecord => ({
  id: r.id,
  customer: r.customer,
  site: r.site,
  works: r.works,
  salesType: r.sales_type,
  status: r.status,
  jobNumbers: r.job_numbers,
  subcontractor: r.subcontractor,
  subSupplier: r.sub_supplier,
  subEstimateNo: r.sub_estimate_no,
  subQuoted: r.sub_quoted,
  subCostOverride: r.sub_cost_override,
  priceOverride: r.price_override,
  goodwill: r.goodwill,
  notes: r.notes,
});

export async function listProjects(): Promise<ProjectRecord[]> {
  return (await q<ProjectRow>("select * from projects order by created_at")).map(toProject);
}

export async function getProject(id: string): Promise<ProjectRecord | null> {
  const row = await one<ProjectRow>("select * from projects where id = $1", [id]);
  return row ? toProject(row) : null;
}

export async function saveProject(p: Omit<ProjectRecord, "id"> & { id?: string }): Promise<string> {
  const values = [
    p.customer, p.site, p.works, p.salesType, p.status, p.jobNumbers, p.subcontractor, p.subSupplier,
    p.subEstimateNo, p.subQuoted, p.subCostOverride, p.priceOverride, p.goodwill, p.notes,
  ];
  if (p.id) {
    await q(
      `update projects set customer = $1, site = $2, works = $3, sales_type = $4, status = $5, job_numbers = $6, subcontractor = $7,
              sub_supplier = $8, sub_estimate_no = $9, sub_quoted = $10, sub_cost_override = $11, price_override = $12,
              goodwill = $13, notes = $14, updated_at = now()
        where id = $15`,
      [...values, p.id]
    );
    return p.id;
  }
  const row = await one<{ id: string }>(
    `insert into projects (customer, site, works, sales_type, status, job_numbers, subcontractor, sub_supplier,
                           sub_estimate_no, sub_quoted, sub_cost_override, price_override, goodwill, notes)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
    values
  );
  return row!.id;
}

export async function deleteProject(id: string) {
  await q("delete from projects where id = $1", [id]);
}

type CostRow = {
  id: string;
  project_id: string;
  xero_invoice_id: string | null;
  supplier: string;
  ref: string;
  date: string | null;
  description: string;
  amount: number;
  tie: "tied" | "probable";
  is_sub: boolean;
};

export async function listProjectCosts(): Promise<ProjectCost[]> {
  const rows = await q<CostRow>("select * from project_costs order by date nulls last, created_at");
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    xeroInvoiceId: r.xero_invoice_id,
    supplier: r.supplier,
    ref: r.ref,
    date: r.date,
    description: r.description,
    amount: r.amount,
    tie: r.tie,
    isSub: r.is_sub,
  }));
}

/** Adds a cost line. Returns false when that Xero bill is already on a project. */
export async function addProjectCost(c: Omit<ProjectCost, "id">, userId: string): Promise<boolean> {
  const rows = await q<{ id: string }>(
    `insert into project_costs (project_id, xero_invoice_id, supplier, ref, date, description, amount, tie, is_sub, created_by)
     select id, $2, $3, $4, $5, $6, $7, $8, $9, $10 from projects where id = $1
     on conflict do nothing returning id`,
    [c.projectId, c.xeroInvoiceId, c.supplier, c.ref, c.date, c.description, c.amount, c.tie, c.isSub, userId]
  );
  return rows.length > 0;
}

export async function deleteProjectCost(id: string) {
  await q("delete from project_costs where id = $1", [id]);
}

/* Debtors chasing */

export async function listChases(): Promise<DebtorChase[]> {
  return q<DebtorChase>(
    `select job_no as "jobNo", status, note, last_chased_on as "lastChasedOn", chase_count as "chaseCount" from debtor_chases`
  );
}

export async function saveChase(
  jobNo: string,
  change: { status: ChaseStatus; note: string; chasedToday: boolean; today: string },
  user: { id: string; name: string }
) {
  await q(
    `insert into debtor_chases (job_no, status, note, last_chased_on, chase_count, updated_by, updated_at)
     values ($1, $2, $3, case when $4 then $5::date end, case when $4 then 1 else 0 end, $6, now())
     on conflict (job_no) do update set
       status = excluded.status, note = excluded.note,
       last_chased_on = case when $4 then $5::date else debtor_chases.last_chased_on end,
       chase_count = debtor_chases.chase_count + case when $4 then 1 else 0 end,
       updated_by = excluded.updated_by, updated_at = now()`,
    [jobNo, change.status, change.note, change.chasedToday, change.today, user.id]
  );
  const action = change.chasedToday ? `Chased. Status: ${change.status}` : `Status: ${change.status}`;
  await q("insert into debtor_events (job_no, action, note, by_user, by_name) values ($1, $2, $3, $4, $5)", [
    jobNo, action, change.note, user.id, user.name,
  ]);
}

export type DebtorEvent = { jobNo: string; action: string; note: string; byName: string; at: string };

export async function listDebtorEvents(limit = 500): Promise<DebtorEvent[]> {
  return q<DebtorEvent>(
    `select job_no as "jobNo", action, note, by_name as "byName", ${iso("at")} as at from debtor_events
      order by at desc limit $1`,
    [limit]
  );
}

/* Questions */

export type QueryTopic = "contractors" | "projects" | "debtors" | "management" | "general";
export type QueryStatus = "open" | "answered" | "resolved";
export type ReportQuery = {
  id: string;
  topic: QueryTopic;
  weekEnding: string | null;
  jobNo: string;
  subject: string;
  detail: string;
  actionTaken: string;
  ask: string;
  answer: string;
  status: QueryStatus;
  askedBy: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
};

export async function listQueries(): Promise<ReportQuery[]> {
  return q<ReportQuery>(
    `select rq.id, rq.topic, rq.week_ending as "weekEnding", rq.job_no as "jobNo", rq.subject, rq.detail,
            rq.action_taken as "actionTaken", rq.ask, rq.answer, rq.status, a.name as "askedBy", b.name as "answeredBy",
            ${iso("rq.answered_at")} as "answeredAt", ${iso("rq.created_at")} as "createdAt"
       from report_queries rq
       left join users a on a.id = rq.asked_by
       left join users b on b.id = rq.answered_by
      order by case rq.status when 'open' then 0 when 'answered' then 1 else 2 end, rq.created_at desc`
  );
}

export async function openQueryCount(): Promise<number> {
  const row = await one<{ n: number }>("select count(*)::int as n from report_queries where status = 'open'");
  return row?.n ?? 0;
}

export async function createQuery(
  qy: Pick<ReportQuery, "topic" | "weekEnding" | "jobNo" | "subject" | "detail" | "actionTaken" | "ask">,
  userId: string
) {
  await q(
    `insert into report_queries (topic, week_ending, job_no, subject, detail, action_taken, ask, asked_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [qy.topic, qy.weekEnding, qy.jobNo, qy.subject, qy.detail, qy.actionTaken, qy.ask, userId]
  );
}

export async function answerQuery(id: string, answer: string, userId: string) {
  await q(
    `update report_queries set answer = $2, status = case when $2 = '' then 'open' else 'answered' end,
            answered_by = $3, answered_at = now()
      where id = $1 and status <> 'resolved'`,
    [id, answer, userId]
  );
}

export async function setQueryStatus(id: string, status: QueryStatus) {
  await q(
    `update report_queries set status = $2, resolved_at = case when $2 = 'resolved' then now() end
      where id = $1`,
    [id, status]
  );
}

export async function deleteQuery(id: string) {
  await q("delete from report_queries where id = $1", [id]);
}

/** Questions already asked about a job in a week, so the same flag is not asked twice. */
export async function askedJobs(): Promise<Set<string>> {
  const rows = await q<{ key: string }>(
    `select coalesce(week_ending::text, '') || '|' || job_no as key from report_queries where job_no <> ''`
  );
  return new Set(rows.map((r) => r.key));
}
