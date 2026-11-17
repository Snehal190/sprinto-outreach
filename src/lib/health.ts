import { checkGeminiKeys } from "./gemini";
import { checkGoogleSignIn, googleAccount } from "./google";
import { resendLive } from "./mailer";
import { dbMode, sql } from "./db";

// API tests. Before a step calls a paid or slow API, it first asks that API a
// free question ("is this key valid?", "how many credits are left?"). A broken
// key or an expired sign-in then fails in under a second with a clear reason,
// instead of after a long model call or halfway through a multi-step run.
//
// Results are cached: a passing test for 10 minutes, a failing one for 30
// seconds (so a fixed key is noticed quickly). A real call that fails with an
// auth error clears the cache so the next step tests again.

export type ApiName = "database" | "gemini" | "hunter" | "resend" | "google";

export type ApiStatus = {
  api: ApiName;
  label: string;
  ok: boolean;
  /** Not set up at all (no key). Steps that need it run in mock/simulated mode instead of failing. */
  off: boolean;
  detail: string;
  /** A few words for the dashboard pill, e.g. "58 credits left". */
  short: string;
  ms: number;
  checkedAt: string;
};

const PASS_FOR_MS = 10 * 60_000;
const FAIL_FOR_MS = 30_000;

const LABEL: Record<ApiName, string> = { database: "Database", gemini: "Gemini", hunter: "Hunter.io", resend: "Resend", google: "Google" };

const store = globalThis as unknown as { __health?: Map<ApiName, { at: number; status: ApiStatus; running?: Promise<ApiStatus> }> };
const cache = (store.__health ??= new Map());

async function timed(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  return { res, data: await res.json().catch(() => ({})) };
}

type Probe = Omit<ApiStatus, "api" | "label" | "ms" | "checkedAt" | "short"> & { short?: string };

async function probe(api: ApiName): Promise<Probe> {
  switch (api) {
    case "database": {
      await sql("SELECT 1");
      return { ok: true, off: false, short: dbMode() === "neon" ? "Neon" : "local", detail: dbMode() === "neon" ? "Neon reachable" : "local database" };
    }
    case "gemini": {
      const checks = await checkGeminiKeys(true);
      if (checks.length === 0) return { ok: false, off: true, detail: "no key in .env.local" };
      const good = checks.filter((c) => c.ok).length;
      const bad = checks.filter((c) => !c.ok).map((c) => `key ${c.key} ${c.detail}`);
      return { ok: good > 0, off: false, short: `${good}/${checks.length} keys`, detail: `${good} of ${checks.length} keys working${bad.length ? ` (${bad.join("; ")})` : ""}` };
    }
    case "hunter": {
      if (!process.env.HUNTER_API_KEY) return { ok: false, off: true, detail: "no key: lookups use the website instead" };
      const { res, data } = await timed("https://api.hunter.io/v2/account", { "X-API-KEY": process.env.HUNTER_API_KEY });
      if (!res.ok) return { ok: false, off: false, detail: data?.errors?.[0]?.details ?? `HTTP ${res.status}` };
      const credits = data?.data?.requests?.credits ?? data?.data?.requests?.searches ?? {};
      const left = Number(credits.remaining ?? Number(credits.available ?? 0) - Number(credits.used ?? 0));
      return {
        ok: left > 0, off: false, short: `${left} credits`,
        detail: left > 0 ? `${left} of ${credits.available} credits left, resets ${data?.data?.reset_date ?? "monthly"}` : `no credits left until ${data?.data?.reset_date ?? "the monthly reset"}`,
      };
    }
    case "resend": {
      if (!resendLive()) return { ok: false, off: true, detail: "no key: emails are simulated" };
      const { res, data } = await timed("https://api.resend.com/domains", { authorization: `Bearer ${process.env.RESEND_API_KEY}` });
      // A sending-only key is valid but may not list domains.
      if (res.ok || data?.name === "restricted_api_key") return { ok: true, off: false, short: "key valid", detail: "key valid" };
      return { ok: false, off: false, detail: data?.message ?? `HTTP ${res.status}` };
    }
    case "google": {
      const check = await checkGoogleSignIn();
      const notSetUp = check.detail === "not connected" || check.detail.startsWith("GOOGLE_CLIENT_ID");
      return { ok: check.ok, off: notSetUp, detail: check.detail };
    }
  }
}

/** Tests one API, using a recent result when there is one. Two callers at once share one test. */
export async function testApi(api: ApiName, force = false): Promise<ApiStatus> {
  const hit = cache.get(api);
  if (hit?.running) return hit.running;
  if (!force && hit && Date.now() - hit.at < (hit.status.ok ? PASS_FOR_MS : FAIL_FOR_MS)) return hit.status;
  const started = Date.now();
  const running = probe(api)
    .catch((err): Probe => ({ ok: false, off: false, detail: (err as Error).name === "TimeoutError" ? "no answer in 10s" : (err as Error).message }))
    .then((result) => {
      const short = result.short ?? (result.off ? "off" : result.ok ? "ok" : "failing");
      const status: ApiStatus = { api, label: LABEL[api], ...result, short, ms: Date.now() - started, checkedAt: new Date().toISOString() };
      cache.set(api, { at: Date.now(), status });
      return status;
    });
  cache.set(api, { at: hit?.at ?? 0, status: hit?.status ?? pending(api), running });
  return running;
}

function pending(api: ApiName): ApiStatus {
  return { api, label: LABEL[api], ok: false, off: false, detail: "not tested yet", short: "testing…", ms: 0, checkedAt: "" };
}

/** Tests every API in parallel. `force` ignores cached results (the dashboard's "Test APIs" button). */
export async function testAllApis(force = false): Promise<ApiStatus[]> {
  return Promise.all((Object.keys(LABEL) as ApiName[]).map((api) => testApi(api, force)));
}

/** Last known results, without calling anything. Unknown APIs are tested in the background. */
export function knownStatus(): ApiStatus[] {
  return (Object.keys(LABEL) as ApiName[]).map((api) => {
    const hit = cache.get(api);
    if (!hit || Date.now() - hit.at > PASS_FOR_MS) void testApi(api);
    return hit?.status ?? pending(api);
  });
}

/** A real call to this API failed: forget the cached result so the next step tests it again. */
export function forgetApiTest(api: ApiName) {
  cache.delete(api);
}

/**
 * The pre-call gate. Tests the APIs a step needs (in parallel, cached) and
 * throws before anything is called when one is broken. APIs that are not set
 * up at all are skipped: those steps already fall back to mock or simulated mode.
 */
export async function requireApis(apis: ApiName[]): Promise<void> {
  const results = await Promise.all([...new Set(apis)].map((api) => testApi(api)));
  const broken = results.filter((r) => !r.ok && !r.off);
  if (broken.length) throw new Error(`API test failed, so nothing was called. ${broken.map((r) => `${r.label}: ${r.detail}`).join(" · ")}`);
}

/** The email route that deliver() will take, so its API can be tested first. */
export async function mailApi(): Promise<ApiName[]> {
  if (await googleAccount()) return ["google"];
  return resendLive() ? ["resend"] : [];
}
