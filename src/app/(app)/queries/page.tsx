import Link from "next/link";
import { answerQueryAction, createQueryAction, deleteQueryAction, setQueryStatusAction } from "@/lib/actions/reporting";
import { reportingAccess, settingsFor } from "@/lib/reporting/context";
import { weekEnding, weekMonth } from "@/lib/reporting/dates";
import { stamp, wdm } from "@/lib/reporting/format";
import { listQueries, type QueryStatus, type QueryTopic, type ReportQuery } from "@/lib/reporting/store";
import { Banner, Field, first, type Search } from "@/components/ui";
import { ConfirmButton } from "@/components/ConfirmButton";
import { SubmitButton } from "@/components/SubmitButton";

export const metadata = { title: "Questions" };

const TOPIC_LABEL: Record<QueryTopic, string> = {
  contractors: "Contractor pay",
  projects: "Projects",
  debtors: "Debtors",
  management: "Management accounts",
  general: "General",
};
const TOPICS = Object.keys(TOPIC_LABEL) as QueryTopic[];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

type ItemProps = { returnTo: string; staff: boolean; canEdit: boolean; biz: string; weekEndsOn: number };
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export default async function QueriesPage({ searchParams }: { searchParams: Search }) {
  const { business: biz, staff, canEdit } = await reportingAccess();
  const sp = await searchParams;
  const returnTo = `/queries`;
  const [settings, queries] = await Promise.all([settingsFor(), listQueries()]);
  const saved = first(sp.saved);
  const error = first(sp.error);

  // Open questions read in week order, as the old "For Jack" tab did; the rest newest first.
  const open = queries
    .filter((q) => q.status === "open")
    .sort((a, b) => (a.weekEnding ?? "9999").localeCompare(b.weekEnding ?? "9999") || a.createdAt.localeCompare(b.createdAt));
  const answered = queries.filter((q) => q.status === "answered").sort((a, b) => (b.answeredAt ?? "").localeCompare(a.answeredAt ?? ""));
  const resolved = queries.filter((q) => q.status === "resolved").sort((a, b) => (b.answeredAt ?? b.createdAt).localeCompare(a.answeredAt ?? a.createdAt));
  const props: ItemProps = { returnTo, staff, canEdit, biz, weekEndsOn: settings.weekEndsOn };

  const lists = (
    <div className="stack">
      <section className="card" id="open">
        <div className="card-head">
          <h2>Open</h2>
          <span className="small muted">{open.length ? plural(open.length, "question") : ""}</span>
        </div>
        {open.length === 0 ? (
          <div className="empty">
            {staff ? `No open questions. ${canEdit ? "Ask one with the form, or from the checks on a contractor week." : ""}` : "Nothing needs an answer right now. Thank you."}
          </div>
        ) : (
          open.map((q) => <QueryItem key={q.id} q={q} {...props} />)
        )}
      </section>

      {answered.length ? (
        <section className="card" id="answered">
          <div className="card-head">
            <h2>Answered</h2>
            <span className="small muted">{staff ? "Check each answer, then mark it resolved." : "We will check these and close them."}</span>
          </div>
          {answered.map((q) => (
            <QueryItem key={q.id} q={q} {...props} />
          ))}
        </section>
      ) : null}

      {resolved.length ? (
        <details className="card" id="resolved">
          <summary className="card-head" style={{ cursor: "pointer" }}>
            <h2>Resolved</h2>
            <span className="small muted">{plural(resolved.length, "question")} · show or hide</span>
          </summary>
          {resolved.map((q) => (
            <QueryItem key={q.id} q={q} {...props} />
          ))}
        </details>
      ) : null}
    </div>
  );

  return (
    <>
      {saved === "query" ? <Banner kind="ok">Question added. {biz} will see it when they sign in.</Banner> : null}
      {saved === "answer" ? <Banner kind="ok">{staff ? "Answer saved." : "Thank you. Your answer is saved."}</Banner> : null}
      {error ? <Banner kind="err">{error}</Banner> : null}

      <div className="toolbar">
        <p style={{ flex: "1 1 320px" }}>
          {staff
            ? `Questions for ${biz}. They see these when they sign in and answer here.`
            : "Everything we need from you is here. Type your answer under each question and press Save."}
        </p>
        <a className="btn" href={`/api/export?report=queries`} download>
          Download Excel
        </a>
      </div>

      {canEdit ? (
        <div className="split">
          <div className="wide">{lists}</div>
          <div className="narrow">
            <AskCard returnTo={returnTo} biz={biz} weekEndsOn={settings.weekEndsOn} />
          </div>
        </div>
      ) : (
        lists
      )}
    </>
  );
}

