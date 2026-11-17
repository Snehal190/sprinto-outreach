// Gemini client with key failover. Keys are tried in order; when one fails
// (invalid, rate limited, quota, server error) the next one is used, and the
// last key that worked is remembered so a dead key is not retried every call.

const DEFAULT_MODEL = "gemini-flash-latest";
const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

function keys(): string[] {
  return [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY,
  ].filter((k): k is string => !!k && k.trim().length > 0);
}

export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
}

let preferred = 0;

// ------------------------------------------------------------- key check

export type KeyCheck = { key: number; ok: boolean; detail: string };

const keyCache = globalThis as unknown as { __geminiKeys?: { at: number; checks: KeyCheck[] } };
const KEYS_OK_FOR_MS = 10 * 60_000;

/**
 * Asks Gemini whether each key is valid, without generating anything (a free
 * model-metadata request, ~150 ms). Cached for 10 minutes, so real calls only
 * try keys that work instead of waiting for a dead key to fail first.
 */
export async function checkGeminiKeys(force = false): Promise<KeyCheck[]> {
  const cached = keyCache.__geminiKeys;
  if (!force && cached && Date.now() - cached.at < KEYS_OK_FOR_MS) return cached.checks;
  const checks = await Promise.all(
    keys().map(async (key, index): Promise<KeyCheck> => {
      try {
        const res = await fetch(`${BASE}/${geminiModel()}`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(10_000) });
        if (res.ok) return { key: index + 1, ok: true, detail: "valid" };
        const data = await res.json().catch(() => ({}));
        return { key: index + 1, ok: false, detail: `${res.status} ${data?.error?.message ?? ""}`.trim() };
      } catch (err) {
        return { key: index + 1, ok: false, detail: (err as Error).name === "TimeoutError" ? "no answer in 10s" : (err as Error).message };
      }
    }),
  );
  keyCache.__geminiKeys = { at: Date.now(), checks };
  return checks;
}

/** Keys that passed the check, in order. Throws at once when none do, before any real call. */
async function usableKeys(): Promise<{ key: string; index: number }[]> {
  const all = keys();
  if (all.length === 0) throw new Error("No Gemini API key is set in .env.local");
  const checks = await checkGeminiKeys();
  const usable = all.map((key, index) => ({ key, index })).filter(({ index }) => checks[index]?.ok);
  if (usable.length === 0) {
    keyCache.__geminiKeys = undefined; // check again next time, in case a key was fixed
    throw new Error(`Gemini API test failed before the call: ${checks.map((c) => `key ${c.key}: ${c.detail}`).join(" | ")}`);
  }
  return usable;
}

/** A key failed during a real call: forget the check so the next call tests the keys again. */
function forgetKeyCheck() {
  keyCache.__geminiKeys = undefined;
}

type Options = {
  /** Let the model use Google Search for live facts. */
  search?: boolean;
  /** Ask for a JSON response (not combinable with search). */
  json?: boolean;
  temperature?: number;
  /** Fast mode: minimal model reasoning. Grounded search is ~4x faster with it. */
  fast?: boolean;
};

export type GeminiResult = { text: string; sources: string[]; /** Pages the search-grounded answer was based on. */ sourceUrls: string[] };

