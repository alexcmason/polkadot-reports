"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireEditor, requireUser } from "../auth";
import { isDate, isUuid, parseMoney, safeReturn, str, todayISO } from "../format";
import { loadServiceM8 } from "../reporting/data";
import { weekEnding } from "../reporting/dates";
import type { ChaseStatus } from "../reporting/debtors";
import type { ProjectStatus } from "../reporting/projects";
import {
  addProjectCost,
  answerQuery,
  createQuery,
  deleteContractor,
  deleteDeduction,
  deleteFee,
  deleteLineRule,
  deleteProject,
  deleteProjectCost,
  deleteQuery,
  getProject,
  getSettings,
  listContractors,
  saveAdjustment,
  saveChase,
  saveContractor,
  saveDeduction,
  saveFee,
  saveLineRule,
  saveProject,
  saveSettings,
  setQueryStatus,
  type ContractorInput,
  type QueryStatus,
  type QueryTopic,
} from "../reporting/store";
import type { CostBasis, LineClass, PaidBy, Treatment } from "../reporting/types";

/* Helpers */

const back = (form: FormData, fallback: string, extra = "") => {
  const base = safeReturn(str(form, "return_to"), fallback);
  if (!extra) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${extra}`;
};

/** An admin or editor. Viewers only answer questions. */
const editor = () => requireEditor();

const BAD_MONEY = "error=Enter amounts like 1250.50.";

/** An amount box, null when empty. Anything else that is not an amount sends the user to `to`, so it is never saved as blank. */
function money(form: FormData, name: string, to: string): number | null {
  const v = parseMoney(str(form, name));
  if (v === undefined) redirect(to);
  return v;
}

/** Sends the user back when a save broke a unique name, such as a second contractor with the same name. Anything else is rethrown. */
function sameName(err: unknown, to: string): never {
  if ((err as { code?: string } | null)?.code === "23505") redirect(to);
  throw err;
}

/** "45", "45%" or "0.45" as 0.45. */
function share(raw: string, fallback: number): number {
  const s = raw.replace(/[%\s]/g, "");
  if (!s) return fallback;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n > 1 ? n / 100 : n;
}

/** A whole number between min and max, keeping `fallback` when the box is empty or not a number. Zero is allowed. */
function whole(raw: string, fallback: number, min: number, max: number): number {
  if (raw.trim() === "") return fallback;
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

const list = (raw: string) =>
  raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const done = () => revalidatePath("/", "layout");

/* Settings */

export async function saveReportSettings(form: FormData) {
  await editor();
  const current = await getSettings();
  const syncFrom = str(form, "sync_from");
  const weekEndsOn = Number(str(form, "week_ends_on"));
  await saveSettings({
    businessName: str(form, "business_name") || current.businessName,
    syncFrom: isDate(syncFrom) ? syncFrom : current.syncFrom,
    labourShare: share(str(form, "labour_share"), current.labourShare),
    cisRate: share(str(form, "cis_rate"), current.cisRate),
    vatRate: share(str(form, "vat_rate"), current.vatRate),
    weekEndsOn: weekEndsOn >= 1 && weekEndsOn <= 7 ? weekEndsOn : current.weekEndsOn,
    payRunLagDays: whole(str(form, "pay_run_lag_days"), current.payRunLagDays, 0, 90),
    projectCategories: list(str(form, "project_categories")),
    recallCategories: list(str(form, "recall_categories")),
    salesTypeTracking: form.has("sales_type_tracking") ? str(form, "sales_type_tracking") : current.salesTypeTracking,
    chaseAfterHours: whole(str(form, "chase_after_hours"), current.chaseAfterHours, 0, 24 * 30),
    lowMarginPct: share(str(form, "low_margin_pct"), current.lowMarginPct),
  });
  done();
  redirect(back(form, "/settings", "saved=settings"));
}

/* Contractors, fees, deductions and line rules */

export async function saveContractorAction(form: FormData) {
  await editor();
  const id = str(form, "id");
  const name = str(form, "name");
  if (!name) redirect(back(form, "/settings", "error=Give the contractor a name."));
  const rate = money(form, "hourly_rate", back(form, "/settings", `${BAD_MONEY}#contractors`));
  await saveContractor({
    id: isUuid(id) ? id : undefined,
    name,
    sm8StaffUuids: form.getAll("sm8_staff_uuids").filter((v): v is string => typeof v === "string" && v.length > 0),
    kind: str(form, "kind") === "staff" ? "staff" : "contractor",
    costBasis: str(form, "cost_basis") === "labour_share" ? "labour_share" : "hourly",
    hourlyRate: rate,
    useBills: form.get("use_bills") === "on",
    billSupplier: str(form, "bill_supplier"),
    active: form.get("active") !== "off",
    notes: str(form, "notes"),
  }).catch((err) => sameName(err, back(form, "/settings", `error=${encodeURIComponent(`A contractor called ${name} already exists.`)}#contractors`)));
  done();
  redirect(back(form, "/settings", "saved=contractor#contractors"));
}

