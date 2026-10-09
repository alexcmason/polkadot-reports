import Link from "next/link";
import { notFound } from "next/navigation";
import { q } from "@/lib/db";
import { hasEncryptionKey } from "@/lib/crypto";
import { configured as xeroConfigured } from "@/lib/integrations/xero";
import type { Integration } from "@/lib/integrations/store";
import { chooseXeroOrg, connectServiceM8, disconnectIntegration } from "@/lib/actions/integrations";
import {
  addDeductionAction,
  addLineRuleAction,
  deleteContractorAction,
  deleteDeductionAction,
  deleteFeeAction,
  deleteLineRuleAction,
  importContractorsFromStaff,
  saveContractorAction,
  saveFeeAction,
} from "@/lib/actions/reporting";
import { loadStandardFees, saveReportSettingsForm } from "@/lib/actions/reporting-setup";
import { integrationsFor, jobRowsFor, reportingAccess, today, xeroFor } from "@/lib/reporting/context";
import { plusDays, weekEnding } from "@/lib/reporting/dates";
import { dmy, gbp, pct, stamp } from "@/lib/reporting/format";
import type { Contractor, FixedFee, LineClass, ReportSettings, SmStaff } from "@/lib/reporting/types";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";
import { Banner, Field, first, type Search } from "@/components/ui";

export const metadata = { title: "Reporting settings" };

/* Recent refreshes: the one raw read on this page */

type SyncRun = {
  id: number;
  trigger: "manual" | "cron";
  status: "running" | "ok" | "error";
  error: string;
  detail: { message?: string; counts?: Record<string, number>; partial?: boolean } | null;
  started_at: string;
  finished_at: string | null;
  started_by: string | null;
};

function recentRuns(): Promise<SyncRun[]> {
  return q<SyncRun>(
    `select s.id, s.trigger, s.status, s.error, s.detail,
            to_char(s.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as started_at,
            to_char(s.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as finished_at,
            u.name as started_by
       from sync_runs s left join users u on u.id = s.started_by
      order by s.started_at desc, s.id desc
      limit 8`
  );
}

/* Words */

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const COUNT_WORDS: Record<string, [string, string]> = {
  job: ["job", "jobs"],
  jobmaterial: ["job line", "job lines"],
  jobactivity: ["time entry", "time entries"],
  jobpayment: ["payment", "payments"],
  company: ["customer", "customers"],
  staff: ["staff member", "staff"],
  category: ["category", "categories"],
  material: ["material", "materials"],
  invoice: ["invoice or bill", "invoices and bills"],
  banktransaction: ["bank transaction", "bank transactions"],
  report: ["report", "reports"],
  tracking: ["tracking category", "tracking categories"],
  account: ["account", "accounts"],
  organisation: ["organisation", "organisations"],
};

function countsText(counts: Record<string, number> | undefined): string {
  const parts = Object.entries(counts ?? {})
    .filter(([, n]) => n > 0)
    .map(([k, n]) => {
      const w = COUNT_WORDS[k] ?? [k, k];
      return `${n.toLocaleString("en-GB")} ${n === 1 ? w[0] : w[1]}`;
    });
  return parts.join(", ") || "Nothing new";
}

/** 0.45 as "45" for a percentage box. */
const pctBox = (v: number) => String(Math.round(v * 10000) / 100);

