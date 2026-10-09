/*
 * Loads demonstration data into a LOCAL or TEST database, so the reports can be tried without
 * connecting ServiceM8 or Xero. Never run it against the live database: it replaces every
 * report setting, record and connection, and adds three demo logins.
 *
 *   DATABASE_URL=... ENCRYPTION_KEY=... node --import tsx scripts/seed-demo.ts
 *
 * The data is Polkadot's own September 2026 figures (contractor master, projects tracker,
 * debtors email and P&L) turned back into ServiceM8 and Xero records.
 */
import pg from "pg";
import bcrypt from "bcryptjs";
import { encrypt } from "../src/lib/crypto";
import * as C from "../src/lib/reporting/fixtures/contractor.fixture";
import { debtorsInputs, CHASES } from "../src/lib/reporting/fixtures/debtors.fixture";
import { projectsInputs } from "../src/lib/reporting/fixtures/projects.fixture";
import { managementReports, INVOICES as MGMT_INVOICES } from "../src/lib/reporting/fixtures/management.fixture";
import type { SmJob, SmLine, SmPayment, XeroInvoice } from "../src/lib/reporting/types";

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
if (!url) throw new Error("Set DATABASE_URL.");
if (/neon\.tech|vercel|amazonaws/.test(url) && process.env.SEED_DEMO_I_AM_SURE !== "yes") {
  throw new Error("This looks like a hosted database. Set SEED_DEMO_I_AM_SURE=yes if you really mean it.");
}

const PASSWORD = "demo-password-1";
const LOGINS = [
  { name: "Demo Admin", email: "owner@demo.test", role: "admin" },
  { name: "Demo Editor", email: "editor@demo.test", role: "editor" },
  { name: "Jack Ronan (demo)", email: "jack@demo.test", role: "viewer" },
] as const;

/** Everything the reports hold, emptied before the demo goes in. Logins are kept. */
const TABLES = [
  "report_queries", "debtor_events", "debtor_chases", "project_costs", "projects", "job_adjustments", "line_rules",
  "deductions", "fixed_fees", "contractors", "report_settings", "sync_runs", "source_records", "integrations",
];

const CATEGORIES: Record<string, string> = {
  "Standard S&M": "cat-sm",
  "Standard IN": "cat-in",
  "Refurbishment Works": "cat-re",
  Recall: "cat-recall",
};