export async function deleteContractorAction(form: FormData) {
  await editor();
  const id = str(form, "id");
  if (isUuid(id)) await deleteContractor(id);
  done();
  redirect(back(form, "/settings#contractors"));
}

/** Adds a contractor for every ServiceM8 staff member not yet linked to one. */
export async function importContractorsFromStaff(form: FormData) {
  await editor();
  const [{ staff }, existing] = await Promise.all([loadServiceM8(), listContractors()]);
  const linked = new Set(existing.flatMap((c) => c.sm8StaffUuids));
  const names = new Map(existing.map((c) => [c.name.toLowerCase(), c]));
  let added = 0;
  for (const s of staff) {
    if (!s.active || linked.has(s.uuid) || !s.name) continue;
    const key = s.name.toLowerCase();
    const same = names.get(key);
    const c: ContractorInput = same
      ? { ...same, sm8StaffUuids: [...same.sm8StaffUuids, s.uuid] }
      : {
          name: s.name, sm8StaffUuids: [s.uuid], kind: "contractor", costBasis: "hourly", hourlyRate: null,
          useBills: false, billSupplier: "", active: true, notes: "",
        };
    // Kept up to date, so two staff with the same name share one contractor and keep both links.
    names.set(key, { ...c, id: await saveContractor(c) });
    linked.add(s.uuid);
    if (!same) added++;
  }
  done();
  redirect(back(form, "/settings", `saved=import&added=${added}#contractors`));
}

export async function saveFeeAction(form: FormData) {
  await editor();
  const name = str(form, "name");
  const amount = money(form, "amount", back(form, "/settings", `${BAD_MONEY}#fees`));
  if (!name || amount === null) redirect(back(form, "/settings", "error=A fee needs a name and an amount.#fees"));
  const id = str(form, "id");
  await saveFee({
    id: isUuid(id) ? id : undefined,
    name,
    amount,
    keywords: list(str(form, "keywords")).map((k) => k.toLowerCase()),
    notes: str(form, "notes"),
    sort: Math.round(Number(str(form, "sort")) || 0),
  }).catch((err) => sameName(err, back(form, "/settings", `error=${encodeURIComponent(`A fee called ${name} already exists.`)}#fees`)));
  done();
  redirect(back(form, "/settings", "saved=fee#fees"));
}

export async function deleteFeeAction(form: FormData) {
  await editor();
  const id = str(form, "id");
  if (isUuid(id)) await deleteFee(id);
  done();
  redirect(back(form, "/settings#fees"));
}

export async function addDeductionAction(form: FormData) {
  await editor();
  const contractorId = str(form, "contractor_id");
  const label = str(form, "label");
  const amount = money(form, "amount", back(form, "/settings", `${BAD_MONEY}#deductions`));
  if (!isUuid(contractorId) || !label || amount === null) {
    redirect(back(form, "/settings", "error=A deduction needs a contractor, a label and an amount.#deductions"));
  }
  // Any date in a week names that week, so a deduction can never fall between weeks.
  const { weekEndsOn } = await getSettings();
  const week = (n: string) => (isDate(str(form, n)) ? weekEnding(str(form, n), weekEndsOn) : null);
  const startsOn = week("starts_on");
  const endsOn = week("ends_on");
  if (startsOn && endsOn && endsOn < startsOn) redirect(back(form, "/settings", "error=The To week is before the From week.#deductions"));
  await saveDeduction({ contractorId, label, amount, startsOn, endsOn, weekEnding: week("week_ending") });
  done();
  redirect(back(form, "/settings", "saved=deduction#deductions"));
}

