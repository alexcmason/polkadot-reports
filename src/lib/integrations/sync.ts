import { one, q } from "../db";
import { todayISO } from "../format";
import { addMonths, monthEnd, monthStart, plusDays } from "../reporting/dates";
import { getSettings } from "../reporting/store";
import type { ReportSettings } from "../reporting/types";
import { IntegrationError, sleep } from "./http";
import { cursorPages, openJobPages, SM8_OBJECTS } from "./servicem8";
import {
  connection,
  connectionChanged,
  getCursor,
  getIntegrations,
  serviceM8Key,
  setCursor,
  writeLive,
  xeroAccess,
  type Conn,
  type Provider,
} from "./store";
import * as xero from "./xero";

/*
 * Copies ServiceM8 and Xero into source_records. Every run picks up where the last one
 * stopped, so a run that hits its time limit is finished by the next one. Every write checks the
 * connection is still the one the run started with, so switching or removing it stops the run.
 */

export type SyncResult = {
  runId: number;
  status: "ok" | "error" | "skipped";
  counts: Record<string, number>;
  errors: string[];
  message: string;
};

type Raw = Record<string, unknown>;

const BATCH = 500;
const CHILDREN = new Set(["jobmaterial", "jobactivity", "jobpayment"]);
const DAY = 86_400_000;
const PARTLY = "Partly refreshed, the rest comes on the next run.";
const NAMES: Record<Provider, string> = { servicem8: "ServiceM8", xero: "Xero" };

const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

class Run {
  counts: Record<string, number> = {};
  errors: string[] = [];
  /** Problems with an extra step that leave the rest of the data sound. They never fail the run. */
  warnings: string[] = [];
  partial = false;
  constructor(private deadline: number) {}
  outOfTime(): boolean {
    if (Date.now() > this.deadline) this.partial = true;
    return this.partial;
  }
  /** Whether a wait of `ms` would still end before the time is up. */
  canWait(ms: number): boolean {
    if (Date.now() + ms > this.deadline) this.partial = true;
    return !this.partial;
  }
  add(kind: string, n: number) {
    this.counts[kind] = (this.counts[kind] ?? 0) + n;
  }
}

export function errorText(label: string, err: unknown): string {
  if (!(err instanceof IntegrationError)) console.error(`${label} sync failed`, err);
  const msg = err instanceof IntegrationError ? err.message : `Something went wrong reading ${label}. Try again later.`;
  return msg.startsWith(label) ? msg : `${label}: ${msg}`;
}

/** Saves records in batches, one statement per batch. Later copies of the same id win. */
async function saveRecords(conn: Conn, kind: string, rows: [string, unknown][]) {
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = new Map<string, string>();
    for (const [id, data] of rows.slice(i, i + BATCH)) {
      if (!id) continue;
      let json = JSON.stringify(data);
      // Postgres jsonb cannot hold a NUL character.
      if (json.includes("\\u0000")) json = JSON.stringify(data, (_, v) => (typeof v === "string" ? v.replace(/\u0000/g, "") : v));
      batch.set(id, json);
    }
    if (!batch.size) continue;
    await writeLive(
      conn,
      `insert into source_records (source, kind, ext_id, data)
       select $1, $4, t.ext_id, t.data from unnest($5::text[], $6::jsonb[]) as t (ext_id, data)
        where exists (select 1 from live)
       on conflict (source, kind, ext_id) do update set data = excluded.data, updated_at = now()`,
      [kind, [...batch.keys()], [...batch.values()]]
    );
  }
}

/** A broken or changed connection stops the provider's run. Anything else is noted and the rest carries on. */
export const stopsProvider = (err: unknown) => err instanceof IntegrationError && err.kind !== "provider";

/** Runs one part of a provider's sync. */
async function step(run: Run, label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (stopsProvider(err)) throw err;
    run.errors.push(errorText(label, err));
  }
}

/** Like step, for extras such as old unpaid invoices: a problem is a warning, not a failed refresh. */
async function softStep(run: Run, label: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (stopsProvider(err)) throw err;
    run.warnings.push(errorText(label, err));
  }
}

