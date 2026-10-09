import { one, q } from "../db";
import { decrypt, encrypt, hasEncryptionKey } from "../crypto";
import { IntegrationError } from "./http";
import { sameServiceM8Account, type Sm8Account } from "./servicem8";
import * as xero from "./xero";

/*
 * The integrations table: one ServiceM8 key and one Xero connection.
 * Callers check access first; these functions do not.
 */

export type Provider = "xero" | "servicem8";
export type XeroTenant = { tenantId: string; name: string };

export type Integration = {
  id: string;
  provider: Provider;
  accountName: string;
  tenantId: string;
  status: "connected" | "needs_reconnect";
  lastSyncAt: string | null;
  lastError: string;
  /** Every Xero organisation granted in the last sign-in. Empty for ServiceM8. */
  tenants: XeroTenant[];
};

type Row = {
  id: string;
  provider: Provider;
  account_name: string;
  tenant_id: string;
  status: Integration["status"];
  last_sync_at: string | null;
  last_error: string;
  tenants: { tenantId?: string; name?: string }[] | null;
};

const SELECT = `select id, provider, account_name, tenant_id, status, last_error, sync_cursor -> 'tenants' as tenants,
                       to_char(last_sync_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_sync_at
                  from integrations`;

function toIntegration(r: Row): Integration {
  return {
    id: r.id,
    provider: r.provider,
    accountName: r.account_name,
    tenantId: r.tenant_id,
    status: r.status,
    lastSyncAt: r.last_sync_at,
    lastError: r.last_error,
    tenants: (Array.isArray(r.tenants) ? r.tenants : []).map((t) => ({ tenantId: String(t.tenantId ?? ""), name: String(t.name ?? "") })),
  };
}

export async function getIntegrations(): Promise<Integration[]> {
  return (await q<Row>(`${SELECT} order by provider`)).map(toIntegration);
}

export async function getIntegration(provider: Provider): Promise<Integration | null> {
  const row = await one<Row>(`${SELECT} where provider = $1`, [provider]);
  return row ? toIntegration(row) : null;
}

/*
 * Every switch, new key or new sign-in moves the connection's generation on. A refresh notes the
 * generation it started with and writes only while it is unchanged, so it stops rather than mix
 * the old account's records into the new one or bring back what was deleted.
 */

/** The connection a refresh started with. */
export type Conn = { provider: Provider; id: string; generation: number };

export const connectionChanged = () => new IntegrationError("changed", "The connection changed during the refresh. Refresh again.");

export async function connection(provider: Provider): Promise<Conn | null> {
  const row = await one<{ id: string; generation: number }>("select id, generation from integrations where provider = $1", [provider]);
  return row ? { provider, id: row.id, generation: row.generation } : null;
}

/**
 * Wraps one write so it runs only while the connection is unchanged. $1 to $3 name the
 * connection (provider, id, generation), the write's own values start at $4, and the write must
 * check `exists (select 1 from live)`. The check takes a share lock, so a switch waits for a
 * write already under way and any later write sees the switch.
 */
export function liveStatement(sql: string): string {
  return `with live as (select 1 from integrations where provider = $1 and id = $2 and generation = $3 for share),
               w as (${sql})
          select exists (select 1 from live) as live`;
}

/** Runs a liveStatement, and stops the refresh when the connection has changed. */
export async function writeLive(conn: Conn, sql: string, params: unknown[] = []): Promise<void> {
  const row = await one<{ live: boolean }>(liveStatement(sql), [conn.provider, conn.id, conn.generation, ...params]);
  if (!row?.live) throw connectionChanged();
}

/**
 * Forgets everything read from one system, so a different account starts clean. Callers move the
 * generation on first, so the delete sees anything an older refresh wrote; it moves on again here,
 * so a refresh that began in between cannot save its place over the deleted rows.
 */
async function forget(provider: Provider, keepTenants = false) {
  await q(
    `with conn as (
       update integrations
          set generation = generation + 1, last_sync_at = null,
              sync_cursor = case when $2 then jsonb_build_object('tenants', coalesce(sync_cursor -> 'tenants', '[]'::jsonb)) else '{}'::jsonb end
        where provider = $1)
     delete from source_records where source = $1`,
    [provider, keepTenants]
  );
}

const SAVED_TWICE = "The connection was changed somewhere else at the same moment. Try again.";

