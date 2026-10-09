import Link from "next/link";
import { createQueryAction } from "@/lib/actions/reporting";
import { freshnessFor, jobRowsFor, reportingAccess, today } from "@/lib/reporting/context";
import {
  defaultWeek,
  monthReport,
  suggestedQueries,
  weekReport,
  type ContractorInputs,
  type ContractorWeek,
  type JobRow,
  type MonthReport,
  type Money,
  type WeekReport,
} from "@/lib/reporting/contractor";
import { addMonths, lastCompleteWeek, monthName, plusDays, round2, weekEnding, weekMonth, weeksInMonth } from "@/lib/reporting/dates";
import { dm, gbp, gbp0, num, pct, tone, wdm } from "@/lib/reporting/format";
import { askedJobs } from "@/lib/reporting/store";
import type { Contractor, Flag } from "@/lib/reporting/types";
import { AutoSelect } from "@/components/AutoSelect";
import { SubmitButton } from "@/components/SubmitButton";
import { Banner, first, type Search } from "@/components/ui";
import { Flags, flagRowClass } from "@/components/reporting/Flags";
import { MoneyChart } from "@/components/reporting/MoneyChart";
import { Stepper } from "@/components/reporting/Stepper";

export const metadata = { title: "Contractor pay" };

/* Helpers */

const isIsoDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
};
const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
const anchor = (c: { contractorId: string | null; name: string }) => `c-${c.contractorId ?? slug(c.name)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const short = (day: string) => day.slice(0, 3);

/** "Fri 4 Sep to Thu 10 Sep 2026", with both years when the span crosses one. */
function span(start: string, end: string): string {
  const ys = start.slice(0, 4);
  const ye = end.slice(0, 4);
  return ys === ye ? `${wdm(start)} to ${wdm(end)} ${ye}` : `${wdm(start)} ${ys} to ${wdm(end)} ${ye}`;
}

/** A money or count header that may wrap onto two lines, so wide figure tables stay readable. */
function Th({ children, left = false, min = 84 }: { children: React.ReactNode; left?: boolean; min?: number }) {
  return (
    <th className={left ? undefined : "num"} style={{ whiteSpace: "normal", minWidth: min, verticalAlign: "bottom" }}>
      {children}
    </th>
  );
}

function Amt({ v, strong = false }: { v: number; strong?: boolean }) {
  return <td className={`${tone(v)}${strong ? " strong" : ""}`}>{gbp(v, { dashZero: true })}</td>;
}

/** Five figures fit on one row on a laptop, as on Debtors. */
const KPI_ROW = { gridTemplateColumns: "repeat(auto-fit, minmax(min(176px, 100%), 1fr))" } as const;

/** Flags that need someone to look: anything above info, or anything with a question attached. */
const needingLook = (flags: Flag[]) => flags.filter((f) => f.severity !== "info" || !!f.ask);

function Kpi({ label, value, sub, late = false }: { label: string; value: string; sub?: string; late?: boolean }) {
  return (
    <div className="kpi static">
      <span className="label">{label}</span>
      <span className={`num md${late ? " late" : ""}`}>{value}</span>
      {sub ? <span className="small muted">{sub}</span> : null}
    </div>
  );
}

const labourMargin = (m: Pick<Money, "labour" | "labourCost">) => (m.labour ? (m.labour - m.labourCost) / m.labour : 0);

function rateChip(c: Contractor | undefined, labourShare: number): { text: string; cls: string } {
  if (!c) return { text: "Not set up", cls: "amber" };
  if (c.kind === "staff") return { text: "Not paid per job", cls: "amber" };
  if (c.costBasis === "labour_share") return { text: `Labour share ${pct(labourShare, 0)}`, cls: "blue" };
  return c.hourlyRate ? { text: `Hourly ${gbp0(c.hourlyRate)}`, cls: "green" } : { text: "Hourly, no rate", cls: "amber" };
}

/* Page */

export default async function ContractorsPage({ searchParams }: { searchParams: Search }) {
  const { business: biz, staff, canEdit } = await reportingAccess();
  const sp = await searchParams;
  const page = `/contractors`;

  const [{ input, rows }, fresh] = await Promise.all([jobRowsFor(), freshnessFor()]);
  const s = input.settings;
  const todayIso = today();
  const lastWeek = lastCompleteWeek(todayIso, s.weekEndsOn);
  const currentWeek = weekEnding(todayIso, s.weekEndsOn);

  const rawWeek = first(sp.week);
  // With no week asked for, open on the last complete week, or the latest earlier week with jobs while it is still empty.
  const week = isIsoDate(rawWeek) ? weekEnding(rawWeek, s.weekEndsOn) : defaultWeek(rows, lastWeek);
  const rawMonth = first(sp.month);
  const month = isMonth(rawMonth) ? rawMonth : weekMonth(week);
  const view: "week" | "month" = first(sp.view) === "month" ? "month" : "week";
  const saved = first(sp.saved);
  const error = first(sp.error);

  const weekLink = (w: string) => `${page}?week=${w}`;
  const monthLink = (m: string) => `${page}?view=month&month=${m}`;
  // Switching from a month to the week view lands on the selected week when it is in that month, else the month's latest complete week with jobs.
  const weekInMonth = (() => {
    if (weekMonth(week) === month) return week;
    const ws = weeksInMonth(month, s.weekEndsOn);
    const lastInMonth = [...ws].reverse().find((w) => w <= lastWeek);
    if (!lastInMonth) return ws[0] ?? week;
    const inMonth = new Set(ws);
    return defaultWeek(rows.filter((r) => inMonth.has(r.weekEnding)), lastInMonth);
  })();
  const topMonth = weekMonth(currentWeek);
  const thisYear = todayIso.slice(0, 4);
  const weekLabel = (w: string) => `Week ending ${wdm(w)}${w.slice(0, 4) !== thisYear ? ` ${w.slice(0, 4)}` : ""}${w > lastWeek ? " (in progress)" : ""}`;

  const weekOptions = Array.from({ length: 16 }, (_, i) => plusDays(lastWeek, -7 * i));
  if (!weekOptions.includes(week)) weekOptions.push(week);
  weekOptions.sort((a, b) => b.localeCompare(a));
  const monthOptions = Array.from({ length: 12 }, (_, i) => addMonths(topMonth, -i));
  if (!monthOptions.includes(month)) monthOptions.push(month);
  monthOptions.sort((a, b) => b.localeCompare(a));

  const prev = view === "week" ? weekLink(plusDays(week, -7)) : monthLink(addMonths(month, -1));
  const next =
    view === "week"
      ? plusDays(week, 7) <= currentWeek
        ? weekLink(plusDays(week, 7))
        : null
      : addMonths(month, 1) <= topMonth
        ? monthLink(addMonths(month, 1))
        : null;
  const exportHref =
    view === "week" ? `/api/export?report=week&week=${week}` : `/api/export?report=month&month=${month}`;

  // Only the view on screen is built.
  const wr = view === "week" ? weekReport(rows, input, week) : null;
  const mr = view === "month" ? monthReport(rows, input, month, todayIso) : null;
  const asked = canEdit && wr ? await askedJobs() : new Set<string>();

  const startDay = DAYS[Math.min(7, Math.max(1, s.weekEndsOn)) % 7];
  const endDay = DAYS[Math.min(7, Math.max(1, s.weekEndsOn)) - 1];
  let description: string;
  if (wr) {
    description = `${span(wr.weekStart, wr.weekEnding)}. Pay run ${wdm(wr.payRun)}. All values exclude VAT unless stated.`;
  } else {
    const ws = mr!.weeks;
    const loaded = ws.filter((w) => w.status === "loaded").length;
    description = ws.length
      ? `Weeks ending ${wdm(ws[0].weekEnding)} to ${wdm(ws[ws.length - 1].weekEnding)} ${ws[ws.length - 1].weekEnding.slice(0, 4)} (${short(startDay)} to ${short(endDay)}). ${loaded} of ${plural(ws.length, "week")} loaded. Project work is held out and shown on Projects. All values exclude VAT unless stated.`
      : "All values exclude VAT unless stated.";
  }

  const noData = !fresh.connected.servicem8;
  const emptyText = noData ? (
    staff ? (
      <>
        No jobs yet. <Link href={`/settings#connections`}>Connect ServiceM8 in Settings</Link>.
      </>
    ) : (
      "Nothing to show yet."
    )
  ) : view === "week" ? (
    "No contractor jobs were completed in this week."
  ) : (
    "No contractor jobs were completed in this month yet."
  );

  return (
    <>
      {saved === "query" ? (
        <Banner kind="ok">
          Added to the questions for {biz}. <Link href={`/queries`}>See all questions</Link>
        </Banner>
      ) : null}
      {error ? <Banner kind="err">{error}</Banner> : null}

      <div className="toolbar">
        <nav className="pills" aria-label="Period">
          <Link href={weekLink(view === "week" ? week : weekInMonth)} className={`pill ${view === "week" ? "active" : ""}`} aria-current={view === "week" ? "true" : undefined}>
            Week
          </Link>
          <Link href={monthLink(view === "month" ? month : weekMonth(week))} className={`pill ${view === "month" ? "active" : ""}`} aria-current={view === "month" ? "true" : undefined}>
            Month
          </Link>
        </nav>
        <Stepper prev={prev} next={next} label={view === "week" ? weekLabel(week) : monthName(month)} unit={view} />
        <form method="get" action={page}>
          {view === "month" ? <input type="hidden" name="view" value="month" /> : null}
          <label className="small muted" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            Go to
            {view === "week" ? (
              <AutoSelect name="week" value={week} label="Week ending" options={weekOptions.map((w) => ({ value: w, label: weekLabel(w) }))} />
            ) : (
              <AutoSelect name="month" value={month} label="Month" options={monthOptions.map((m) => ({ value: m, label: monthName(m) }))} />
            )}
          </label>
          <noscript>
            <button type="submit" className="btn">
              Show
            </button>
          </noscript>
        </form>
        <a className="btn" href={exportHref} download style={{ marginLeft: "auto" }}>
          Download Excel
        </a>
      </div>
      <p className="small muted" style={{ marginTop: -8 }}>
        {description}
      </p>

      {wr ? (
        <WeekView
          wr={wr}
          input={input}
          biz={biz}
          staff={staff}
          canEdit={canEdit}
          asked={asked}
          returnTo={weekLink(week)}
          emptyText={emptyText}
        />
      ) : null}
      {mr ? <MonthView mr={mr} biz={biz} cisRate={s.cisRate} weekLink={weekLink} emptyText={emptyText} /> : null}
    </>
  );
}