/** ISO UTC timestamp as ServiceM8 sends it: London local time, "YYYY-MM-DD HH:MM:SS". */
function london(iso: string | null): string {
  if (!iso) return "0000-00-00 00:00:00";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const rawJob = (j: SmJob, companyUuid: string) => ({
  uuid: j.uuid,
  active: j.active ? "1" : "0",
  generated_job_id: j.jobNo,
  status: j.status,
  date: j.date ? `${j.date} 00:00:00` : "0000-00-00 00:00:00",
  completion_date: j.completionDate ? `${j.completionDate} 16:00:00` : "0000-00-00 00:00:00",
  completion_actioned_by_uuid: j.completedByUuid ?? "",
  category_uuid: CATEGORIES[j.categoryName] ?? "",
  company_uuid: companyUuid,
  job_address: j.site,
  billing_address: j.customer,
  job_description: j.description,
  work_done_description: j.workDone,
  total_invoice_amount: j.totalIncVat.toFixed(2),
  invoice_sent: j.invoiceSent ? "1" : "0",
  invoice_sent_stamp: london(j.invoiceSentAt),
  quote_sent: j.quoteSent ? "1" : "0",
  edit_date: london(new Date().toISOString()),
});

const rawLine = (l: SmLine) => ({
  uuid: l.uuid,
  active: "1",
  job_uuid: l.jobUuid,
  material_uuid: l.materialUuid ?? "",
  name: l.name,
  quantity: String(l.quantity),
  price: l.unitPriceEx.toFixed(2),
  cost: l.unitCost.toFixed(2),
  sort_order: String(l.sort),
});

const rawPayment = (p: SmPayment) => ({
  uuid: p.uuid,
  active: "1",
  job_uuid: p.jobUuid,
  amount: p.amount.toFixed(2),
  timestamp: `${p.date ?? "2026-09-01"} 12:00:00`,
  method: p.method,
  note: p.note,
  is_deposit: p.isDeposit ? "1" : "0",
});

const rawInvoice = (i: XeroInvoice) => ({
  InvoiceID: i.id,
  Type: i.type,
  InvoiceNumber: i.number,
  Reference: i.reference,
  Contact: { ContactID: i.contactId, Name: i.contactName },
  DateString: `${i.date}T00:00:00`,
  DueDateString: i.dueDate ? `${i.dueDate}T00:00:00` : null,
  Status: i.status,
  LineAmountTypes: "Exclusive",
  SubTotal: i.subTotal,
  TotalTax: i.totalTax,
  Total: i.total,
  AmountDue: i.amountDue,
  AmountPaid: i.amountPaid,
  AmountCredited: i.amountCredited,
  FullyPaidOnDate: i.fullyPaidOn ? `/Date(${Date.parse(`${i.fullyPaidOn}T00:00:00Z`)}+0000)/` : undefined,
  CISDeduction: i.cisDeduction,
  LineItems: i.lines.map((l) => ({
    Description: l.description,
    Quantity: l.quantity,
    UnitAmount: l.unitAmount,
    LineAmount: l.lineAmount,
    AccountCode: l.accountCode,
    TaxAmount: l.taxAmount,
    Tracking: l.tracking.map((t) => ({ Name: t.name, Option: t.option })),
  })),
});

async function main() {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query("begin");
    await db.query(`truncate ${TABLES.join(", ")}`);

    // Logins.
    const hash = await bcrypt.hash(PASSWORD, 12);
    for (const l of LOGINS) {
      await db.query(
        `insert into users (name, email, password_hash, role, status) values ($1, $2, $3, $4, 'active')
         on conflict (email) do update set password_hash = excluded.password_hash, role = excluded.role, status = 'active'`,
        [l.name, l.email, hash, l.role]
      );
    }
    const owner = (await db.query("select id from users where email = $1", [LOGINS[0].email])).rows[0].id as string;

    // Settings, contractors, fees, deductions, adjustments.
    const s = C.SETTINGS;
    await db.query(
      `insert into report_settings (id, business_name, sync_from, labour_share, cis_rate, vat_rate, week_ends_on, pay_run_lag_days,
                                    project_categories, recall_categories, sales_type_tracking, chase_after_hours, low_margin_pct)
       values (true, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [s.businessName, s.syncFrom, s.labourShare, s.cisRate, s.vatRate, s.weekEndsOn, s.payRunLagDays, s.projectCategories, s.recallCategories, s.salesTypeTracking, s.chaseAfterHours, s.lowMarginPct]
    );
    const contractorIds = new Map<string, string>();
    for (const c of C.CONTRACTORS) {
      const id = (
        await db.query(
          `insert into contractors (name, sm8_staff_uuids, kind, cost_basis, hourly_rate, use_bills, bill_supplier, active, notes)
           values ($1, $2, $3, $4, $5, $6, $7, true, $8) returning id`,
          [c.name, c.sm8StaffUuids, c.kind, c.costBasis, c.hourlyRate, c.useBills, c.billSupplier, c.notes]
        )
      ).rows[0].id as string;
      contractorIds.set(c.id, id);
    }
    for (const f of C.FEES) {
      await db.query("insert into fixed_fees (name, amount, keywords, sort) values ($1, $2, $3, $4)", [f.name, f.amount, f.keywords, f.sort]);
    }
    for (const d of C.DEDUCTIONS) {
      await db.query("insert into deductions (contractor_id, label, amount, starts_on, ends_on, week_ending) values ($1, $2, $3, $4, $5, $6)", [
        contractorIds.get(d.contractorId), d.label, d.amount, d.startsOn, d.endsOn, d.weekEnding,
      ]);
    }
    for (const a of C.ADJUSTMENTS) {
      await db.query(
        `insert into job_adjustments (job_no, cost_basis, actual_bill, bill_ref, materials_paid_by, business_materials, contractor_extra, note, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [a.jobNo, a.costBasis, a.actualBill, a.billRef, a.materialsPaidBy, a.businessMaterials, a.contractorExtra, a.note, owner]
      );
    }

    // Source records: debtors first, then projects, then the contractor master (later wins on a shared job number).
    const contractor = C.contractorInputs();
    const debtors = debtorsInputs();
    const projects = projectsInputs();
    const jobs = new Map<string, SmJob>();
    const lineSets = new Map<string, SmLine[]>();
    const payments: SmPayment[] = [];
    const sentAt = new Map<string, string | null>();
    for (const set of [debtors.jobs, projects.jobs, contractor.jobs]) {
      for (const j of set) {
        if (!j.active && jobs.get(j.jobNo)?.active) continue; // a deleted copy never replaces a live job
        if (j.invoiceSentAt) sentAt.set(j.jobNo, j.invoiceSentAt);
        jobs.set(j.jobNo, j);
      }
    }
    // Lines come only from the fixture whose job won, since two fixtures can share a job's uuid.
    for (const [lines, owners] of [[projects.lines, projects.jobs], [contractor.lines, contractor.jobs]] as const) {
      for (const l of lines) {
        const job = owners.find((j) => j.uuid === l.jobUuid);
        if (job && jobs.get(job.jobNo) === job) lineSets.set(`${job.uuid}`, [...(lineSets.get(job.uuid) ?? []).filter((x) => owners.some((o) => o.uuid === x.jobUuid && o === job)), l]);
      }
    }
    for (const [list, owners] of [[debtors.payments, debtors.jobs], [projects.payments, projects.jobs]] as const) {
      for (const p of list) {
        const job = owners.find((j) => j.uuid === p.jobUuid);
        const winner = job ? jobs.get(job.jobNo) : undefined;
        if (winner) payments.push({ ...p, uuid: `${p.uuid}-${winner.uuid}`, jobUuid: winner.uuid });
      }
    }
    // Master jobs that are not on the debtors email were paid: record the payment in both systems.
    const owed = new Set(debtors.jobs.map((j) => j.jobNo));
    for (const j of contractor.jobs) {
      if (owed.has(j.jobNo) || jobs.get(j.jobNo) !== j) continue;
      payments.push({ uuid: `paid-${j.jobNo}`, jobUuid: j.uuid, amount: j.totalIncVat, date: j.completionDate, method: "Stripe", note: "", isDeposit: false });
      const inv = contractor.invoices.find((i) => i.type === "ACCREC" && i.number === j.jobNo);
      if (inv) Object.assign(inv, { amountPaid: inv.total, amountDue: 0, status: "PAID", fullyPaidOn: j.completionDate });
    }
    const companies = new Map<string, { uuid: string; isIndividual: boolean | null }>();
    const put = async (source: string, kind: string, id: string, data: unknown) =>
      db.query(
        `insert into source_records (source, kind, ext_id, data) values ($1, $2, $3, $4)
         on conflict (source, kind, ext_id) do update set data = excluded.data`,
        [source, kind, id, JSON.stringify(data)]
      );
    for (const [name, uuid] of Object.entries(CATEGORIES)) await put("servicem8", "category", uuid, { uuid, active: "1", name });
    for (const st of contractor.staff) {
      const [first, ...rest] = st.name.split(" ");
      await put("servicem8", "staff", st.uuid, { uuid: st.uuid, active: "1", first, last: rest.join(" ") });
    }
    for (const j of jobs.values()) {
      let co = companies.get(j.customer);
      if (!co) {
        co = { uuid: `co-${companies.size + 1}`, isIndividual: j.customerIsIndividual ?? !/ltd|limited|group|projects|homes|apartments/i.test(j.customer) };
        companies.set(j.customer, co);
        await put("servicem8", "company", co.uuid, { uuid: co.uuid, active: "1", name: j.customer, is_individual: co.isIndividual ? "1" : "0" });
      }
      await put("servicem8", "job", j.uuid, rawJob({ ...j, invoiceSent: j.invoiceSent || !!sentAt.get(j.jobNo), invoiceSentAt: sentAt.get(j.jobNo) ?? j.invoiceSentAt }, co.uuid));
    }
    // Jobs that only appear in the debtors email or the projects tracker were not on the September
    // contractor master. Leave them out of the contractor weeks so the demo still ties to the master.
    const onMaster = new Set(contractor.jobs.map((j) => j.jobNo));
    for (const j of jobs.values()) {
      if (onMaster.has(j.jobNo) || j.status !== "Completed" || s.projectCategories.includes(j.categoryName)) continue;
      await db.query(
        `insert into job_adjustments (job_no, treatment, note, updated_by) values ($1, 'exclude', $2, $3)
         on conflict (job_no) do nothing`,
        [j.jobNo, "Demo data: not on the September contractor master.", owner]
      );
    }
    for (const list of lineSets.values()) for (const l of list) await put("servicem8", "jobmaterial", l.uuid, rawLine(l));
    for (const p of payments) await put("servicem8", "jobpayment", p.uuid, rawPayment(p));

    const invoices = new Map<string, XeroInvoice>();
    for (const set of [MGMT_INVOICES, contractor.invoices, debtors.invoices, projects.invoices]) {
      for (const i of set) invoices.set(`${i.type}:${i.number}`, i);
    }
    for (const i of invoices.values()) await put("xero", "invoice", i.id, rawInvoice(i));
    await put("xero", "tracking", "tc-sales-type", {
      TrackingCategoryID: "tc-sales-type",
      Name: "Sales Type",
      Options: ["IN", "RE", "S&M"].map((n) => ({ TrackingOptionID: `opt-${n}`, Name: n })),
    });
    await put("xero", "organisation", "org-demo", { OrganisationID: "org-demo", Name: "Polkadot Property Services Ltd", FinancialYearEndMonth: 3 });
    for (const [key, report] of managementReports()) await put("xero", "report", key, report);

    // Projects, costs, chases and a few questions answered the way the director did.
    const projectIds = new Map<string, string>();
    for (const p of projects.projects) {
      const id = (
        await db.query(
          `insert into projects (customer, site, works, sales_type, status, job_numbers, subcontractor, sub_supplier, sub_estimate_no,
                                 sub_quoted, sub_cost_override, price_override, goodwill, notes)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning id`,
          [p.customer, p.site, p.works, p.salesType, p.status, p.jobNumbers, p.subcontractor, p.subSupplier, p.subEstimateNo, p.subQuoted, p.subCostOverride, p.priceOverride, p.goodwill, p.notes]
        )
      ).rows[0].id as string;
      projectIds.set(p.id, id);
    }
    for (const c of projects.costs) {
      await db.query(
        `insert into project_costs (project_id, xero_invoice_id, supplier, ref, date, description, amount, tie, is_sub, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) on conflict do nothing`,
        [projectIds.get(c.projectId), c.xeroInvoiceId, c.supplier, c.ref, c.date, c.description, c.amount, c.tie, c.isSub, owner]
      );
    }
    for (const ch of CHASES) {
      await db.query("insert into debtor_chases (job_no, status, note, last_chased_on, chase_count, updated_by) values ($1, $2, $3, $4, $5, $6)", [
        ch.jobNo, ch.status, ch.note, ch.lastChasedOn, ch.chaseCount, owner,
      ]);
    }
    const questions: [string, string, string, string, string, string][] = [
      ["2026-09-10", "21128", "Air con visit, paid. A £140.00 bill from LDN Plumbing Heating and Cooling (9 Sep) looks like the cost.", "Did LDN do it?", "Yes Tommy AC", "answered"],
      ["2026-09-17", "21227", "Still a work order, no engineer. Xero has 21227 and 21227A, both £280.00, both paid.", "One visit or two? If one, the customer has paid twice.", "", "open"],
      ["2026-09-24", "21272", "EICR remedials. No UNLMTD bill yet.", "Did UNLMTD do it? Send the bill.", "", "open"],
    ];
    for (const [week, job, subject, ask, answer, status] of questions) {
      await db.query(
        `insert into report_queries (topic, week_ending, job_no, subject, ask, answer, status, asked_by, answered_at)
         values ('contractors', $1, $2, $3, $4, $5, $6, $7, case when $5 <> '' then now() end)`,
        [week, job, subject, ask, answer, status, owner]
      );
    }

    // Pretend both systems are connected so the pages show data. Refreshing will fail with the demo keys.
    for (const provider of ["servicem8", "xero"]) {
      await db.query(
        `insert into integrations (provider, account_name, tenant_id, secret_enc, last_sync_at, connected_by)
         values ($1, 'Demo data', 'demo', $2, now(), $3)`,
        [provider, encrypt("demo-not-a-real-key"), owner]
      );
    }
    await db.query("commit");
    console.log(`Demo data loaded. Sign in as ${LOGINS.map((l) => `${l.email} (${l.role})`).join(", ")} with password ${PASSWORD}.`);
  } catch (err) {
    await db.query("rollback");
    throw err;
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
