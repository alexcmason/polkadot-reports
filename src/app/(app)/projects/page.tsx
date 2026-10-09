import Link from "next/link";
import { addProjectCostAction } from "@/lib/actions/reporting";
import { freshnessFor, invoicesFor, jobRowsFor, projectsFor, reportingAccess, serviceM8For, settingsFor, today } from "@/lib/reporting/context";
import { weekEnding, weekMonth } from "@/lib/reporting/dates";
import { dmy, gbp, gbp0, pct, tone } from "@/lib/reporting/format";
import {
  buildProjects,
  normJobNo,
  OUT_OF_TOTALS,
  PROJECT_STATUS_LABEL,
  suggestCosts,
  unallocatedBills,
  type ProjectRecord,
  type ProjectRow,
  type ProjectStatus,
} from "@/lib/reporting/projects";
import type { SmJob } from "@/lib/reporting/types";
import { Banner, first, type Search } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { Flags, flagRowClass } from "@/components/reporting/Flags";
import { ProjectForm } from "@/components/reporting/ProjectForm";

export const metadata = { title: "Projects" };

const STATUS_CHIP: Record<ProjectStatus, string> = {
  completed: "chip green",
  in_progress: "chip blue",
  quoted: "chip",
  awaiting_price: "chip amber",
  lost: "chip",
};

const COLUMNS = 22;