/* Week view */

function WeekView({
  wr,
  input,
  biz,
  staff,
  canEdit,
  asked,
  returnTo,
  emptyText,
}: {
  wr: WeekReport;
  input: ContractorInputs;
  biz: string;
  staff: boolean;
  canEdit: boolean;
  asked: Set<string>;
  returnTo: string;
  emptyText: React.ReactNode;
}) {
  const t = wr.total;
  const s = input.settings;
  const jobsMonth = weekMonth(wr.weekEnding);
  const jobHref = (jobNo: string) => `/jobs?month=${jobsMonth}#job-${encodeURIComponent(jobNo)}`;
  const JobNo = ({ jobNo }: { jobNo: string }) =>
    staff ? (
      <Link href={jobHref(jobNo)} className="title">
        {jobNo}
      </Link>
    ) : (
      <span className="strong">{jobNo}</span>
    );

  // Line names read as materials by guess are a costing note for editors, not for viewers.
  const shown = (flags: Flag[]) => (staff ? flags : flags.filter((f) => f.code !== "unclassified"));
  const suggestions = suggestedQueries(wr);
  const byJob = new Map(suggestions.map((q) => [q.jobNo, q]));
  const xeroAsk = suggestions.find((q) => q.subject.startsWith("In Xero in the week"));
  const hasChecks = wr.flagged.length + wr.heldOut.length + wr.xeroOnly.length + wr.unsuccessful.length > 0;

  const ask = (jobNo: string, subject: string, question: string, actionTaken: string) =>
    canEdit ? (
      <AskForm
        returnTo={returnTo}
        week={wr.weekEnding}
        jobNo={jobNo}
        subject={subject}
        ask={question}
        actionTaken={actionTaken}
        biz={biz}
        asked={asked.has(`${wr.weekEnding}|${jobNo}`)}
      />
    ) : null;

  return (
    <>
      <div className="kpis" style={KPI_ROW}>
        <Kpi label="Charged ex VAT" value={gbp(t.chargedEx)} sub={`${gbp(t.chargedInc)} inc VAT`} />
        <Kpi label="Gross margin" value={gbp(t.grossMargin)} sub={`${pct(t.marginPct)} of charged`} late={t.grossMargin < 0} />
        <Kpi label="Contractor labour cost" value={gbp(t.labourCost)} sub={`Labour margin ${pct(labourMargin(t))}`} />
        <Kpi label="Net payable" value={gbp(t.netPayable)} sub={`After CIS ${gbp(t.cis)} and deductions ${gbp(t.deductions)}`} />
        <Kpi label="Jobs" value={String(t.jobs)} sub={`${num(t.units)} units / hrs`} />
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Week summary</h2>
          <span className="small muted">Pay run {wdm(wr.payRun)}</span>
        </div>
        {wr.contractors.length === 0 ? (
          <div className="empty">{emptyText}</div>
        ) : (
          <div className="scroll">
            <table className="tbl figs compact sticky" style={{ minWidth: 1280 }}>
              <thead>
                <tr>
                  <th>Contractor</th>
                  <Th min={48}>Jobs</Th>
                  <Th min={60}>Units / hrs</Th>
                  <Th>Labour £</Th>
                  <Th>Reimbursed to contractor £</Th>
                  <Th>{biz} materials £</Th>
                  <Th>Charged ex VAT £</Th>
                  <Th>Contractor labour cost £</Th>
                  <Th>CIS withheld £</Th>
                  <Th>Deductions £</Th>
                  <Th>Net payable £</Th>
                  <Th>Gross margin £</Th>
                  <Th min={64}>Margin %</Th>
                  <Th min={64}>Labour margin %</Th>
                </tr>
              </thead>
              <tbody>
                {wr.contractors.map((c) => (
                  <tr key={anchor(c)}>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <a href={`#${anchor(c)}`} className="title">
                        {c.name}
                      </a>
                    </td>
                    <td className="num">{c.jobs}</td>
                    <td className="num">{num(c.units)}</td>
                    <Amt v={c.labour} />
                    <Amt v={c.reimbursed} />
                    <Amt v={c.businessMaterials} />
                    <Amt v={c.chargedEx} />
                    <Amt v={c.labourCost} />
                    <Amt v={c.cis} />
                    <Amt v={c.deductions} />
                    <Amt v={c.netPayable} strong />
                    <Amt v={c.grossMargin} />
                    <td className="num">{pct(c.marginPct)}</td>
                    <td className="num">{pct(c.labourMarginPct)}</td>
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <td className="num">{t.jobs}</td>
                  <td className="num">{num(t.units)}</td>
                  <Amt v={t.labour} />
                  <Amt v={t.reimbursed} />
                  <Amt v={t.businessMaterials} />
                  <Amt v={t.chargedEx} />
                  <Amt v={t.labourCost} />
                  <Amt v={t.cis} />
                  <Amt v={t.deductions} />
                  <Amt v={t.netPayable} />
                  <Amt v={t.grossMargin} />
                  <td className="num">{pct(t.marginPct)}</td>
                  <td className="num">{pct(labourMargin(t))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      {hasChecks ? (
        <section className="card" id="checks">
          <div className="card-head">
            <h2>Checks</h2>
            <span className="small muted">
              {canEdit ? `Ask ${biz} adds the question to Questions. ` : ""}
              {plural(wr.flagged.length, "flagged job")}
            </span>
          </div>

          {wr.flagged.length ? (
            <>
              <div className="sub-label">Flagged jobs</div>
              <div className="scroll">
                <table className="tbl figs compact" style={{ minWidth: 960 }}>
                  <thead>
                    <tr>
                      <th>Job no</th>
                      <th>Customer</th>
                      <th>Contractor</th>
                      <Th>Charged ex VAT £</Th>
                      <th>Flags</th>
                      {canEdit ? <th>Question</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {wr.flagged.map((r) => {
                      // The engine's question when it has one; otherwise the flags that need a look (not the info notes).
                      const q = byJob.get(r.jobNo);
                      const subject = q?.subject ?? needingLook(r.flags).map((f) => f.text).join(" ");
                      const question = q?.ask ?? "";
                      return (
                        <tr key={r.jobNo} className={flagRowClass(r.flags)}>
                          <td>
                            <JobNo jobNo={r.jobNo} />
                          </td>
                          <td>{r.customer || <span className="muted">Not stated</span>}</td>
                          <td style={{ whiteSpace: "nowrap" }}>{r.contractorName}</td>
                          <Amt v={r.chargedEx} />
                          <td style={{ minWidth: 260 }}>
                            <Flags flags={shown(r.flags)} />
                          </td>
                          {canEdit ? (
                            <td>
                              {q ? ask(r.jobNo, subject, question, "Costed as shown in the meantime.") : <span className="small muted">For the team to check</span>}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {wr.unsuccessful.length ? (
            <>
              <div className="sub-label">Unsuccessful in ServiceM8 with money against them</div>
              <div className="scroll">
                <table className="tbl figs compact" style={{ minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th>Job no</th>
                      <th>Customer</th>
                      <th>Job date</th>
                      <Th>Total inc VAT £</Th>
                      {canEdit ? <th>Question</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {wr.unsuccessful.map((j) => {
                      const q = byJob.get(j.jobNo);
                      return (
                        <tr key={j.uuid} className="flagged">
                          <td className="strong">{j.jobNo}</td>
                          <td>{j.customer}</td>
                          <td style={{ whiteSpace: "nowrap" }}>{wdm(j.date)}</td>
                          <Amt v={j.totalIncVat} />
                          {canEdit ? (
                            <td>
                              {ask(
                                j.jobNo,
                                q?.subject ?? `Unsuccessful in ServiceM8 with ${gbp(j.totalIncVat)} against it.`,
                                q?.ask ?? "Is it chargeable?",
                                "Left out of the figures in the meantime."
                              )}
                            </td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}

          {wr.xeroOnly.length ? (
            <>
              <div className="sub-label">In Xero in the week, not completed in ServiceM8 this week</div>
              <div className="scroll">
                <table className="tbl figs compact" style={{ minWidth: 720 }}>
                  <thead>
                    <tr>
                      <th>Invoice</th>
                      <th>Contact</th>
                      <th>Dated</th>
                      <Th>Ex VAT £</Th>
                      <Th>Inc VAT £</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {wr.xeroOnly.map((inv) => (
                      <tr key={inv.id}>
                        <td className="strong">{inv.number}</td>
                        <td>{inv.contactName}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{wdm(inv.date)}</td>
                        <Amt v={inv.subTotal} />
                        <Amt v={inv.total} />
                      </tr>
                    ))}
                    {wr.xeroOnly.length > 1 ? (
                      <tr className="total">
                        <td colSpan={3}>Total</td>
                        <Amt v={round2(wr.xeroOnly.reduce((n, i) => n + i.subTotal, 0))} />
                        <Amt v={round2(wr.xeroOnly.reduce((n, i) => n + i.total, 0))} />
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
              {canEdit && xeroAsk ? (
                <div className="row">
                  <span className="small muted">{xeroAsk.ask}</span>
                  {ask(xeroAsk.jobNo, xeroAsk.subject, xeroAsk.ask, "Left out of this week in the meantime.")}
                </div>
              ) : null}
            </>
          ) : null}

          {wr.heldOut.length ? (
            <>
              <div className="sub-label">Held out of the figures</div>
              <div className="scroll">
                <table className="tbl figs compact" style={{ minWidth: 820 }}>
                  <thead>
                    <tr>
                      <th>Job no</th>
                      <th>Customer</th>
                      <th>Contractor</th>
                      <th>Treatment</th>
                      <Th>Charged ex VAT £</Th>
                      <th>Note</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wr.heldOut.map((r) => (
                      <tr key={r.jobNo}>
                        <td>
                          <JobNo jobNo={r.jobNo} />
                        </td>
                        <td>{r.customer}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.contractorName}</td>
                        <td>
                          <span className="chip">{r.treatment === "project" ? "Held out as project" : "Left out"}</span>
                        </td>
                        <Amt v={r.chargedEx} />
                        <td className="small muted">{r.note || r.category}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {wr.contractors.map((c) => (
        <ContractorCard
          key={anchor(c)}
          c={c}
          contractor={c.contractorId ? input.contractors.find((x) => x.id === c.contractorId) : undefined}
          labourShare={s.labourShare}
          cisRate={s.cisRate}
          biz={biz}
          JobNo={JobNo}
          shownFlags={shown}
        />
      ))}
    </>
  );
}

function AskForm({
  returnTo,
  week,
  jobNo,
  subject,
  ask,
  actionTaken,
  biz,
  asked,
}: {
  returnTo: string;
  week: string;
  jobNo: string;
  subject: string;
  ask: string;
  actionTaken: string;
  biz: string;
  asked: boolean;
}) {
  if (asked) return <span className="chip green">Asked</span>;
  return (
    <form action={createQueryAction}>
      <input type="hidden" name="return_to" value={returnTo} />
      <input type="hidden" name="topic" value="contractors" />
      <input type="hidden" name="week_ending" value={week} />
      <input type="hidden" name="job_no" value={jobNo} />
      <input type="hidden" name="subject" value={subject} />
      <input type="hidden" name="ask" value={ask} />
      <input type="hidden" name="action_taken" value={actionTaken} />
      <SubmitButton className="btn" pending="Adding…">
        Ask {biz}
      </SubmitButton>
    </form>
  );
}

function ContractorCard({
  c,
  contractor,
  labourShare,
  cisRate,
  biz,
  JobNo,
  shownFlags,
}: {
  c: ContractorWeek;
  contractor: Contractor | undefined;
  labourShare: number;
  cisRate: number;
  biz: string;
  JobNo: (p: { jobNo: string }) => React.ReactNode;
  shownFlags: (flags: Flag[]) => Flag[];
}) {
  const chip = rateChip(contractor, labourShare);
  const ties =
    Math.abs(round2(c.rows.reduce((n, r) => n + r.chargedEx, 0)) - c.chargedEx) < 0.005 &&
    Math.abs(round2(c.rows.reduce((n, r) => n + r.grossMargin, 0)) - c.grossMargin) < 0.005;
  const paidBy = (r: JobRow) => (r.materialsPaidBy === "business" ? biz : "Contractor");

  return (
    <section className="card" id={anchor(c)}>
      <div className="card-head">
        <div className="chips" style={{ alignItems: "center" }}>
          <h2>{c.name}</h2>
          <span className={`chip ${chip.cls}`}>{chip.text}</span>
        </div>
        <span className="small muted">
          {plural(c.jobs, "job")} · net payable {gbp(c.netPayable)}
        </span>
      </div>
      <div className="scroll">
        <table className="tbl figs compact sticky" style={{ minWidth: 2050 }}>
          <thead>
            <tr>
              <th>Completed</th>
              <th>Job no</th>
              <th>Customer</th>
              <Th min={56}>Units / hrs</Th>
              <Th min={64}>Rate £</Th>
              <Th>Labour £</Th>
              <Th min={64}>Parking £</Th>
              <Th>Materials £</Th>
              <Th min={64}>Other £</Th>
              <Th>Charged ex VAT £</Th>
              <Th>Charged inc VAT £</Th>
              <Th>Contractor cost £</Th>
              <Th>Reimbursed £</Th>
              <Th>{biz} materials £</Th>
              <Th>Gross margin £</Th>
              <Th min={64}>Margin %</Th>
              <Th left min={100}>
                Cost basis
              </Th>
              <Th left min={90}>
                Materials paid by
              </Th>
              <Th left min={110}>
                Xero status
              </Th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            {c.rows.map((r) => (
              <tr key={r.jobNo} className={flagRowClass(r.flags)}>
                <td style={{ whiteSpace: "nowrap" }}>{wdm(r.completed)}</td>
                <td>
                  <JobNo jobNo={r.jobNo} />
                </td>
                <td style={{ minWidth: 160 }}>
                  {r.customer || <span className="muted">Not stated</span>}
                  {r.note ? <div className="sub">{r.note}</div> : null}
                </td>
                <td className="num">{num(r.units)}</td>
                <td className="num">{gbp(r.rate, { dashZero: true })}</td>
                <Amt v={r.labour} />
                <Amt v={r.parking} />
                <Amt v={r.materials} />
                <Amt v={r.other} />
                <Amt v={r.chargedEx} />
                <Amt v={r.chargedInc} />
                <Amt v={r.labourCost} />
                <Amt v={r.reimbursed} />
                <Amt v={r.businessMaterials} />
                <Amt v={r.grossMargin} />
                <td className={r.marginPct < 0 ? "num neg" : "num"}>{r.chargedEx ? pct(r.marginPct) : "–"}</td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {r.costBasisLabel}
                  {r.billRef ? <div className="sub">{r.billRef}</div> : null}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>{paidBy(r)}</td>
                <td style={{ whiteSpace: "nowrap" }}>{r.xeroStatus}</td>
                <td style={{ minWidth: 240 }}>
                  <Flags flags={shownFlags(r.flags)} />
                </td>
              </tr>
            ))}
            <tr className="total">
              <td>Total</td>
              <td />
              <td />
              <td className="num">{num(c.units)}</td>
              <td />
              <Amt v={c.labour} />
              <Amt v={c.parking} />
              <Amt v={c.materials} />
              <Amt v={c.other} />
              <Amt v={c.chargedEx} />
              <Amt v={c.chargedInc} />
              <Amt v={c.labourCost} />
              <Amt v={c.reimbursed} />
              <Amt v={c.businessMaterials} />
              <Amt v={c.grossMargin} />
              <td className="num">{pct(c.marginPct)}</td>
              <td />
              <td />
              <td className={ties ? "muted" : "late"} style={{ whiteSpace: "nowrap" }}>
                {ties ? "Ties to Job Data" : "Does not tie to Job Data"}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      <div className="pay">
        <div>
          <h3>Pay build</h3>
          <dl>
            <div>
              <dt>Contractor labour cost</dt>
              <dd>{gbp(c.labourCost)}</dd>
            </div>
            <div>
              <dt>Less CIS at {pct(cisRate, 0)}</dt>
              <dd>{gbp(-c.cis)}</dd>
            </div>
            <div>
              <dt>Reimbursed to contractor</dt>
              <dd>{gbp(c.reimbursed)}</dd>
            </div>
            <div>
              <dt>Less weekly deductions</dt>
              <dd>{gbp(-c.deductions)}</dd>
            </div>
            {c.deductionLines.map((d, i) => (
              <div key={`${d.label}-${i}`} className="tiny muted" style={{ paddingLeft: 12 }}>
                <dt>{d.label}</dt>
                <dd>{gbp(-d.amount)}</dd>
              </div>
            ))}
            <div className="sum">
              <dt>Net payable</dt>
              <dd>{gbp(c.netPayable)}</dd>
            </div>
          </dl>
        </div>
        <div>
          <h3>Profitability</h3>
          <dl>
            <div>
              <dt>Charged ex VAT</dt>
              <dd>{gbp(c.chargedEx)}</dd>
            </div>
            <div>
              <dt>Less contractor labour cost</dt>
              <dd>{gbp(-c.labourCost)}</dd>
            </div>
            <div>
              <dt>Less reimbursed to contractor</dt>
              <dd>{gbp(-c.reimbursed)}</dd>
            </div>
            <div>
              <dt>Less materials bought by {biz}</dt>
              <dd>{gbp(-c.businessMaterials)}</dd>
            </div>
            <div className="sum">
              <dt>Gross margin</dt>
              <dd className={c.grossMargin < 0 ? "late" : undefined}>{gbp(c.grossMargin)}</dd>
            </div>
            <div>
              <dt>Margin</dt>
              <dd>{pct(c.marginPct)}</dd>
            </div>
          </dl>
        </div>
        <div>
          <h3>Key figures</h3>
          <dl>
            <div>
              <dt>Jobs</dt>
              <dd>{c.jobs}</dd>
            </div>
            <div>
              <dt>Units / hrs</dt>
              <dd>{num(c.units)}</dd>
            </div>
            <div>
              <dt>Charged per unit</dt>
              <dd>{gbp(c.chargedPerUnit)}</dd>
            </div>
            <div>
              <dt>Labour cost per unit</dt>
              <dd>{gbp(c.costPerUnit)}</dd>
            </div>
            <div>
              <dt>Labour margin</dt>
              <dd>{pct(c.labourMarginPct)}</dd>
            </div>
            <div>
              <dt>Share of week revenue</dt>
              <dd>{pct(c.shareOfRevenue)}</dd>
            </div>
            <div>
              <dt>Hourly rate on the card</dt>
              <dd>{gbp(c.cardRate, { dashZero: true })}</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}

/* Month view */

const STATUS: Record<MonthReport["weeks"][number]["status"], { text: string; cls: string }> = {
  loaded: { text: "Loaded", cls: "green" },
  to_come: { text: "To come", cls: "" },
  no_jobs: { text: "No jobs", cls: "amber" },
};

function MoneyHeads({ biz }: { biz: string }) {
  return (
    <>
      <Th min={48}>Jobs</Th>
      <Th min={60}>Units / hrs</Th>
      <Th>Labour £</Th>
      <Th min={70}>Parking £</Th>
      <Th>Materials £</Th>
      <Th min={64}>Other £</Th>
      <Th>Charged ex VAT £</Th>
      <Th>Charged inc VAT £</Th>
      <Th>Contractor labour cost £</Th>
      <Th>CIS withheld £</Th>
      <Th>Reimbursed to contractor £</Th>
      <Th>Deductions £</Th>
      <Th>Net payable £</Th>
      <Th>{biz} materials £</Th>
      <Th>Gross margin £</Th>
      <Th min={64}>Margin %</Th>
    </>
  );
}

function MoneyCells({ m, empty = false }: { m: Money; empty?: boolean }) {
  return (
    <>
      <td className="num">{empty ? "–" : m.jobs}</td>
      <td className="num">{empty ? "–" : num(m.units)}</td>
      <Amt v={m.labour} />
      <Amt v={m.parking} />
      <Amt v={m.materials} />
      <Amt v={m.other} />
      <Amt v={m.chargedEx} />
      <Amt v={m.chargedInc} />
      <Amt v={m.labourCost} />
      <Amt v={m.cis} />
      <Amt v={m.reimbursed} />
      <Amt v={m.deductions} />
      <Amt v={m.netPayable} strong />
      <Amt v={m.businessMaterials} />
      <Amt v={m.grossMargin} />
      <td className="num">{m.chargedEx ? pct(m.marginPct) : "–"}</td>
    </>
  );
}

function Matrix({ title, rows, weeks }: { title: string; rows: MonthReport["charged"]; weeks: string[] }) {
  const colTotals = weeks.map((_, i) => round2(rows.reduce((n, r) => n + (r.byWeek[i] ?? 0), 0)));
  const grand = round2(rows.reduce((n, r) => n + r.total, 0));
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        <span className="small muted">Ex VAT, by week ending</span>
      </div>
      <div className="scroll">
        <table className="tbl figs compact sticky" style={{ minWidth: 260 + weeks.length * 110 }}>
          <thead>
            <tr>
              <th>Contractor</th>
              {weeks.map((w) => (
                <th key={w} className="num">
                  {dm(w)}
                </th>
              ))}
              <th className="num">Total £</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td style={{ whiteSpace: "nowrap" }}>{r.name}</td>
                {r.byWeek.map((v, i) => (
                  <Amt key={weeks[i] ?? i} v={v} />
                ))}
                <Amt v={r.total} strong />
              </tr>
            ))}
            <tr className="total">
              <td>Total</td>
              {colTotals.map((v, i) => (
                <Amt key={weeks[i]} v={v} />
              ))}
              <Amt v={grand} />
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Contractor names short enough to sit under a column: full names when they all fit, else first name and initial for all. */
function chartLabels(names: string[]): string[] {
  const room = Math.floor(664 / Math.max(1, names.length) / 6.5);
  if (names.every((n) => n.length <= room)) return names;
  return names.map((name) => {
    const [a, b] = name.split(/\s+/);
    const initial = b ? `${a} ${b[0]}` : a;
    return initial.length <= room ? initial : a.slice(0, Math.max(3, room));
  });
}

function MonthView({
  mr,
  biz,
  cisRate,
  weekLink,
  emptyText,
}: {
  mr: MonthReport;
  biz: string;
  cisRate: number;
  weekLink: (w: string) => string;
  emptyText: React.ReactNode;
}) {
  const t = mr.total;
  const weeks = mr.weeks.map((w) => w.weekEnding);
  const labels = chartLabels(mr.contractors.map((c) => c.name));

  return (
    <>
      <div className="kpis" style={KPI_ROW}>
        <Kpi label="Charged ex VAT" value={gbp(t.chargedEx)} sub={`${gbp(t.chargedInc)} inc VAT`} />
        <Kpi label="Gross margin" value={gbp(t.grossMargin)} sub={`${pct(t.marginPct)} of charged`} late={t.grossMargin < 0} />
        <Kpi label="Net payable" value={gbp(t.netPayable)} sub={`After CIS ${gbp(t.cis)} and deductions ${gbp(t.deductions)}`} />
        <Kpi label="CIS withheld" value={gbp(t.cis)} sub={`${pct(cisRate, 0)} of labour cost`} />
        <Kpi label="Jobs" value={String(t.jobs)} sub={`${num(t.units)} units / hrs`} />
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Month to date by contractor</h2>
        </div>
        {mr.contractors.length === 0 ? (
          <div className="empty">{emptyText}</div>
        ) : (
          <div className="scroll">
            <table className="tbl figs compact sticky" style={{ minWidth: 1700 }}>
              <thead>
                <tr>
                  <th>Contractor</th>
                  <MoneyHeads biz={biz} />
                </tr>
              </thead>
              <tbody>
                {mr.contractors.map((c) => (
                  <tr key={c.contractorId ?? c.name}>
                    <td style={{ whiteSpace: "nowrap" }}>{c.name}</td>
                    <MoneyCells m={c} />
                  </tr>
                ))}
                <tr className="total">
                  <td>Total</td>
                  <MoneyCells m={t} />
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Week by week</h2>
          <span className="small muted">Open a week for the contractor detail and pay build</span>
        </div>
        <div className="scroll">
          <table className="tbl figs compact sticky" style={{ minWidth: 1900 }}>
            <thead>
              <tr>
                <th>Week ending</th>
                <MoneyHeads biz={biz} />
                <Th left min={90}>
                  Pay run
                </Th>
                <Th left min={80}>
                  Status
                </Th>
              </tr>
            </thead>
            <tbody>
              {mr.weeks.map((w) => (
                <tr key={w.weekEnding}>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <Link href={weekLink(w.weekEnding)} className="title">
                      {wdm(w.weekEnding)}
                    </Link>
                  </td>
                  <MoneyCells m={w} empty={w.status === "to_come"} />
                  <td style={{ whiteSpace: "nowrap" }}>{wdm(w.payRun)}</td>
                  <td>
                    <span className={`chip ${STATUS[w.status].cls}`}>{STATUS[w.status].text}</span>
                  </td>
                </tr>
              ))}
              <tr className="total">
                <td>Total</td>
                <MoneyCells m={t} />
                <td />
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {mr.contractors.length ? (
        <>
          <Matrix title="Charged ex VAT by contractor and week" rows={mr.charged} weeks={weeks} />
          <Matrix title="Gross margin by contractor and week" rows={mr.margin} weeks={weeks} />

          <section className="card">
            <div className="card-head">
              <h2>Gross margin by contractor</h2>
              <span className="small muted">Month to date, ex VAT</span>
            </div>
            <MoneyChart
              title={`Gross margin by contractor, ${monthName(mr.month)}`}
              columns={mr.contractors.map((c, i) => ({
                key: c.contractorId ?? c.name,
                label: labels[i],
                value: c.grossMargin,
                detail: [
                  ["Charged", gbp(c.chargedEx)],
                  ["Margin", pct(c.marginPct)],
                ],
              }))}
            />
          </section>
        </>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2>Controls</h2>
        </div>
        {mr.controls.map((c) => (
          <div key={c.label} className="row">
            <span>{c.label}</span>
            {c.ok ? (
              <span className="chip green">Nil</span>
            ) : (
              <span className="chip amber">{c.label.startsWith("Jobs") ? c.value : gbp(c.value)}</span>
            )}
          </div>
        ))}
        <p className="small muted" style={{ padding: "12px 20px 16px", borderTop: "1px solid var(--line-soft)" }}>
          All should read nil. Anything else means a job sits outside the weeks or carries a contractor name that is not set up.
        </p>
      </section>
    </>
  );
}
