import Link from "next/link";
import { freshnessFor, jobRowsFor, reportingAccess, reportsFor, serviceM8For, settingsFor, today, xeroFor } from "@/lib/reporting/context";
import { monthReport, type MonthReport } from "@/lib/reporting/contractor";
import { addMonths, monthEnd, monthName, monthOf, monthShort, round2 } from "@/lib/reporting/dates";
import { change, dmy, gbp, gbp0, pct, tone } from "@/lib/reporting/format";
import { managementReport, UNASSIGNED, type BalanceSummary, type ManagementReport, type PnlRow } from "@/lib/reporting/management";
import { AutoSelect } from "@/components/AutoSelect";
import { first, type Search } from "@/components/ui";
import type { Column } from "@/components/reporting/ColumnChart";
import { MoneyChart } from "@/components/reporting/MoneyChart";
import { Stepper } from "@/components/reporting/Stepper";

export const metadata = { title: "Management accounts" };

const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
/** A refresh reads Xero's reports for this month and the 12 before it. */
const MONTHS_READ = 13;
/** Text for screen readers only. */
const HIDDEN: React.CSSProperties = { display: "inline-block", width: 1, height: 1, margin: -1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "September" */
const monthWord = (month: string) => MONTHS[Number(month.slice(5, 7)) - 1];

/* Small pieces */

function Kpi({ label, value, sub, delta, late = false }: { label: string; value: string; sub?: string; delta?: { text: string; up: boolean } | null; late?: boolean }) {
  return (
    <div className="kpi static">
      <span className="label">{label}</span>
      <span className={`num md${late ? " late" : ""}`}>{value}</span>
      {sub ? <span className="small muted">{sub}</span> : null}
      {delta ? <span className={`delta ${delta.up ? "up" : "down"}`}>{delta.text}</span> : null}
    </div>
  );
}

/** "Up 12.0% on August", or null with nothing to compare. */
function delta(ratio: number | null, priorMonth: string): { text: string; up: boolean } | null {
  if (ratio === null) return null;
  if (Math.abs(ratio) < 0.0005) return { text: `Level with ${monthWord(priorMonth)}`, up: true };
  return { text: `${ratio > 0 ? "Up" : "Down"} ${pct(Math.abs(ratio))} on ${monthWord(priorMonth)}`, up: ratio > 0 };
}

function Amt({ v, strong = false }: { v: number | null | undefined; strong?: boolean }) {
  return <td className={`${tone(v)}${strong ? " strong" : ""}`}>{gbp(v, { dashZero: true })}</td>;
}

function Card({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {aside ? <span className="small muted">{aside}</span> : null}
      </div>
      {children}
    </section>
  );
}

const Intro = ({ children }: { children: React.ReactNode }) => (
  <p className="small muted" style={{ padding: "0 20px 14px", maxWidth: 760 }}>
    {children}
  </p>
);

/** A missing report key in words: "the balance sheet at 31 Aug 2026". */
function missingWords(key: string, tracking: string): string {
  const [kind, month] = key.split(":");
  if (kind === "bs") return `the balance sheet at ${dmy(monthEnd(month))}`;
  if (kind === "pnl-cash") return `the cash basis profit and loss for ${monthName(month)}`;
  if (kind === "pnl-tracking") return `the profit and loss by ${tracking || "sales type"} for ${monthName(month)}`;
  return `the profit and loss for ${monthName(month)}`;
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/* Page */

export default async function ManagementPage({ searchParams }: { searchParams: Search }) {
  const { business: biz, staff } = await reportingAccess();
  const sp = await searchParams;
  const page = `/management`;

  const [settings, fresh] = await Promise.all([settingsFor(), freshnessFor()]);

  if (!fresh.connected.xero) {
    return (
      <Card title="Management accounts">
        <div className="empty">
          {staff ? (
            <>
              The management accounts come from Xero. <Link href={`/settings#connections`}>Connect Xero in Settings</Link>.
            </>
          ) : (
            "Nothing to show yet."
          )}
        </div>
      </Card>
    );
  }

  const [reports, xero, sm] = await Promise.all([reportsFor(), xeroFor(), serviceM8For()]);
  const todayIso = today();
  const current = monthOf(todayIso);
  const available = [...reports.keys()]
    .filter((k) => /^pnl:\d{4}-\d{2}$/.test(k) && reports.get(k) != null)
    .map((k) => k.slice(4))
    .sort()
    .reverse();
  const raw = first(sp.month);
  const month = isMonth(raw) ? raw : (available.find((m) => m !== current) ?? available[0] ?? null);

  if (!month) {
    return (
      <Card title="Management accounts">
        <div className="empty">
          {staff
            ? "No profit and loss reports have been read from Xero yet. They come in with the next refresh, using the button at the top of the page."
            : "Nothing to show yet."}
        </div>
      </Card>
    );
  }

  // Figures
  const fromXero = xero.organisation?.financialYearEndMonth ?? null;
  const fyEndMonth = fromXero ?? 3;
  const customerTypes = new Map<string, boolean>();
  for (const j of sm.jobs) if (j.customerIsIndividual !== null && j.jobNo) customerTypes.set(j.jobNo, j.customerIsIndividual);
  const r = managementReport({ month, reports, invoices: xero.invoices, trackingName: settings.salesTypeTracking, fyEndMonth, customerTypes });
  const jobs = fresh.connected.servicem8 ? await jobRowsFor() : null;
  const contractors = jobs ? monthReport(jobs.rows, jobs.input, month, todayIso) : null;

  // Navigation
  const priorMonth = addMonths(month, -1);
  const link = (m: string) => `${page}?month=${m}`;
  const oldest = available[available.length - 1];
  const prev = oldest && month <= oldest ? null : link(priorMonth);
  const next = addMonths(month, 1) <= current ? link(addMonths(month, 1)) : null;
  const options = [...new Set([month, ...available])].sort().reverse();
  const fyWords = `${MONTHS[fyEndMonth % 12]} to ${MONTHS[fyEndMonth - 1]}`;
  const ytdGaps = r.missing.filter((k) => k.startsWith("pnl:") && k.slice(4) >= r.ytdFrom && k.slice(4) <= month).map((k) => monthWord(k.slice(4)));
  const pnlMissing = r.missing.includes(`pnl:${month}`);

  const missing = r.missing.map((k) => missingWords(k, settings.salesTypeTracking));
  const missingText = missing.length > 4 ? `${missing.slice(0, 3).join(", ")} and ${missing.length - 3} more reports` : listWords(missing);
  // Reports for months before the refresh window never arrive, so do not promise them.
  const oldestRead = addMonths(current, -(MONTHS_READ - 1));
  const beyondWindow = r.missing.some((key) => (key.split(":")[1] ?? "") < oldestRead);
  const missingHint = !staff
    ? "The figures that depend on them are left blank."
    : beyondWindow
      ? `A refresh reads the last ${MONTHS_READ} months from Xero, so reports before ${monthName(oldestRead)} stay blank.`
      : "They come in with the next refresh.";

  const k = r.kpis;
  const s = r.summary;

  return (
    <>
      <div className="toolbar">
        <Stepper prev={prev} next={next} label={monthName(month)} unit="month" />
        {options.length > 1 ? (
          <form method="get" action={page}>
            <label className="small muted" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
              Go to
              <AutoSelect name="month" value={month} label="Month" options={options.map((m) => ({ value: m, label: monthName(m) }))} />
            </label>
            <noscript>
              <button type="submit" className="btn">
                Show
              </button>
            </noscript>
          </form>
        ) : null}
        <a className="btn" href={`/api/export?report=management&month=${month}`} download style={{ marginLeft: "auto" }}>
          Download Excel
        </a>
      </div>
      <p className="small muted" style={{ marginTop: -8 }}>
        From Xero{month === current ? ", month to date" : ""}. All figures exclude VAT unless stated.
      </p>

      {missing.length ? (
        <div className="banner note" role="status">
          Not read from Xero: {missingText}. {missingHint}
        </div>
      ) : null}

      {/* With the month's P&L missing the engine gives zeros: show blanks, and no change on last month. */}
      <div className="kpis">
        <Kpi
          label="Income"
          value={pnlMissing ? "–" : gbp0(k.income)}
          sub={`${monthName(month)}, ex VAT`}
          delta={r.prior && !pnlMissing ? delta(change(s.income, r.prior.income), priorMonth) : null}
        />
        <Kpi
          label="Gross profit"
          value={pnlMissing ? "–" : gbp0(k.grossProfit)}
          sub={pnlMissing ? undefined : `GP ${pct(k.gpPct)} of income`}
          delta={r.prior && !pnlMissing ? delta(change(s.grossProfit, r.prior.grossProfit), priorMonth) : null}
          late={k.grossProfit < 0}
        />
        <Kpi label="Net profit" value={pnlMissing ? "–" : gbp0(k.netProfit)} sub={pnlMissing ? undefined : `${pct(s.npPct)} of income`} late={k.netProfit < 0} />
      </div>
      {r.balance ? (
        <div className="kpis">
          {k.cashAtBank !== null ? <Kpi label="Cash at bank" value={gbp0(k.cashAtBank)} sub={`At ${dmy(monthEnd(month))}`} late={k.cashAtBank < 0} /> : null}
          {k.debtors !== null ? <Kpi label="Debtors" value={gbp0(k.debtors)} sub="Owed by customers" /> : null}
          {k.creditors !== null ? <Kpi label="Creditors" value={gbp0(k.creditors)} sub="Owed to suppliers" /> : null}
          {k.vatOwed !== null ? (
            <Kpi label={k.vatOwed < 0 ? "VAT refund due" : "VAT owed"} value={gbp0(Math.abs(k.vatOwed))} sub="Net, at the month end" />
          ) : null}
        </div>
      ) : null}

      <Card title="Summary" aside={monthName(month)}>
        <ul className="commentary">
          {r.commentary.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Card>

      {r.trend.length ? <Trend r={r} month={month} /> : null}

      <Card
        title="Profit and loss"
        aside={
          <>
            {monthName(month)}. Year to date {monthWord(r.ytdFrom)} to {monthName(month)}, in a financial year running {fyWords}
            {fromXero === null ? " (assumed, as Xero has not said)" : " (from Xero)"}.
          </>
        }
      >
        {ytdGaps.length ? <Intro>Year to date leaves out {listWords(ytdGaps)}, as Xero&apos;s report for {ytdGaps.length === 1 ? "that month" : "those months"} has not been read.</Intro> : null}
        {pnlMissing ? (
          <div className="empty">The profit and loss for {monthName(month)} has not been read from Xero yet.</div>
        ) : (
          <div className="scroll">
            <table className="tbl figs sticky" style={{ minWidth: 780 }}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="num">{monthShort(month)}</th>
                  <th className="num">{monthShort(priorMonth)}</th>
                  <th className="num">Change</th>
                  <th className="num">Year to date</th>
                  <th className="num">% of income</th>
                </tr>
              </thead>
              <tbody>
                {r.pnl.map((row, i) => (
                  <PnlLine key={`${row.kind}-${row.section}-${row.label}-${i}`} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Segments r={r} tracking={settings.salesTypeTracking} staff={staff} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(440px, 100%), 1fr))", gap: 24, alignItems: "start" }}>
        <Cash r={r} />
        <Balance r={r} />
      </div>

      <InvoicesRaised r={r} />

      <ContractorCard
        m={contractors}
        month={month}
        biz={biz}
        staff={staff}
        connected={fresh.connected.servicem8}
      />
    </>
  );
}

/* Sections */

function PnlLine({ row }: { row: PnlRow }) {
  if (row.kind === "section") {
    return (
      <tr className="group">
        <td colSpan={6}>{row.label}</td>
      </tr>
    );
  }
  const strong = row.kind !== "account";
  return (
    <tr className={row.kind === "total" ? "total" : undefined}>
      <td className={strong ? "strong" : undefined} style={row.kind === "account" ? { paddingLeft: 32 } : undefined}>
        {row.label}
      </td>
      <Amt v={row.month} strong={strong} />
      <Amt v={row.prior} strong={strong} />
      <Amt v={row.change} strong={strong} />
      <Amt v={row.ytd} strong={strong} />
      <td className={`num${row.kind === "account" ? " muted" : ""}`}>{pct(row.pctOfIncome)}</td>
    </tr>
  );
}

function Trend({ r, month }: { r: ManagementReport; month: string }) {
  const income: Column[] = r.trend.map((t) => ({
    key: t.month,
    label: monthShort(t.month),
    value: t.income,
    detail: [
      ["Gross profit", gbp0(t.grossProfit)],
      ["GP %", pct(t.gpPct)],
      ["Net profit", gbp0(t.netProfit)],
    ],
  }));
  const net: Column[] = r.trend.map((t) => ({
    key: t.month,
    label: monthShort(t.month),
    value: t.netProfit,
    detail: [
      ["Income", gbp0(t.income)],
      ["Net margin", pct(t.income > 0 ? t.netProfit / t.income : null)],
    ],
  }));
  const span = r.trend.length > 1 ? `${monthShort(r.trend[0].month)} to ${monthShort(r.trend[r.trend.length - 1].month)}` : monthShort(r.trend[0].month);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(600px, 100%), 1fr))", gap: 24 }}>
      <Card title="Income by month" aside={`${span}, ex VAT. ${monthShort(month)} highlighted.`}>
        <MoneyChart title={`Income by month, ${span}`} columns={income} highlight={month} whole />
      </Card>
      <Card title="Net profit by month" aside={`${span}. Losses show below the line.`}>
        <MoneyChart title={`Net profit by month, ${span}`} columns={net} highlight={month} whole />
      </Card>
    </div>
  );
}

function Segments({ r, tracking, staff }: { r: ManagementReport; tracking: string; staff: boolean }) {
  const list = r.segments ?? [];
  const sum = (f: (g: (typeof list)[number]) => number) => round2(list.reduce((n, g) => n + f(g), 0));
  const income = sum((g) => g.income);
  const cos = sum((g) => g.costOfSales);
  const gp = sum((g) => g.grossProfit);
  return (
    <Card title="By sales type" aside={monthName(r.month)}>
      {tracking ? (
        <Intro>
          From the Xero tracking category {tracking}. Costs not tagged with a sales type show under {UNASSIGNED}.
        </Intro>
      ) : null}
      {!tracking ? (
        <div className="empty">
          {staff ? (
            <>
              Choose the Xero tracking category that splits sales in <Link href={`/settings#settings`}>Settings</Link>.
            </>
          ) : (
            "Nothing to show yet."
          )}
        </div>
      ) : !r.segments ? (
        <div className="empty">
          The profit and loss by {tracking} for {monthName(r.month)} has not been read from Xero yet.
          {staff ? " It comes in with the next refresh. If it stays empty, check the tracking category name in Settings." : ""}
        </div>
      ) : !list.length ? (
        <div className="empty">Nothing was tagged with a {tracking} in {monthName(r.month)}.</div>
      ) : (
        <div className="scroll">
          <table className="tbl figs" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Sales type</th>
                <th className="num">Income</th>
                <th className="num">Cost of sales</th>
                <th className="num">Gross profit</th>
                <th className="num">GP %</th>
                <th className="num">Share of income</th>
              </tr>
            </thead>
            <tbody>
              {list.map((g) => (
                <tr key={g.name}>
                  <td className={g.name === UNASSIGNED ? "muted" : "strong"}>{g.name}</td>
                  <Amt v={g.income} />
                  <Amt v={g.costOfSales} />
                  <Amt v={g.grossProfit} />
                  <td className={g.gpPct !== null && g.gpPct < 0 ? "num neg" : "num"}>{pct(g.gpPct)}</td>
                  <td className="num">{pct(g.shareOfIncome)}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total</td>
                <Amt v={income} />
                <Amt v={cos} />
                <Amt v={gp} />
                <td className="num">{pct(income > 0 ? gp / income : null)}</td>
                <td className="num">{income > 0 ? pct(1) : "–"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Cash({ r }: { r: ManagementReport }) {
  const c = r.cash;
  const moneyIn = c?.lines.filter((l) => l.section === "income" || l.section === "other_income") ?? [];
  const moneyOut = c?.lines.filter((l) => l.section === "cost_of_sales" || l.section === "expenses") ?? [];
  return (
    <Card title="Cash in and out" aside={monthName(r.month)}>
      <Intro>Xero&apos;s profit and loss on the cash basis: only what was received and paid in the month. Ex VAT.</Intro>
      {!c ? (
        <div className="empty">The cash basis profit and loss for {monthName(r.month)} has not been read from Xero yet.</div>
      ) : (
        <div className="scroll">
          <table className="tbl figs compact">
            <thead>
              <tr>
                <th>Account</th>
                <th className="num">{monthShort(r.month)}</th>
              </tr>
            </thead>
            <tbody>
              <tr className="group">
                <td colSpan={2}>Money in</td>
              </tr>
              {moneyIn.map((l, i) => (
                <tr key={`in-${l.account}-${i}`}>
                  <td style={{ paddingLeft: 28 }}>{l.account}</td>
                  <Amt v={l.amount} />
                </tr>
              ))}
              <tr>
                <td className="strong">Total money in</td>
                <Amt v={c.moneyIn} strong />
              </tr>
              <tr className="group">
                <td colSpan={2}>Money out</td>
              </tr>
              {moneyOut.map((l, i) => (
                <tr key={`out-${l.account}-${i}`}>
                  <td style={{ paddingLeft: 28 }}>{l.account}</td>
                  <Amt v={l.amount} />
                </tr>
              ))}
              <tr>
                <td className="strong">Total money out</td>
                <Amt v={c.moneyOut} strong />
              </tr>
              <tr className="total">
                <td>{c.net < 0 ? "Net cash out" : "Net cash in"}</td>
                <Amt v={c.net} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const BS_ROWS: [keyof BalanceSummary, string][] = [
  ["bank", "Cash at bank"],
  ["debtors", "Debtors"],
  ["otherCurrentAssets", "Other current assets"],
  ["fixedAssets", "Fixed assets"],
  ["creditors", "Creditors"],
  ["vat", "VAT"],
  ["payeCis", "PAYE and CIS"],
  ["otherCurrentLiabilities", "Other current liabilities"],
  ["longTermLiabilities", "Long-term liabilities"],
];

function Balance({ r }: { r: ManagementReport }) {
  const b = r.balance;
  const priorMonth = addMonths(r.month, -1);
  const line = ([key, label]: [keyof BalanceSummary, string], strong = false) => (
    <tr key={key} className={strong ? "total" : undefined}>
      <td style={strong ? undefined : { paddingLeft: 28 }}>{label}</td>
      <Amt v={b!.now[key]} />
      <Amt v={b!.prior ? b!.prior[key] : null} />
      <Amt v={b!.prior ? round2(b!.now[key] - b!.prior[key]) : null} />
    </tr>
  );
  return (
    <Card title="Balance sheet" aside={`At ${dmy(monthEnd(r.month))}`}>
      <Intro>What the business has and owes at the month end, from Xero, against the month before. Amounts owed show as positive.</Intro>
      {!b ? (
        <div className="empty">The balance sheet at {dmy(monthEnd(r.month))} has not been read from Xero yet.</div>
      ) : (
        <div className="scroll">
          <table className="tbl figs compact" style={{ minWidth: 440 }}>
            <thead>
              <tr>
                <th>
                  <span style={HIDDEN}>Line</span>
                </th>
                <th className="num">{monthShort(r.month)}</th>
                <th className="num">{monthShort(priorMonth)}</th>
                <th className="num">Change</th>
              </tr>
            </thead>
            <tbody>
              <tr className="group">
                <td colSpan={4}>What it has</td>
              </tr>
              {BS_ROWS.slice(0, 4).map((x) => line(x))}
              <tr className="group">
                <td colSpan={4}>What it owes</td>
              </tr>
              {BS_ROWS.slice(4).map((x) => line(x))}
              {line(["netAssets", "Net assets"], true)}
            </tbody>
          </table>
          {b.now.vat < 0 ? <Intro>VAT is a refund due from HMRC.</Intro> : null}
        </div>
      )}
    </Card>
  );
}

function InvoicesRaised({ r }: { r: ManagementReport }) {
  const d = r.debtorsRaised;
  const name = monthName(r.month);
  return (
    <Card title={`Invoices raised in ${name}`} aside="Inc VAT">
      <Intro>
        Sales invoices dated in the month, not drafts or voided. Whether the customer is a business or an individual comes from ServiceM8, else from the name on
        the invoice.
      </Intro>
      {!d.rows.length ? (
        <div className="empty">No sales invoices are dated in {name}.</div>
      ) : (
        <div className="scroll">
          <table className="tbl figs" style={{ minWidth: 720 }}>
            <thead>
              <tr>
                <th>Customer</th>
                <th className="num">Invoices</th>
                <th className="num">Total</th>
                <th className="num">Paid</th>
                <th className="num">Not paid</th>
              </tr>
            </thead>
            <tbody>
              {d.bySegment.map((g) => {
                const rows = d.rows.filter((x) => x.segment === g.segment);
                return [
                  <tr key={`${g.segment}-head`} className="group">
                    <td colSpan={5}>{g.segment}</td>
                  </tr>,
                  ...rows.map((x) => (
                    <tr key={`${g.segment}-${x.type}`}>
                      <td style={{ paddingLeft: 28 }}>{x.type === "B2B" ? "Business (B2B)" : "Individual (B2C)"}</td>
                      <td className="num">{x.count}</td>
                      <Amt v={x.total} />
                      <Amt v={x.paid} />
                      <Amt v={x.notPaid} />
                    </tr>
                  )),
                  rows.length > 1 ? (
                    <tr key={`${g.segment}-total`}>
                      <td className="strong">{g.segment} total</td>
                      <td className="num strong">{g.count}</td>
                      <Amt v={g.total} strong />
                      <Amt v={g.paid} strong />
                      <Amt v={g.notPaid} strong />
                    </tr>
                  ) : null,
                ];
              })}
              <tr className="total">
                <td>Total</td>
                <td className="num">{d.total.count}</td>
                <Amt v={d.total.total} />
                <Amt v={d.total.paid} />
                <Amt v={d.total.notPaid} />
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function ContractorCard({
  m,
  month,
  biz,
  staff,
  connected,
}: {
  m: MonthReport | null;
  month: string;
  biz: string;
  staff: boolean;
  connected: boolean;
}) {
  const t = m?.total;
  return (
    <Card title="Contractor profitability" aside={monthName(month)}>
      <Intro>
        Service and maintenance work only. Projects are on the <Link href={`/projects`}>Projects</Link> tab. Week by week detail is in{" "}
        <Link href={`/contractors?view=month&month=${month}`}>Contractors</Link>. Ex VAT.
      </Intro>
      {!connected ? (
        <div className="empty">
          {staff ? (
            <>
              No jobs yet. <Link href={`/settings#connections`}>Connect ServiceM8 in Settings</Link>.
            </>
          ) : (
            "Nothing to show yet."
          )}
        </div>
      ) : !m || !m.contractors.length ? (
        <div className="empty">No contractor jobs were completed in {monthName(month)}.</div>
      ) : (
        <div className="scroll">
          <table className="tbl figs compact sticky" style={{ minWidth: 1120 }}>
            <thead>
              <tr>
                <th>Contractor</th>
                <th className="num">Jobs</th>
                <th className="num">Charged ex VAT</th>
                <th className="num">Labour cost</th>
                <th className="num">Reimbursed</th>
                <th className="num">{biz} materials</th>
                <th className="num">Gross margin</th>
                <th className="num">Margin %</th>
                <th className="num">Deductions recovered</th>
                <th className="num">CIS withheld</th>
              </tr>
            </thead>
            <tbody>
              {m.contractors.map((c) => (
                <tr key={c.contractorId ?? c.name}>
                  <td className="strong">{c.name}</td>
                  <td className="num">{c.jobs}</td>
                  <Amt v={c.chargedEx} />
                  <Amt v={c.labourCost} />
                  <Amt v={c.reimbursed} />
                  <Amt v={c.businessMaterials} />
                  <Amt v={c.grossMargin} />
                  <td className={c.marginPct < 0 ? "num neg" : "num"}>{c.chargedEx ? pct(c.marginPct) : "–"}</td>
                  <Amt v={c.deductions} />
                  <Amt v={c.cis} />
                </tr>
              ))}
              {t ? (
                <tr className="total">
                  <td>Total</td>
                  <td className="num">{t.jobs}</td>
                  <Amt v={t.chargedEx} />
                  <Amt v={t.labourCost} />
                  <Amt v={t.reimbursed} />
                  <Amt v={t.businessMaterials} />
                  <Amt v={t.grossMargin} />
                  <td className={t.marginPct < 0 ? "num neg" : "num"}>{t.chargedEx ? pct(t.marginPct) : "–"}</td>
                  <Amt v={t.deductions} />
                  <Amt v={t.cis} />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
