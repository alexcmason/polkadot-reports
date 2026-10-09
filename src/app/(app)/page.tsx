import Link from "next/link";
import {
  chasesFor,
  contractorInputsFor,
  freshnessFor,
  invoicesFor,
  jobRowsFor,
  openQueriesFor,
  projectsFor,
  reportingAccess,
  serviceM8For,
  settingsFor,
  today,
} from "@/lib/reporting/context";
import { defaultWeek, weekReport, type WeekReport } from "@/lib/reporting/contractor";
import { buildDebtors, DEBTOR_BUCKETS } from "@/lib/reporting/debtors";
import { buildProjects, OUT_OF_TOTALS } from "@/lib/reporting/projects";
import { lastCompleteWeek, plusDays } from "@/lib/reporting/dates";
import { change, dm, gbp, gbp0, pct, tone, wdm } from "@/lib/reporting/format";
import { listQueries } from "@/lib/reporting/store";

export const metadata = { title: "Reporting overview" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type Attention = { key: string; text: string; href: string | null; tone: "warn" | "error" };

export default async function OverviewPage() {
  const { business: biz, staff } = await reportingAccess();
  const [fresh, settings] = await Promise.all([freshnessFor(), settingsFor()]);

  /* Nothing connected yet: how to get started. */
  if (!fresh.connected.servicem8 && !fresh.connected.xero) {
    if (!staff) {
      return (
        <section className="card">
          <div className="card-head">
            <h2>Getting started</h2>
          </div>
          <div className="empty">Your reports are being set up. They appear here once ServiceM8 and Xero are connected.</div>
        </section>
      );
    }
    const { contractors } = await contractorInputsFor();
    const steps = [
      { done: fresh.connected.servicem8, label: "Connect ServiceM8", hint: "Jobs, job lines, staff and payments come from ServiceM8.", href: `/settings#connections` },
      { done: fresh.connected.xero, label: "Connect Xero", hint: "Sales invoices, bills and the accounts come from Xero.", href: `/settings#connections` },
      {
        done: contractors.length > 0,
        label: "Set up contractors and rates",
        hint: "Who is paid per job, their card rate or labour share, and any weekly deductions.",
        href: `/settings#contractors`,
      },
      { done: !!fresh.lastSyncAt, label: "Refresh the data", hint: "Reads everything in. The first refresh can take a few minutes.", href: `/settings#connections` },
    ];
    return (
      <section className="card">
        <div className="card-head">
          <h2>Getting started</h2>
          <span className="small muted">
            {steps.filter((s) => s.done).length} of {steps.length} done
          </span>
        </div>
        <ul className="checklist">
          {steps.map((s) => (
            <li key={s.label}>
              <span className={`tick ${s.done ? "done" : ""}`} role="img" aria-label={s.done ? "Done" : "To do"}>
                {s.done ? "✓" : ""}
              </span>
              <div>
                <Link href={s.href} className="strong">
                  {s.label}
                </Link>
                <div className="small muted">{s.hint}</div>
              </div>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  /* Figures */
  const todayIso = today();
  const lastWeek = lastCompleteWeek(todayIso, settings.weekEndsOn);
  const [{ input, rows }, sm, invoices, chases, proj, openCount, queries] = await Promise.all([
    jobRowsFor(),
    serviceM8For(),
    invoicesFor(),
    chasesFor(),
    projectsFor(),
    openQueriesFor(),
    staff ? listQueries() : Promise.resolve([]),
  ]);

  // The headline week is the last complete week, or the latest earlier week with jobs while the last one is still empty.
  const shownWeek = defaultWeek(rows, lastWeek);
  const latest = shownWeek === lastWeek;
  // The last six complete weeks for the table, newest first. Each week is built once, however many places use it.
  const recentEndings = Array.from({ length: 6 }, (_, i) => plusDays(lastWeek, -7 * i));
  const built = new Map<string, WeekReport>();
  const report = (w: string): WeekReport => {
    const done = built.get(w);
    if (done) return done;
    const made = weekReport(rows, input, w);
    built.set(w, made);
    return made;
  };
  const recent = recentEndings.map(report);
  const week = report(shownWeek);
  const before = report(plusDays(shownWeek, -7));

  const debtors = buildDebtors({
    jobs: sm.jobs,
    payments: sm.payments,
    invoices: invoices.filter((i) => i.type === "ACCREC"),
    chases,
    chaseAfterHours: settings.chaseAfterHours,
    now: new Date().toISOString(),
    today: todayIso,
  });
  const over90 = debtors.buckets.find((b) => b.label === DEBTOR_BUCKETS[3]) ?? { label: DEBTOR_BUCKETS[3], count: 0, amount: 0 };

  const projects = buildProjects({
    projects: proj.projects,
    costs: proj.costs,
    jobs: sm.jobs,
    lines: sm.lines,
    payments: sm.payments,
    invoices,
    settings,
    today: todayIso,
  });
  const liveProjects = projects.rows.filter((r) => !OUT_OF_TOTALS.includes(r.record.status)).length;

  // Line names read as materials only by guess, over the last eight weeks.
  const since = plusDays(lastWeek, -7 * 7);
  const guessed = new Set(rows.filter((r) => r.weekEnding >= since && r.weekEnding <= lastWeek).flatMap((r) => r.unclassified));
  const answered = queries.filter((q) => q.status === "answered").length;

  // Against the week before the headline week.
  const charged = change(week.total.chargedEx, before.total.chargedEx);

  /* Needs attention */
  const items: Attention[] = [];
  if (week.flagged.length) {
    items.push({
      key: "flagged",
      text: `${plural(week.flagged.length, "job")} flagged in the week ending ${dm(shownWeek)}`,
      href: `/contractors?week=${shownWeek}#checks`,
      tone: week.flagged.some((r) => r.flags.some((f) => f.severity === "error")) ? "error" : "warn",
    });
  }
  if (openCount) {
    items.push({
      key: "open",
      text: staff ? `${plural(openCount, "open question")} for ${biz}` : `${plural(openCount, "question")} waiting for your answer`,
      href: `/queries`,
      tone: "warn",
    });
  }
  if (staff && answered) {
    items.push({ key: "answered", text: `${plural(answered, "answer")} from ${biz} to review`, href: `/queries#answered`, tone: "warn" });
  }
  if (over90.count) {
    items.push({
      key: "debtors",
      text: `${plural(over90.count, "invoice")} unpaid for over 90 days, ${gbp(over90.amount)}`,
      href: `/debtors?bucket=${encodeURIComponent(DEBTOR_BUCKETS[3])}`,
      tone: "error",
    });
  }
  if (staff && projects.unallocatedBills.length) {
    items.push({
      key: "bills",
      text: `${plural(projects.unallocatedBills.length, "project bill")} not on a project yet`,
      href: `/projects`,
      tone: "warn",
    });
  }
  if (staff && guessed.size) {
    items.push({
      key: "lines",
      text: `${plural(guessed.size, "line name")} read as materials by guess`,
      href: `/settings#lines`,
      tone: "warn",
    });
  }
  // Connection errors are technical, so viewers get a plain note instead.
  if (staff) fresh.problems.forEach((p, i) => items.push({ key: `problem-${i}`, text: p, href: `/settings#connections`, tone: "error" }));
  else if (fresh.problems.length) {
    items.push({ key: "problem", text: "Some figures may be out of date until a system is reconnected.", href: null, tone: "warn" });
  }

  // No ServiceM8, or connected but no completed job has come through yet (before the first refresh, say).
  const noJobs = !fresh.connected.servicem8 || rows.length === 0;

  return (
    <>
      {/* Five figures fit on one row on a laptop, as on Debtors. */}
      <div className="kpis" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(176px, 100%), 1fr))" }}>
        <div className="kpi static">
          <span className="label">{latest ? "Last week" : "Latest week"}</span>
          <span className="num md">{gbp0(week.total.chargedEx)}</span>
          <span className="small">
            Gross margin {gbp(week.total.grossMargin)} · {pct(week.total.marginPct)}
          </span>
          <span className="tiny muted">Charged ex VAT, week ending {dm(shownWeek)}</span>
          {charged !== null ? (
            <span className={`delta ${charged >= 0 ? "up" : "down"}`}>
              {charged >= 0 ? "Up" : "Down"} {pct(Math.abs(charged), 0)} on {dm(before.weekEnding)}
            </span>
          ) : null}
        </div>
        <div className="kpi static">
          <span className="label">Net pay to contractors</span>
          <span className="num md">{gbp0(week.total.netPayable)}</span>
          <span className="small muted">Pay run {wdm(week.payRun)}</span>
        </div>
        <div className="kpi static">
          <span className="label">Debtors to chase</span>
          <span className="num md">{gbp0(debtors.toChase.amount)}</span>
          <span className="small muted">
            {plural(debtors.toChase.count, "invoice")}, inc VAT
            {over90.amount > 0.005 ? ` · ${gbp(over90.amount)} over 90 days` : ""}
          </span>
        </div>
        <div className="kpi static">
          <span className="label">Projects live</span>
          <span className="num md">{gbp0(projects.totals.grossProfit)}</span>
          <span className="small muted">
            {liveProjects ? `Gross profit on ${plural(liveProjects, "project")} · ${pct(projects.totals.marginPct)} margin` : "No projects yet"}
          </span>
        </div>
        <Link href={`/queries`} className="kpi">
          <span className="label">Questions open</span>
          <span className="num md">{openCount}</span>
          <span className="small muted">{openCount ? (staff ? `Waiting for ${biz}` : "Waiting for your answer") : "Nothing waiting"}</span>
        </Link>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Needs attention</h2>
          {items.length ? <span className="small muted">{plural(items.length, "item")}</span> : null}
        </div>
        {items.length === 0 ? (
          <div className="empty">Nothing needs attention. Every check is clear.</div>
        ) : (
          items.map((it) =>
            it.href ? (
              <Link key={it.key} href={it.href} className="row">
                <span className={`flag ${it.tone}`} style={{ fontSize: 14 }}>
                  {it.text}
                </span>
                <span className="small strong" style={{ color: "var(--brand)" }} aria-hidden="true">
                  Open ›
                </span>
              </Link>
            ) : (
              <div key={it.key} className="row">
                <span className={`flag ${it.tone}`} style={{ fontSize: 14 }}>
                  {it.text}
                </span>
              </div>
            )
          )
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Recent weeks</h2>
          <span className="small muted">Contractor jobs, ex VAT. Weeks run {weekRunLabel(settings.weekEndsOn)}.</span>
        </div>
        {noJobs ? (
          <div className="empty">
            {staff && !fresh.connected.servicem8 ? (
              <>
                No jobs yet. <Link href={`/settings#connections`}>Connect ServiceM8 in Settings</Link>.
              </>
            ) : staff ? (
              <>
                No completed jobs from ServiceM8 yet. Refresh the data, or check the date reports start from in{" "}
                <Link href={`/settings#settings`}>Settings</Link>.
              </>
            ) : (
              "Nothing to show yet."
            )}
          </div>
        ) : (
          <div className="scroll">
            <table className="tbl figs" style={{ minWidth: 820 }}>
              <thead>
                <tr>
                  <th>Week ending</th>
                  <th className="num">Jobs</th>
                  <th className="num">Charged ex VAT</th>
                  <th className="num">Gross margin</th>
                  <th className="num">Margin %</th>
                  <th className="num">Net payable</th>
                  <th>Pay run</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((w) => (
                  <tr key={w.weekEnding}>
                    <td>
                      <Link href={`/contractors?week=${w.weekEnding}`} className="title">
                        {wdm(w.weekEnding)}
                      </Link>
                      {w.flagged.length ? <span className="chip amber" style={{ marginLeft: 8 }}>{w.flagged.length} flagged</span> : null}
                    </td>
                    <td className="num">{w.total.jobs || <span className="muted">No jobs</span>}</td>
                    <td className={tone(w.total.chargedEx)}>{gbp(w.total.chargedEx, { dashZero: true })}</td>
                    <td className={tone(w.total.grossMargin)}>{gbp(w.total.grossMargin, { dashZero: true })}</td>
                    <td className="num">{w.total.jobs ? pct(w.total.marginPct) : "–"}</td>
                    <td className={tone(w.total.netPayable)}>{gbp(w.total.netPayable, { dashZero: true })}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{wdm(w.payRun)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "Friday to Thursday" for weeks ending on Thursday (ISO 4). */
function weekRunLabel(weekEndsOn: number): string {
  const end = Math.min(7, Math.max(1, weekEndsOn));
  return `${DAYS[end % 7]} to ${DAYS[end - 1]}`;
}