const LINE_CLASSES: { value: LineClass; label: string }[] = [
  { value: "labour_hourly", label: "Labour by the hour" },
  { value: "labour_fixed", label: "Fixed-price labour" },
  { value: "parking", label: "Parking" },
  { value: "materials", label: "Materials" },
  { value: "other", label: "Other (paid back to the contractor)" },
  { value: "ignore", label: "Ignore" },
];
const lineClassLabel = (c: LineClass) => LINE_CLASSES.find((x) => x.value === c)?.label ?? c;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Text for screen readers only. */
const HIDDEN: React.CSSProperties = { display: "inline-block", width: 1, height: 1, margin: -1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" };

/** An edit form opened from a table row, kept in view when the table scrolls sideways. */
function EditPanel({ title, closeHref, children }: { title: string; closeHref: string; children: React.ReactNode }) {
  return (
    <div style={{ position: "sticky", left: 16, width: "min(880px, max(280px, calc(100vw - 360px)))", padding: "4px 0 12px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0 16px" }}>
        <span className="strong">{title}</span>
        <a href={closeHref} className="link">
          Close
        </a>
      </div>
      {children}
    </div>
  );
}

/* Page */

export default async function SettingsPage({ searchParams }: { searchParams: Search }) {
  const { business: biz, staff, canEdit, isAdmin } = await reportingAccess();
  if (!staff) notFound();
  const sp = await searchParams;
  const here = `/settings`;

  const [integrations, { input, rows }, xero, runs] = await Promise.all([integrationsFor(), jobRowsFor(), xeroFor(), recentRuns()]);
  const s = input.settings;
  const todayIso = today();
  const since = plusDays(todayIso, -56);
  // The date pickers below step a week at a time from a real week ending.
  const weekAnchor = weekEnding("2020-01-01", s.weekEndsOn);

  const sm8 = integrations.find((i) => i.provider === "servicem8") ?? null;
  const xe = integrations.find((i) => i.provider === "xero") ?? null;
  const hasKey = hasEncryptionKey();
  const xeroReady = xeroConfigured() && hasKey;

  const contractors = [...input.contractors].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const staffList = [...input.staff].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const staffNames = new Map(input.staff.map((p) => [p.uuid, p.name]));
  const linkedTo = new Map<string, string>();
  for (const c of input.contractors) for (const u of c.sm8StaffUuids) linkedTo.set(u, c.name);

  // ServiceM8 staff who completed jobs in the last 8 weeks but are not linked to a contractor.
  const unlinkedJobs = new Map<string, number>();
  for (const j of input.jobs) {
    if (!j.active || j.status !== "Completed" || !j.completedByUuid || linkedTo.has(j.completedByUuid)) continue;
    if ((j.completionDate ?? j.date ?? "") < since) continue;
    unlinkedJobs.set(j.completedByUuid, (unlinkedJobs.get(j.completedByUuid) ?? 0) + 1);
  }
  const unlinked = [...unlinkedJobs.entries()].sort((a, b) => b[1] - a[1]).map(([uuid, n]) => ({ name: staffNames.get(uuid) || "Someone not in the staff list", n }));
  const importable = input.staff.filter((p) => p.active && p.name && !linkedTo.has(p.uuid)).length;

  const categories = [...new Set(input.jobs.map((j) => j.categoryName.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const trackingNames = [...new Set(xero.tracking.map((t) => t.name.trim()).filter(Boolean))].sort();
  const suppliers = [...new Set(xero.invoices.filter((i) => i.type === "ACCPAY").map((i) => i.contactName.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 400);

  // Lines read as materials by guess in the last 8 weeks.
  const guesses = new Map<string, { name: string; n: number; jobs: Set<string> }>();
  for (const r of rows) {
    if (r.weekEnding < since) continue;
    for (const name of r.unclassified) {
      const key = name.trim().toLowerCase();
      if (!key) continue;
      const g = guesses.get(key) ?? { name: name.trim(), n: 0, jobs: new Set<string>() };
      g.n++;
      g.jobs.add(r.jobNo);
      guesses.set(key, g);
    }
  }
  const guessList = [...guesses.values()].sort((a, b) => b.jobs.size - a.jobs.size || a.name.localeCompare(b.name));
  const nextSort = Math.max(0, ...input.lineRules.map((r) => r.sort)) + 1;

  // Banners
  const saved = first(sp.saved);
  const added = Number(first(sp.added)) || 0;
  const error = first(sp.error);
  const connected = first(sp.connected);
  const disconnected = first(sp.disconnected);
  const savedText: Record<string, string> = {
    settings: "Report settings saved.",
    contractor: "Contractor saved.",
    import: added ? `Added ${plural(added, "contractor")} from ServiceM8. Set their rates below.` : "Everyone in ServiceM8 is already linked to a contractor.",
    fee: "Fee saved.",
    fees: added ? `Added ${plural(added, "standard fee")}.` : "The standard fees were already there.",
    deduction: "Deduction added.",
    rule: "Rule added. The reports read lines with it straight away.",
  };
  // Saves add "?saved=…#section" to return_to, so it carries no anchor. Deletes go straight back to
  // return_to, so theirs names the section to land on.
  const hidden = (
    <>
      <input type="hidden" name="return_to" value={here} />
    </>
  );
  const hiddenAt = (section: string) => (
    <>
      <input type="hidden" name="return_to" value={`${here}#${section}`} />
    </>
  );

  return (
    <>
      {saved && savedText[saved] ? <Banner kind="ok">{savedText[saved]}</Banner> : null}
      {connected === "servicem8" ? <Banner kind="ok">ServiceM8 is connected. Use Refresh at the top of the page to read it in.</Banner> : null}
      {connected === "xero" ? <Banner kind="ok">Xero is connected. Use Refresh at the top of the page to read it in.</Banner> : null}
      {disconnected === "servicem8" || disconnected === "xero" ? (
        <Banner kind="ok">{disconnected === "xero" ? "Xero" : "ServiceM8"} is disconnected, and what was read from it has been deleted from this app.</Banner>
      ) : null}
      {error ? <Banner kind="err">{error}</Banner> : null}

      <nav className="pills" aria-label="Settings sections">
        {[
          ["connections", "Connections"],
          ["settings", "Report settings"],
          ["contractors", "Contractors and rates"],
          ["fees", "Fixed fees"],
          ["deductions", "Weekly deductions"],
          ["lines", "How job lines are read"],
        ].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="pill">
            {label}
          </a>
        ))}
      </nav>

      {/* 1. Connections */}
      <section className="card" id="connections" style={{ scrollMarginTop: 16 }}>
        <div className="card-head">
          <h2>Connections</h2>
          <span className="small muted">Read only. Nothing is ever changed in ServiceM8 or Xero.</span>
        </div>
        {isAdmin && !hasKey ? (
          <div style={{ padding: "0 20px 14px" }}>
            <Banner kind="note">Set ENCRYPTION_KEY in Vercel first. Keys and sign-ins are stored encrypted with it.</Banner>
          </div>
        ) : null}

        <div className="sub-label">ServiceM8</div>
        <IntegrationFacts i={sm8} accountLabel="Account" />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12, padding: "4px 20px 20px" }}>
          {!isAdmin ? (
            <p className="small muted">Only an admin can connect systems.</p>
          ) : sm8 ? (
            <>
              <details style={{ width: "100%" }}>
                <summary className="link">Replace the key</summary>
                <ServiceM8Form label="Save the new key" />
              </details>
              <form action={disconnectIntegration}>
                <input type="hidden" name="provider" value="servicem8" />
                <ConfirmButton className="btn danger" message="Disconnect ServiceM8? Everything read from it is deleted from this app until it is connected again.">
                  Disconnect ServiceM8
                </ConfirmButton>
              </form>
            </>
          ) : (
            <>
              <p className="small" style={{ maxWidth: 640 }}>
                In ServiceM8 go to Settings, then API Keys, then Add API Key. Choose Read Only and copy the key.
              </p>
              <ServiceM8Form label="Connect ServiceM8" />
            </>
          )}
        </div>

        <div className="sub-label">Xero</div>
        <IntegrationFacts i={xe} accountLabel="Organisation" />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12, padding: "4px 20px 20px" }}>
          {!isAdmin ? (
            <p className="small muted">Only an admin can connect systems.</p>
          ) : xe ? (
            <>
              {xe.status === "needs_reconnect" && xeroReady ? (
                <a className="btn primary" href="/api/xero/start">
                  Connect Xero again
                </a>
              ) : null}
              {xe.tenants.length > 1 ? (
                <form action={chooseXeroOrg} className="filters">
                  <label>
                    Organisation
                    <select name="tenant_id" defaultValue={xe.tenantId}>
                      {xe.tenants.map((t) => (
                        <option key={t.tenantId} value={t.tenantId}>
                          {t.name || t.tenantId}
                        </option>
                      ))}
                    </select>
                  </label>
                  <SubmitButton className="btn" pending="Switching…">
                    Use this organisation
                  </SubmitButton>
                  <span className="small muted" style={{ flexBasis: "100%" }}>
                    Switching deletes what was read from the other organisation. The new one is read on the next refresh.
                  </span>
                </form>
              ) : null}
              <form action={disconnectIntegration}>
                <input type="hidden" name="provider" value="xero" />
                <ConfirmButton className="btn danger" message="Disconnect Xero? Everything read from Xero is deleted from this app and its access to Xero is removed.">
                  Disconnect Xero
                </ConfirmButton>
              </form>
            </>
          ) : (
            <>
              <p className="small" style={{ maxWidth: 640 }}>
                Sign in to Xero as someone who can see {biz}&apos;s organisation and tick it when Xero asks.
              </p>
              {!xeroConfigured() ? <Banner kind="note">Add XERO_CLIENT_ID and XERO_CLIENT_SECRET in Vercel first. See the README.</Banner> : null}
              {xeroReady ? (
                <a className="btn primary" href="/api/xero/start">
                  Connect Xero
                </a>
              ) : null}
            </>
          )}
        </div>

        <div className="sub-label">Recent refreshes</div>
        {runs.length ? (
          <div className="scroll">
            <table className="tbl compact" style={{ minWidth: 760 }}>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>How</th>
                  <th>Result</th>
                  <th>What was read</th>
                  <th>Problems</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td style={{ whiteSpace: "nowrap" }}>{stamp(run.started_at)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{run.trigger === "cron" ? "Scheduled" : run.started_by ? `By ${run.started_by}` : "By hand"}</td>
                    <td>
                      <RunChip run={run} />
                    </td>
                    <td className="small">{run.status === "running" ? "Still reading" : countsText(run.detail?.counts)}</td>
                    <td className="small" style={{ maxWidth: 360, overflowWrap: "anywhere" }}>
                      {run.error ? <span className="late">{run.error}</span> : run.detail?.partial ? <span className="muted">The rest comes on the next refresh.</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No refreshes yet. Once a system is connected, use Refresh at the top of the page.</div>
        )}
      </section>

      {/* 2. Report settings */}
      <section className="card" id="settings" style={{ scrollMarginTop: 16 }}>
        <div className="card-head">
          <h2>Report settings</h2>
          <span className="small muted">Used by every report</span>
        </div>
        <div className="card-body">
          {canEdit ? (
            <SettingsForm s={s} biz={biz} categories={categories} trackingNames={trackingNames} hidden={hidden} />
          ) : (
            <p className="muted">Only admins and editors can change the settings.</p>
          )}
        </div>
      </section>

      {/* 3. Contractors */}
      <section className="card" id="contractors" style={{ scrollMarginTop: 16 }}>
        <div className="card-head">
          <h2>Contractors and rates</h2>
          <span className="small muted">{plural(contractors.length, "contractor")}</span>
        </div>
        {unlinked.length ? (
          <div style={{ padding: "0 20px 14px" }}>
            <Banner kind="note">
              Did jobs in the last 8 weeks but are not linked to a contractor:{" "}
              {unlinked.map((u, i) => (
                <span key={`${u.name}-${i}`}>
                  {i ? ", " : ""}
                  {u.name} ({plural(u.n, "job")})
                </span>
              ))}
              . Link them below, or add them as not paid per job.
            </Banner>
          </div>
        ) : null}
        {contractors.length ? (
          <div className="scroll">
            <table className="tbl figs compact sticky" style={{ minWidth: 960 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>ServiceM8 staff</th>
                  <th>Paid by</th>
                  <th className="num">Card rate</th>
                  <th>Costed from bills</th>
                  <th>Bill supplier</th>
                  <th>Active</th>
                  {canEdit ? (
                    <th>
                      <span style={HIDDEN}>Edit</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {contractors.map((c) => [
                  <tr key={c.id} id={`contractor-${c.id}`} className={c.active ? undefined : "muted"}>
                    <td className="strong">{c.name}</td>
                    <td className="small">
                      {c.sm8StaffUuids.length ? c.sm8StaffUuids.map((u) => staffNames.get(u) || "Not in ServiceM8").join(", ") : <span className="late">Not linked</span>}
                    </td>
                    <td>
                      {c.kind === "staff" ? (
                        <span className="chip amber">Not paid per job</span>
                      ) : c.costBasis === "labour_share" ? (
                        <span className="chip blue">Labour share {pct(s.labourShare, 0)}</span>
                      ) : (
                        <span className="chip green">Hourly</span>
                      )}
                    </td>
                    <td className="num">{c.hourlyRate ? `${gbp(c.hourlyRate)}/hr` : c.kind === "contractor" && c.costBasis === "hourly" ? <span className="late">No rate</span> : "–"}</td>
                    <td>{c.useBills ? "Yes" : "No"}</td>
                    <td className="small">{c.billSupplier || <span className="muted">–</span>}</td>
                    <td>{c.active ? "Yes" : <span className="muted">No</span>}</td>
                    {canEdit ? (
                      <td>
                        <a href={`#edit-contractor-${c.id}`} className="link" aria-controls={`edit-contractor-${c.id}`}>
                          Edit<span style={HIDDEN}> {c.name}</span>
                        </a>
                      </td>
                    ) : null}
                  </tr>,
                  canEdit ? (
                    // Hidden until its Edit link targets it (#edit-contractor-…), as on Job data and Debtors.
                    <tr key={`${c.id}-edit`} id={`edit-contractor-${c.id}`} className="edit-row collapsed" style={{ scrollMarginTop: 96 }}>
                      <td colSpan={8} style={{ position: "static", background: "#fafbfc" }}>
                        <EditPanel title={`Edit ${c.name}`} closeHref={`#contractor-${c.id}`}>
                          <ContractorForm c={c} staffList={staffList} linkedTo={linkedTo} labourShare={s.labourShare} hidden={hidden} />
                          <form action={deleteContractorAction}>
                            {hiddenAt("contractors")}
                            <input type="hidden" name="id" value={c.id} />
                            <ConfirmButton message={`Delete ${c.name}? Their deductions are deleted too, and jobs typed in against them go back to ServiceM8's engineer.`}>
                              Delete {c.name}
                            </ConfirmButton>
                          </form>
                        </EditPanel>
                      </td>
                    </tr>
                  ) : null,
                ])}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            No contractors yet.{" "}
            {input.staff.length
              ? "Add everyone from ServiceM8 below, then set their rates."
              : sm8
                ? "Refresh the data to read the ServiceM8 staff list, or add one below."
                : "Connect ServiceM8 above to read the staff list, or add one below."}
          </div>
        )}
        {canEdit ? (
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {importable ? (
              <form action={importContractorsFromStaff} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
                {hidden}
                <SubmitButton className="btn" pending="Adding…">
                  Add everyone from ServiceM8
                </SubmitButton>
                <span className="small muted">
                  {plural(importable, "active staff member", "active staff members")} not linked yet. Each is added as a contractor on the hourly card rate, with no rate set.
                </span>
              </form>
            ) : null}
            <details>
              <summary className="link">Add a contractor</summary>
              <ContractorForm c={null} staffList={staffList} linkedTo={linkedTo} labourShare={s.labourShare} hidden={hidden} />
            </details>
          </div>
        ) : null}
        <datalist id="bill-suppliers">
          {suppliers.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </section>

      {/* 4. Fixed fees */}
      <section className="card" id="fees" style={{ scrollMarginTop: 16 }}>
        <div className="card-head">
          <h2>Fixed fees</h2>
          <span className="small muted">What a contractor is paid for a standard job</span>
        </div>
        <p className="small muted" style={{ padding: "0 20px 14px", maxWidth: 760 }}>
          A job whose labour line contains one of the words is costed at the fee, unless the contractor is on the labour share or their bill names the job. Fees
          are tried in order, so put the more particular ones first.
        </p>
        {input.fixedFees.length ? (
          <div className="scroll">
            <table className="tbl figs compact" style={{ minWidth: 680 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="num">Fee £</th>
                  <th>Matches lines containing</th>
                  <th className="num">Order</th>
                  {canEdit ? (
                    <th>
                      <span style={HIDDEN}>Edit or delete</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {input.fixedFees.map((f) => [
                  <tr key={f.id} id={`fee-${f.id}`}>
                    <td className="strong">
                      {f.name}
                      {f.notes ? <div className="sub">{f.notes}</div> : null}
                    </td>
                    <td className="num">{gbp(f.amount)}</td>
                    <td className="small">{f.keywords.length ? f.keywords.join(", ") : <span className="muted">Chosen by hand on the job</span>}</td>
                    <td className="num">{f.sort}</td>
                    {canEdit ? (
                      <td style={{ whiteSpace: "nowrap" }}>
                        <a href={`#edit-fee-${f.id}`} className="link" aria-controls={`edit-fee-${f.id}`} style={{ marginRight: 16 }}>
                          Edit<span style={HIDDEN}> {f.name}</span>
                        </a>
                        <form action={deleteFeeAction} style={{ display: "inline" }}>
                          {hiddenAt("fees")}
                          <input type="hidden" name="id" value={f.id} />
                          <ConfirmButton message={`Delete the ${f.name} fee? Jobs costed at it go back to the card rate or the labour share.`}>
                            Delete<span style={HIDDEN}> {f.name}</span>
                          </ConfirmButton>
                        </form>
                      </td>
                    ) : null}
                  </tr>,
                  canEdit ? (
                    <tr key={`${f.id}-edit`} id={`edit-fee-${f.id}`} className="edit-row collapsed" style={{ scrollMarginTop: 96 }}>
                      <td colSpan={5} style={{ position: "static", background: "#fafbfc" }}>
                        <EditPanel title={`Edit ${f.name}`} closeHref={`#fee-${f.id}`}>
                          <FeeForm f={f} hidden={hidden} />
                        </EditPanel>
                      </td>
                    </tr>
                  ) : null,
                ])}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No fixed fees yet.</div>
        )}
        {canEdit ? (
          <div className="card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {!input.fixedFees.length ? (
              <form action={loadStandardFees} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
                {hidden}
                <SubmitButton className="btn primary" pending="Adding…">
                  Add the standard fees
                </SubmitButton>
                <span className="small muted">
                  Combined boiler service and GSC £100, boiler service £80, Gas Safety Certificate £80, powerflush £250, boiler swap £450, EICR £280 and EICR for key
                  accounts £130. Change any of them afterwards.
                </span>
              </form>
            ) : null}
            <details>
              <summary className="link">Add a fee</summary>
              <FeeForm f={null} hidden={hidden} nextSort={Math.max(0, ...input.fixedFees.map((f) => f.sort)) + 1} />
            </details>
          </div>
        ) : null}
      </section>

      {/* 5. Weekly deductions */}
      <section className="card" id="deductions" style={{ scrollMarginTop: 16 }}>
        <div className="card-head">
          <h2>Weekly deductions</h2>
          <span className="small muted">Taken off a contractor&apos;s pay, such as van hire or a franchise fee</span>
        </div>
        {input.deductions.length ? (
          <div className="scroll">
            <table className="tbl figs compact" style={{ minWidth: 720 }}>
              <thead>
                <tr>
                  <th>Label</th>
                  <th className="num">£ a week</th>
                  <th>From week</th>
                  <th>To week</th>
                  <th>One-off week</th>
                  {canEdit ? (
                    <th>
                      <span style={HIDDEN}>Delete</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {contractors
                  .filter((c) => input.deductions.some((d) => d.contractorId === c.id))
                  .map((c) => {
                    const list = input.deductions.filter((d) => d.contractorId === c.id);
                    return [
                      <tr key={`${c.id}-group`} className="group">
                        <td colSpan={canEdit ? 6 : 5}>{c.name}</td>
                      </tr>,
                      ...list.map((d) => (
                        <tr key={d.id}>
                          <td>{d.label}</td>
                          <td className="num">{gbp(d.amount)}</td>
                          <td>{d.weekEnding ? <span className="muted">–</span> : d.startsOn ? dmy(d.startsOn) : "From the start"}</td>
                          <td>{d.weekEnding ? <span className="muted">–</span> : d.endsOn ? dmy(d.endsOn) : "No end"}</td>
                          <td>{d.weekEnding ? dmy(d.weekEnding) : <span className="muted">–</span>}</td>
                          {canEdit ? (
                            <td className="num">
                              <form action={deleteDeductionAction}>
                                {hiddenAt("deductions")}
                                <input type="hidden" name="id" value={d.id} />
                                <ConfirmButton message={`Delete ${c.name}'s ${d.label} deduction?`}>
                                  Delete<span style={HIDDEN}> {d.label}</span>
                                </ConfirmButton>
                              </form>
                            </td>
                          ) : null}
                        </tr>
                      )),
                    ];
                  })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No deductions.</div>
        )}
        {canEdit && contractors.length ? (
          <div className="card-body">
            <form action={addDeductionAction} className="mini">
              {hidden}
              <Field label="Contractor">
                <select name="contractor_id" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {contractors
                    .filter((c) => c.active)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Label">
                <input type="text" name="label" required placeholder="Van" />
              </Field>
              <Field label="£ a week">
                <input type="text" inputMode="decimal" name="amount" required />
              </Field>
              <Field label="From week" hint="A week-ending date">
                <input type="date" name="starts_on" min={weekAnchor} step={7} />
              </Field>
              <Field label="To week" hint="Blank runs indefinitely">
                <input type="date" name="ends_on" min={weekAnchor} step={7} />
              </Field>
              <Field label="One-off week" hint="For a single deduction">
                <input type="date" name="week_ending" min={weekAnchor} step={7} />
              </Field>
              <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
                <SubmitButton pending="Adding…">Add deduction</SubmitButton>
                <span className="small muted">
                  Leave To week blank to run indefinitely. Use One-off week for a single deduction. Weeks are named by the day they end, a {DAYS[s.weekEndsOn - 1]}.
                </span>
              </div>
            </form>
          </div>
        ) : null}
      </section>

      {/* 6. Line rules */}
      <section className="card" id="lines" style={{ scrollMarginTop: 16 }}>
        <div className="card-head">
          <h2>How job lines are read</h2>
          <span className="small muted">Each ServiceM8 job line is read as one of six types</span>
        </div>
        <dl className="data">
          <div>
            <dt>Labour by the hour</dt>
            <dd>Hours charged. Costed at the contractor&apos;s card rate.</dd>
          </div>
          <div>
            <dt>Fixed-price labour</dt>
            <dd>A price for the work. Costed at a matching fixed fee, else the labour share until their bill arrives.</dd>
          </div>
          <div>
            <dt>Parking</dt>
            <dd>Parking, congestion charge and ULEZ. Paid back to the contractor.</dd>
          </div>
          <div>
            <dt>Materials</dt>
            <dd>Parts. Paid back to the contractor, unless {biz} bought them.</dd>
          </div>
          <div>
            <dt>Other</dt>
            <dd>Anything else the contractor paid for, paid back to them in full.</dd>
          </div>
          <div>
            <dt>Ignore</dt>
            <dd>Left out of every figure, such as a note line.</dd>
          </div>
        </dl>
        <p className="small muted" style={{ padding: "12px 20px 14px", maxWidth: 760, borderTop: "1px solid var(--line-soft)" }}>
          The rules below are tried in order, and the first whose text appears in the line name wins. A ServiceM8 material ID matches that material exactly. Lines no
          rule matches are read by built-in guesses (labour, call-out, parking, boiler service and so on), and anything else is read as materials.
        </p>
        {input.lineRules.length ? (
          <div className="scroll">
            <table className="tbl compact" style={{ minWidth: 560 }}>
              <thead>
                <tr>
                  <th>Match</th>
                  <th>Type</th>
                  <th className="num">Order</th>
                  {canEdit ? (
                    <th>
                      <span style={HIDDEN}>Delete</span>
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {input.lineRules.map((r) => (
                  <tr key={r.id}>
                    <td className="strong" style={{ overflowWrap: "anywhere" }}>
                      {r.match}
                    </td>
                    <td>{lineClassLabel(r.lineClass)}</td>
                    <td className="num">{r.sort}</td>
                    {canEdit ? (
                      <td className="num">
                        <form action={deleteLineRuleAction}>
                          {hiddenAt("lines")}
                          <input type="hidden" name="id" value={r.id} />
                          <ConfirmButton message={`Delete the rule for "${r.match}"?`}>
                            Delete<span style={HIDDEN}> the rule for {r.match}</span>
                          </ConfirmButton>
                        </form>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">No rules yet. The built-in guesses are used.</div>
        )}
        {canEdit ? (
          <div className="card-body">
            <form action={addLineRuleAction} className="mini">
              {hidden}
              <Field label="Line name contains" hint="Or a ServiceM8 material ID">
                <input type="text" name="match" required />
              </Field>
              <Field label="Read it as">
                <select name="line_class" required defaultValue="">
                  <option value="" disabled>
                    Choose…
                  </option>
                  {LINE_CLASSES.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Order" hint="Lower numbers are tried first">
                <input type="text" inputMode="numeric" name="sort" defaultValue={String(nextSort)} />
              </Field>
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                <SubmitButton pending="Adding…">Add rule</SubmitButton>
              </div>
            </form>
          </div>
        ) : null}

        <div className="sub-label">Read as materials by guess, last 8 weeks</div>
        {guessList.length ? (
          <>
            <p className="small muted" style={{ padding: "0 20px 12px", maxWidth: 760 }}>
              These line names matched no rule and were read as materials. If any is labour, parking or something else, say how to read it and every job using it
              changes.
            </p>
            <div className="scroll">
              <table className="tbl compact" style={{ minWidth: 640 }}>
                <thead>
                  <tr>
                    <th>Line name</th>
                    <th className="num">Jobs</th>
                    <th>{canEdit ? "Read it as" : "Example jobs"}</th>
                  </tr>
                </thead>
                <tbody>
                  {guessList.slice(0, 40).map((g) => (
                    <tr key={g.name}>
                      <td style={{ overflowWrap: "anywhere" }}>{g.name}</td>
                      <td className="num">{g.jobs.size}</td>
                      <td>
                        {canEdit ? (
                          <form action={addLineRuleAction} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                            {hidden}
                            <input type="hidden" name="match" value={g.name} />
                            <input type="hidden" name="sort" value={String(nextSort)} />
                            <select name="line_class" className="compact" required defaultValue="" aria-label={`Read ${g.name} as`}>
                              <option value="" disabled>
                                Choose…
                              </option>
                              {LINE_CLASSES.map((c) => (
                                <option key={c.value} value={c.value}>
                                  {c.label}
                                </option>
                              ))}
                            </select>
                            <SubmitButton className="btn" pending="Adding…">
                              Add rule
                            </SubmitButton>
                          </form>
                        ) : (
                          <span className="small muted">{[...g.jobs].slice(0, 4).join(", ")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {guessList.length > 40 ? <p className="small muted" style={{ padding: "10px 20px 16px" }}>And {guessList.length - 40} more, shown here as these are dealt with.</p> : null}
          </>
        ) : (
          <div className="empty">
            {input.jobs.length ? "Every job line in the last 8 weeks matched a rule or a built-in guess." : "Nothing yet. Lines appear here once jobs are read from ServiceM8."}
          </div>
        )}
      </section>

      <p className="small muted">
        Looking for the reports? <Link href="/">Back to the overview</Link>.
      </p>
    </>
  );
}

/* Pieces */

function IntegrationFacts({ i, accountLabel }: { i: Integration | null; accountLabel: string }) {
  return (
    <dl className="data">
      <div>
        <dt>Status</dt>
        <dd>
          {!i ? (
            <span className="chip">Not connected</span>
          ) : i.status === "needs_reconnect" ? (
            <span className="chip amber">Needs connecting again</span>
          ) : (
            <span className="chip green">Connected</span>
          )}
        </dd>
      </div>
      {i ? (
        <>
          <div>
            <dt>{accountLabel}</dt>
            <dd>{i.accountName || "–"}</dd>
          </div>
          <div>
            <dt>Last refreshed</dt>
            <dd>{stamp(i.lastSyncAt)}</dd>
          </div>
          {i.lastError ? (
            <div>
              <dt>Last problem</dt>
              <dd className="late">{i.lastError}</dd>
            </div>
          ) : null}
        </>
      ) : null}
    </dl>
  );
}

function RunChip({ run }: { run: SyncRun }) {
  if (run.status === "running") return <span className="chip blue">Running</span>;
  if (run.status === "error") return <span className="chip amber">Problem</span>;
  if (run.detail?.partial) return <span className="chip amber">Partly done</span>;
  return <span className="chip green">Done</span>;
}

function ServiceM8Form({ label }: { label: string }) {
  return (
    <form action={connectServiceM8} className="form" style={{ maxWidth: 640, paddingTop: 12 }}>
      <Field label="ServiceM8 API key" hint="Stored encrypted. Checked with ServiceM8 before it is saved." className="full">
        <input type="password" name="api_key" autoComplete="off" spellCheck={false} required />
      </Field>
      <div className="full">
        <SubmitButton pending="Checking the key…">{label}</SubmitButton>
      </div>
    </form>
  );
}

function SettingsForm({
  s,
  biz,
  categories,
  trackingNames,
  hidden,
}: {
  s: ReportSettings;
  biz: string;
  categories: string[];
  trackingNames: string[];
  hidden: React.ReactNode;
}) {
  const seen = categories.length ? `ServiceM8 categories seen in jobs: ${categories.slice(0, 24).join(", ")}${categories.length > 24 ? " and more" : ""}.` : "";
  const tracking = trackingNames.includes(s.salesTypeTracking) || !s.salesTypeTracking ? trackingNames : [s.salesTypeTracking, ...trackingNames];
  return (
    <form action={saveReportSettingsForm} className="form">
      {hidden}
      <Field label="Business short name" hint={`Used in labels such as "Bought by ${biz}"`}>
        <input type="text" name="business_name" defaultValue={s.businessName} required />
      </Field>
      <Field label="Read data from" hint="How far back to read data">
        <input type="date" name="sync_from" defaultValue={s.syncFrom} required />
      </Field>
      <Field label="Weeks end on" hint={`${biz}'s weeks run ${DAYS[s.weekEndsOn % 7]} to ${DAYS[s.weekEndsOn - 1]}`}>
        <select name="week_ends_on" defaultValue={String(s.weekEndsOn)}>
          {DAYS.map((d, i) => (
            <option key={d} value={String(i + 1)}>
              {d}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Pay run, days after the week ends" hint="28 pays four weeks after the week ends">
        <input type="text" inputMode="numeric" name="pay_run_lag_days" defaultValue={String(s.payRunLagDays)} />
      </Field>
      <Field label="Labour share %" hint="Of the labour charged, where no rate, fee or bill applies. 45 means 45%.">
        <input type="text" inputMode="decimal" name="labour_share" defaultValue={pctBox(s.labourShare)} />
      </Field>
      <Field label="CIS rate %" hint="Taken off contractors' labour">
        <input type="text" inputMode="decimal" name="cis_rate" defaultValue={pctBox(s.cisRate)} />
      </Field>
      <Field label="VAT rate %">
        <input type="text" inputMode="decimal" name="vat_rate" defaultValue={pctBox(s.vatRate)} />
      </Field>
      <Field label="Low margin warning %" hint="Jobs with a margin below this are marked">
        <input type="text" inputMode="decimal" name="low_margin_pct" defaultValue={pctBox(s.lowMarginPct)} />
      </Field>
      <Field label="Chase invoices after, hours" hint="Time for the automatic card charge to go through first">
        <input type="text" inputMode="numeric" name="chase_after_hours" defaultValue={String(s.chaseAfterHours)} />
      </Field>
      <Field label="Sales type tracking in Xero" hint="The Xero tracking category that splits sales, such as RE, S&M and IN">
        {tracking.length ? (
          <select name="sales_type_tracking" defaultValue={s.salesTypeTracking}>
            {/* With nothing chosen yet, saving the form must not quietly pick the first category. */}
            {!s.salesTypeTracking ? <option value="">Not chosen</option> : null}
            {tracking.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        ) : (
          <input type="text" name="sales_type_tracking" defaultValue={s.salesTypeTracking} />
        )}
      </Field>
      <Field label="Project categories" hint={`Comma separated. Jobs in these are held out of contractor pay and shown on Projects. ${seen}`} className="full">
        <input type="text" name="project_categories" defaultValue={s.projectCategories.join(", ")} />
      </Field>
      <Field label="Recall categories" hint="Comma separated. Recalls are normally unpaid, and are marked when they have no value." className="full">
        <input type="text" name="recall_categories" defaultValue={s.recallCategories.join(", ")} />
      </Field>
      <div className="full">
        <SubmitButton pending="Saving…">Save settings</SubmitButton>
      </div>
    </form>
  );
}

function ContractorForm({
  c,
  staffList,
  linkedTo,
  labourShare,
  hidden,
}: {
  c: Contractor | null;
  staffList: SmStaff[];
  linkedTo: Map<string, string>;
  labourShare: number;
  hidden: React.ReactNode;
}) {
  const known = new Set(staffList.map((p) => p.uuid));
  const missing = (c?.sm8StaffUuids ?? []).filter((u) => !known.has(u));
  return (
    <form action={saveContractorAction} className="mini" style={{ padding: "12px 0 16px" }}>
      {hidden}
      {c ? <input type="hidden" name="id" value={c.id} /> : null}
      <Field label="Name">
        <input type="text" name="name" defaultValue={c?.name ?? ""} required />
      </Field>
      <Field label="Paid">
        <select name="kind" defaultValue={c?.kind ?? "contractor"}>
          <option value="contractor">Per job</option>
          <option value="staff">Not paid per job (director, office)</option>
        </select>
      </Field>
      <Field label="Cost basis">
        <select name="cost_basis" defaultValue={c?.costBasis ?? "hourly"}>
          <option value="hourly">Hourly at the card rate</option>
          <option value="labour_share">Share of labour charged ({pct(labourShare, 0)})</option>
        </select>
      </Field>
      <Field label="Card rate £ an hour">
        <input type="text" inputMode="decimal" name="hourly_rate" defaultValue={c?.hourlyRate != null ? String(c.hourlyRate) : ""} />
      </Field>
      <Field label="Bill supplier in Xero" hint="The name on their bills">
        <input type="text" name="bill_supplier" list="bill-suppliers" defaultValue={c?.billSupplier ?? ""} autoComplete="off" />
      </Field>
      <Field label="Active">
        <select name="active" defaultValue={c && !c.active ? "off" : "on"}>
          <option value="on">Yes</option>
          <option value="off">No</option>
        </select>
      </Field>
      <label className="check" style={{ gridColumn: "1 / -1" }}>
        <input type="checkbox" name="use_bills" defaultChecked={c?.useBills ?? false} />
        Use their Xero bill when it names the job
      </label>
      <fieldset style={{ gridColumn: "1 / -1" }}>
        <legend className="field-label" style={{ marginBottom: 6 }}>
          ServiceM8 staff
        </legend>
        {staffList.length || missing.length ? (
          <div className="checks">
            {staffList.map((p) => {
              const other = linkedTo.get(p.uuid);
              const elsewhere = other && other !== c?.name ? other : null;
              return (
                <label key={p.uuid} className="check">
                  <input type="checkbox" name="sm8_staff_uuids" value={p.uuid} defaultChecked={c?.sm8StaffUuids.includes(p.uuid) ?? false} />
                  <span>
                    {p.name || "No name"}
                    {!p.active ? <span className="muted"> (inactive)</span> : null}
                    {elsewhere ? <span className="muted">{elsewhere === p.name ? " (linked already)" : ` (linked to ${elsewhere})`}</span> : null}
                  </span>
                </label>
              );
            })}
            {missing.map((u) => (
              <label key={u} className="check">
                <input type="checkbox" name="sm8_staff_uuids" value={u} defaultChecked />
                <span className="muted">No longer in ServiceM8</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="small muted">The staff list comes in when ServiceM8 is connected and refreshed.</p>
        )}
        <small className="muted" style={{ display: "block", marginTop: 4 }}>
          Jobs completed by these people are this contractor&apos;s.
        </small>
      </fieldset>
      <div style={{ gridColumn: "1 / -1" }}>
        <Field label="Notes">
          <input type="text" name="notes" defaultValue={c?.notes ?? ""} />
        </Field>
      </div>
      <div style={{ gridColumn: "1 / -1" }}>
        <SubmitButton pending="Saving…">{c ? `Save ${c.name}` : "Add contractor"}</SubmitButton>
      </div>
    </form>
  );
}

function FeeForm({ f, hidden, nextSort }: { f: FixedFee | null; hidden: React.ReactNode; nextSort?: number }) {
  return (
    <form action={saveFeeAction} className="mini" style={{ padding: "12px 0 16px" }}>
      {hidden}
      {f ? <input type="hidden" name="id" value={f.id} /> : null}
      <Field label="Name">
        <input type="text" name="name" defaultValue={f?.name ?? ""} required />
      </Field>
      <Field label="Fee £">
        <input type="text" inputMode="decimal" name="amount" defaultValue={f ? String(f.amount) : ""} required />
      </Field>
      <div style={{ gridColumn: "1 / -1" }}>
        <Field label="Matches lines containing" hint="Comma separated, such as boiler service, cp12">
          <input type="text" name="keywords" defaultValue={f?.keywords.join(", ") ?? ""} />
        </Field>
      </div>
      <Field label="Notes">
        <input type="text" name="notes" defaultValue={f?.notes ?? ""} placeholder="Per visit" />
      </Field>
      <Field label="Order" hint="Lower numbers are tried first">
        <input type="text" inputMode="numeric" name="sort" defaultValue={String(f?.sort ?? nextSort ?? 0)} />
      </Field>
      <div style={{ gridColumn: "1 / -1" }}>
        <SubmitButton pending="Saving…">{f ? `Save ${f.name}` : "Add fee"}</SubmitButton>
      </div>
    </form>
  );
}
