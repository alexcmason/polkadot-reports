import Link from "next/link";
import { notFound } from "next/navigation";
import { saveAdjustmentAction } from "@/lib/actions/reporting";
import { freshnessFor, jobRowsFor, reportingAccess, today } from "@/lib/reporting/context";
import { defaultWeek, type JobRow } from "@/lib/reporting/contractor";
import { addMonths, lastCompleteWeek, monthName, round2, weekEnding, weekMonth, weeksInMonth } from "@/lib/reporting/dates";
import { dm, gbp, num, pct, tone } from "@/lib/reporting/format";
import type { Contractor, FixedFee, JobAdjustment } from "@/lib/reporting/types";
import { Banner, Field, first, type Search } from "@/components/ui";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";
import { Flags, flagRowClass, needsLook } from "@/components/reporting/Flags";
import { Stepper } from "@/components/reporting/Stepper";

export const metadata = { title: "Job data" };

const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const COLUMNS = 27;
const inline = { display: "inline-flex", alignItems: "center", gap: 8 } as const;
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function Th({ children, left = false, min = 84 }: { children: React.ReactNode; left?: boolean; min?: number }) {
  return (
    <th className={left ? undefined : "num"} style={{ whiteSpace: "normal", minWidth: min, verticalAlign: "bottom" }}>
      {children}
    </th>
  );
}

function Amt({ v, blank = false }: { v: number | null; blank?: boolean }) {
  if (v === null) return <td className="num muted">{blank ? "" : "–"}</td>;
  return <td className={tone(v)}>{gbp(v, { dashZero: true })}</td>;
}

const money = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