/** The ServiceM8 account's uuid is kept in tenant_id. */
export async function saveServiceM8(apiKey: string, account: Sm8Account, userId: string): Promise<void> {
  const before = await one<{ tenant_id: string; generation: number }>(
    "select tenant_id, generation from integrations where provider = 'servicem8'"
  );
  const saved = await one(
    `insert into integrations (provider, account_name, tenant_id, secret_enc, status, connected_by)
     values ('servicem8', $1, $2, $3, 'connected', $4)
     on conflict (provider) do update
       set account_name = excluded.account_name, tenant_id = excluded.tenant_id, secret_enc = excluded.secret_enc, status = 'connected',
           last_error = '', connected_by = excluded.connected_by, generation = integrations.generation + 1
       where integrations.generation = $5
     returning id`,
    [account.accountName, account.vendorId, encrypt(apiKey), userId, before?.generation ?? null]
  );
  if (!saved) throw new IntegrationError("config", SAVED_TWICE);
  if (!sameServiceM8Account(before?.tenant_id, account.vendorId)) await forget("servicem8");
}

export async function saveXero(
  tokens: { refreshToken: string; accessToken: string; expiresIn: number },
  tenant: XeroTenant,
  tenants: XeroTenant[],
  userId: string
): Promise<void> {
  const before = await one<{ tenant_id: string; generation: number }>("select tenant_id, generation from integrations where provider = 'xero'");
  const saved = await one(
    `insert into integrations (provider, account_name, tenant_id, secret_enc, access_token_enc, access_expires_at,
                               status, sync_cursor, connected_by)
     values ('xero', $1, $2, $3, $4, now() + $5 * interval '1 second', 'connected', jsonb_build_object('tenants', $6::jsonb), $7)
     on conflict (provider) do update
       set account_name = excluded.account_name, tenant_id = excluded.tenant_id, secret_enc = excluded.secret_enc,
           access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at, status = 'connected',
           last_error = '', connected_by = excluded.connected_by, generation = integrations.generation + 1,
           sync_cursor = integrations.sync_cursor || jsonb_build_object('tenants', $6::jsonb)
       where integrations.generation = $8
     returning id`,
    [
      tenant.name,
      tenant.tenantId,
      encrypt(tokens.refreshToken),
      encrypt(tokens.accessToken),
      tokens.expiresIn,
      JSON.stringify(tenants),
      userId,
      before?.generation ?? null,
    ]
  );
  if (!saved) throw new IntegrationError("config", SAVED_TWICE);
  if (before && before.tenant_id !== tenant.tenantId) await forget("xero", true);
}

/** Switch to another organisation from the last Xero sign-in. */
export async function chooseXeroTenant(tenantId: string): Promise<void> {
  const current = await getIntegration("xero");
  if (!current) throw new IntegrationError("config", "Xero is not connected.");
  const tenant = current.tenants.find((t) => t.tenantId === tenantId);
  if (!tenant) throw new IntegrationError("config", "That Xero organisation was not part of the last sign-in. Connect Xero again.");
  if (tenant.tenantId === current.tenantId) return;
  await q(
    "update integrations set tenant_id = $2, account_name = $3, last_error = '', generation = generation + 1 where provider = $1",
    ["xero", tenant.tenantId, tenant.name]
  );
  await forget("xero", true);
}

/** Stops reading a system and deletes what was read from it. For Xero the sign-in is revoked too. */
export async function disconnect(provider: Provider): Promise<void> {
  if (provider === "xero") await forgetXero().catch(() => {});
  // The connection goes first: from then on a refresh still running cannot write, so nothing comes back.
  await q("delete from integrations where provider = $1", [provider]);
  await q("delete from source_records where source = $1", [provider]);
}

async function forgetXero() {
  const row = await one<{ secret_enc: string }>("select secret_enc from integrations where provider = 'xero'");
  if (row) await xero.revoke(readSecret(row.secret_enc, UNREADABLE_XERO));
}

export async function serviceM8Key(conn: Conn): Promise<string> {
  const row = await one<{ secret_enc: string }>("select secret_enc from integrations where id = $1 and generation = $2", [conn.id, conn.generation]);
  if (!row) throw connectionChanged();
  return readSecret(row.secret_enc, "The saved ServiceM8 key can no longer be read. Add the key again in Settings.");
}

