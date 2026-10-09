import { IntegrationError, request } from "./http";

const AUTHORIZE = "https://login.xero.com/identity/connect/authorize";
const IDENTITY = "https://identity.xero.com/connect";
const CONNECTIONS = "https://api.xero.com/connections";
const API = "https://api.xero.com/api.xro/2.0";
const PAGE_SIZE = 1000;

/** Granular scopes. Apps created after 2 March 2026 cannot ask for the old broad ones. */
export const XERO_SCOPES =
  "openid profile email offline_access accounting.invoices.read accounting.payments.read accounting.banktransactions.read accounting.contacts.read accounting.settings.read accounting.reports.profitandloss.read accounting.reports.balancesheet.read accounting.reports.aged.read";

type Row = Record<string, unknown>;

export type XeroTokens = { accessToken: string; refreshToken: string; expiresIn: number };
export type XeroConnection = { id: string; tenantId: string; tenantName: string; tenantType: string; authEventId: string };

function creds() {
  const id = process.env.XERO_CLIENT_ID;
  const secret = process.env.XERO_CLIENT_SECRET;
  if (!id || !secret) throw new IntegrationError("config", "Xero is not set up. Add XERO_CLIENT_ID and XERO_CLIENT_SECRET in Vercel.");
  return { id, secret, basic: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}` };
}

export const configured = () => !!process.env.XERO_CLIENT_ID && !!process.env.XERO_CLIENT_SECRET;

/** Holds the sign-in state between /api/xero/start and the callback. */
export const STATE_COOKIE = "pr_xero";

export function authUrl(state: string, redirectUri: string): string {
  const p = new URLSearchParams({ response_type: "code", client_id: creds().id, redirect_uri: redirectUri, scope: XERO_SCOPES, state });
  return `${AUTHORIZE}?${p.toString().replace(/\+/g, "%20")}`;
}

async function token(body: Record<string, string>): Promise<XeroTokens> {
  let res: Response;
  try {
    res = await fetch(`${IDENTITY}/token`, {
      method: "POST",
      headers: { Authorization: creds().basic, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(body),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    if (err instanceof IntegrationError) throw err;
    throw new IntegrationError("provider", "Xero sign-in could not be reached. Try again in a few minutes.");
  }
  const json = (await res.json().catch(() => ({}))) as Record<string, string | number | undefined>;
  if (!res.ok) {
    if (json.error === "invalid_grant") throw new IntegrationError("reconnect", "Xero access has expired. Connect Xero again.");
    if (json.error === "invalid_client") {
      throw new IntegrationError("config", "Xero did not accept the app's details. Check XERO_CLIENT_ID and XERO_CLIENT_SECRET in Vercel.");
    }
    throw new IntegrationError("provider", `Xero sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
  }
  if (!json.access_token || !json.refresh_token) {
    throw new IntegrationError("reconnect", "Xero did not give long-term access. Connect Xero again.");
  }
  return { accessToken: String(json.access_token), refreshToken: String(json.refresh_token), expiresIn: Number(json.expires_in ?? 1800) };
}

export const exchangeCode = (code: string, redirectUri: string) =>
  token({ grant_type: "authorization_code", code, redirect_uri: redirectUri });

export const refresh = (refreshToken: string) => token({ grant_type: "refresh_token", refresh_token: refreshToken });

/** The auth event an access token came from, read from its JWT without checking the signature. */
export function authEventId(accessToken: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as Row;
    return typeof claims.authentication_event_id === "string" ? claims.authentication_event_id : null;
  } catch {
    return null;
  }
}

