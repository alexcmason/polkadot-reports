import Link from "next/link";
import { notFound } from "next/navigation";
import { addProjectCostAction, deleteProjectAction, deleteProjectCostAction } from "@/lib/actions/reporting";
import { invoicesFor, jobRowsFor, projectsFor, reportingAccess, serviceM8For, settingsFor, today } from "@/lib/reporting/context";
import { round2, ukDate, weekEnding, weekMonth } from "@/lib/reporting/dates";
import { dmy, gbp, pct, tone } from "@/lib/reporting/format";
import { buildProjectRow, PROJECT_STATUS_LABEL, suggestCosts, type ProjectStatus, type RevenueLine } from "@/lib/reporting/projects";
import { getProject } from "@/lib/reporting/store";
import type { SmJob } from "@/lib/reporting/types";
import { isUuid } from "@/lib/format";
import { Banner, Field, first, type Search } from "@/components/ui";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";
import { Flags } from "@/components/reporting/Flags";
import { ProjectForm } from "@/components/reporting/ProjectForm";

export const metadata = { title: "Project" };

const STATUS_CHIP: Record<ProjectStatus, string> = {
  completed: "chip green",
  in_progress: "chip blue",
  quoted: "chip",
  awaiting_price: "chip amber",
  lost: "chip",
};

const SOURCE: Record<RevenueLine["source"], string> = { xero: "Xero", servicem8: "ServiceM8", deposit: "Deposit" };

/** Green once paid, amber while money is owed, grey otherwise. */
function stageChip(stage: string): string {
  if (/unpaid|part paid|to confirm/i.test(stage)) return "chip amber";
  if (/– paid$|paid in full/i.test(stage)) return "chip green";
  return "chip";
}

