import { NextResponse } from "next/server";
import { canEdit, getUser } from "@/lib/auth";
import { appOrigin } from "@/lib/url";
import { jobRowsFor, chasesFor, invoicesFor, projectsFor, reportsFor, serviceM8For, settingsFor, today, xeroFor } from "@/lib/reporting/context";
import { monthReport, weekReport } from "@/lib/reporting/contractor";
import { addMonths, monthName, monthOf, weekEnding, weeksInMonth } from "@/lib/reporting/dates";
import { buildDebtors, xeroLedger } from "@/lib/reporting/debtors";
import {
  debtorsWorkbook,
  jobsWorkbook,
  managementWorkbook,
  monthWorkbook,
  projectsWorkbook,
  queriesWorkbook,
  weekWorkbook,
  type ExcelContext,
} from "@/lib/reporting/excel";
import { dmy } from "@/lib/reporting/format";
import { managementReport } from "@/lib/reporting/management";
import { buildProjects } from "@/lib/reporting/projects";
import { listQueries } from "@/lib/reporting/store";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const REPORTS = ["week", "month", "jobs", "projects", "debtors", "management", "queries"] as const;
type Report = (typeof REPORTS)[number];

const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
/** A real day as YYYY-MM-DD. 2026-02-30 and 2026-13-01 are not. */
function isDate(s: string): boolean {
  const t = Date.parse(`${s}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === s;
}

const plain = (message: string, status: number) =>
  new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "April to March (from Xero)" for the management accounts. */
function fyNote(ytdFrom: string, month: string, fyEndMonth: number, fromXero: boolean): string {
  const start = MONTHS_FULL[fyEndMonth % 12];
  const end = MONTHS_FULL[fyEndMonth - 1];
  return `Year to date ${monthName(ytdFrom)} to ${monthName(month)}. Financial year ${start} to ${end}${fromXero ? "" : " (assumed, Xero did not say)"}.`;
}

/** A spreadsheet of one report for anyone signed in. Job data is for admins and editors only. */
export async function GET(request: Request) {
  const user = await getUser();
  if (!user) return NextResponse.redirect(`${await appOrigin(request)}/login`);
  const staff = canEdit(user);
  const settings = await settingsFor();
  const business = settings.businessName || "Reports";

  const query = new URL(request.url).searchParams;
  const report = (query.get("report") ?? "") as Report;
  if (!REPORTS.includes(report)) return plain(`Unknown report. Use one of: ${REPORTS.join(", ")}.`, 400);
  if (report === "jobs" && !staff) return plain("Job data is for admins and editors only.", 403);

  const todayIso = today();
  const ctx: ExcelContext = { clientName: business, businessName: business, settings, today: todayIso, staff };
  let file: Buffer;
  let label: string;

  switch (report) {
    case "week": {
      const raw = query.get("week") ?? "";
      if (!isDate(raw)) return plain("Choose a week, as week=YYYY-MM-DD.", 400);
      const { input, rows } = await jobRowsFor();
      const week = weekEnding(raw, settings.weekEndsOn);
      file = await weekWorkbook(weekReport(rows, input, week), { ...ctx, contractors: input.contractors });
      label = `Contractor pay week ending ${dmy(week)}`;
      break;
    }
    case "month": {
      const month = query.get("month") ?? "";
      if (!isMonth(month)) return plain("Choose a month, as month=YYYY-MM.", 400);
      const [{ input, rows }, queries] = await Promise.all([jobRowsFor(), listQueries()]);
      const mr = monthReport(rows, input, month, todayIso);
      const weeks = weeksInMonth(month, settings.weekEndsOn).map((w) => weekReport(rows, input, w));
      file = await monthWorkbook(mr, weeks, mr.rows, queries, {
        ...ctx,
        contractors: input.contractors,
        fees: input.fixedFees,
        deductions: input.deductions,
      });
      label = `Contractor pay ${monthName(month)}`;
      break;
    }
    case "jobs": {
      const month = query.get("month") ?? "";
      if (!isMonth(month)) return plain("Choose a month, as month=YYYY-MM.", 400);
      const { rows } = await jobRowsFor();
      const weeks = new Set(weeksInMonth(month, settings.weekEndsOn));
      file = await jobsWorkbook(
        rows.filter((r) => weeks.has(r.weekEnding)),
        { ...ctx, period: monthName(month) }
      );
      label = `Job data ${monthName(month)}`;
      break;
    }
    case "projects": {
      const [{ projects, costs }, sm, invoices] = await Promise.all([projectsFor(), serviceM8For(), invoicesFor()]);
      const pr = buildProjects({ projects, costs, jobs: sm.jobs, lines: sm.lines, payments: sm.payments, invoices, settings, today: todayIso });
      file = await projectsWorkbook(pr, ctx);
      label = "Projects";
      break;
    }
    case "debtors": {
      const [sm, invoices, chases] = await Promise.all([serviceM8For(), invoicesFor(), chasesFor()]);
      const dr = buildDebtors({
        jobs: sm.jobs,
        payments: sm.payments,
        invoices,
        chases,
        chaseAfterHours: settings.chaseAfterHours,
        now: new Date().toISOString(),
        today: todayIso,
      });
      file = await debtorsWorkbook(dr, xeroLedger(invoices, todayIso), ctx);
      label = `Debtors ${dmy(todayIso)}`;
      break;
    }
    case "management": {
      const [reports, xero, sm, { input, rows }] = await Promise.all([reportsFor(), xeroFor(), serviceM8For(), jobRowsFor()]);
      const available = [...reports.keys()]
        .filter((k) => /^pnl:\d{4}-\d{2}$/.test(k) && reports.get(k) != null)
        .map((k) => k.slice(4))
        .sort()
        .reverse();
      const raw = query.get("month") ?? "";
      if (raw && !isMonth(raw)) return plain("Choose a month, as month=YYYY-MM.", 400);
      const current = monthOf(todayIso);
      const month = raw || available.find((m) => m !== current) || available[0] || addMonths(current, -1);
      const fromXero = xero.organisation?.financialYearEndMonth ?? null;
      const fyEndMonth = fromXero ?? 3;
      const customerTypes = new Map<string, boolean>();
      for (const j of sm.jobs) if (j.customerIsIndividual !== null && j.jobNo) customerTypes.set(j.jobNo, j.customerIsIndividual);
      const mr = managementReport({ month, reports, invoices: xero.invoices, trackingName: settings.salesTypeTracking, fyEndMonth, customerTypes });
      const contractorMonth = sm.jobs.length ? monthReport(rows, input, month, todayIso) : null;
      file = await managementWorkbook(mr, contractorMonth, { ...ctx, fyNote: fyNote(mr.ytdFrom, month, fyEndMonth, fromXero !== null) });
      label = `Management accounts ${monthName(month)}`;
      break;
    }
    case "queries": {
      file = await queriesWorkbook(await listQueries(), ctx);
      label = `Questions for ${ctx.businessName}`;
      break;
    }
  }

  const name = `${business} - ${label}.xlsx`;
  const ascii = name
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/["\\/:*?<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      "Cache-Control": "no-store",
    },
  });
}