/** Xero organisations the token can read. Practices and other tenant types are left out. */
export async function connections(accessToken: string): Promise<XeroConnection[]> {
  const res = await request(CONNECTIONS, { label: "Xero", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
  const list = (await res.json()) as Row[];
  return (Array.isArray(list) ? list : [])
    .filter((c) => c.tenantType === "ORGANISATION")
    .map((c) => ({
      id: String(c.id ?? ""),
      tenantId: String(c.tenantId ?? ""),
      tenantName: String(c.tenantName ?? ""),
      tenantType: String(c.tenantType ?? ""),
      authEventId: String(c.authEventId ?? ""),
    }));
}

/** Removes one organisation's connection, leaving any others on the same Xero login alone. */
export async function removeConnection(accessToken: string, connectionId: string): Promise<void> {
  const res = await request(`${CONNECTIONS}/${encodeURIComponent(connectionId)}`, {
    label: "Xero",
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await res.body?.cancel().catch(() => {});
}

/** Best effort: revokes the token and every connection made with it. */
export async function revoke(refreshToken: string): Promise<void> {
  try {
    const res = await fetch(`${IDENTITY}/revocation`, {
      method: "POST",
      headers: { Authorization: creds().basic, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel().catch(() => {});
  } catch {
    // Nothing to do: the stored token is deleted either way.
  }
}

function get(tok: string, tenantId: string, path: string, extra?: Record<string, string>): Promise<Response> {
  return request(`${API}/${path}`, {
    label: "Xero",
    headers: { Authorization: `Bearer ${tok}`, "xero-tenant-id": tenantId, Accept: "application/json", ...extra },
  });
}

/** "2026-10-01T09:30:00" in UTC, the form Xero expects in If-Modified-Since. */
function modifiedHeader(v: string): string {
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(v);
  const t = hasZone ? Date.parse(v) : Date.parse(`${v.slice(0, 19)}Z`);
  return Number.isNaN(t) ? v : new Date(t).toISOString().slice(0, 19);
}

type PageOpts = { modifiedSince?: string; fromDate?: string; where?: string; statuses?: string[]; ids?: string[] };

/**
 * Oldest change first, so the sync can save its place after every page. Each page after the
 * first asks again for changes since the newest one read, not for the next page number: a record
 * that changes part way moves to the end, and with page numbers it would push another one past
 * the reader. Only when that would not move on, as when a whole page shares one second, does it
 * go by page number instead.
 */
async function* paged(tok: string, tenantId: string, path: string, key: string, opts: PageOpts): AsyncGenerator<Row[]> {
  let since = opts.modifiedSince;
  for (let page = 1; ; ) {
    const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE), order: "UpdatedDateUTC ASC" });
    const where = [opts.where, opts.fromDate ? dateFrom(opts.fromDate) : ""].filter(Boolean).join(" AND ");
    if (where) p.set("where", where);
    if (opts.statuses?.length) p.set("Statuses", opts.statuses.join(","));
    if (opts.ids?.length) p.set("IDs", opts.ids.join(","));
    const qs = p.toString().replace(/\+/g, "%20");
    const res = await get(tok, tenantId, `${path}?${qs}`, since ? { "If-Modified-Since": modifiedHeader(since) } : undefined);
    if (res.status === 304) return;
    const json = (await res.json()) as Row & { pagination?: { pageCount?: unknown; pageSize?: unknown } };
    const rows = Array.isArray(json[key]) ? (json[key] as Row[]) : [];
    if (!rows.length) return;
    yield rows;
    // Go by the page size Xero says it used: an endpoint that ignores pageSize sends 100 a page.
    const { pageCount, pageSize } = json.pagination ?? {};
    const size = typeof pageSize === "number" && pageSize > 0 ? pageSize : 100;
    if (rows.length < size || (typeof pageCount === "number" && page >= pageCount)) return;
    const next = nextSince(rows, since);
    if (next) {
      since = next;
      page = 1;
    } else page++;
  }
}

function dateFrom(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `Date>=DateTime(${y},${m},${d})`;
}

const toSecond = (ms: number) => Math.floor(ms / 1000) * 1000;

/**
 * If-Modified-Since for the page after `rows`: a second before the newest change in it, as Xero
 * compares to the second, so ties are read again rather than missed. Null when that would not
 * move on, which includes a page within one second: asking again would only return it again.
 */
function nextSince(rows: Row[], since: string | undefined): string | null {
  const times = rows.flatMap((r) => {
    const t = parseXeroTimestamp(r.UpdatedDateUTC);
    return t ? [Date.parse(t)] : [];
  });
  if (!times.length) return null;
  const newest = toSecond(Math.max(...times));
  if (newest === toSecond(Math.min(...times))) return null;
  const next = newest - 1000;
  const from = since ? Date.parse(`${modifiedHeader(since)}Z`) : Number.NEGATIVE_INFINITY;
  return next > from ? new Date(next).toISOString() : null;
}

export const invoicePages = (tok: string, tenantId: string, opts: PageOpts) => paged(tok, tenantId, "Invoices", "Invoices", opts);

/** Unpaid sales invoices of any date or age. */
export const openSalesInvoicePages = (tok: string, tenantId: string) =>
  invoicePages(tok, tenantId, { statuses: ["AUTHORISED", "SUBMITTED"], where: 'Type=="ACCREC" AND AmountDue>0' });

export const bankTransactionPages = (tok: string, tenantId: string, opts: PageOpts) =>
  paged(tok, tenantId, "BankTransactions", "BankTransactions", opts);

export async function getList(tok: string, tenantId: string, path: "TrackingCategories" | "Accounts" | "Organisation"): Promise<Row[]> {
  const json = (await (await get(tok, tenantId, path)).json()) as Row;
  const list = json[path === "Organisation" ? "Organisations" : path];
  return Array.isArray(list) ? (list as Row[]) : [];
}

export async function getReport(
  tok: string,
  tenantId: string,
  name: "ProfitAndLoss" | "BalanceSheet",
  params: Record<string, string>
): Promise<Row | null> {
  const p = new URLSearchParams({ ...params, standardLayout: "true" });
  const json = (await (await get(tok, tenantId, `Reports/${name}?${p}`)).json()) as { Reports?: Row[] };
  return json.Reports?.[0] ?? null;
}

const MS_DATE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/** A Xero date as YYYY-MM-DD. Xero dates are midnight in the organisation's time. */
export function parseXeroDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = s.match(MS_DATE);
  if (m) {
    let ms = Number(m[1]);
    if (m[2]) {
      const sign = m[2][0] === "-" ? -1 : 1;
      ms += sign * (Number(m[2].slice(1, 3)) * 60 + Number(m[2].slice(3, 5))) * 60_000;
    }
    return new Date(ms).toISOString().slice(0, 10);
  }
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

/** A Xero UTC timestamp such as UpdatedDateUTC as an ISO string. */
export function parseXeroTimestamp(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const m = s.match(MS_DATE);
  if (m) return new Date(Number(m[1])).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(s)) return null;
  const t = Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