/** When the start date moves earlier, everything is read again from the new date. */
async function checkSyncFrom(conn: Conn, syncFrom: string) {
  const used = await getCursor<string>(conn, "syncFrom");
  if (used && syncFrom < used) {
    await writeLive(
      conn,
      `update integrations set sync_cursor = jsonb_build_object('tenants', coalesce(sync_cursor -> 'tenants', '[]'::jsonb))
        where id = $2 and exists (select 1 from live)`
    );
  }
  if (used !== syncFrom) await setCursor(conn, "syncFrom", syncFrom);
}

/* ServiceM8 */

const londonClock = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/London",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Now in ServiceM8's form: "2026-10-08 14:05:00", London time. */
const londonNow = () => londonClock.format(new Date()).replace("T", " ");

function minusMinutes(local: string, minutes: number): string {
  const t = Date.parse(`${local.slice(0, 19).replace(" ", "T")}Z`);
  if (Number.isNaN(t)) return local;
  return new Date(t - minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
}

/** Where a listing stopped part way: its filter, the next page, and what it had seen so far. */
type Resume = { filter: string | null; next: string; high: string; started: string };

async function syncObject(run: Run, conn: Conn, apiKey: string, object: string, syncFrom: string) {
  const markKey = `sm8:${object}`;
  const resumeKey = `${markKey}:resume`;
  const mark = await getCursor<string>(conn, markKey);
  const resume = await getCursor<Resume>(conn, resumeKey);

  let filter: string | undefined;
  let from = "-1";
  let high = mark ?? "";
  let started = londonNow();
  let resumable = !!resume;
  if (resume?.next) {
    filter = resume.filter ?? undefined;
    from = resume.next;
    started = resume.started || started;
    if (resume.high > high) high = resume.high;
  } else if (mark) {
    // Two hours of overlap: ServiceM8 stamps edits in UK local time, so a clock change can move them back an hour.
    filter = `edit_date gt '${minusMinutes(mark, 120)}'`;
  } else if (object === "job") {
    filter = `edit_date gt '${syncFrom} 00:00:00'`;
  } else if (CHILDREN.has(object)) {
    filter = `edit_date gt '${plusDays(syncFrom, -180)} 00:00:00'`;
  }

  try {
    for await (const page of cursorPages(apiKey, object, filter, from)) {
      await saveRecords(conn, object, page.rows.map((r) => [text(r.uuid), r]));
      run.add(object, page.rows.length);
      for (const r of page.rows) {
        const edited = text(r.edit_date);
        if (edited > high && !edited.startsWith("0000")) high = edited;
      }
      if (page.next) {
        // Pages are not in edit order, so the place is saved as a page cursor until the listing ends.
        await setCursor(conn, resumeKey, { filter: filter ?? null, next: page.next, high, started } satisfies Resume);
        resumable = true;
        if (run.outOfTime()) return;
      }
    }
  } catch (err) {
    if (from !== "-1" && err instanceof IntegrationError && err.kind === "provider") {
      await setCursor(conn, resumeKey, null);
    }
    throw err;
  }
  // Anything edited after the listing began is read again next time.
  const done = high && high > started ? started : high;
  if (done && done !== mark) await setCursor(conn, markKey, done);
  if (resumable) await setCursor(conn, resumeKey, null);
}

/** Invoiced jobs still unpaid, however long since they were edited, so old debts reach the chase list. */
async function syncOpenJobs(run: Run, conn: Conn, apiKey: string) {
  if (await getCursor<string>(conn, "sm8:openJobsOff")) return;
  for await (const page of openJobPages(apiKey)) {
    // ServiceM8 ignores a filter it cannot read and returns every job. Stop at once rather than read the whole history.
    const unfiltered = page.rows.some((r) => text(r.invoice_sent) !== "1" || text(r.payment_received) !== "0");
    if (unfiltered) {
      await setCursor(conn, "sm8:openJobsOff", "ignored");
      run.warnings.push("ServiceM8 did not apply the filter for unpaid invoices, so only jobs edited since the start date are read.");
      return;
    }
    await saveRecords(conn, "job", page.rows.map((r) => [text(r.uuid), r]));
    run.add("job", page.rows.length);
    if (page.next && run.outOfTime()) return;
  }
}

async function syncServiceM8(run: Run, conn: Conn, settings: ReportSettings) {
  const apiKey = await serviceM8Key(conn);
  await checkSyncFrom(conn, settings.syncFrom);
  for (const object of SM8_OBJECTS) {
    if (run.outOfTime()) return;
    await step(run, "ServiceM8", () => syncObject(run, conn, apiKey, object, settings.syncFrom));
  }
  if (run.outOfTime()) return;
  await softStep(run, "ServiceM8", () => syncOpenJobs(run, conn, apiKey));
}

/* Xero */

type Pace = () => Promise<boolean>;
type Access = () => Promise<{ token: string; tenantId: string }>;

/**
 * Keeps to Xero's 60 calls a minute per organisation, with room to spare. Answers false, and
 * marks the run partial, rather than wait past the end of the run's time.
 */
function pacer(run: Run, limit = 55, windowMs = 60_000): Pace {
  const times: number[] = [];
  return async () => {
    while (times.length && Date.now() - times[0] > windowMs) times.shift();
    if (times.length >= limit) {
      const wait = windowMs - (Date.now() - times[0]) + 100;
      if (!run.canWait(wait)) return false;
      await sleep(wait);
    }
    times.push(Date.now());
    return true;
  };
}

async function* paced<T>(gen: AsyncGenerator<T>, pace: Pace): AsyncGenerator<T> {
  try {
    for (;;) {
      if (!(await pace())) return;
      const r = await gen.next();
      if (r.done) return;
      yield r.value;
    }
  } finally {
    await gen.return(undefined);
  }
}

async function syncXero(run: Run, conn: Conn, settings: ReportSettings) {
  const pace = pacer(run);
  const access = async () => {
    const a = await xeroAccess();
    if (a.id !== conn.id || a.generation !== conn.generation) throw connectionChanged();
    return a;
  };
  await access();
  await checkSyncFrom(conn, settings.syncFrom);

  for (const [kind, idField] of [
    ["invoice", "InvoiceID"],
    ["banktransaction", "BankTransactionID"],
  ] as const) {
    if (run.outOfTime()) return;
    await step(run, "Xero", async () => {
      const key = `xero:${kind}`;
      const mark = await getCursor<string>(conn, key);
      const { token, tenantId } = await access();
      // A minute of overlap, as Xero compares to the second.
      const opts = { fromDate: settings.syncFrom, modifiedSince: mark ? new Date(Date.parse(mark) - 60_000).toISOString() : undefined };
      const gen = kind === "invoice" ? xero.invoicePages(token, tenantId, opts) : xero.bankTransactionPages(token, tenantId, opts);
      let high = mark ?? "";
      for await (const rows of paced(gen, pace)) {
        await saveRecords(conn, kind, rows.map((r) => [text(r[idField]), r]));
        run.add(kind, rows.length);
        for (const r of rows) {
          const updated = xero.parseXeroTimestamp(r.UpdatedDateUTC);
          if (updated && updated > high) high = updated;
        }
        // Pages come oldest change first, so the place can be saved after every page.
        if (high && high !== mark) await setCursor(conn, key, high);
        if (run.outOfTime()) return;
      }
    });
  }

  if (run.outOfTime()) return;
  await softStep(run, "Xero", () => syncOpenInvoices(run, conn, access, pace));

  let tracking: Raw[] | null = null;
  for (const [path, kind, idField] of [
    ["TrackingCategories", "tracking", "TrackingCategoryID"],
    ["Accounts", "account", "AccountID"],
    ["Organisation", "organisation", "OrganisationID"],
  ] as const) {
    if (run.outOfTime()) return;
    await step(run, "Xero", async () => {
      if (!(await pace())) return;
      const { token, tenantId } = await access();
      const rows = await xero.getList(token, tenantId, path);
      const ids = rows.map((r) => text(r[idField]));
      await saveRecords(conn, kind, rows.map((r, i) => [ids[i], r]));
      await writeLive(
        conn,
        "delete from source_records where source = $1 and kind = $4 and not (ext_id = any($5::text[])) and exists (select 1 from live)",
        [kind, ids.filter(Boolean)]
      );
      run.add(kind, rows.length);
      if (kind === "tracking") tracking = rows;
    });
  }

  if (run.outOfTime()) return;
  await step(run, "Xero", () => syncReports(run, conn, settings, tracking, access, pace));
}

const ID_BATCH = 50;

/**
 * Unpaid sales invoices of any date, so old debts reach the ledger. One saved as unpaid that is
 * no longer in the list is read again by id, so a payment on an invoice older than the start
 * date is not missed.
 */
async function syncOpenInvoices(run: Run, conn: Conn, access: Access, pace: Pace) {
  const open: string[] = [];
  const { token, tenantId } = await access();
  for await (const rows of paced(xero.openSalesInvoicePages(token, tenantId), pace)) {
    await saveRecords(conn, "invoice", rows.map((r) => [text(r.InvoiceID), r]));
    run.add("invoice", rows.length);
    open.push(...rows.map((r) => text(r.InvoiceID)));
    if (run.outOfTime()) return;
  }
  if (run.partial) return;
  const stale = await q<{ ext_id: string }>(
    `select ext_id from source_records
      where source = 'xero' and kind = 'invoice' and data ->> 'Type' = 'ACCREC'
        and data ->> 'Status' in ('AUTHORISED', 'SUBMITTED') and data -> 'AmountDue' > '0'::jsonb and not (ext_id = any($1::text[]))`,
    [open]
  );
  for (let i = 0; i < stale.length; i += ID_BATCH) {
    if (run.outOfTime()) return;
    const { token, tenantId } = await access();
    const ids = stale.slice(i, i + ID_BATCH).map((r) => r.ext_id);
    for await (const rows of paced(xero.invoicePages(token, tenantId, { ids }), pace)) {
      await saveRecords(conn, "invoice", rows.map((r) => [text(r.InvoiceID), r]));
      run.add("invoice", rows.length);
    }
  }
}

async function syncReports(run: Run, conn: Conn, settings: ReportSettings, fetched: Raw[] | null, access: Access, pace: Pace) {
  const tracking =
    fetched ?? (await q<{ data: Raw }>("select data from source_records where source = 'xero' and kind = 'tracking'")).map((r) => r.data);
  const wanted = settings.salesTypeTracking.trim().toLowerCase();
  const category = wanted ? tracking.find((t) => text(t.Name).trim().toLowerCase() === wanted) : undefined;
  const categoryId = category ? text(category.TrackingCategoryID) : "";

  const fullAt = await getCursor<string>(conn, "reportsFull");
  const full = !fullAt || Date.now() - Date.parse(fullAt) > DAY;
  const thisMonth = todayISO().slice(0, 7);

  for (let i = 0; i < (full ? 13 : 3); i++) {
    if (run.outOfTime()) return;
    const month = addMonths(thisMonth, -i);
    const range = { fromDate: monthStart(month), toDate: monthEnd(month) };
    const list: [string, "ProfitAndLoss" | "BalanceSheet", Record<string, string>][] = [[`pnl:${month}`, "ProfitAndLoss", range]];
    if (categoryId) list.push([`pnl-tracking:${month}`, "ProfitAndLoss", { ...range, trackingCategoryID: categoryId }]);
    list.push([`pnl-cash:${month}`, "ProfitAndLoss", { ...range, paymentsOnly: "true" }]);
    list.push([`bs:${month}`, "BalanceSheet", { date: monthEnd(month) }]);
    const got: [string, unknown][] = [];
    let paused = false;
    try {
      for (const [id, name, params] of list) {
        if (!(await pace())) {
          paused = true;
          break;
        }
        const { token, tenantId } = await access();
        const report = await xero.getReport(token, tenantId, name, params);
        if (report) got.push([id, report]);
      }
    } finally {
      // Keep the month's reports already read, even if a later one failed.
      await saveRecords(conn, "report", got);
      run.add("report", got.length);
    }
    if (paused) return;
  }
  if (full) await setCursor(conn, "reportsFull", new Date().toISOString());
}

/* Runs */

/**
 * Runs one provider against the connection as it is now. Only a run that read everything counts
 * as a refresh; one that ran out of time has saved its place, and the next run carries on.
 */
async function syncProvider(run: Run, provider: Provider, fn: (conn: Conn) => Promise<void>) {
  const conn = await connection(provider);
  if (!conn) return;
  const label = NAMES[provider];
  const before = run.errors.length;
  let fatal: unknown = null;
  try {
    await fn(conn);
  } catch (err) {
    fatal = err;
    run.errors.push(errorText(label, err));
  }
  const reconnect = fatal instanceof IntegrationError && fatal.kind === "reconnect";
  await q(
    `update integrations
        set last_error = $3,
            status = case when $4 then 'needs_reconnect' else 'connected' end,
            last_sync_at = case when $5 then now() else last_sync_at end
      where id = $1 and generation = $2`,
    [conn.id, conn.generation, [...new Set(run.errors.slice(before))].join(" "), reconnect, !fatal && !run.partial]
  );
}

/** Refreshes the ServiceM8 and Xero copies. Never throws; problems come back in the result. */
export async function syncNow(opts: { trigger: "manual" | "cron"; userId?: string; budgetMs?: number }): Promise<SyncResult> {
  const integrations = await getIntegrations();
  if (!integrations.length) {
    return { runId: 0, status: "skipped", counts: {}, errors: [], message: "Nothing is connected yet. Connect ServiceM8 or Xero in Settings." };
  }

  await q(
    `update sync_runs set status = 'error', error = 'Stopped before it finished.', finished_at = now()
      where status = 'running' and started_at <= now() - interval '10 minutes'`
  );
  const started = await one<{ id: number }>(
    `insert into sync_runs (trigger, started_by)
     select $1, $2
      where not exists (select 1 from sync_runs where status = 'running' and started_at > now() - interval '10 minutes')
     on conflict (status) where status = 'running' do nothing
     returning id`,
    [opts.trigger, opts.userId ?? null]
  );
  if (!started) {
    const current = await one<{ id: number }>("select id from sync_runs where status = 'running' order by started_at desc limit 1");
    return { runId: current?.id ?? 0, status: "skipped", counts: {}, errors: [], message: "A refresh is already running." };
  }

  const run = new Run(Date.now() + (opts.budgetMs ?? 240_000));
  let status: "ok" | "error" = "ok";
  let message = "";
  try {
    const settings = await getSettings();
    const has = (p: Provider) => integrations.some((i) => i.provider === p);
    if (has("servicem8")) await syncProvider(run, "servicem8", (conn) => syncServiceM8(run, conn, settings));
    if (has("xero") && !run.outOfTime()) await syncProvider(run, "xero", (conn) => syncXero(run, conn, settings));
  } catch (err) {
    console.error("sync failed", err);
    run.errors.push("The refresh stopped because of an unexpected problem. Try again later.");
  } finally {
    status = run.errors.length ? "error" : "ok";
    const parts = [...new Set([...run.errors, ...run.warnings])];
    if (run.partial) parts.push(PARTLY);
    message = parts.join(" ") || "Everything is up to date.";
    await q("update sync_runs set status = $2, detail = $3::jsonb, error = $4, finished_at = now() where id = $1", [
      started.id,
      status,
      JSON.stringify({ counts: run.counts, errors: run.errors, warnings: run.warnings, message, partial: run.partial }),
      run.errors.join("\n"),
    ]).catch((err: unknown) => console.error("sync run could not be closed", err));
  }
  return { runId: started.id, status, counts: run.counts, errors: run.errors, message };
}