export async function deleteDeductionAction(form: FormData) {
  await editor();
  const id = str(form, "id");
  if (isUuid(id)) await deleteDeduction(id);
  done();
  redirect(back(form, "/settings#deductions"));
}

const LINE_CLASSES: LineClass[] = ["labour_hourly", "labour_fixed", "parking", "materials", "other", "ignore"];

export async function addLineRuleAction(form: FormData) {
  await editor();
  const match = str(form, "match");
  const cls = str(form, "line_class") as LineClass;
  if (!match || !LINE_CLASSES.includes(cls)) redirect(back(form, "/settings", "error=A rule needs some text to match and a type.#lines"));
  await saveLineRule(match, cls, Math.round(Number(str(form, "sort")) || 0));
  done();
  redirect(back(form, "/settings", "saved=rule#lines"));
}

export async function deleteLineRuleAction(form: FormData) {
  await editor();
  const id = str(form, "id");
  if (isUuid(id)) await deleteLineRule(id);
  done();
  redirect(back(form, "/settings#lines"));
}

/* Job adjustments */

const BASES: CostBasis[] = ["hourly", "labour_share", "fixed_fee", "actual_bill"];
const TREATMENTS: Treatment[] = ["include", "exclude", "project"];

export async function saveAdjustmentAction(form: FormData) {
  const user = await editor();
  const jobNo = str(form, "job_no");
  if (!jobNo) redirect(back(form, "/jobs"));
  const basis = str(form, "cost_basis") as CostBasis;
  const paidBy = str(form, "materials_paid_by") as PaidBy;
  const treatment = str(form, "treatment") as Treatment;
  const contractorId = str(form, "contractor_id");
  const feeId = str(form, "fixed_fee_id");
  const bad = back(form, "/jobs", BAD_MONEY);
  // Any date in a week moves the job to that week, so it can never fall between weeks.
  const week = str(form, "week_ending");
  const settings = isDate(week) ? await getSettings() : null;
  await saveAdjustment(
    {
      jobNo,
      contractorId: isUuid(contractorId) ? contractorId : null,
      costBasis: BASES.includes(basis) ? basis : null,
      fixedFeeId: isUuid(feeId) ? feeId : null,
      actualBill: money(form, "actual_bill", bad),
      billRef: str(form, "bill_ref"),
      materialsPaidBy: paidBy === "business" || paidBy === "contractor" ? paidBy : null,
      businessMaterials: money(form, "business_materials", bad),
      contractorExtra: money(form, "contractor_extra", bad),
      treatment: TREATMENTS.includes(treatment) ? treatment : "include",
      weekEnding: settings ? weekEnding(week, settings.weekEndsOn) : null,
      note: str(form, "note"),
    },
    user.id
  );
  done();
  redirect(back(form, "/jobs", `saved=${encodeURIComponent(jobNo)}`));
}

/* Projects */

const PROJECT_STATUSES: ProjectStatus[] = ["awaiting_price", "quoted", "in_progress", "completed", "lost"];

export async function saveProjectAction(form: FormData) {
  await editor();
  const id = str(form, "id");
  const customer = str(form, "customer");
  if (!customer) redirect(back(form, "/projects", "error=Give the project a customer name."));
  const status = str(form, "status") as ProjectStatus;
  const bad = back(form, "/projects", BAD_MONEY);
  const saved = await saveProject({
    id: isUuid(id) ? id : undefined,
    customer,
    site: str(form, "site"),
    works: str(form, "works"),
    salesType: str(form, "sales_type") || "RE",
    status: PROJECT_STATUSES.includes(status) ? status : "quoted",
    jobNumbers: list(str(form, "job_numbers")).map((j) => j.toUpperCase()),
    subcontractor: str(form, "subcontractor"),
    subSupplier: str(form, "sub_supplier"),
    subEstimateNo: str(form, "sub_estimate_no"),
    subQuoted: money(form, "sub_quoted", bad),
    subCostOverride: money(form, "sub_cost_override", bad),
    priceOverride: money(form, "price_override", bad),
    goodwill: form.get("goodwill") === "on",
    notes: str(form, "notes"),
  });
  done();
  redirect(`/projects/${saved}?saved=1`);
}

