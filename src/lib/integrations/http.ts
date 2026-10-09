export class IntegrationError extends Error {
  constructor(
    public kind: "reconnect" | "config" | "provider" | "rate_limit" | "changed" | "unreachable",
    message: string
  ) {
    super(message);
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const BACKOFF = [5_000, 15_000, 30_000];
const MAX_WAIT = 60_000;

const REJECTED: Record<string, string> = {
  ServiceM8: "ServiceM8 rejected the API key. Add a new key in Settings.",
  Xero: "Xero rejected our access. Connect Xero again in Settings.",
};

/** Seconds from a Retry-After header, which may also be an HTTP date. */
function retryAfter(res: Response): number | null {
  const h = res.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isNaN(at) ? null : Math.max(0, at - Date.now());
}

/**
 * fetch with a timeout, retries for busy or failing servers, and plain-English errors.
 * A 304 is returned as-is, for callers that send If-Modified-Since.
 */
export async function request(
  url: string,
  init: RequestInit & { label: string },
  opts: { retries?: number; timeoutMs?: number } = {}
): Promise<Response> {
  const { label, ...rest } = init;
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  for (let attempt = 0; ; attempt++) {
    const backoff = BACKOFF[Math.min(attempt, BACKOFF.length - 1)];
    let res: Response;
    try {
      res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" });
    } catch {
      // One quick retry for a blip. A service that is down stops the refresh rather than retrying every page.
      if (attempt < Math.min(retries, 1)) {
        await sleep(3_000);
        continue;
      }
      throw new IntegrationError("unreachable", `${label} could not be reached. Try again in a few minutes.`);
    }
    if (res.ok || res.status === 304) return res;

    if (res.status === 429) {
      const wait = retryAfter(res) ?? backoff;
      const daily = /day/i.test(res.headers.get("x-rate-limit-problem") ?? "") || /per day/i.test(await peek(res));
      await res.body?.cancel().catch(() => {});
      if (daily) throw new IntegrationError("rate_limit", `${label}'s daily limit has been reached. The refresh will carry on tomorrow.`);
      if (attempt >= retries || wait > MAX_WAIT) {
        throw new IntegrationError("rate_limit", `${label} is busy. The refresh will carry on next time.`);
      }
      await sleep(wait);
      continue;
    }

    if (res.status >= 500 && attempt < retries) {
      await res.body?.cancel().catch(() => {});
      await sleep(backoff);
      continue;
    }

    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      if (/insuff/i.test(res.headers.get("www-authenticate") ?? "")) {
        throw new IntegrationError("reconnect", `${label} has not given permission to read everything we need. Connect ${label} again and approve every item.`);
      }
      throw new IntegrationError("reconnect", REJECTED[label] ?? `${label} rejected our access. Connect it again in Settings.`);
    }

    const detail = (await peek(res)).replace(/\s+/g, " ").trim();
    throw new IntegrationError("provider", `${label} returned an error (${res.status}).${detail ? ` ${detail}` : ""}`);
  }
}

/** The first 300 characters of a response body, read once. */
const bodies = new WeakMap<Response, Promise<string>>();
function peek(res: Response): Promise<string> {
  let p = bodies.get(res);
  if (!p) {
    p = res
      .text()
      .then((t) => t.slice(0, 300))
      .catch(() => "");
    bodies.set(res, p);
  }
  return p;
}