function QueryItem({ q, returnTo, staff, canEdit, biz, weekEndsOn }: ItemProps & { q: ReportQuery }) {
  // Job Data lists a job under the month its week starts in; the date typed in may not be a week ending, so snap it first.
  const jobLink =
    staff && q.weekEnding && /^\d+[a-z]?$/i.test(q.jobNo)
      ? `/jobs?month=${weekMonth(weekEnding(q.weekEnding, weekEndsOn))}#job-${encodeURIComponent(q.jobNo)}`
      : null;
  const hidden = (
    <>
      <input type="hidden" name="return_to" value={returnTo} />
      <input type="hidden" name="id" value={q.id} />
    </>
  );
  const answerForm = (
    <form action={answerQueryAction} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {hidden}
      <Field label={staff ? "Answer" : "Your answer"}>
        <textarea name="answer" defaultValue={q.answer} rows={3} />
      </Field>
      <div>
        <SubmitButton pending="Saving…">Save</SubmitButton>
      </div>
    </form>
  );
  const statusButton = (status: QueryStatus, label: string, primary = false) => (
    <form action={setQueryStatusAction}>
      {hidden}
      <input type="hidden" name="status" value={status} />
      <SubmitButton className={primary ? "btn primary" : "btn"} pending="Saving…">
        {label}
      </SubmitButton>
    </form>
  );

  return (
    <article id={`q-${q.id}`} style={{ display: "flex", flexDirection: "column", gap: 10, padding: "16px 20px 18px", borderTop: "1px solid var(--line-soft)" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "6px 12px" }}>
        <span className="chip">{TOPIC_LABEL[q.topic] ?? q.topic}</span>
        {q.weekEnding ? (
          staff ? (
            <Link href={`/contractors?week=${q.weekEnding}`} className="small">
              Week ending {wdm(q.weekEnding)}
            </Link>
          ) : (
            <span className="small muted">Week ending {wdm(q.weekEnding)}</span>
          )
        ) : null}
        {q.jobNo ? (
          jobLink ? (
            <Link href={jobLink} className="small">
              Job {q.jobNo}
            </Link>
          ) : (
            <span className="small muted">Job {q.jobNo}</span>
          )
        ) : null}
        <span className="tiny muted" style={{ marginLeft: "auto" }}>
          Asked {stamp(q.createdAt)}
          {staff && q.askedBy ? ` by ${q.askedBy}` : ""}
        </span>
      </div>

      <div className="strong" style={{ fontSize: 15 }}>
        {q.subject}
      </div>
      {q.detail ? <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{q.detail}</p> : null}
      {q.actionTaken || q.ask ? (
        <div className="note-box" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {q.actionTaken ? (
            <div>
              <span className="strong">What we did: </span>
              {q.actionTaken}
            </div>
          ) : null}
          {q.ask ? (
            <div>
              <span className="strong">What we need: </span>
              {q.ask}
            </div>
          ) : null}
        </div>
      ) : null}

      {q.answer ? (
        <div className="answer">
          {q.answer}
          <div className="tiny muted" style={{ marginTop: 6 }}>
            Answered{q.answeredBy ? ` by ${q.answeredBy}` : ""}
            {q.answeredAt ? `, ${stamp(q.answeredAt)}` : ""}
          </div>
        </div>
      ) : null}

      {/* Viewers answer here; editors only answer for them now and then, so their box starts closed. */}
      {q.status === "open" && !staff ? answerForm : null}
      {q.status === "open" && staff ? (
        <details>
          <summary className="link">Answer for {biz}</summary>
          <div style={{ paddingTop: 8 }}>{answerForm}</div>
        </details>
      ) : null}
      {q.status === "answered" ? (
        <details>
          <summary className="link">
            Change the answer
          </summary>
          <div style={{ paddingTop: 8 }}>{answerForm}</div>
        </details>
      ) : null}

      {canEdit ? (
        <div className="actions" style={{ gap: 8 }}>
          {q.status === "answered" ? statusButton("resolved", "Mark resolved", true) : null}
          {q.status === "open" ? statusButton("resolved", "Mark resolved") : null}
          {q.status === "answered" ? statusButton("open", "Reopen") : null}
          {q.status === "resolved" ? statusButton("open", "Reopen") : null}
          <form action={deleteQueryAction}>
            {hidden}
            <ConfirmButton message="Delete this question? This cannot be undone.">Delete</ConfirmButton>
          </form>
        </div>
      ) : null}
    </article>
  );
}

function AskCard({ returnTo, biz, weekEndsOn }: { returnTo: string; biz: string; weekEndsOn: number }) {
  const day = DAY_NAMES[Math.min(7, Math.max(1, weekEndsOn)) - 1];
  return (
    <section className="card" id="ask">
      <div className="card-head">
        <h2>Ask a question</h2>
        <span className="small muted">{biz} sees it straight away</span>
      </div>
      <div className="card-body">
        <form action={createQueryAction} className="form">
          <input type="hidden" name="return_to" value={returnTo} />
          <Field label="Topic">
            <select name="topic" defaultValue="contractors">
              {TOPICS.map((t) => (
                <option key={t} value={t}>
                  {TOPIC_LABEL[t]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Week ending" hint={`Optional. A ${day}.`}>
            <input type="date" name="week_ending" min={weekEnding("2020-01-01", weekEndsOn)} step={7} />
          </Field>
          <Field label="Job no" hint="Optional">
            <input type="text" name="job_no" />
          </Field>
          <Field label="Subject" className="full">
            <input type="text" name="subject" required />
          </Field>
          <Field label="Detail" className="full">
            <textarea name="detail" rows={3} />
          </Field>
          <Field label="What we did in the meantime" className="full">
            <input type="text" name="action_taken" placeholder="Costed as shown in the meantime." />
          </Field>
          <Field label="What we need" className="full">
            <input type="text" name="ask" />
          </Field>
          <div className="full">
            <SubmitButton pending="Adding…">Add question</SubmitButton>
          </div>
        </form>
      </div>
    </section>
  );
}