export async function generate(prompt: string, opts: Options = {}): Promise<GeminiResult> {
  const all = await usableKeys();

  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: opts.temperature ?? 0.4,
      ...(opts.json && !opts.search ? { responseMimeType: "application/json" } : {}),
      ...(opts.fast ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
    },
    ...(opts.search ? { tools: [{ google_search: {} }] } : {}),
  };

  const errors: string[] = [];
  for (let attempt = 0; attempt < all.length; attempt++) {
    const pos = (preferred + attempt) % all.length;
    const index = all[pos].index;
    try {
      const res = await fetch(`${BASE}/${geminiModel()}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": all[pos].key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(240_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message: string = data?.error?.message ?? `HTTP ${res.status}`;
        // A malformed request fails the same way on every key, so stop early.
        if (res.status === 400 && !/api key/i.test(message)) {
          throw Object.assign(new Error(`Gemini rejected the request: ${message}`), { fatal: true });
        }
        errors.push(`key ${index + 1}: ${res.status} ${message}`);
        if (res.status === 400 || res.status === 401 || res.status === 403) forgetKeyCheck();
        continue;
      }
      const candidate = data?.candidates?.[0];
      const text: string = (candidate?.content?.parts ?? [])
        .map((p: { text?: string }) => p.text ?? "")
        .join("");
      if (!text.trim()) {
        errors.push(`key ${index + 1}: empty response (${candidate?.finishReason ?? "unknown"})`);
        continue;
      }
      const sources: string[] = (candidate?.groundingMetadata?.groundingChunks ?? [])
        .map((c: { web?: { title?: string; uri?: string } }) => c.web?.title || c.web?.uri)
        .filter(Boolean);
      preferred = pos;
      const sourceUrls: string[] = (candidate?.groundingMetadata?.groundingChunks ?? [])
        .map((c: { web?: { uri?: string } }) => c.web?.uri)
        .filter(Boolean);
      return { text, sources: [...new Set(sources)], sourceUrls: [...new Set(sourceUrls)] };
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err;
      // A timeout is not a key problem, so trying the next key would only repeat the wait.
      if ((err as Error).name === "TimeoutError") throw new Error("Gemini took too long to respond. Try again, or ask for fewer companies.");
      errors.push(`key ${index + 1}: ${(err as Error).message}`);
    }
  }
  throw new Error(`All Gemini keys failed. ${errors.join(" | ")}`);
}

/** Pulls the first JSON value out of a model response, tolerating code fences and prose. */
export function parseJson<T>(text: string): T {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf("]"), cleaned.lastIndexOf("}"));
    if (start === -1 || end <= start) throw new Error("The model did not return JSON");
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  }
}

export async function generateJson<T>(prompt: string, opts: Options = {}): Promise<{ data: T; sources: string[] }> {
  const result = await generate(prompt, { ...opts, json: true });
  return { data: parseJson<T>(result.text), sources: result.sources };
}

// ------------------------------------------------------------- tool calling

export type ToolDeclaration = { name: string; description: string; parameters: Record<string, unknown> };
export type Part = { text?: string; functionCall?: { name: string; args: Record<string, unknown>; id?: string }; [key: string]: unknown };
export type Content = { role: "user" | "model"; parts: Part[] };

/**
 * One model turn in a tool-calling conversation. The model receives only the
 * tool names and descriptions, never the code, and answers either with text or
 * with a decision to call a tool. Nothing is executed here: the caller runs
 * the real function and sends the result back in the next turn.
 */
export async function converse(input: { system: string; contents: Content[]; tools: ToolDeclaration[] }): Promise<Content> {
  const all = await usableKeys();
  const body = {
    systemInstruction: { parts: [{ text: input.system }] },
    contents: input.contents,
    tools: [{ functionDeclarations: input.tools }],
    generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: "low" } },
  };
  const errors: string[] = [];
  for (let attempt = 0; attempt < all.length; attempt++) {
    const pos = (preferred + attempt) % all.length;
    const index = all[pos].index;
    try {
      const res = await fetch(`${BASE}/${geminiModel()}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": all[pos].key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message: string = data?.error?.message ?? `HTTP ${res.status}`;
        if (res.status === 400 && !/api key/i.test(message)) throw Object.assign(new Error(`Gemini rejected the request: ${message}`), { fatal: true });
        errors.push(`key ${index + 1}: ${res.status} ${message}`);
        if (res.status === 400 || res.status === 401 || res.status === 403) forgetKeyCheck();
        continue;
      }
      const content = data?.candidates?.[0]?.content;
      if (!content?.parts?.length) {
        errors.push(`key ${index + 1}: empty response`);
        continue;
      }
      preferred = pos;
      // Returned exactly as received: the parts carry signatures the model needs to see again.
      return { role: "model", parts: content.parts };
    } catch (err) {
      if ((err as { fatal?: boolean }).fatal) throw err;
      if ((err as Error).name === "TimeoutError") throw new Error("Gemini took too long to respond.");
      errors.push(`key ${index + 1}: ${(err as Error).message}`);
    }
  }
  throw new Error(`All Gemini keys failed. ${errors.join(" | ")}`);
}
