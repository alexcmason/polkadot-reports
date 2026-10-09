import Link from "next/link";
import { saveChaseAction } from "@/lib/actions/reporting";
import { chasesFor, freshnessFor, invoicesFor, jobRowsFor, reportingAccess, serviceM8For, settingsFor, today } from "@/lib/reporting/context";
import {
  buildDebtors,
  CHASE_LABEL,
  CHASE_STATUSES,
  chaseEmailText,
  DEBTOR_BUCKETS,
  DO_NOT_CHASE,
  LEDGER_BUCKETS,
  xeroLedger,
  type ChaseStatus,
  type DebtorRow,
} from "@/lib/reporting/debtors";
import { round2, weekEnding, weekMonth } from "@/lib/reporting/dates";
import { dm, dmy, gbp, gbp0, stamp, tone } from "@/lib/reporting/format";
import { listDebtorEvents, type DebtorEvent } from "@/lib/reporting/store";
import type { SmJob } from "@/lib/reporting/types";
import { Banner, Field, first, type Search } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { CopyButton } from "@/components/reporting/CopyButton";
import { Flags } from "@/components/reporting/Flags";

export const metadata = { title: "Debtors" };

const VIEWS = ["chase", "ledger", "log"] as const;
type View = (typeof VIEWS)[number];

