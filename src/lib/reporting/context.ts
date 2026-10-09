import { cache } from "react";
import { canEdit as mayEdit, requireUser } from "../auth";
import { todayISO } from "../format";
import { getIntegrations, type Integration } from "../integrations/store";
import { buildJobRows, type ContractorInputs, type JobRow } from "./contractor";
import { loadReports, loadServiceM8, loadXero } from "./data";
import {
  getSettings,
  listAdjustments,
  listChases,
  listContractors,
  listDeductions,
  listFees,
  listLineRules,
  listProjectCosts,
  listProjects,
  openQueryCount,
} from "./store";
import type { ReportSettings, XeroInvoice } from "./types";
import type { User } from "../types";

/*
 * Request-scoped loading for the pages. Each loader runs at most once per request, so a layout
 * and a page can both ask for the same data.
 */

export type Access = {
  user: User;
  /** Admins and editors: they prepare the reports. Viewers read them and answer questions. */
  staff: boolean;
  canEdit: boolean;
  isAdmin: boolean;
  /** The business's short name, for labels such as "Bought by Polkadot". */
  business: string;
};

/** The signed-in person and what they may do, or a redirect to sign in. */
export const reportingAccess = cache(async (): Promise<Access> => {
  const user = await requireUser();
  const settings = await settingsFor();
  const edit = mayEdit(user);
  return { user, staff: edit, canEdit: edit, isAdmin: user.role === "admin", business: settings.businessName || "the business" };
});

export const settingsFor = cache(() => getSettings());
export const integrationsFor = cache((): Promise<Integration[]> => getIntegrations());
export const serviceM8For = cache(() => loadServiceM8());
export const xeroFor = cache(() => loadXero());
export const reportsFor = cache(() => loadReports());
export const projectsFor = cache(async () => {
  const [projects, costs] = await Promise.all([listProjects(), listProjectCosts()]);
  return { projects, costs };
});
export const chasesFor = cache(() => listChases());
export const openQueriesFor = cache(() => openQueryCount());

/**
 * Sales invoices, bills and bank spending in one list, as the engines expect. Money received
 * straight into the bank is left out: it is not a sales invoice, and counting it would double
 * the invoice it pays.
 */
export const invoicesFor = cache(async (): Promise<XeroInvoice[]> => {
  const x = await xeroFor();
  return [...x.invoices, ...x.bankTransactions.filter((t) => t.type === "ACCPAY")];
});

export const contractorInputsFor = cache(async (): Promise<ContractorInputs> => {
  const [settings, contractors, fixedFees, deductions, lineRules, adjustments, sm, invoices] = await Promise.all([
    settingsFor(),
    listContractors(),
    listFees(),
    listDeductions(),
    listLineRules(),
    listAdjustments(),
    serviceM8For(),
    invoicesFor(),
  ]);
  return {
    settings,
    contractors,
    fixedFees,
    deductions,
    lineRules,
    adjustments,
    jobs: sm.jobs,
    lines: sm.lines,
    activities: sm.activities,
    staff: sm.staff,
    invoices,
  };
});

export const jobRowsFor = cache(async (): Promise<{ input: ContractorInputs; rows: JobRow[] }> => {
  const input = await contractorInputsFor();
  return { input, rows: buildJobRows(input) };
});

export type Freshness = { lastSyncAt: string | null; connected: { servicem8: boolean; xero: boolean }; problems: string[] };

export const freshnessFor = cache(async (): Promise<Freshness> => {
  const list = await integrationsFor();
  const sm = list.find((i) => i.provider === "servicem8");
  const xe = list.find((i) => i.provider === "xero");
  // A system that has never finished a refresh makes the whole app "never refreshed", so the catch-up keeps going.
  const times = list.map((i) => i.lastSyncAt).sort((a, b) => (a ?? "").localeCompare(b ?? ""));
  const problems: string[] = [];
  for (const i of list) {
    const name = i.provider === "xero" ? "Xero" : "ServiceM8";
    if (i.status === "needs_reconnect") problems.push(`${name} needs connecting again.`);
    else if (i.lastError) problems.push(i.lastError.startsWith(name) ? i.lastError : `${name}: ${i.lastError}`);
  }
  return { lastSyncAt: times[0] ?? null, connected: { servicem8: !!sm, xero: !!xe }, problems };
});

export const today = () => todayISO();

export type { ReportSettings };
