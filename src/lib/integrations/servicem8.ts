import { request } from "./http";

const BASE = "https://api.servicem8.com/api_1.0";

export const SM8_OBJECTS = ["staff", "category", "company", "job", "jobmaterial", "jobactivity", "jobpayment"] as const;
export type Sm8Object = (typeof SM8_OBJECTS)[number];

type Row = Record<string, unknown>;

function get(apiKey: string, path: string): Promise<Response> {
  return request(`${BASE}${path}`, {
    label: "ServiceM8",
    headers: { "X-API-Key": apiKey, Accept: "application/json" },
  });
}

export type Sm8Account = { accountName: string; vendorId: string };

/**
 * Checks a key works and returns the ServiceM8 account. vendorId is the account's own uuid, or
 * empty when the key cannot read it; the name is only for showing.
 */
export async function verifyKey(apiKey: string): Promise<Sm8Account> {
  try {
    const json = (await (await get(apiKey, "/vendor.json")).json()) as Row | Row[];
    const vendor = Array.isArray(json) ? json[0] : json;
    const name = typeof vendor?.name === "string" ? vendor.name.trim() : "";
    const uuid = typeof vendor?.uuid === "string" ? vendor.uuid.trim() : "";
    return { accountName: name || "ServiceM8", vendorId: uuid };
  } catch {
    await (await get(apiKey, "/taxrate.json?cursor=-1")).body?.cancel();
    return { accountName: "ServiceM8", vendorId: "" };
  }
}

/** Data read with the old key is kept only when both keys are known to belong to the same account. Names prove nothing. */
export const sameServiceM8Account = (before: string | null | undefined, vendorId: string) => !!before && !!vendorId && before === vendorId;

export type Sm8Page = { rows: Row[]; next: string | null };

/**
 * Every page of an object, with the cursor for the page after it. `from` resumes a listing
 * part way through. The filter must be encoded by hand: ServiceM8 ignores a filter sent with
 * "+" for spaces and returns everything.
 */
export async function* cursorPages(apiKey: string, object: string, filter?: string, from = "-1"): AsyncGenerator<Sm8Page> {
  let cursor = from;
  const seen = new Set([cursor]);
  for (;;) {
    const qs = `${filter ? `%24filter=${encodeURIComponent(filter)}&` : ""}cursor=${encodeURIComponent(cursor)}`;
    const res = await get(apiKey, `/${object}.json?${qs}`);
    const json = (await res.json()) as unknown;
    const header = res.headers.get("x-next-cursor")?.trim() || null;
    const next = header && !seen.has(header) ? header : null;
    yield { rows: Array.isArray(json) ? (json as Row[]) : [], next };
    if (!next) return;
    seen.add(next);
    cursor = next;
  }
}

/** Every page of an object. Values come back as strings, exactly as ServiceM8 sends them. */
export async function* pages(apiKey: string, object: string, filter?: string): AsyncGenerator<Row[]> {
  for await (const page of cursorPages(apiKey, object, filter)) yield page.rows;
}

/** Jobs invoiced and not yet paid, however long ago they were last edited. */
export const openJobPages = (apiKey: string) => cursorPages(apiKey, "job", "invoice_sent eq '1' and payment_received eq '0'");