const CHASE_CHIP: Record<ChaseStatus, string> = {
  to_chase: "chip",
  chased: "chip blue",
  promised: "chip green",
  queried: "chip amber",
  paid: "chip green",
  write_off: "chip",
  hold: "chip amber",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Read by screen readers only. Kept in the flow, not absolutely positioned, so it cannot widen the page from inside a scrolling table. */
const HIDDEN: React.CSSProperties = { display: "inline-block", width: 1, height: 1, margin: -1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" };

/** Lets a long header wrap onto two lines so the table stays narrow. */
const WRAP: React.CSSProperties = { whiteSpace: "normal", verticalAlign: "bottom" };

/** "Chased. Status: to_chase" with the status in words. */
const eventText = (action: string) => action.replace(/Status: (\w+)/, (_, s: string) => `Status: ${CHASE_LABEL[s as ChaseStatus] ?? s}`);

export default async function DebtorsPage({ searchParams }: { searchParams: Search }) {
  const { user, business, staff, canEdit } = await reportingAccess();
  const sp = await searchParams;
  const edit = staff && canEdit;
  const here = `/debtors`;

  const view: View = (VIEWS as readonly string[]).includes(first(sp.view)) ? (first(sp.view) as View) : "chase";
  const bucket = DEBTOR_BUCKETS.includes(first(sp.bucket)) ? first(sp.bucket) : "";
  const status = (CHASE_STATUSES as string[]).includes(first(sp.status)) ? (first(sp.status) as ChaseStatus) : "";
  const search = first(sp.q).trim();
  const saved = first(sp.saved);
  const error = first(sp.error);

  const [settings, sm, invoices, chases, events, fresh, jobRows] = await Promise.all([
    settingsFor(),
    serviceM8For(),
    invoicesFor(),
    chasesFor(),
    listDebtorEvents(),
    freshnessFor(),
    staff ? jobRowsFor() : null,
  ]);
  const now = today();
  const report = buildDebtors({
    jobs: sm.jobs,
    payments: sm.payments,
    invoices,
    chases,
    chaseAfterHours: settings.chaseAfterHours,
    now: new Date().toISOString(),
    today: now,
  });
  const ledger = view === "ledger" ? xeroLedger(invoices, now) : null;

  const jobsByUuid = new Map(sm.jobs.map((j) => [j.uuid, j]));
  const eventsByJob = new Map<string, DebtorEvent[]>();
  for (const e of events) {
    const key = e.jobNo.trim().toUpperCase();
    const list = eventsByJob.get(key) ?? [];
    if (list.length < 3) eventsByJob.set(key, [...list, e]);
  }

  const needle = search.toLowerCase();
  const shown = report.rows.filter(
    (r) =>
      (!bucket || r.bucket === bucket) &&
      (!status || r.status === status) &&
      (!needle || [r.jobNo, r.customer, r.site].some((s) => s.toLowerCase().includes(needle)))
  );
  const sumOf = (pick: (r: DebtorRow) => number) => round2(shown.reduce((s, r) => s + pick(r), 0));
  const shownTotal = { total: sumOf((r) => r.total), paid: sumOf((r) => r.paid), balance: sumOf((r) => r.balance) };
  const filtered = !!(bucket || status || search);

  const query = (over: Record<string, string>) => {
    const p = new URLSearchParams();
    const all = { view: view === "chase" ? "" : view, bucket, status, q: search, ...over };
    for (const [k, v] of Object.entries(all)) if (v) p.set(k, v);
    const s = p.toString();
    return s ? `${here}?${s}` : here;
  };
  const returnTo = query({});
  // Job Data lists completed jobs under the month their pay week starts in, after any move made there.
  const weekOf = new Map((jobRows?.rows ?? []).map((r) => [r.jobUuid, r.weekEnding]));
  const jobHref = (job: SmJob | undefined) => {
    const day = job?.completionDate ?? job?.date;
    if (!staff || !job || job.status !== "Completed" || !day) return null;
    const week = weekOf.get(job.uuid) ?? weekEnding(day, settings.weekEndsOn);
    return `/jobs?month=${weekMonth(week)}#job-${encodeURIComponent(job.jobNo)}`;
  };
  const over90 = report.buckets[report.buckets.length - 1];
  const hours = report.chaseAfterHours;

  const pills: { id: View; label: string }[] = [
    { id: "chase", label: "Chase list" },
    { id: "ledger", label: "Xero ledger" },
    { id: "log", label: "Activity" },
  ];

  const noServiceM8 = !fresh.connected.servicem8;

  return (
    <>
      <p className="muted" style={{ maxWidth: 820 }}>
        Invoices sent from ServiceM8 and still unpaid more than {hours} hours after they went out, checked against payments in Xero. Before chasing, check
        Stripe for card payments that have not been marked paid.
      </p>

      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <nav className="pills" aria-label="Debtors views">
          {pills.map((p) => (
            <Link
              key={p.id}
              href={p.id === "chase" ? here : `${here}?view=${p.id}`}
              className={`pill ${view === p.id ? "active" : ""}`}
              aria-current={view === p.id ? "page" : undefined}
            >
              {p.label}
            </Link>
          ))}
        </nav>
        <a href={`/api/export?report=debtors`} className="btn" download>
          Download Excel
        </a>
      </div>

      {saved ? (
        <Banner kind="ok">
          Saved job {saved}.{" "}
          {view === "chase" && shown.some((r) => r.jobNo === saved) ? <a href={`#job-${encodeURIComponent(saved)}`}>Show the row</a> : null}
        </Banner>
      ) : null}
      {error ? <Banner kind="err">{error}</Banner> : null}

      <div className="kpis" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(176px, 100%), 1fr))" }}>
        <div className="kpi static">
          <span className="label">Outstanding</span>
          <span className="num md">{gbp0(report.total.amount)}</span>
          <span className="small muted">{plural(report.total.count, "invoice")}, inc VAT</span>
        </div>
        <div className="kpi static">
          <span className="label">To chase</span>
          <span className="num md">{gbp0(report.toChase.amount)}</span>
          <span className="small muted">{plural(report.toChase.count, "invoice")}</span>
        </div>
        <div className="kpi static">
          <span className="label">90+ days</span>
          <span className={`num md ${over90.amount > 0 ? "late" : ""}`}>{gbp0(over90.amount)}</span>
          <span className="small muted">{plural(over90.count, "invoice")}</span>
        </div>
        <div className="kpi static">
          <span className="label">Queried by client</span>
          <span className="num md">{report.byStatus.queried.count}</span>
          <span className="small muted">{report.byStatus.queried.count ? `${gbp(report.byStatus.queried.amount)} – do not chase` : "None"}</span>
        </div>
        <div className="kpi static">
          <span className="label">Paid elsewhere</span>
          <span className="num md">{report.byStatus.paid.count}</span>
          <span className="small muted">{report.byStatus.paid.count ? `${gbp(report.byStatus.paid.amount)} to mark paid in ServiceM8` : "None"}</span>
        </div>
      </div>

      {view === "chase" ? (
        <>
          <div className="split">
            <section className="card narrow">
              <div className="card-head">
                <h2>By age</h2>
                <span className="small muted">Days since the invoice was sent</span>
              </div>
              <table className="tbl figs">
                <thead>
                  <tr>
                    <th>Age</th>
                    <th className="num">Invoices</th>
                    <th className="num">Outstanding</th>
                  </tr>
                </thead>
                <tbody>
                  {report.buckets.map((b) => (
                    <tr key={b.label}>
                      <td>
                        <Link href={query({ bucket: bucket === b.label ? "" : b.label })} aria-current={bucket === b.label ? "true" : undefined}>
                          {b.label}
                        </Link>
                      </td>
                      <td className="num">{b.count}</td>
                      <td className={tone(b.amount)}>{gbp(b.amount)}</td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td>Total</td>
                    <td className="num">{report.total.count}</td>
                    <td className={tone(report.total.amount)}>{gbp(report.total.amount)}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="card wide">
              <div className="card-head">
                <h2>Largest debts by client</h2>
                <span className="small muted">Top 10</span>
              </div>
              {report.byCustomer.length === 0 ? (
                <div className="empty">Nobody owes anything.</div>
              ) : (
                <div className="scroll">
                  <table className="tbl figs" style={{ minWidth: 460 }}>
                    <thead>
                      <tr>
                        <th>Client</th>
                        <th className="num">Invoices</th>
                        <th className="num">Outstanding</th>
                        <th className="num">Oldest</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.byCustomer.slice(0, 10).map((c) => (
                        <tr key={c.customer}>
                          <td>
                            <Link href={query({ q: c.customer, bucket: "", status: "" })}>{c.customer}</Link>
                          </td>
                          <td className="num">{c.count}</td>
                          <td className={tone(c.amount)}>{gbp(c.amount)}</td>
                          <td className={c.oldestDays >= 90 ? "num late" : "num"}>{plural(c.oldestDays, "day")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <section className="card">
            <div className="card-head">
              <h2>Chase list</h2>
              <span className="small muted">
                {filtered
                  ? `Showing ${plural(shown.length, "invoice")} of ${report.total.count}, ${gbp(shownTotal.balance)}`
                  : `${plural(report.total.count, "invoice")}, oldest first`}
              </span>
            </div>
            <form method="get" action={here} className="filters toolbar" style={{ padding: "0 20px 14px" }}>
              <label>
                Age
                <select name="bucket" defaultValue={bucket}>
                  <option value="">All ages</option>
                  {DEBTOR_BUCKETS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Status
                <select name="status" defaultValue={status}>
                  <option value="">All statuses</option>
                  {CHASE_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {CHASE_LABEL[s]} ({report.byStatus[s].count})
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Search
                <input type="search" name="q" defaultValue={search} placeholder="Job, client or site" style={{ minWidth: 220 }} />
              </label>
              <button type="submit" className="btn">
                Apply
              </button>
              {filtered ? (
                <Link href={here} className="link">
                  Clear
                </Link>
              ) : null}
            </form>
            {report.rows.length === 0 ? (
              <div className="empty">
                {noServiceM8 ? (
                  staff ? (
                    <>
                      <Link href={`/settings`}>Connect ServiceM8 in Settings</Link> to build the chase list.
                    </>
                  ) : (
                    "Nothing to show yet."
                  )
                ) : (
                  `Nothing to chase. Every invoice sent more than ${hours} hours ago is paid.`
                )}
              </div>
            ) : shown.length === 0 ? (
              <div className="empty">
                No invoices match. <Link href={here}>Clear the filters</Link>.
              </div>
            ) : (
              <div className="scroll">
                <table className="tbl figs compact sticky" style={{ minWidth: edit ? 1080 : 1000 }}>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Client</th>
                      <th>Site</th>
                      <th>Invoiced</th>
                      <th className="num">Days</th>
                      <th className="num" style={{ ...WRAP, minWidth: 96 }}>
                        Invoice (inc VAT) £
                      </th>
                      <th className="num" style={WRAP}>
                        Paid £
                      </th>
                      <th className="num" style={WRAP}>
                        Balance £
                      </th>
                      <th>Note</th>
                      <th>Status</th>
                      <th style={WRAP}>Last chased</th>
                      {edit ? (
                        <th>
                          <span style={HIDDEN}>Update</span>
                        </th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((r) => (
                      <ChaseRows
                        key={r.jobUuid}
                        row={r}
                        href={jobHref(jobsByUuid.get(r.jobUuid))}
                        events={eventsByJob.get(r.jobNo.trim().toUpperCase()) ?? []}
                        edit={edit}
                        open={saved === r.jobNo}
                        returnTo={returnTo}
                      />
                    ))}
                    <tr className="total">
                      <td>Total</td>
                      <td colSpan={4}>{filtered ? `${plural(shown.length, "invoice")} shown` : plural(shown.length, "invoice")}</td>
                      <td className={tone(shownTotal.total)}>{gbp(shownTotal.total)}</td>
                      <td className={tone(shownTotal.paid)}>{gbp(shownTotal.paid, { dashZero: true })}</td>
                      <td className={tone(shownTotal.balance)}>{gbp(shownTotal.balance)}</td>
                      <td colSpan={edit ? 4 : 3} />
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {report.housekeeping.length ? (
            <section className="card">
              <div className="card-head">
                <h2>Housekeeping</h2>
                <span className="small muted">Paid in Xero but still unpaid in ServiceM8 – mark these paid in ServiceM8</span>
              </div>
              <div className="scroll">
                <table className="tbl figs compact" style={{ minWidth: 640 }}>
                  <thead>
                    <tr>
                      <th>Job</th>
                      <th>Client</th>
                      <th className="num">Total (inc VAT) £</th>
                      <th className="num">Paid in ServiceM8 £</th>
                      <th className="num">Paid in Xero £</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.housekeeping.map((h) => {
                      const href = jobHref(jobsByUuid.get(h.jobUuid));
                      return (
                        <tr key={h.jobUuid}>
                          <td>
                            {href ? <Link href={href}>{h.jobNo}</Link> : h.jobNo}
                            {h.xeroNumber && h.xeroNumber !== h.jobNo ? <div className="tiny muted">Xero {h.xeroNumber}</div> : null}
                          </td>
                          <td>{h.customer}</td>
                          <td className={tone(h.total)}>{gbp(h.total)}</td>
                          <td className={tone(h.smPaid)}>{gbp(h.smPaid, { dashZero: true })}</td>
                          <td className={tone(h.xeroPaid)}>{gbp(h.xeroPaid)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {staff && report.rows.length ? (
            <section className="card">
              <div className="card-head">
                <h2>Chase email</h2>
                <CopyButton target="chase-email" label="Copy email" />
              </div>
              <div className="card-body stack" style={{ gap: 8 }}>
                <p className="small muted">The full list as plain text, laid out like the director&apos;s email. Paste it into an email or a spreadsheet.</p>
                <textarea
                  id="chase-email"
                  rows={12}
                  readOnly
                  className="copy"
                  aria-label="Chase email text"
                  defaultValue={chaseEmailText(report, { businessName: business, asAt: dmy(now) })}
                  style={{ whiteSpace: "pre", overflowWrap: "normal" }}
                />
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {view === "ledger" && ledger ? (
        <section className="card">
          <div className="card-head">
            <h2>Xero sales ledger</h2>
            <span className="small muted">Unpaid sales invoices in Xero, by days past the due date</span>
          </div>
          {!fresh.connected.xero ? (
            <div className="empty">
              {staff ? (
                <>
                  <Link href={`/settings`}>Connect Xero in Settings</Link> to see the sales ledger.
                </>
              ) : (
                "Nothing to show yet."
              )}
            </div>
          ) : ledger.rows.length === 0 ? (
            <div className="empty">Nothing is owed in Xero.</div>
          ) : (
            <div className="scroll">
              <table className="tbl figs compact sticky" style={{ minWidth: 980 }}>
                <thead>
                  <tr>
                    <th>Contact</th>
                    {LEDGER_BUCKETS.map((b) => (
                      <th key={b} className="num">
                        {b}
                      </th>
                    ))}
                    <th className="num">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.rows.map((r) => (
                    <tr key={r.contactId || r.contactName}>
                      <td>
                        {r.contactName}
                        <div className="sub">
                          {plural(r.invoices.length, "invoice")}: {r.invoices.map((li) => li.invoice.number).filter(Boolean).slice(0, 4).join(", ")}
                          {r.invoices.length > 4 ? "…" : ""}
                        </div>
                      </td>
                      {r.amounts.map((v, i) => (
                        <td key={LEDGER_BUCKETS[i]} className={i === LEDGER_BUCKETS.length - 1 && v > 0.004 ? "num late" : tone(v)}>
                          {gbp(v, { dashZero: true })}
                        </td>
                      ))}
                      <td className={tone(r.total)} style={{ fontWeight: 600 }}>
                        {gbp(r.total)}
                      </td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td>Total ({plural(ledger.count, "invoice")})</td>
                    {ledger.buckets.map((b) => (
                      <td key={b.label} className={tone(b.amount)}>
                        {gbp(b.amount, { dashZero: true })}
                      </td>
                    ))}
                    <td className={tone(ledger.total)}>{gbp(ledger.total)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
          {fresh.connected.xero ? (
            <div className="card-body">
              <p>
                ServiceM8 says <strong>{gbp(report.total.amount)}</strong> outstanding; Xero says <strong>{gbp(ledger.total)}</strong>. Difference{" "}
                <strong className={Math.abs(report.total.amount - ledger.total) > 0.004 ? "late" : undefined}>{gbp(report.total.amount - ledger.total)}</strong>.
              </p>
              <p className="small muted" style={{ marginTop: 6 }}>
                The ServiceM8 figure is the chase list: invoices sent more than {hours} hours ago, less payments recorded in ServiceM8 or Xero. Invoices sent in the
                last {hours} hours, payments recorded in only one system, and Xero invoices not raised from ServiceM8 explain most differences.
              </p>
            </div>
          ) : null}
        </section>
      ) : null}

      {view === "log" ? (
        <section className="card">
          <div className="card-head">
            <h2>Activity</h2>
            <span className="small muted">Chasing notes and status changes, newest first</span>
          </div>
          {events.length === 0 ? (
            <div className="empty">{edit ? "Nothing logged yet. Updates you make on the chase list appear here." : "Nothing logged yet."}</div>
          ) : (
            <div className="scroll">
              <table className="tbl compact" style={{ minWidth: 760 }}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Job</th>
                    <th>Action</th>
                    <th>Note</th>
                    <th>By</th>
                  </tr>
                </thead>
                <tbody>
                  {events.slice(0, 300).map((e, i) => (
                    <tr key={`${e.at}-${e.jobNo}-${i}`}>
                      <td style={{ whiteSpace: "nowrap" }}>{stamp(e.at)}</td>
                      <td>
                        <Link href={query({ view: "", q: e.jobNo, bucket: "", status: "" })}>{e.jobNo}</Link>
                      </td>
                      <td>{eventText(e.action)}</td>
                      <td style={{ whiteSpace: "pre-wrap" }}>{e.note}</td>
                      <td>{e.byName}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
    </>
  );
}

const COLUMNS = 11;

function ChaseRows({
  row: r,
  href,
  events,
  edit,
  open,
  returnTo,
}: {
  row: DebtorRow;
  href: string | null;
  events: DebtorEvent[];
  edit: boolean;
  /** Show the update form without its link being clicked: after saving this job. */
  open: boolean;
  returnTo: string;
}) {
  const notes = [r.note, r.chase.note].filter(Boolean);
  const rowId = `job-${r.jobNo}`;
  const editId = `edit-${r.jobNo}`;
  return (
    <>
      <tr id={rowId} className={DO_NOT_CHASE.includes(r.status) ? "flagged" : undefined}>
        <td style={{ whiteSpace: "nowrap" }}>{href ? <Link href={href}>{r.jobNo}</Link> : r.jobNo}</td>
        <td style={{ minWidth: 110 }}>{r.customer}</td>
        <td style={{ minWidth: 140 }}>{r.site}</td>
        <td style={{ whiteSpace: "nowrap" }}>{dmy(r.invoicedOn)}</td>
        <td className={r.days >= 90 ? "num late strong" : "num"}>{r.days}</td>
        <td className={tone(r.total)}>{gbp(r.total)}</td>
        <td className={tone(r.paid)}>{gbp(r.paid, { dashZero: true })}</td>
        <td className={tone(r.balance)} style={{ fontWeight: 600 }}>
          {gbp(r.balance)}
        </td>
        <td style={{ minWidth: 130 }}>
          {notes.length ? <div className="small">{notes.join(". ")}</div> : null}
          <Flags flags={r.flags} />
        </td>
        <td>
          <span className={CHASE_CHIP[r.status]}>{CHASE_LABEL[r.status]}</span>
        </td>
        <td style={{ whiteSpace: "nowrap" }}>
          {r.chase.lastChasedOn ? (
            <>
              {dm(r.chase.lastChasedOn)}
              <div className="tiny muted">
                {r.daysSinceChased === 0 ? "today" : r.daysSinceChased === 1 ? "yesterday" : `${r.daysSinceChased} days ago`}
                {r.chase.chaseCount > 1 ? ` · ${r.chase.chaseCount} times` : ""}
              </div>
            </>
          ) : (
            <span className="muted">–</span>
          )}
        </td>
        {edit ? (
          <td>
            <a href={`#${encodeURIComponent(editId)}`} className="link" aria-controls={editId}>
              Update<span style={HIDDEN}> {r.jobNo}</span>
            </a>
          </td>
        ) : null}
      </tr>
      {edit ? (
        // Hidden until its Update link targets it (#edit-…); shown straight away after saving this job.
        <tr id={editId} className={open ? "edit-row" : "edit-row collapsed"} style={{ scrollMarginTop: 96 }}>
          <td colSpan={COLUMNS + 1} style={{ position: "static", background: "#fafbfc" }}>
            <div style={{ position: "sticky", left: 16, width: "min(880px, max(280px, calc(100vw - 360px)))", padding: "4px 0 8px" }}>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0 16px" }}>
                <span className="strong">
                  Update {r.jobNo}
                  <span className="muted" style={{ fontWeight: 400 }}>
                    {" "}
                    · {r.customer}
                  </span>
                </span>
                <a href={`#${encodeURIComponent(rowId)}`} className="link">
                  Close
                </a>
              </div>
              <form action={saveChaseAction} className="mini">
                <input type="hidden" name="return_to" value={returnTo} />
                <input type="hidden" name="job_no" value={r.jobNo} />
                <Field label="Status">
                  {/* "To chase" posts no status, so saveChaseAction records "Chased" when Chased today is pressed and "To chase" otherwise. */}
                  <select name="status" defaultValue={r.status === "to_chase" ? "" : r.status}>
                    {CHASE_STATUSES.map((s) => (
                      <option key={s} value={s === "to_chase" ? "" : s}>
                        {CHASE_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Note" hint="Shown on the chase list and in the email">
                  <input type="text" name="note" defaultValue={r.chase.note} />
                </Field>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 8, paddingTop: 22 }}>
                  <SubmitButton pending="Saving…">Save</SubmitButton>
                  <button type="submit" name="chased_today" value="1" className="btn">
                    Chased today
                  </button>
                </div>
              </form>
              {events.length ? (
                <ul className="tiny muted" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {events.map((e, i) => (
                    <li key={`${e.at}-${i}`}>
                      {stamp(e.at)} – {eventText(e.action)}
                      {e.note ? `: ${e.note}` : ""} – {e.byName}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="tiny muted" style={{ marginTop: 8 }}>
                  No updates logged yet.
                </p>
              )}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