/** Read by screen readers only. Kept in the flow, not absolutely positioned, so it cannot widen the page from inside a scrolling table. */
const HIDDEN: React.CSSProperties = { display: "inline-block", width: 1, height: 1, margin: -1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" };

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Search }) {
  const { projectId } = await params;
  const { user, business: biz, staff, canEdit } = await reportingAccess();
  if (!isUuid(projectId)) notFound();
  const record = await getProject(projectId);
  if (!record) notFound();
  const sp = await searchParams;
  const edit = staff && canEdit;
  const here = `/projects/${projectId}`;

  const [settings, { projects, costs }, sm, invoices, jobRows] = await Promise.all([
    settingsFor(),
    projectsFor(),
    serviceM8For(),
    invoicesFor(),
    staff ? jobRowsFor() : null,
  ]);
  const row = buildProjectRow(record, { projects, costs, jobs: sm.jobs, lines: sm.lines, payments: sm.payments, invoices, settings, today: today() });
  const suggestions = edit ? suggestCosts(record, invoices, costs) : [];
  const subSupplier = record.subSupplier.trim().toLowerCase();
  const fromSub = (supplier: string) => !!subSupplier && supplier.toLowerCase().includes(subSupplier);

  const total = <T,>(items: T[], pick: (t: T) => number) => round2(items.reduce((s, t) => s + pick(t), 0));
  const counted = row.costs.filter((c) => !c.voided);
  const costTotal = round2(row.subInvoiced + row.otherCosts);
  const costPaid = total(counted, (c) => c.paid ?? 0);
  const costDue = total(counted, (c) => c.due ?? 0);
  const rev = { ex: total(row.revenue, (l) => l.ex), inc: row.billedInc, paid: row.clientPaid, due: row.clientOutstanding };

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

  return (
    <>
      <header className="head">
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <div className="small muted">
            <Link href={`/projects`}>Projects</Link> / {record.customer}
          </div>
          <h2>{record.customer}</h2>
          {record.site || record.works ? <div className="muted">{[record.site, record.works].filter(Boolean).join(" · ")}</div> : null}
          <div className="chips">
            <span className={STATUS_CHIP[record.status]}>{PROJECT_STATUS_LABEL[record.status]}</span>
            <span className={stageChip(row.billingStage)}>{row.billingStage}</span>
            {record.subcontractor ? <span className="chip">{record.subcontractor}</span> : null}
          </div>
        </div>
        {edit ? (
          <div className="actions">
            <a href={`${here}?edit=1#edit`} className="btn">
              Edit project
            </a>
          </div>
        ) : null}
      </header>

      {saved ? <Banner kind="ok">{saved === "cost" ? "Cost added to the project." : "Project saved."}</Banner> : null}
      {error ? <Banner kind="err">{error}</Banner> : null}

      <section className="card">
        <div className="card-head">
          <h2>Figures</h2>
          <span className="small muted">Ex VAT unless stated</span>
        </div>
        <div className="pay">
          <div>
            <h3>Price and cost</h3>
            <dl>
              <div>
                <dt>
                  Our price
                  {!record.goodwill && record.priceOverride !== null ? <span className="tiny"> (set by hand)</span> : null}
                </dt>
                <dd>{record.goodwill ? "Not charged" : gbp(row.price)}</dd>
              </div>
              <div>
                <dt>
                  Sub quoted{record.subEstimateNo ? <span className="tiny"> (estimate {record.subEstimateNo})</span> : null}
                </dt>
                <dd>{record.subQuoted === null ? "–" : gbp(record.subQuoted)}</dd>
              </div>
              <div>
                <dt>Sub invoiced to date</dt>
                <dd>{gbp(row.subInvoiced, { dashZero: true })}</dd>
              </div>
              <div>
                <dt>Sub cost used</dt>
                <dd>{gbp(row.subCostUsed, { dashZero: true })}</dd>
              </div>
              <div>
                <dt>Other costs</dt>
                <dd>{gbp(row.otherCosts, { dashZero: true })}</dd>
              </div>
              <div className="sum">
                <dt>Total cost</dt>
                <dd>{gbp(row.totalCost, { dashZero: true })}</dd>
              </div>
            </dl>
            <p className="tiny muted" style={{ marginTop: 6 }}>
              {record.subCostOverride !== null
                ? "Sub cost used is set by hand on this project."
                : "Sub cost used: invoiced to date once complete (the estimate until they bill), otherwise the larger of invoiced and quoted."}
            </p>
          </div>
          <div>
            <h3>Profit</h3>
            <dl>
              <div className="sum">
                <dt>Gross profit</dt>
                <dd className={row.grossProfit < -0.004 ? "late" : undefined}>{gbp(row.grossProfit)}</dd>
              </div>
              <div>
                <dt>Markup</dt>
                <dd className={(row.markupPct ?? 0) < 0 ? "late" : undefined}>{pct(row.markupPct)}</dd>
              </div>
              <div>
                <dt>Margin</dt>
                <dd className={(row.marginPct ?? 0) < 0 ? "late" : undefined}>{pct(row.marginPct)}</dd>
              </div>
            </dl>
            <p className="tiny muted" style={{ marginTop: 6 }}>
              Markup is profit on cost; margin is profit on price.
            </p>
          </div>
          <div>
            <h3>Client (inc VAT)</h3>
            <dl>
              <div>
                <dt>Billed to client</dt>
                <dd>{gbp(row.billedInc, { dashZero: true })}</dd>
              </div>
              <div>
                <dt>Client paid</dt>
                <dd>{gbp(row.clientPaid, { dashZero: true })}</dd>
              </div>
              <div className="sum">
                <dt>Client outstanding</dt>
                <dd className={row.clientOutstanding > 0.004 ? "late" : undefined}>{gbp(row.clientOutstanding, { dashZero: true })}</dd>
              </div>
            </dl>
          </div>
          <div>
            <h3>Subcontractor</h3>
            <dl>
              <div>
                <dt>Sub paid</dt>
                <dd>{gbp(row.subPaid, { dashZero: true })}</dd>
              </div>
              <div className="sum">
                <dt>Sub outstanding</dt>
                <dd>{gbp(row.subOutstanding, { dashZero: true })}</dd>
              </div>
              <div>
                <dt>Xero type in ServiceM8</dt>
                <dd>{row.categoryCheck || "–"}</dd>
              </div>
              {record.salesType ? (
                <div>
                  <dt>Should be</dt>
                  <dd>{record.salesType}</dd>
                </div>
              ) : null}
            </dl>
          </div>
        </div>
      </section>

      <div className="split">
        <section className="card wide">
          <div className="card-head">
            <h2>ServiceM8 jobs</h2>
          </div>
          {row.jobs.length === 0 ? (
            <div className="empty">{edit ? "No jobs linked. Add the ServiceM8 job numbers under Edit project." : "No jobs linked yet."}</div>
          ) : (
            <div className="scroll">
              <table className="tbl figs compact" style={{ minWidth: 600 }}>
                <thead>
                  <tr>
                    <th>Job no</th>
                    <th>Status</th>
                    <th>Category</th>
                    <th>Customer</th>
                    <th className="num">Total inc VAT £</th>
                    <th>Invoice sent</th>
                    <th>Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {row.jobs.map((j) => {
                    const href = jobHref(j.job);
                    if (!j.job) {
                      return (
                        <tr key={j.jobNo} className="error">
                          <td>{j.jobNo}</td>
                          <td colSpan={6} className="late">
                            Not found in ServiceM8
                          </td>
                        </tr>
                      );
                    }
                    const sent = ukDate(j.job.invoiceSentAt);
                    return (
                      <tr key={j.jobNo}>
                        <td>{href ? <Link href={href}>{j.jobNo}</Link> : j.jobNo}</td>
                        <td>{j.job.status}</td>
                        <td>
                          {j.categoryName || <span className="muted">None</span>}
                          {j.categoryCode !== "RE" ? <div className="tiny late">{j.categoryCode === "blank" ? "No Xero type" : "Not a project category"}</div> : null}
                        </td>
                        <td>{j.job.customer}</td>
                        <td className={tone(j.job.totalIncVat)}>{gbp(j.job.totalIncVat)}</td>
                        <td>{j.job.invoiceSent ? (sent ? dmy(sent) : "Yes") : <span className="muted">No</span>}</td>
                        <td>{j.job.completionDate ? dmy(j.job.completionDate) : <span className="muted">–</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card narrow">
          <div className="card-head">
            <h2>Checks and notes</h2>
            <span className="small muted">{row.flags.length ? `${row.flags.length} to look at` : "Nothing to look at"}</span>
          </div>
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {row.flags.length ? <Flags flags={row.flags} /> : <p className="small muted">No checks raised.</p>}
            {record.notes ? (
              <div>
                <div className="eyebrow">Notes</div>
                <div className="note-box">{record.notes}</div>
              </div>
            ) : null}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Revenue</h2>
          <span className="small muted">Sales invoices for the jobs, and deposits taken before invoicing</span>
        </div>
        {row.revenue.length === 0 ? (
          <div className="empty">Not billed yet.</div>
        ) : (
          <div className="scroll">
            <table className="tbl figs compact" style={{ minWidth: 900 }}>
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Ref</th>
                  <th>Date</th>
                  <th>Description</th>
                  <th className="num">Ex VAT £</th>
                  <th className="num">Inc VAT £</th>
                  <th className="num">Paid £</th>
                  <th className="num">Due £</th>
                </tr>
              </thead>
              <tbody>
                {row.revenue.map((l, i) => (
                  <tr key={`${l.source}-${l.ref}-${i}`}>
                    <td>{SOURCE[l.source]}</td>
                    <td>{l.ref}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{dmy(l.date)}</td>
                    <td>{l.description}</td>
                    <td className={tone(l.ex)}>{gbp(l.ex)}</td>
                    <td className={tone(l.inc)}>{gbp(l.inc)}</td>
                    <td className={tone(l.paid)}>{gbp(l.paid, { dashZero: true })}</td>
                    <td className={l.due > 0.004 ? "num late" : "num"}>{gbp(l.due, { dashZero: true })}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td colSpan={4}>Total</td>
                  <td className={tone(rev.ex)}>{gbp(rev.ex)}</td>
                  <td className={tone(rev.inc)}>{gbp(rev.inc)}</td>
                  <td className={tone(rev.paid)}>{gbp(rev.paid, { dashZero: true })}</td>
                  <td className={tone(rev.due)}>{gbp(rev.due, { dashZero: true })}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Costs</h2>
          <span className="small muted">Ex VAT. Tied costs name the job or site; probable ones are from the subcontractor</span>
        </div>
        {row.costs.length === 0 ? (
          <div className="empty">{edit ? "No costs yet. Add the subcontractor's bill from the suggestions below, or by hand." : "No costs recorded yet."}</div>
        ) : (
          <div className="scroll">
            <table className="tbl figs compact" style={{ minWidth: 1040 }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Supplier</th>
                  <th>Ref</th>
                  <th>Description</th>
                  <th className="num">Amount £</th>
                  <th>Tie</th>
                  <th>Sub?</th>
                  <th className="num">Paid £</th>
                  <th className="num">Due £</th>
                  {edit ? (
                    <th>
                      <span style={HIDDEN}>Remove</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {row.costs.map((c) => (
                  <tr key={c.id} className={c.voided ? "flagged" : undefined}>
                    <td style={{ whiteSpace: "nowrap" }}>{dmy(c.date)}</td>
                    <td>{c.supplier}</td>
                    <td>{c.ref || c.bill?.number}</td>
                    <td>
                      {c.description}
                      {c.voided ? (
                        <div className="flags" style={{ marginTop: 4 }}>
                          <span className="flag warn">Voided in Xero – left out of the cost</span>
                        </div>
                      ) : !c.xeroInvoiceId ? (
                        <div className="tiny muted">Added by hand</div>
                      ) : null}
                    </td>
                    <td className={tone(c.amount)} style={c.voided ? { textDecoration: "line-through" } : undefined}>
                      {gbp(c.amount)}
                    </td>
                    <td>
                      <span className={c.tie === "tied" ? "chip green" : "chip amber"}>{c.tie === "tied" ? "Tied" : "Probable"}</span>
                    </td>
                    <td>{c.isSub ? "Yes" : <span className="muted">No</span>}</td>
                    <td className="num">{c.paid === null ? <span className="muted">–</span> : gbp(c.paid, { dashZero: true })}</td>
                    <td className={(c.due ?? 0) > 0.004 ? "num late" : "num"}>{c.due === null ? <span className="muted">–</span> : gbp(c.due, { dashZero: true })}</td>
                    {edit ? (
                      <td>
                        <form action={deleteProjectCostAction}>
                          <input type="hidden" name="return_to" value={here} />
                          <input type="hidden" name="id" value={c.id} />
                          <ConfirmButton message={`Remove ${c.ref || "this cost"} from the project?${c.xeroInvoiceId ? " The bill stays in Xero." : ""}`}>
                            Remove<span style={HIDDEN}> {c.ref || c.description}</span>
                          </ConfirmButton>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
                <tr className="total">
                  <td colSpan={4}>Total</td>
                  <td className={tone(costTotal)}>{gbp(costTotal)}</td>
                  <td colSpan={2} />
                  <td className="num">{gbp(costPaid, { dashZero: true })}</td>
                  <td className="num">{gbp(costDue, { dashZero: true })}</td>
                  {edit ? <td /> : null}
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {edit ? (
        <section className="card">
          <div className="card-head">
            <h2>Suggested costs</h2>
            <span className="small muted">Xero bills not on any project that name a job, the site postcode, or come from the subcontractor</span>
          </div>
          {suggestions.length === 0 ? (
            <div className="empty">
              No suggestions.{" "}
              {record.subSupplier ? "Nothing unallocated mentions the jobs or the site." : "Add the subcontractor's name on their Xero bills under Edit project to see their bills here."}
            </div>
          ) : (
            <div className="scroll">
              <table className="tbl figs compact" style={{ minWidth: 1100 }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Supplier</th>
                    <th>Ref</th>
                    <th>Description</th>
                    <th className="num">Net £</th>
                    <th>Why</th>
                    <th>Add</th>
                  </tr>
                </thead>
                <tbody>
                  {suggestions.map(({ bill, reason, tie }) => {
                    const ref = bill.number || bill.reference;
                    const description = (bill.lines[0]?.description || bill.reference || "").split(/\r?\n/)[0].trim();
                    return (
                      <tr key={bill.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{dmy(bill.date)}</td>
                        <td>{bill.contactName}</td>
                        <td>{ref}</td>
                        <td style={{ minWidth: 200 }}>{description}</td>
                        <td className={tone(bill.subTotal)}>{gbp(bill.subTotal)}</td>
                        <td>
                          <span className={tie === "tied" ? "chip green" : "chip amber"}>{reason}</span>
                        </td>
                        <td>
                          <form action={addProjectCostAction} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                            <input type="hidden" name="return_to" value={here} />
                            <input type="hidden" name="project_id" value={record.id} />
                            <input type="hidden" name="xero_invoice_id" value={bill.id} />
                            <input type="hidden" name="supplier" value={bill.contactName} />
                            <input type="hidden" name="ref" value={ref} />
                            <input type="hidden" name="date" value={bill.date} />
                            <input type="hidden" name="description" value={description} />
                            <input type="hidden" name="amount" value={bill.subTotal.toFixed(2)} />
                            <label className="tiny muted" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              Tie
                              <select name="tie" className="compact" defaultValue={tie}>
                                <option value="tied">Tied</option>
                                <option value="probable">Probable</option>
                              </select>
                            </label>
                            <label className="check small">
                              <input type="checkbox" name="is_sub" defaultChecked={fromSub(bill.contactName)} />
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

      {edit ? (
        <details className="card" id="cost" open={first(sp.cost) === "1" && !saved}>
          <summary className="card-head" style={{ cursor: "pointer" }}>
            <h2>Add a cost by hand</h2>
            <span className="small muted">For costs not in Xero, such as materials {biz} bought on a card · show or hide</span>
          </summary>
          <div className="card-body">
            <form action={addProjectCostAction} className="form">
              <input type="hidden" name="return_to" value={`${here}?cost=1`} />
              <input type="hidden" name="project_id" value={record.id} />
              <Field label="Supplier">
                <input type="text" name="supplier" defaultValue={record.subSupplier || record.subcontractor} />
              </Field>
              <Field label="Ref">
                <input type="text" name="ref" />
              </Field>
              <Field label="Date">
                <input type="date" name="date" />
              </Field>
              <Field label="Amount £" hint="Ex VAT">
                <input type="text" inputMode="decimal" name="amount" required />
              </Field>
              <Field label="Description" className="full">
                <input type="text" name="description" />
              </Field>
              <Field label="Tie">
                <select name="tie" defaultValue="tied">
                  <option value="tied">Tied – it is for this project</option>
                  <option value="probable">Probable – likely for this project</option>
                </select>
              </Field>
              <fieldset className="field">
                <legend>Subcontractor</legend>
                <label className="check">
                  <input type="checkbox" name="is_sub" defaultChecked />
                  Counts as the subcontractor&apos;s cost
                </label>
              </fieldset>
              <div className="full actions">
                <SubmitButton pending="Adding…">Add cost</SubmitButton>
              </div>
            </form>
          </div>
        </details>
      ) : null}

      {edit ? (
        <details className="card" id="edit" open={first(sp.edit) === "1"}>
          <summary className="card-head" style={{ cursor: "pointer" }}>
            <h2>Edit project</h2>
            <span className="small muted">Status, linked jobs, the subcontractor&apos;s estimate and notes · show or hide</span>
          </summary>
          <div className="card-body stack">
            <ProjectForm returnTo={`${here}?edit=1`} project={record} submitLabel="Save project" />
            <form action={deleteProjectAction} className="actions" style={{ borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
              <input type="hidden" name="return_to" value={`/projects`} />
              <input type="hidden" name="id" value={record.id} />
              <ConfirmButton message={`Delete the project for ${record.customer}? Its cost lines go too. Nothing changes in ServiceM8 or Xero.`}>
                Delete project
              </ConfirmButton>
            </form>
          </div>
        </details>
      ) : null}
    </>
  );
}