export async function deleteProjectAction(form: FormData) {
  await editor();
  const id = str(form, "id");
  if (isUuid(id)) await deleteProject(id);
  done();
  redirect("/projects");
}

export async function addProjectCostAction(form: FormData) {
  const user = await editor();
  const projectId = str(form, "project_id");
  if (!isUuid(projectId) || !(await getProject(projectId))) redirect("/projects");
  const amount = money(form, "amount", back(form, `/projects/${projectId}`, BAD_MONEY));
  const date = str(form, "date");
  if (amount === null) redirect(back(form, `/projects/${projectId}`, "error=A cost needs an amount."));
  const ok = await addProjectCost(
    {
      projectId,
      xeroInvoiceId: str(form, "xero_invoice_id") || null,
      supplier: str(form, "supplier"),
      ref: str(form, "ref"),
      date: isDate(date) ? date : null,
      description: str(form, "description"),
      amount,
      tie: str(form, "tie") === "probable" ? "probable" : "tied",
      isSub: form.get("is_sub") === "on" || str(form, "is_sub") === "1",
    },
    user.id
  );
  done();
  redirect(back(form, `/projects/${projectId}`, ok ? "saved=cost" : "error=That bill is already on a project."));
}

export async function deleteProjectCostAction(form: FormData) {
  await editor();
  const id = str(form, "id");
  if (isUuid(id)) await deleteProjectCost(id);
  done();
  redirect(back(form, "/projects"));
}

/* Debtors */

const CHASE: ChaseStatus[] = ["to_chase", "chased", "promised", "queried", "paid", "write_off", "hold"];

export async function saveChaseAction(form: FormData) {
  const user = await editor();
  const jobNo = str(form, "job_no");
  const status = str(form, "status") as ChaseStatus;
  if (!jobNo) redirect(back(form, "/debtors"));
  const chasedToday = str(form, "chased_today") === "1";
  await saveChase(
    jobNo,
    { status: CHASE.includes(status) ? status : chasedToday ? "chased" : "to_chase", note: str(form, "note"), chasedToday, today: todayISO() },
    user
  );
  done();
  redirect(back(form, "/debtors", `saved=${encodeURIComponent(jobNo)}`));
}

/* Questions */

const TOPICS: QueryTopic[] = ["contractors", "projects", "debtors", "management", "general"];

export async function createQueryAction(form: FormData) {
  const user = await editor();
  const subject = str(form, "subject");
  if (!subject) redirect(back(form, "/queries", "error=Say what the question is about."));
  const topic = str(form, "topic") as QueryTopic;
  const week = str(form, "week_ending");
  await createQuery(
    {
      topic: TOPICS.includes(topic) ? topic : "general",
      weekEnding: isDate(week) ? week : null,
      jobNo: str(form, "job_no"),
      subject,
      detail: str(form, "detail"),
      actionTaken: str(form, "action_taken"),
      ask: str(form, "ask"),
    },
    user.id
  );
  done();
  redirect(back(form, "/queries", "saved=query"));
}

/** Anyone signed in may answer. */
export async function answerQueryAction(form: FormData) {
  const user = await requireUser();
  const id = str(form, "id");
  if (!isUuid(id)) redirect("/queries");
  await answerQuery(id, str(form, "answer"), user.id);
  done();
  redirect(back(form, "/queries", "saved=answer"));
}

export async function setQueryStatusAction(form: FormData) {
  await editor();
  const id = str(form, "id");
  const status = str(form, "status") as QueryStatus;
  if (isUuid(id) && ["open", "answered", "resolved"].includes(status)) await setQueryStatus(id, status);
  done();
  redirect(back(form, "/queries"));
}

export async function deleteQueryAction(form: FormData) {
  await editor();
  const id = str(form, "id");
  if (isUuid(id)) await deleteQuery(id);
  done();
  redirect(back(form, "/queries"));
}