/** Read by screen readers only. Kept in the flow, not absolutely positioned, so it cannot widen the page from inside a scrolling table. */
const HIDDEN: React.CSSProperties = { display: "inline-block", width: 1, height: 1, margin: -1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" };

/** The status a new project takes from its ServiceM8 job. */
function statusFromJob(job: SmJob): ProjectStatus {
  if (job.status === "Completed") return "completed";
  if (job.status === "Work Order") return "in_progress";
  if (job.status === "Unsuccessful") return "lost";
  return "quoted";
}

/** "20290A" without its trailing letter. */
const baseNo = (no: string) => normJobNo(no).replace(/(\d)[A-Z]$/, "$1");

export default async function ProjectsPage({ searchParams }: { searchParams: Search }) {
  const { user, staff, canEdit } = await reportingAccess();
  const sp = await searchParams;
  const edit = staff && canEdit;
  const here = `/projects`;

  const [settings, { projects, costs }, sm, invoices, fresh, jobRows] = await Promise.all([
    settingsFor(),
    projectsFor(),
    serviceM8For(),
    invoicesFor(),
    freshnessFor(),
    staff ? jobRowsFor() : null,
  ]);
  const now = today();
  const report = buildProjects({ projects, costs, jobs: sm.jobs, lines: sm.lines, payments: sm.payments, invoices, settings, today: now });
  const t = report.totals;
  const liveCount = report.rows.filter((r) => !OUT_OF_TOTALS.includes(r.record.status)).length;

  const subcontractors = [...new Set(projects.map((p) => p.subcontractor.trim()).filter(Boolean))];
  const supplierNames = [...new Set(projects.map((p) => p.subSupplier.trim()).filter(Boolean))];
  const bills = edit ? unallocatedBills(invoices, costs, supplierNames) : [];

  // Pre-select the project a bill most likely belongs to: one whose job number or postcode it mentions.
  const billProject = new Map<string, string>();
  if (bills.length) {
    for (const r of report.rows) {
      for (const s of suggestCosts(r.record, bills, costs)) {
        if (s.tie === "tied" && !billProject.has(s.bill.id)) billProject.set(s.bill.id, r.record.id);
      }
    }
  }

  // ServiceM8 jobs in a project category that are not on any project yet.
  const categories = new Set(settings.projectCategories.map((c) => c.trim().toLowerCase()).filter(Boolean));
  const onProject = new Set(projects.flatMap((p) => p.jobNumbers.map(normJobNo)));
  const loose = staff
    ? sm.jobs
        .filter((j) => j.active && j.status !== "Unsuccessful" && categories.has(j.categoryName.trim().toLowerCase()))
        .filter((j) => !onProject.has(normJobNo(j.jobNo)) && !onProject.has(baseNo(j.jobNo)))
        .sort((a, b) => b.jobNo.localeCompare(a.jobNo, "en-GB", { numeric: true }))
    : [];

  // ?new=<jobNo> opens the new project form filled in from that job.
  const newNo = normJobNo(first(sp.new));
  const sameNo = (j: SmJob) => normJobNo(j.jobNo) === newNo;
  const newJob = newNo ? (sm.jobs.find((j) => j.active && sameNo(j)) ?? sm.jobs.find(sameNo) ?? null) : null;
  const openNew = !!newNo || first(sp.add) === "1" || report.rows.length === 0;
  const newReturn = newNo ? `${here}?new=${encodeURIComponent(newNo)}` : `${here}?add=1`;
  const usual = subcontractors.length === 1 ? projects.findLast((p) => p.subcontractor.trim() === subcontractors[0]) : undefined;
  const defaults: Partial<ProjectRecord> = {
    subcontractor: usual?.subcontractor ?? "",
    subSupplier: usual?.subSupplier ?? "",
    ...(newJob
      ? {
          customer: newJob.customer,
          site: newJob.site,
          works: newJob.description.split(/\r?\n/)[0].trim().slice(0, 200),
          jobNumbers: [newJob.jobNo],
          status: statusFromJob(newJob),
        }
      : {}),
  };

  const saved = first(sp.saved);
  const error = first(sp.error);
  // Job Data lists completed jobs under the month their pay week starts in, after any move made there.
  const weekOf = new Map((jobRows?.rows ?? []).map((r) => [r.jobUuid, r.weekEnding]));
  const jobHref = (job: SmJob | null) => {
    const day = job?.completionDate ?? job?.date;
    if (!staff || !job || job.status !== "Completed" || !day) return null;
    const week = weekOf.get(job.uuid) ?? weekEnding(day, settings.weekEndsOn);
    return `/jobs?month=${weekMonth(week)}#job-${encodeURIComponent(job.jobNo)}`;
  };
  const projectLabel = (p: ProjectRecord) => `${p.customer}${p.jobNumbers.length ? ` – ${p.jobNumbers.join(", ")}` : ""}`;

  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "10px 16px" }}>
        <p className="muted" style={{ maxWidth: 720 }}>
          Projects and quoted installation work, held out of the contractor figures. Prices exclude VAT unless stated.
        </p>
        <div className="actions no-print">
          {edit ? (
            <a href={`${here}?add=1#new`} className="btn">
              New project
            </a>
          ) : null}
          <a href={`/api/export?report=projects`} className="btn" download>
            Download Excel
          </a>
        </div>
      </div>

      {saved ? <Banner kind="ok">{saved === "cost" ? "Bill added to the project." : "Saved."}</Banner> : null}
      {error ? <Banner kind="err">{error}</Banner> : null}

      <div className="kpis">
        <div className="kpi static">
          <span className="label">Live work</span>
          <span className="num md">{gbp0(t.price)}</span>
          <span className="small muted">
            Our price ex VAT, {liveCount} {liveCount === 1 ? "project" : "projects"}. Excludes lost and awaiting price.
          </span>
        </div>
        <div className="kpi static">
          <span className="label">Gross profit</span>
          <span className={`num md ${t.grossProfit < 0 ? "late" : ""}`}>{gbp0(t.grossProfit)}</span>
          <span className="small muted">
            {pct(t.marginPct)} margin · {pct(t.markupPct)} markup
          </span>
        </div>
        <div className="kpi static">
          <span className="label">Billed to clients</span>
          <span className="num md">{gbp0(t.billedInc)}</span>
          <span className="small muted">Inc VAT. {gbp(t.clientOutstanding)} outstanding</span>
        </div>
        <div className="kpi static">
          <span className="label">Owed to subcontractors</span>
          <span className="num md">{gbp0(t.subOutstanding)}</span>
          <span className="small muted">
            {gbp(t.subPaid)} paid of {gbp(t.subInvoiced)} invoiced
          </span>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Projects</h2>
          {subcontractors.length ? (
            <span className="small muted">Subcontractors: {subcontractors.join(", ")}</span>
          ) : staff && report.rows.length ? (
            <span className="small muted">No subcontractors named yet</span>
          ) : null}
        </div>
        {report.rows.length === 0 ? (
          <div className="empty">
            {!staff ? (
              "Nothing to show yet."
            ) : !fresh.connected.servicem8 ? (
              <>
                No projects yet. <Link href={`/settings`}>Connect ServiceM8 in Settings</Link> to price projects from their jobs.
              </>
            ) : edit ? (
              <>
                No projects yet. Add one below, or start one from a job in a project category.
              </>
            ) : (
              "No projects yet."
            )}
          </div>
        ) : (
          <div className="scroll">
            <table className="tbl figs compact sticky" style={{ minWidth: 2600 }}>
              <thead>
                <tr>
                  {/* Client comes first so it stays pinned while the figures scroll; the export keeps the spreadsheet's order. */}
                  <Th w={160}>Client</Th>
                  <Th>Sub estimate no</Th>
                  <Th>Sub invoice no(s)</Th>
                  <Th>Client job no(s)</Th>
                  <Th w={180}>Site address</Th>
                  <Th w={200}>Works</Th>
                  <Th>Status</Th>
                  <Th num>Sub quoted £</Th>
                  <Th num>Sub invoiced to date £</Th>
                  <Th num>Sub cost used £</Th>
                  <Th num>Our price to client £</Th>
                  <Th num>Gross profit £</Th>
                  <Th num>Markup %</Th>
                  <Th num>Margin %</Th>
                  <Th w={170}>Client billing stage</Th>
                  <Th num>Billed to client £ (inc VAT)</Th>
                  <Th num>Client paid £</Th>
                  <Th num>Client outstanding £</Th>
                  <Th num>Sub paid £</Th>
                  <Th num>Sub outstanding £</Th>
                  <Th>Xero type in ServiceM8</Th>
                  <Th w={340}>Checks / notes</Th>
                </tr>
              </thead>
              <tbody>
                {report.groups.map((g) => (
                  <GroupRows key={g.status} label={g.label} rows={g.rows} jobHref={jobHref} showSub={subcontractors.length > 1} />
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td colSpan={6}>All live, completed and quoted jobs (excludes lost)</td>
                  <Money v={t.subQuoted} />
                  <Money v={t.subInvoiced} />
                  <Money v={t.subCostUsed} />
                  <Money v={t.price} />
                  <Money v={t.grossProfit} />
                  <td className={tone(t.markupPct)}>{pct(t.markupPct)}</td>
                  <td className={tone(t.marginPct)}>{pct(t.marginPct)}</td>
                  <td />
                  <Money v={t.billedInc} />
                  <Money v={t.clientPaid} />
                  <Money v={t.clientOutstanding} />
                  <Money v={t.subPaid} />
                  <Money v={t.subOutstanding} />
                  <td colSpan={2} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {edit ? (
        <details className="card" id="new" open={openNew}>
          <summary className="card-head" style={{ cursor: "pointer" }}>
            <h2>New project</h2>
            <span className="small muted">
              {newJob ? `Filled in from job ${newJob.jobNo}` : "Link it to its ServiceM8 jobs by job number"} · show or hide
            </span>
          </summary>
          <div className="card-body">
            {newNo && !newJob ? (
              <p className="small late" style={{ marginBottom: 12 }}>
                Job {newNo} was not found in ServiceM8.
              </p>
            ) : null}
            <ProjectForm
              key={newJob?.uuid ?? "blank"}
              returnTo={newReturn}
              defaults={defaults}
              submitLabel="Add project"
            />
          </div>
        </details>
      ) : null}

      {staff ? (
        <section className="card">
          <div className="card-head">
            <h2>Jobs in project categories not on a project</h2>
            <span className="small muted">
              {settings.projectCategories.length ? `Categories: ${settings.projectCategories.join(", ")}` : "No project categories set"}
            </span>
          </div>
          {!fresh.connected.servicem8 ? (
            <div className="empty">
              <Link href={`/settings`}>Connect ServiceM8 in Settings</Link> to see jobs here.
            </div>
          ) : !settings.projectCategories.length ? (
            <div className="empty">
              Choose which ServiceM8 categories are projects in <Link href={`/settings`}>Settings</Link>.
            </div>
          ) : loose.length === 0 ? (
            <div className="empty">Every live job in a project category is on a project.</div>
          ) : (
            <div className="scroll">
              <table className="tbl figs compact" style={{ minWidth: 860 }}>
                <thead>
                  <tr>
                    <th>Job no</th>
                    <th>Customer</th>
                    <th>Site</th>
                    <th>Status</th>
                    <th className="num">Total inc VAT £</th>
                    <th>
                      <span style={HIDDEN}>Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {loose.map((j) => {
                    const href = jobHref(j);
                    return (
                      <tr key={j.uuid}>
                        <td>{href ? <Link href={href}>{j.jobNo}</Link> : j.jobNo}</td>
                        <td>{j.customer}</td>
                        <td>{j.site}</td>
                        <td>{j.status}</td>
                        <Money v={j.totalIncVat} />
                        <td>
                          {edit ? (
                            <Link href={`${here}?new=${encodeURIComponent(j.jobNo)}#new`} className="link">
                              Start a project
                            </Link>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {edit ? (
        <section className="card">
          <div className="card-head">
            <h2>Unallocated project bills</h2>
            <span className="small muted">Bills from project subcontractors that are not on a project yet.</span>
          </div>
          {!supplierNames.length ? (
            <div className="empty">Add the subcontractor&apos;s name on their Xero bills to a project, and their bills will show here.</div>
          ) : !fresh.connected.xero ? (
            <div className="empty">
              <Link href={`/settings`}>Connect Xero in Settings</Link> to see the subcontractors&apos; bills.
            </div>
          ) : bills.length === 0 ? (
            <div className="empty">Every bill from {supplierNames.join(", ")} is on a project.</div>
          ) : (
            <div className="scroll">
              <table className="tbl figs compact" style={{ minWidth: 1180 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Supplier</th>
                    <th>Ref</th>
                    <th>Description</th>
                    <th className="num">Net £</th>
                    <th>Add to a project</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => {
                    const ref = b.number || b.reference;
                    const description = (b.lines[0]?.description || b.reference || "").split(/\r?\n/)[0].trim();
                    const guess = billProject.get(b.id) ?? "";
                    return (
                      <tr key={b.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{dmy(b.date)}</td>
                        <td>{b.contactName}</td>
                        <td>{ref}</td>
                        <td style={{ minWidth: 220 }}>{description}</td>
                        <Money v={b.subTotal} />
                        <td>
                          <form action={addProjectCostAction} style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: 8 }}>
                            <input type="hidden" name="return_to" value={here} />
                            <input type="hidden" name="xero_invoice_id" value={b.id} />
                            <input type="hidden" name="supplier" value={b.contactName} />
                            <input type="hidden" name="ref" value={ref} />
                            <input type="hidden" name="date" value={b.date} />
                            <input type="hidden" name="description" value={description} />
                            <input type="hidden" name="amount" value={b.subTotal.toFixed(2)} />
                            <label className="tiny muted" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              Project
                              <select name="project_id" className="compact" defaultValue={guess} required style={{ maxWidth: 240 }}>
                                <option value="" disabled>
                                  Choose a project
                                </option>
                                {report.rows.map((r) => (
                                  <option key={r.record.id} value={r.record.id}>
                                    {projectLabel(r.record)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="tiny muted" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              Tie
                              <select name="tie" className="compact" defaultValue={guess ? "tied" : "probable"}>
                                <option value="tied">Tied</option>
                                <option value="probable">Probable</option>
                              </select>
                            </label>
                            <label className="check small">
                              <input type="checkbox" name="is_sub" defaultChecked />
                              Subcontractor
                            </label>
                            <SubmitButton className="btn" pending="Adding…">
                              Add
                            </SubmitButton>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}

function Th({ children, num, w }: { children: React.ReactNode; num?: boolean; w?: number }) {
  return (
    <th className={num ? "num" : undefined} style={{ whiteSpace: "normal", verticalAlign: "bottom", minWidth: w ?? (num ? 96 : undefined) }}>
      {children}
    </th>
  );
}

function Money({ v }: { v: number }) {
  return <td className={tone(v)}>{gbp(v, { dashZero: true })}</td>;
}

function GroupRows({
  label,
  rows,
  jobHref,
  showSub,
}: {
  label: string;
  rows: ProjectRow[];
  jobHref: (job: SmJob | null) => string | null;
  /** Name the subcontractor under the client when there is more than one. */
  showSub: boolean;
}) {
  return (
    <>
      <tr className="group">
        <td style={{ whiteSpace: "nowrap" }}>{label.toUpperCase()}</td>
        <td colSpan={COLUMNS - 1}>
          <span className="muted" style={{ fontWeight: 500 }}>
            {rows.length} {rows.length === 1 ? "project" : "projects"}
          </span>
        </td>
      </tr>
      {rows.map((r) => {
        const p = r.record;
        const subRefs = [...new Set(r.costs.filter((c) => c.isSub && !c.voided).map((c) => c.ref || c.bill?.number || "").filter(Boolean))];
        const estimate = p.subEstimateNo || (p.status === "awaiting_price" ? "Not yet priced" : "No estimate");
        return (
          <tr key={p.id} className={flagRowClass(r.flags)}>
            <td>
              <Link href={`/projects/${p.id}`} className="title">
                {p.customer}
              </Link>
              {showSub && p.subcontractor ? <div className="sub">{p.subcontractor}</div> : null}
            </td>
            <td className={p.subEstimateNo ? undefined : "muted"} style={{ whiteSpace: "nowrap" }}>
              {estimate}
            </td>
            <td>{subRefs.length ? subRefs.join(", ") : <span className="muted">–</span>}</td>
            <td>
              {r.jobs.length ? (
                r.jobs.map((j, i) => {
                  const href = jobHref(j.job);
                  return (
                    <span key={j.jobNo}>
                      {i ? ", " : ""}
                      {href ? <Link href={href}>{j.jobNo}</Link> : j.jobNo}
                    </span>
                  );
                })
              ) : (
                <span className="muted">–</span>
              )}
            </td>
            <td>{p.site}</td>
            <td>{p.works}</td>
            <td>
              <span className={STATUS_CHIP[p.status]}>{PROJECT_STATUS_LABEL[p.status]}</span>
            </td>
            {p.subQuoted === null ? <td className="num muted">–</td> : <Money v={p.subQuoted} />}
            <Money v={r.subInvoiced} />
            <Money v={r.subCostUsed} />
            <Money v={r.price} />
            <Money v={r.grossProfit} />
            <td className={tone(r.markupPct)}>{pct(r.markupPct)}</td>
            <td className={tone(r.marginPct)}>{pct(r.marginPct)}</td>
            <td>{r.billingStage}</td>
            <Money v={r.billedInc} />
            <Money v={r.clientPaid} />
            <Money v={r.clientOutstanding} />
            <Money v={r.subPaid} />
            <Money v={r.subOutstanding} />
            <td>{r.categoryCheck || <span className="muted">–</span>}</td>
            <td>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Flags flags={r.flags} />
                {p.notes ? <div className="small" style={{ whiteSpace: "pre-wrap" }}>{p.notes}</div> : null}
              </div>
            </td>
          </tr>
        );
      })}
    </>
  );
}