export default async function JobDataPage({ searchParams }: { searchParams: Search }) {
  const { business: biz, staff, canEdit } = await reportingAccess();
  if (!staff) notFound();
  const sp = await searchParams;
  const page = `/jobs`;

  const [{ input, rows }, fresh] = await Promise.all([jobRowsFor(), freshnessFor()]);
  const s = input.settings;
  const todayIso = today();
  const lastWeek = lastCompleteWeek(todayIso, s.weekEndsOn);
  const topMonth = weekMonth(weekEnding(todayIso, s.weekEndsOn));

  const rawMonth = first(sp.month);
  // With no month asked for, open on the month of the week the reports open on.
  const month = isMonth(rawMonth) ? rawMonth : weekMonth(defaultWeek(rows, lastWeek));
  const contractor = first(sp.contractor);
  const flaggedOnly = first(sp.flagged) === "1";
  const search = first(sp.q).trim();
  const saved = first(sp.saved);
  const error = first(sp.error);

  /* Rows: every job whose week starts in the month, held-out jobs included. */
  const weeks = new Set(weeksInMonth(month, s.weekEndsOn));
  const inMonth = rows.filter((r) => weeks.has(r.weekEnding));
  const needle = search.toLowerCase();
  const shown = inMonth.filter((r) => {
    if (contractor === "unassigned") {
      if (r.contractorId) return false;
    } else if (contractor && r.contractorId !== contractor) return false;
    if (flaggedOnly && !needsLook(r.flags)) return false;
    if (needle && !r.jobNo.toLowerCase().includes(needle) && !r.customer.toLowerCase().includes(needle)) return false;
    return true;
  });
  const included = shown.filter((r) => r.treatment === "include");
  const sum = (pick: (r: JobRow) => number | null) => round2(included.reduce((n, r) => n + (pick(r) ?? 0), 0));
  const total = {
    units: sum((r) => r.units),
    labour: sum((r) => r.labour),
    parking: sum((r) => r.parking),
    materials: sum((r) => r.materials),
    other: sum((r) => r.other),
    chargedEx: sum((r) => r.chargedEx),
    chargedInc: sum((r) => r.chargedInc),
    xeroEx: sum((r) => r.xeroEx),
    actualBill: sum((r) => r.actualBill),
    labourCost: sum((r) => r.labourCost),
    businessMaterials: sum((r) => r.businessMaterials),
    contractorExtra: sum((r) => r.contractorExtra),
    reimbursed: sum((r) => r.reimbursed),
    grossMargin: sum((r) => r.grossMargin),
  };
  const totalMargin = total.chargedEx ? total.grossMargin / total.chargedEx : 0;

  /* Links that keep the filters */
  const link = (over: { month?: string; contractor?: string; flagged?: boolean; q?: string } = {}) => {
    const p = new URLSearchParams();
    p.set("month", over.month ?? month);
    const c = over.contractor ?? contractor;
    if (c) p.set("contractor", c);
    if (over.flagged ?? flaggedOnly) p.set("flagged", "1");
    const q = over.q ?? search;
    if (q) p.set("q", q);
    return `${page}?${p.toString()}`;
  };
  const returnTo = link();
  const filtered = !!contractor || flaggedOnly || !!search;

  const monthOptions = Array.from({ length: 12 }, (_, i) => addMonths(topMonth, -i));
  if (!monthOptions.includes(month)) monthOptions.push(month);
  monthOptions.sort((a, b) => b.localeCompare(a));
  const contractors = [...input.contractors].sort((a, b) => a.name.localeCompare(b.name));
  const fees = [...input.fixedFees].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  const adjustments = new Map(input.adjustments.map((a) => [a.jobNo.trim().toLowerCase(), a]));

  const heldOut = shown.length - included.length;
  const flaggedCount = shown.filter((r) => needsLook(r.flags)).length;

  // After a save, point at the row, which may now sit in another month or outside the filters.
  const savedRow = saved ? rows.find((r) => r.jobNo === saved) : undefined;
  const savedHref = !savedRow
    ? null
    : shown.includes(savedRow)
      ? `#job-${encodeURIComponent(savedRow.jobNo)}`
      : `${link({ month: weekMonth(savedRow.weekEnding), contractor: "", flagged: false, q: "" })}#job-${encodeURIComponent(savedRow.jobNo)}`;
  const savedWhere = savedRow && weekMonth(savedRow.weekEnding) !== month ? ` It is now in ${monthName(weekMonth(savedRow.weekEnding))}.` : "";
  // The week ending field only accepts the last day of a week, so a job cannot fall between weeks.
  const weekDay = DAY_NAMES[Math.min(7, Math.max(1, s.weekEndsOn)) - 1];
  const weekAnchor = weekEnding("2020-01-01", s.weekEndsOn);

  return (
    <>
      {saved ? (
        <Banner kind="ok">
          Saved job {saved}. Every report now uses the new costing.{savedWhere} {savedHref ? <a href={savedHref}>Show the row</a> : null}
        </Banner>
      ) : null}
      {error ? <Banner kind="err">{error}</Banner> : null}

      <div className="toolbar">
        <Stepper
          prev={link({ month: addMonths(month, -1) })}
          next={addMonths(month, 1) <= topMonth ? link({ month: addMonths(month, 1) }) : null}
          label={monthName(month)}
          unit="month"
        />
        <form method="get" action={page}>
          <label className="small muted" style={inline}>
            Month
            <select name="month" defaultValue={month}>
              {monthOptions.map((m) => (
                <option key={m} value={m}>
                  {monthName(m)}
                </option>
              ))}
            </select>
          </label>
          <label className="small muted" style={inline}>
            Contractor
            <select name="contractor" defaultValue={contractor}>
              <option value="">Everyone</option>
              {contractors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="unassigned">Unassigned</option>
            </select>
          </label>
          <label className="check small">
            <input type="checkbox" name="flagged" value="1" defaultChecked={flaggedOnly} />
            Flagged only
          </label>
          <label className="small muted" style={inline}>
            Search
            <input type="search" name="q" defaultValue={search} placeholder="Job no or customer" style={{ minWidth: 180 }} />
          </label>
          <button type="submit" className="btn">
            Apply
          </button>
          {filtered ? (
            <Link href={link({ contractor: "", flagged: false, q: "" })} className="link">
              Clear filters
            </Link>
          ) : null}
        </form>
        <a className="btn" href={`/api/export?report=jobs&month=${month}`} download style={{ marginLeft: "auto" }}>
          Download Excel
        </a>
      </div>
      <p className="small muted" style={{ marginTop: -8 }}>
        Every completed ServiceM8 job in the month, one row each, costed with the rates in Settings. {canEdit ? "Select a job number to change how it is costed. Changes are kept and apply to every report." : "Select a job number for its bills and line notes."}
      </p>

      <section className="card">
        <div className="card-head">
          <h2>{monthName(month)}</h2>
          <span className="small muted">
            {plural(shown.length, "job")}
            {heldOut ? ` · ${heldOut} held out` : ""}
            {flaggedCount ? ` · ${flaggedCount} flagged` : ""}
            {filtered ? ` · filtered from ${inMonth.length}` : ""}
          </span>
        </div>
        {shown.length === 0 ? (
          <div className="empty">
            {!fresh.connected.servicem8 ? (
              <>
                No jobs yet. <Link href={`/settings#connections`}>Connect ServiceM8 in Settings</Link>.
              </>
            ) : inMonth.length === 0 ? (
              `No completed jobs in ${monthName(month)}.`
            ) : (
              <>
                No jobs match these filters. <Link href={link({ contractor: "", flagged: false, q: "" })}>Clear the filters</Link>.
              </>
            )}
          </div>
        ) : (
          <div className="scroll" style={{ containerType: "inline-size" }}>
            <table className="tbl figs compact sticky" style={{ minWidth: 2400 }}>
              <thead>
                <tr>
                  <th style={{ verticalAlign: "bottom" }}>Week ending</th>
                  <Th left min={120}>
                    Contractor
                  </Th>
                  <Th left min={70}>
                    Completed
                  </Th>
                  <Th left min={70}>
                    Job no
                  </Th>
                  <Th left min={180}>
                    Customer
                  </Th>
                  <Th min={56}>Units / hrs</Th>
                  <Th min={64}>Rate £</Th>
                  <Th>Labour £</Th>
                  <Th min={64}>Parking £</Th>
                  <Th>Materials £</Th>
                  <Th min={64}>Other £</Th>
                  <Th>Charged ex VAT £</Th>
                  <Th>Charged inc VAT £</Th>
                  <Th left min={70}>
                    Xero invoice
                  </Th>
                  <Th>Xero ex VAT £</Th>
                  <Th left min={110}>
                    Status
                  </Th>
                  <Th left min={100}>
                    Cost basis
                  </Th>
                  <Th min={70}>Cost rate £</Th>
                  <Th min={70}>Actual bill £</Th>
                  <Th left min={110}>
                    Bill ref
                  </Th>
                  <Th>Contractor labour cost £</Th>
                  <Th left min={90}>
                    Materials paid by
                  </Th>
                  <Th>{biz} materials cost £</Th>
                  <Th min={76}>Contractor extra £</Th>
                  <Th>Reimbursed to contractor £</Th>
                  <Th>Gross margin £</Th>
                  <Th min={64}>Margin %</Th>
                </tr>
              </thead>
              <tbody>
                <tr className="total">
                  <td>Total</td>
                  <td />
                  <td />
                  <td style={{ whiteSpace: "nowrap" }}>{plural(included.length, "job")}</td>
                  <td className="small muted" style={{ fontWeight: 400 }}>
                    {heldOut ? "Held-out jobs are not in the total" : ""}
                  </td>
                  <td className="num">{num(total.units)}</td>
                  <td />
                  <Amt v={total.labour} />
                  <Amt v={total.parking} />
                  <Amt v={total.materials} />
                  <Amt v={total.other} />
                  <Amt v={total.chargedEx} />
                  <Amt v={total.chargedInc} />
                  <td />
                  <Amt v={total.xeroEx} />
                  <td />
                  <td />
                  <td />
                  <Amt v={total.actualBill} />
                  <td />
                  <Amt v={total.labourCost} />
                  <td />
                  <Amt v={total.businessMaterials} />
                  <Amt v={total.contractorExtra} />
                  <Amt v={total.reimbursed} />
                  <Amt v={total.grossMargin} />
                  <td className="num">{pct(totalMargin)}</td>
                </tr>
                {shown.map((r) => (
                  <JobRows
                    key={`${r.jobUuid}-${r.jobNo}`}
                    r={r}
                    adj={adjustments.get(r.jobNo.trim().toLowerCase())}
                    biz={biz}
                    returnTo={returnTo}
                    open={saved === r.jobNo}
                    canEdit={canEdit}
                    contractors={contractors}
                    fees={fees}
                    labourShare={s.labourShare}
                    weekDay={weekDay}
                    weekAnchor={weekAnchor}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function JobRows({
  r,
  adj,
  biz,
  returnTo,
  open,
  canEdit,
  contractors,
  fees,
  labourShare,
  weekDay,
  weekAnchor,
}: {
  r: JobRow;
  adj: JobAdjustment | undefined;
  biz: string;
  returnTo: string;
  /** Show the panel without its link being clicked: after saving this job. */
  open: boolean;
  canEdit: boolean;
  contractors: Contractor[];
  fees: FixedFee[];
  labourShare: number;
  weekDay: string;
  weekAnchor: string;
}) {
  const held = r.treatment !== "include";
  const rowClass = [held ? "muted" : flagRowClass(r.flags)].filter(Boolean).join(" ") || undefined;
  const paidBy = r.materialsPaidBy === "business" ? biz : "Contractor";
  const unclassified = [...new Set(r.unclassified)];
  const rowId = `job-${r.jobNo}`;
  const editId = `edit-${r.jobNo}`;
  const action = canEdit ? "Adjust" : "Details for";

  return (
    <>
      <tr id={rowId} className={rowClass} style={{ scrollMarginTop: 96 }}>
        <td style={{ whiteSpace: "nowrap" }}>{dm(r.weekEnding)}</td>
        <td style={{ whiteSpace: "nowrap" }} className={r.contractorId || held ? undefined : "late"}>
          {r.contractorName}
        </td>
        <td style={{ whiteSpace: "nowrap" }}>{dm(r.completed)}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          <a href={`#${encodeURIComponent(editId)}`} className="title" aria-controls={editId} aria-label={`${action} ${r.jobNo}`}>
            {r.jobNo}
          </a>
        </td>
        <td title={r.description || undefined} style={{ minWidth: 220 }}>
          {r.customer || <span className="muted">Not stated</span>}
          {held || r.adjusted ? (
            <span className="chips" style={{ display: "inline-flex", gap: 4, marginLeft: 6 }}>
              {held ? <span className="chip">{r.treatment === "project" ? "Held out as project" : "Left out"}</span> : null}
              {r.adjusted ? <span className="chip blue">Adjusted</span> : null}
            </span>
          ) : null}
          {r.note ? <div className="sub">{r.note}</div> : null}
          {r.flags.length ? (
            <div style={{ marginTop: 4 }}>
              <Flags flags={r.flags} />
            </div>
          ) : null}
        </td>
        <td className="num">{num(r.units)}</td>
        <td className="num">{gbp(r.rate, { dashZero: true })}</td>
        <Amt v={r.labour} />
        <Amt v={r.parking} />
        <Amt v={r.materials} />
        <Amt v={r.other} />
        <Amt v={r.chargedEx} />
        <Amt v={r.chargedInc} />
        <td>{r.xeroNumber ?? <span className="muted">–</span>}</td>
        <Amt v={r.xeroEx} />
        <td style={{ whiteSpace: "nowrap" }} className={r.xeroStatus === "Agrees" ? undefined : "late"}>
          {r.xeroStatus}
        </td>
        <td style={{ whiteSpace: "nowrap" }}>{r.costBasisLabel}</td>
        <Amt v={r.costRate} blank />
        <Amt v={r.actualBill} blank />
        <td className="small">{r.billRef}</td>
        <Amt v={r.labourCost} />
        <td style={{ whiteSpace: "nowrap" }}>{paidBy}</td>
        <Amt v={r.businessMaterials} />
        <Amt v={r.contractorExtra} />
        <Amt v={r.reimbursed} />
        <Amt v={r.grossMargin} />
        <td className={r.marginPct < 0 ? "num neg" : "num"}>{r.chargedEx ? pct(r.marginPct) : "–"}</td>
      </tr>
      {/* Hidden until its job number is clicked (#edit-…), as on Debtors; open straight away after saving this job. */}
      <tr id={editId} className={open ? "edit-row" : "edit-row collapsed"} style={{ scrollMarginTop: 160 }}>
        <td colSpan={COLUMNS} style={{ position: "static", background: "#fafbfc", paddingTop: 8, paddingBottom: 10 }}>
          {/* Stays in view while the wide table scrolls sideways. */}
          <div style={{ position: "sticky", left: 16, width: "calc(100cqw - 32px)", maxWidth: 1120, display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "0 16px" }}>
              <span className="strong">
                {action} {r.jobNo}
                <span className="muted" style={{ fontWeight: 400 }}>
                  {" "}
                  · {[r.customer, r.contractorName].filter(Boolean).join(" · ")}
                </span>
              </span>
              <a href={`#${encodeURIComponent(rowId)}`} className="link">
                Close
              </a>
            </div>
            {r.category || r.description ? (
              <div className="small muted" style={{ overflowWrap: "anywhere" }}>
                {[r.category, r.description.length > 220 ? `${r.description.slice(0, 220)}…` : r.description].filter(Boolean).join(" · ")}
              </div>
            ) : null}
            {r.bills.length ? (
              <div className="small">
                <span className="muted">Bills naming this job: </span>
                {r.bills.map((b) => `${b.supplier} ${b.number}, ${gbp(b.net)}, labour ${gbp(b.labour)}`).join("; ")}
              </div>
            ) : null}
            {unclassified.length ? (
              <div className="small">
                <span className="muted">Read as materials by guess: </span>
                {unclassified.join(", ")}. <Link href={`/settings#lines`}>Settings › Line rules</Link>
              </div>
            ) : null}
            {canEdit ? (
              <>
                <form action={saveAdjustmentAction} className="mini" style={{ padding: "8px 0" }}>
                  <input type="hidden" name="return_to" value={returnTo} />
                  <input type="hidden" name="job_no" value={r.jobNo} />
                  <Field label="Contractor" hint={`Now ${r.contractorName}`}>
                    <select name="contractor_id" defaultValue={adj?.contractorId ?? ""}>
                      <option value="">As ServiceM8</option>
                      {contractors.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.active ? "" : " (inactive)"}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Cost basis" hint={`Now ${r.costBasisLabel}`}>
                    <select name="cost_basis" defaultValue={adj?.costBasis ?? ""}>
                      <option value="">Automatic</option>
                      <option value="hourly">Hourly at the card rate</option>
                      <option value="labour_share">Labour share ({pct(labourShare, 0)})</option>
                      <option value="fixed_fee">Fixed fee</option>
                      <option value="actual_bill">Actual bill</option>
                    </select>
                  </Field>
                  <Field label="Fixed fee" hint="Used when the cost basis is a fixed fee">
                    <select name="fixed_fee_id" defaultValue={adj?.fixedFeeId ?? ""}>
                      <option value="">Match by line name</option>
                      {fees.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.name}, {gbp(f.amount)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Actual bill £" hint="Labour on the bill, ex VAT">
                    <input type="text" inputMode="decimal" name="actual_bill" defaultValue={money(adj?.actualBill)} />
                  </Field>
                  <Field label="Bill ref">
                    <input type="text" name="bill_ref" defaultValue={adj?.billRef ?? ""} />
                  </Field>
                  <Field label="Materials paid by" hint={`Now ${paidBy}`}>
                    <select name="materials_paid_by" defaultValue={adj?.materialsPaidBy ?? ""}>
                      <option value="">Automatic</option>
                      <option value="contractor">Contractor</option>
                      <option value="business">{biz}</option>
                    </select>
                  </Field>
                  <Field label={`${biz} materials cost £`} hint="The purchase invoice, ex VAT">
                    <input type="text" inputMode="decimal" name="business_materials" defaultValue={money(adj?.businessMaterials)} />
                  </Field>
                  <Field label="Contractor extra £" hint="Paid back to the contractor on top">
                    <input type="text" inputMode="decimal" name="contractor_extra" defaultValue={money(adj?.contractorExtra)} />
                  </Field>
                  <Field label="Treatment">
                    <select name="treatment" defaultValue={adj?.treatment ?? "include"}>
                      <option value="include">Include</option>
                      <option value="project">Hold out as a project</option>
                      <option value="exclude">Leave out</option>
                    </select>
                  </Field>
                  <Field label="Week ending" hint={`Now ${dm(r.weekEnding)}. A ${weekDay}; blank uses the completion date.`}>
                    {/* The moved week as it now reads, so a week saved before the week day changed still fits the step. */}
                    <input type="date" name="week_ending" min={weekAnchor} step={7} defaultValue={adj?.weekEnding ? r.weekEnding : ""} />
                  </Field>
                  <Field label="Note" hint="Shown on the reports">
                    <input type="text" name="note" defaultValue={adj?.note ?? ""} />
                  </Field>
                  <div style={{ display: "flex", alignItems: "flex-end" }}>
                    <SubmitButton pending="Saving…">Save</SubmitButton>
                  </div>
                </form>
                {r.adjusted ? (
                  <form action={saveAdjustmentAction}>
                    <input type="hidden" name="return_to" value={returnTo} />
                    <input type="hidden" name="job_no" value={r.jobNo} />
                    <input type="hidden" name="treatment" value="include" />
                    <ConfirmButton message={`Clear every change to job ${r.jobNo} and cost it automatically again?`}>
                      Clear the changes and cost it automatically
                    </ConfirmButton>
                  </form>
                ) : null}
              </>
            ) : null}
          </div>
        </td>
      </tr>
    </>
  );
}