/** Decrypts a saved secret, with a plain message when ENCRYPTION_KEY is missing or has changed. */
function readSecret(packed: string, unreadable: string): string {
  if (!hasEncryptionKey()) throw new IntegrationError("config", "ENCRYPTION_KEY is not set in Vercel, so saved connections cannot be read.");
  try {
    return decrypt(packed);
  } catch {
    throw new IntegrationError("reconnect", unreadable);
  }
}

/** A working token, and the connection it was read from. */
type XeroAccess = { token: string; tenantId: string; id: string; generation: number };
const inflight = new Map<string, Promise<XeroAccess>>();

/** A working Xero access token and organisation. Parallel callers share one refresh. */
export function xeroAccess(): Promise<XeroAccess> {
  let pending = inflight.get("xero");
  if (!pending) {
    pending = loadXeroAccess().finally(() => inflight.delete("xero"));
    inflight.set("xero", pending);
  }
  return pending;
}

type TokenRow = { id: string; generation: number; secret_enc: string; access_token_enc: string | null; tenant_id: string; fresh: boolean };
const UNREADABLE_XERO = "The saved Xero sign-in can no longer be read. Connect Xero again.";

/*
 * A token is reused only with 5 minutes to spare. A refresh runs for at most about 4, and
 * pages are read with the token it started with, so it never expires part way through.
 */
const tokenRow = () =>
  one<TokenRow>(
    `select id, generation, secret_enc, access_token_enc, tenant_id,
            (access_expires_at is not null and access_expires_at > now() + interval '5 minutes') as fresh
       from integrations where provider = 'xero'`
  );

const toAccess = (row: TokenRow, token: string): XeroAccess => ({ token, tenantId: row.tenant_id, id: row.id, generation: row.generation });

async function loadXeroAccess(): Promise<XeroAccess> {
  const row = await tokenRow();
  if (!row) throw new IntegrationError("config", "Xero is not connected.");
  if (!row.tenant_id) throw new IntegrationError("config", "Choose which Xero organisation to use in Settings.");
  try {
    if (row.fresh && row.access_token_enc) return toAccess(row, readSecret(row.access_token_enc, UNREADABLE_XERO));
    let t: xero.XeroTokens;
    try {
      t = await xero.refresh(readSecret(row.secret_enc, UNREADABLE_XERO));
    } catch (err) {
      // Another server may have refreshed first and saved a newer token; use that rather than give up.
      const now = err instanceof IntegrationError && err.kind === "reconnect" ? await tokenRow() : null;
      if (now && now.secret_enc !== row.secret_enc && now.fresh && now.access_token_enc) {
        return toAccess(now, readSecret(now.access_token_enc, UNREADABLE_XERO));
      }
      throw err;
    }
    // Xero has already retired the old refresh token, so the new one is saved before anything else,
    // unless the saved one changed meanwhile: a new sign-in must not be overwritten with the old one's.
    await q(
      `update integrations set secret_enc = $1, access_token_enc = $2, access_expires_at = now() + $3 * interval '1 second',
              status = 'connected'
        where provider = 'xero' and secret_enc = $4`,
      [encrypt(t.refreshToken), encrypt(t.accessToken), t.expiresIn, row.secret_enc]
    );
    return toAccess(row, t.accessToken);
  } catch (err) {
    if (err instanceof IntegrationError && err.kind === "reconnect") {
      await q("update integrations set status = 'needs_reconnect', last_error = $1 where provider = 'xero' and secret_enc = $2", [
        err.message,
        row.secret_enc,
      ]);
    }
    throw err;
  }
}

export async function getCursor<T = unknown>(conn: Conn, key: string): Promise<T | null> {
  const row = await one<{ v: T | null }>("select sync_cursor -> $3::text as v from integrations where id = $1 and generation = $2", [
    conn.id,
    conn.generation,
    key,
  ]);
  if (!row) throw connectionChanged();
  return row.v ?? null;
}

/** Saves one value in the sync cursor. A null value removes the key. */
export async function setCursor(conn: Conn, key: string, value: unknown): Promise<void> {
  if (value === null || value === undefined) {
    await writeLive(conn, "update integrations set sync_cursor = sync_cursor - $4::text where id = $2 and exists (select 1 from live)", [key]);
    return;
  }
  await writeLive(
    conn,
    "update integrations set sync_cursor = jsonb_set(sync_cursor, array[$4::text], $5::jsonb, true) where id = $2 and exists (select 1 from live)",
    [key, JSON.stringify(value)]
  );
}
