import { sql, dbMode, type Row } from "./db";
import { generate, generateJson, geminiModel, parseJson } from "./gemini";
import { syncTags } from "./tags";
import { captureLesson, detachLesson, feedbackStats, markSent, retrieveLessons, segmentOf } from "./feedback";
import { deliver, resendLive, testRecipients } from "./mailer";
import { googleAccount, googleConfigured } from "./google";
import { forgetApiTest, requireApis, testAllApis } from "./health";
import { schedulingSnapshot, startThread } from "./scheduler";
import { describeOpen, findContactsOnWebsite, qualifyFromWebsite, researchPerson, type Person, type PersonResearch } from "./research";
import { draftSafety, guard, icpDetail, sourcedSignal } from "./evals/checks";
import { stepFailures } from "./evals/runner";
import { DEFAULT_SETTINGS, getProfile, getSettings, icpKey, rankTitle, type IcpProfile, type Settings } from "./icp";

export { getSettings, type Settings };

// The basic funnel: ICP -> discover -> score/shortlist -> POC + pain points
// -> draft -> human edit -> send. Companies without enough information are
// researched by the scraper (scraper.ts, research.ts). Human edits to drafts
// feed the feedback loop (feedback.ts). Evals: src/lib/evals.

export const SHORTLIST_THRESHOLD = 70;

/**
 * Eval ICP-05: an ICP too thin to build a profile from is refused with a clear
 * message instead of being guessed at. Product and company name fall back to
 * the defaults when left empty.
 */
export function validateSettings(next: Settings): Settings {
  const out = { ...next, icp: String(next.icp ?? "").trim() };
  const thin = icpDetail(out.icp);
  if (thin) throw new Error(`Add more detail to the ICP: ${thin}.`);
  for (const k of ["product", "companyName"] as const) out[k] = String(out[k] ?? "").trim() || DEFAULT_SETTINGS[k];
  return out;
}

/**
 * Saves the settings. A new ICP first gets its profile (one model call), so a
 * failure leaves the old settings in place. Companies found for another ICP
 * stay in the database but drop out of view; saving that ICP again brings
 * them back.
 */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = validateSettings({ ...(await getSettings()), ...patch });
  await getProfile(next);
  await sql(
    `INSERT INTO settings (key, value) VALUES ('funnel', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [JSON.stringify(next)],
  );
  return next;
}

export async function getState() {
  await syncTags();
  const settings = await getSettings();
  const key = icpKey(settings);
  const [profile, companies, contacts, drafts, edits, lessons, feedback, scheduling] = await Promise.all([
    getProfile(settings),
    sql(`SELECT * FROM companies WHERE icp_key = $1 ORDER BY fit_score DESC NULLS LAST, id DESC`, [key]),
    sql(`SELECT * FROM contacts`),
    sql(`SELECT * FROM drafts`),
    sql(`SELECT count(*)::int AS n FROM draft_edits e JOIN drafts d ON d.id = e.draft_id JOIN companies c ON c.id = d.company_id WHERE c.icp_key = $1`, [key]),
    sql(`SELECT * FROM lessons WHERE draft_id IS NOT NULL`),
    feedbackStats(key),
    schedulingSnapshot(),
  ]);
  const visible = new Set(companies.map((c) => c.id));
  const [checks, lastEval] = await Promise.all([
    stepFailures(companies.map((c) => c.id)),
    sql(`SELECT id, passed, summary->'killFailed' AS kill, summary->'hardFailed' AS hard, summary->'softBelow' AS soft, finished_at FROM eval_runs WHERE icp_key = $1 AND status = 'done' ORDER BY id DESC LIMIT 1`, [key]),
  ]);
  const google = { configured: googleConfigured(), email: await googleAccount() };
  const withLesson = (d: Row | undefined) => (d ? { ...d, lesson: lessons.find((l) => l.draft_id === d.id) ?? null } : null);
  return {
    settings,
    companies: companies.map((c) => ({
      ...c,
      contact: contacts.find((p) => p.company_id === c.id) ?? null,
      draft: withLesson(drafts.find((d) => d.company_id === c.id)),
      thread: scheduling.threads.find((t) => t.company_id === c.id) ?? null,
      checks: checks.filter((x) => x.company_id === c.id).map((x) => ({ case_id: x.case_id, severity: x.severity, detail: x.detail })),
    })),
    lastEval: lastEval[0] ?? null,
    profile: { summary: profile.summary, custom: profile.custom, leadWith: profile.leadWith.label, incumbent: profile.incumbent.label, questions: profile.questions.map((q) => q.label), rubric: profile.rubric, threshold: SHORTLIST_THRESHOLD, warnings: profile.warnings ?? [] },
    notifications: scheduling.notifications.filter((n) => n.company_id === null || visible.has(n.company_id)),
    calendar: scheduling.calendar,
    rules: scheduling.rules,
    editsLogged: edits[0]?.n ?? 0,
    feedback,
    config: {
      db: dbMode(),
      model: geminiModel(),
      hunter: !!process.env.HUNTER_API_KEY,
      resend: resendLive(),
      google,
      testRecipient: testRecipients().join(", ") || null,
    },
    apis: await testAllApis(),
  };
}

function cleanDomain(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .trim();
}

async function getCompany(id: number): Promise<Row> {
  const rows = await sql(`SELECT * FROM companies WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error("Company not found");
  return rows[0];
}

function companyFacts(c: Row, profile: IcpProfile): string {
  return [
    `Name: ${c.name}`,
    `Website: ${c.domain}`,
    `What they do: ${c.description ?? "unknown"}`,
    `Funding stage: ${c.funding_stage ?? "unknown"} (${c.last_funding ?? "no round details"})`,
    `HQ: ${c.hq ?? "unknown"}`,
    `Employees: ${c.employees ?? "unknown"}`,
    `Target markets / customers: ${c.target_markets ?? "unknown"}`,
    `${profile.incumbent.label}: ${c.certifications_held ?? "unknown"}`,
    `Signals: ${(c.signals ?? []).join("; ") || "none found"}`,
  ].join("\n");
}

// ---------------------------------------------------------------- discovery

export type Found = {
  name: string;
  domain: string;
  description?: string;
  funding_stage?: string;
  last_funding?: string;
  hq?: string;
  employees?: string;
  target_markets?: string;
  certifications_held?: string;
  signals?: string[];
  /** Where the search found the company (eval DIS-06). Checked by fetching it before it is stored. */
  source_url?: string;
};

type Score = {
  domain: string;
  fit_score: number;
  fit_reason: string;
  recommended_framework: string;
  info_sufficient: boolean;
  missing_info?: string;
};

export async function scoreCompanies(settings: Settings, profile: IcpProfile, found: Found[]): Promise<Score[]> {
  const { data } = await generateJson<Score[] | Score>(
    `Score each company against this ICP for the seller described.

Seller: ${settings.companyName}. ${settings.product}
ICP: ${settings.icp}

Scoring rubric (0-100):
${profile.rubric.map((r) => `- ${r}`).join("\n")}
- Judge only from the facts given. Where facts are "unknown", do not assume them.

Set info_sufficient to false when the facts are too thin to judge ICP fit confidently, and say in
missing_info exactly what is missing (these companies will be sent to a scraper for more data).
recommended_framework is the ${profile.leadWith.label.toLowerCase()}: ${profile.leadWith.guide}.
fit_reason is 1-2 plain sentences citing the specific facts behind the score.

Companies:
${JSON.stringify(found, null, 1)}

"certifications_held" in the facts means: ${profile.incumbent.label.toLowerCase()}.

Return a JSON array with one item per company:
{"domain": string, "fit_score": number, "fit_reason": string, "recommended_framework": string,
 "info_sufficient": boolean, "missing_info": string}`,
    { temperature: 0.1 },
  );
  return Array.isArray(data) ? data : [data];
}

export async function discoverCompanies(count: number) {
  const settings = await getSettings();
  const profile = await getProfile(settings);
  const key = icpKey(settings);
  const known = (await sql(`SELECT domain FROM companies WHERE icp_key = $1`, [key])).map((r) => r.domain);

  // Step 1: find candidates with live Google Search.
  const search = await generate(
    `You are a B2B sales researcher for ${settings.companyName}:
${settings.product}

Ideal customer profile (ICP):
${settings.icp}

Use Google Search to find ${count} real companies that match this ICP right now. Prioritise companies showing
intent signals such as: ${profile.discovery.signals}.
${profile.discovery.avoid}
${known.length ? `Do not return any of these, they are already in the list: ${known.join(", ")}.` : ""}

Only state facts you found. If you could not find a fact, write "unknown" - never guess.

Return ONLY a JSON array, no prose, where each item is:
{"name": string, "domain": "example.com", "description": one sentence on what the product does,
 "funding_stage": e.g. "Seed", "Series A", "Series B", "Series C", "Series D+", "Bootstrapped", "Public" or "unknown",
 "last_funding": e.g. "$20M Series A, March 2026" or "unknown", "hq": "City, Country",
 "employees": e.g. "51-200" or "unknown", "target_markets": who they sell to and in which regions,
 "certifications_held": ${profile.incumbent.label.toLowerCase()}, e.g. ${profile.incumbent.example},
 "source_url": the full URL of the page that shows why this company matches (the news article, funding announcement or job post
   behind its signals); use its own website only if nothing else,
 "signals": [{"text": a short factual intent signal, "source": where it came from with its date, e.g. "TechCrunch, Mar 2026" or "company blog"}]}
Leave out any signal you cannot name a source for.`,
    // Not "fast": with low thinking the model tends to answer from memory instead of searching.
    { search: true, temperature: 0.3 },
  );

  const returned = parseJson<Found[]>(search.text).map((f) => ({
    ...f,
    domain: cleanDomain(f.domain),
    // Eval SCO-04: every signal names its source; unsourced ones are dropped.
    signals: (Array.isArray(f.signals) ? f.signals : []).map(sourcedSignal).filter((x): x is string => !!x),
  }));
  // Eval DIS-04: how many returned companies were already in the list (they are dropped here).
  const repeats = returned.filter((f) => known.includes(f.domain)).length;
  const found = returned.filter((f) => f.name && f.domain && !known.includes(f.domain)).slice(0, count);
  if (found.length === 0) return { added: 0, requested: count, returned: returned.length, repeats };

  // Step 2: score each candidate against the ICP, and check each company's source page loads (eval DIS-06).
  const [scores, checkedSources] = await Promise.all([scoreCompanies(settings, profile, found), Promise.all(found.map((f) => checkSource(f.source_url)))]);

  let added = 0;
  for (const [i, f] of found.entries()) {
    const s = scores.find((x) => cleanDomain(x.domain) === f.domain);
    const sources = [...new Set([checkedSources[i], ...search.sourceUrls.length ? search.sources : []].filter((x): x is string => !!x))].slice(0, 12);
    const score = s ? Math.max(0, Math.min(100, Math.round(Number(s.fit_score) || 0))) : null;
    const rows = await sql(
      `INSERT INTO companies (name, domain, description, funding_stage, last_funding, hq, employees,
         target_markets, certifications_held, signals, sources, fit_score, fit_reason,
         recommended_framework, info_sufficient, missing_info, status, scrape_status, icp_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (domain, icp_key) DO NOTHING RETURNING id`,
      [
        f.name, f.domain, f.description ?? null, f.funding_stage ?? null, f.last_funding ?? null,
        f.hq ?? null, f.employees ?? null, f.target_markets ?? null, f.certifications_held ?? null,
        JSON.stringify(f.signals ?? []), JSON.stringify(sources),
        score, s?.fit_reason ?? null, s?.recommended_framework ?? null,
        s?.info_sufficient ?? false, s?.missing_info ?? null,
        score !== null && score >= SHORTLIST_THRESHOLD ? "shortlisted" : "candidate",
        // Not enough information to judge fit: queue the company for the scraper.
        s?.info_sufficient ? "none" : "pending",
        key,
      ],
    );
    added += rows.length;
  }
  return { added, requested: count, returned: returned.length, repeats };
}

/**
 * Eval DIS-06: the page the search says it found a company on, kept only if it
 * really loads. Search redirect links are followed to the real page. Returns
 * the final URL, or null.
 */
async function checkSource(url: string | undefined): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Mozilla/5.0 (compatible; OutreachBot/1.0)" } });
    await res.body?.cancel().catch(() => {});
    // 401/403 means the page exists but blocks bots, which still proves it is real.
    return res.status < 400 || res.status === 401 || res.status === 403 ? res.url || url : null;
  } catch {
    return null;
  }
}

export async function setCompanyStatus(id: number, status: string) {
  if (!["candidate", "shortlisted", "rejected"].includes(status)) throw new Error("Invalid status");
  // status_manual: the human chose this status, so it may differ from the score (eval SCO-02).
  await sql(`UPDATE companies SET status = $1, status_manual = TRUE WHERE id = $2`, [status, id]);
}

export async function deleteCompany(id: number) {
  await sql(`DELETE FROM companies WHERE id = $1`, [id]);
}

// ------------------------------------------------------------------ scraper

/** The Growth Lead's own list of company websites. Each one is queued for the scraper. */
/** Eval DIS-07: pasted lines become clean, unique domains (at most 25); anything else is reported as skipped. */
export function normaliseWebsites(lines: string[]): { domains: string[]; skipped: string[] } {
  const domains: string[] = [];
  const skipped: string[] = [];
  for (const line of lines.map((l) => String(l ?? "").trim()).filter(Boolean)) {
    const domain = cleanDomain(line);
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain)) skipped.push(line);
    else if (!domains.includes(domain)) domains.push(domain);
  }
  return { domains: domains.slice(0, 25), skipped };
}

export async function addCompanies(websites: string[]) {
  const key = icpKey(await getSettings());
  let added = 0;
  const { domains, skipped } = normaliseWebsites(websites);
  for (const domain of domains) {
    const rows = await sql(
      `INSERT INTO companies (name, domain, info_sufficient, missing_info, scrape_status, icp_key)
       VALUES ($1, $1, FALSE, 'Not researched yet', 'pending', $2)
       ON CONFLICT (domain, icp_key) DO NOTHING RETURNING id`,
      [domain, key],
    );
    added += rows.length;
  }
  return { added, skipped };
}

const EXIT_TEXT: Record<string, string> = {
  decided: "Every question was answered.",
  not_fit: "Stopped early: it fails a must-have question.",
  sources_exhausted: "Stopped: every relevant page was tried.",
  page_limit: "Stopped: page limit reached.",
  request_limit: "Stopped: request limit reached.",
  time_limit: "Stopped: time limit reached.",
  site_unreachable: "The website could not be reached.",
};

/**
 * Researches one company from its website, then scores it. The scraper reads
 * the homepage and fetches further named pages only while a question about ICP
 * fit is still open. Whatever the exit, the company still gets an answer.
 */
export async function scrapeCompany(id: number) {
  const company = await getCompany(id);
  const settings = await getSettings();
  const profile = await getProfile(settings);
  try {
    const result = await qualifyFromWebsite(company, settings, profile);
    const f = result.facts;
    const keep = (next: string | undefined, current: string | null) =>
      next && !/^(unknown|n\/a)$/i.test(next.trim()) ? next : current;
    const merged = {
      name: f?.name && company.name === company.domain ? f.name : company.name,
      domain: company.domain,
      description: keep(f?.description, company.description) ?? undefined,
      funding_stage: keep(f?.funding_stage, company.funding_stage) ?? "unknown",
      last_funding: keep(f?.last_funding, company.last_funding) ?? "unknown",
      hq: keep(f?.hq, company.hq) ?? "unknown",
      employees: keep(f?.employees, company.employees) ?? "unknown",
      target_markets: keep(f?.target_markets, company.target_markets) ?? "unknown",
      certifications_held: keep(f?.certifications_held, company.certifications_held) ?? "unknown",
      signals: [...new Set([...(f?.signals ?? []), ...(company.signals ?? [])])].map(sourcedSignal).filter((x): x is string => !!x).slice(0, 8),
    };

    const summary = {
      exitReason: result.exitReason,
      exitText: EXIT_TEXT[result.exitReason],
      steps: result.steps,
      pagesRead: result.pagesRead,
      requests: result.requests,
      durationMs: result.durationMs,
      answers: Object.fromEntries(profile.questions.map((q) => [q.label, f?.answers?.[q.id] ?? "unknown"])),
    };
    const missing = result.decided ? null : `${EXIT_TEXT[result.exitReason]} Still unknown: ${describeOpen(result.open)}.`;

    // The system still has to answer, even on a forced exit: score with what it has.
    let score: Score | undefined;
    if (result.exitReason === "not_fit") {
      score = { domain: company.domain, fit_score: 10, fit_reason: `Fails a must-have (${result.failed ?? "fit question"}): ${merged.description ?? "see website"}`, recommended_framework: "", info_sufficient: true };
    } else if (f) {
      const answers = Object.fromEntries(profile.questions.map((q) => [q.id, f.answers?.[q.id] ?? "unknown"]));
      score = (await scoreCompanies(settings, profile, [{ ...merged, ...answers } as Found]))[0];
    }
    const fit = score ? Math.max(0, Math.min(100, Math.round(Number(score.fit_score) || 0))) : company.fit_score;

    await sql(
      `UPDATE companies SET name=$1, description=$2, funding_stage=$3, last_funding=$4, hq=$5, employees=$6,
         target_markets=$7, certifications_held=$8, signals=$9::jsonb, fit_score=$10, fit_reason=$11,
         recommended_framework=$12, info_sufficient=$13, missing_info=$14, status=$15,
         scrape_status='done', scrape_summary=$16::jsonb, status_manual = (status = 'rejected' AND status_manual)
       WHERE id=$17`,
      [
        merged.name, merged.description ?? null, merged.funding_stage, merged.last_funding, merged.hq, merged.employees,
        merged.target_markets, merged.certifications_held, JSON.stringify(merged.signals),
        fit, score?.fit_reason ?? company.fit_reason, score?.recommended_framework || company.recommended_framework,
        result.decided, missing,
        company.status === "rejected" ? "rejected" : fit !== null && fit >= SHORTLIST_THRESHOLD ? "shortlisted" : "candidate",
        JSON.stringify(summary), id,
      ],
    );
    return { exitReason: result.exitReason, pagesRead: result.pagesRead };
  } catch (err) {
    // Never leave a company stuck in "pending": that would re-queue it forever.
    await sql(`UPDATE companies SET scrape_status='failed', scrape_summary=$1::jsonb WHERE id=$2`, [
      JSON.stringify({ exitReason: "error", exitText: `Scrape failed: ${(err as Error).message}`, steps: [] }), id,
    ]);
    throw err;
  }
}

// ---------------------------------------------------------------------- POC

type HunterProfile = {
  organization: string | null; description: string | null; industry: string | null; headcount: string | null;
  company_type: string | null; location: string | null; technologies: string[]; linkedin: string | null;
};

/**
 * Kill guard (eval POC-02): at most one Hunter.io credit per company. Hunter
 * charges for a search that returns people and for a found email; an empty
 * search is free. Every charged request is logged in hunter_usage.
 */
async function hunterBudget(companyId: number) {
  const used = (await sql(`SELECT coalesce(sum(credits), 0)::int AS n FROM hunter_usage WHERE company_id = $1`, [companyId]))[0]?.n ?? 0;
  guard("POC-02", used >= 1 ? `this company has already used ${used} Hunter.io credit${used === 1 ? "" : "s"}` : null);
}

async function logHunter(companyId: number, domain: string, kind: string, credits: number) {
  if (credits > 0) await sql(`INSERT INTO hunter_usage (company_id, domain, kind, credits) VALUES ($1,$2,$3,$4)`, [companyId, domain, kind, credits]);
}

async function hunterDomainSearch(companyId: number, domain: string, filters: Record<string, string>): Promise<{ people: Person[]; profile: HunterProfile }> {
  await hunterBudget(companyId);
  const query = new URLSearchParams({ domain, limit: "10", type: "personal", ...filters });
  const res = await fetch(`https://api.hunter.io/v2/domain-search?${query}`, {
    headers: { "X-API-KEY": process.env.HUNTER_API_KEY! },
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    forgetApiTest("hunter");
    throw new Error(`Hunter.io: ${data?.errors?.[0]?.details ?? `HTTP ${res.status}`}`);
  }
  const d: Row = data?.data ?? {};
  const people: Person[] = (d.emails ?? [])
    .filter((e: Row) => e.value && e.first_name)
    .map((e: Row) => ({
      first_name: e.first_name ?? "",
      last_name: e.last_name ?? "",
      title: e.position ?? "",
      email: e.value,
      confidence: e.confidence ?? null,
      linkedin: e.linkedin ?? null,
      seniority: e.seniority ?? null,
      department: e.department ?? null,
      sourceUrls: (e.sources ?? []).filter((x: Row) => x.still_on_page !== false && x.uri).map((x: Row) => x.uri),
    }));
  // The same response carries Hunter's company profile, at no extra credit.
  const profile: HunterProfile = {
    organization: d.organization ?? null, description: d.description ?? null, industry: d.industry ?? null,
    headcount: d.headcount ?? null, company_type: d.company_type ?? null,
    location: [d.city, d.state, d.country].filter(Boolean).join(", ") || null,
    technologies: Array.isArray(d.technologies) ? d.technologies : [], linkedin: d.linkedin ?? null,
  };
  await logHunter(companyId, domain, "domain-search", (d.emails ?? []).length > 0 ? 1 : 0);
  return { people, profile };
}

/**
 * Everyone Hunter.io has for the domain, best contact first, plus its company
 * profile. Each Hunter call costs a credit, so:
 *  - the answer is cached per domain and reused on every later lookup;
 *  - it first asks only for senior people in the departments that own
 *    the ICP's buyer, and widens to everyone only when that returns nobody.
 */
async function hunterSearch(companyId: number, domain: string, profile: IcpProfile): Promise<{ people: Person[]; profile: HunterProfile | null; cached: boolean }> {
  const hit = (await sql(`SELECT people, profile FROM hunter_cache WHERE domain = $1`, [domain]))[0];
  // The cache is shared by every ICP; the ranking depends on the ICP, so it is done on the way out.
  const ranked = (people: Person[]) => [...people].sort((a, b) => rankTitle(a.title, profile) - rankTitle(b.title, profile) || (b.confidence ?? 0) - (a.confidence ?? 0));
  if (hit) return { people: ranked(hit.people), profile: hit.profile, cached: true };

  // About to spend a credit: make sure the key works and credits are left first.
  await requireApis(["hunter"]);
  const departments: Record<string, string> = profile.hunterDepartments.length ? { department: profile.hunterDepartments.join(",") } : {};
  let result = await hunterDomainSearch(companyId, domain, { seniority: "senior,executive", ...departments });
  if (result.people.length === 0) result = await hunterDomainSearch(companyId, domain, {});
  await sql(
    `INSERT INTO hunter_cache (domain, people, profile) VALUES ($1, $2::jsonb, $3::jsonb)
     ON CONFLICT (domain) DO UPDATE SET people = EXCLUDED.people, profile = EXCLUDED.profile, fetched_at = now()`,
    [domain, JSON.stringify(result.people), JSON.stringify(result.profile)],
  );
  return { ...result, people: ranked(result.people), cached: false };
}

/** Merges Hunter's company profile into the company record, filling gaps only. */
async function applyProfile(company: Row, profile: HunterProfile | null, icp: IcpProfile) {
  if (!profile) return;
  const blank = (v: unknown) => !v || /^unknown$/i.test(String(v));
  const signals: string[] = [...(company.signals ?? [])];
  // Tools that show the company already has a vendor for what the seller sells.
  const rival = profile.technologies.find((t) => icp.competitors.some((c) => t.toLowerCase().includes(c.toLowerCase())));
  if (rival && !signals.some((x) => x.includes(rival))) signals.push(`Already uses a competing tool: ${rival} (Hunter.io)`);
  await sql(`UPDATE companies SET profile = $1::jsonb, employees = $2, hq = $3, signals = $4::jsonb WHERE id = $5`, [
    JSON.stringify(profile),
    blank(company.employees) && profile.headcount ? profile.headcount : company.employees,
    blank(company.hq) && profile.location ? profile.location : company.hq,
    JSON.stringify(signals), company.id,
  ]);
}

async function hunterEmailFinder(companyId: number, domain: string, person: Person): Promise<{ email: string; confidence: number | null } | null> {
  await hunterBudget(companyId);
  const query = new URLSearchParams({ domain, first_name: person.first_name, last_name: person.last_name });
  const res = await fetch(`https://api.hunter.io/v2/email-finder?${query}`, {
    headers: { "X-API-KEY": process.env.HUNTER_API_KEY! },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => null);
  const data = res?.ok ? await res.json().catch(() => null) : null;
  await logHunter(companyId, domain, "email-finder", data?.data?.email ? 1 : 0);
  return data?.data?.email ? { email: data.data.email, confidence: data.data.score ?? null } : null;
}

/** What may be said about the person: only facts that were verified against a fetched source. */
function personNotes(research: PersonResearch | null | undefined): string {
  const verified = (research?.facts ?? []).filter((f) => typeof f === "object" && f.verified);
  if (verified.length === 0) return "nothing verified beyond their title";
  return verified.map((f) => `- ${f.text}`).join("\n");
}

async function painPoints(company: Row, title: string, settings: Settings, profile: IcpProfile, research: PersonResearch | null): Promise<string[]> {
  const { data } = await generateJson<{ pain_points: string[] }>(
    `Seller: ${settings.companyName}. ${settings.product}

Prospect company:
${companyFacts(company, profile)}

The person we will email holds this role: ${title || profile.roles[0]?.persona || "senior leader"}.
What we know about this person:
${personNotes(research)}

Give exactly two pain points this specific person is likely feeling right now about ${profile.painTopic}
(${company.recommended_framework || profile.leadWith.options.join(" / ") || "what the seller offers"}). Each must be tied to
their role AND to a concrete fact about this company above - not generic pain. Where what we
know about the person makes a pain more specific (their remit, their background), use it.
Each is one sentence, under 30 words.

Return JSON: {"pain_points": [string, string]}`,
    { temperature: 0.4 },
  );
  return (data.pain_points ?? []).slice(0, 2);
}

export async function findPoc(companyId: number) {
  const company = await getCompany(companyId);
  const settings = await getSettings();
  const profile = await getProfile(settings);

  let person: Person | null = null;
  let source = "mock";
  if (process.env.HUNTER_API_KEY) {
    const hunter = await hunterSearch(company.id, company.domain, profile);
    await applyProfile(company, hunter.profile, profile);
    person = hunter.people[0] ?? null;
    source = "hunter";
  }
  if (!person) {
    // Hunter.io has nobody for this company (or is not connected): look for a
    // named person on the company's own website with the scraper.
    const scraped = await findContactsOnWebsite(company, profile);
    person = scraped.people[0] ?? null;
    source = "scraped";
    // A name without an email: ask Hunter for that specific person's address.
    if (person && !person.email && process.env.HUNTER_API_KEY) {
      const found = await hunterEmailFinder(company.id, company.domain, person).catch(() => null);
      if (found) person = { ...person, ...found };
    }
  }
  if (!person) {
    // Nothing anywhere: a clearly fake placeholder so the rest of the funnel can
    // be exercised. Sending to a placeholder contact is blocked in sendDraft.
    person = { first_name: "Sample", last_name: "Contact", title: "CTO (placeholder)", email: `placeholder@${company.domain}`, confidence: null };
    source = "mock";
  }
  await researchAndSave(company, settings, profile, person, source);
}

/** Researches the person (unless they are a placeholder), works out their pain points and saves the contact. */
async function researchAndSave(company: Row, settings: Settings, profile: IcpProfile, person: Person, source: string) {
  // A research failure must not lose the contact, so it degrades to "nothing found".
  let research: PersonResearch | null = null;
  if (source !== "mock") {
    research = await researchPerson(company, person, profile).catch((err) => {
      console.error("Person research failed:", err);
      return null;
    });
  }

  const pains = await painPoints(company, person.title.replace(" (placeholder)", ""), settings, profile, research);
  await sql(
    `INSERT INTO contacts (company_id, first_name, last_name, title, email, confidence, source, pain_points, linkedin, research)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::jsonb)
     ON CONFLICT (company_id) DO UPDATE SET first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
       title = EXCLUDED.title, email = EXCLUDED.email, confidence = EXCLUDED.confidence,
       source = EXCLUDED.source, pain_points = EXCLUDED.pain_points, linkedin = EXCLUDED.linkedin,
       research = EXCLUDED.research`,
    [company.id, person.first_name, person.last_name, person.title, person.email, person.confidence, source, JSON.stringify(pains), person.linkedin ?? null, research ? JSON.stringify(research) : null],
  );
}

/** Re-runs the research and pain points for the contact already on file. Uses no Hunter.io credits. */
export async function researchPoc(companyId: number) {
  const company = await getCompany(companyId);
  const contact = (await sql(`SELECT * FROM contacts WHERE company_id = $1`, [companyId]))[0];
  if (!contact) throw new Error("Find the POC first");
  if (contact.source === "mock") throw new Error("This is a placeholder contact, there is nobody to research");
  const cached = (await sql(`SELECT people FROM hunter_cache WHERE domain = $1`, [company.domain]))[0];
  const known = (cached?.people ?? []).find((p: Person) => p.email && p.email === contact.email);
  const earlier: string[] = (contact.research?.steps ?? [])
    .filter((s: Row) => s.source === "contact_source" && typeof s.url === "string" && s.url.startsWith("http"))
    .map((s: Row) => s.url);
  const settings = await getSettings();
  await researchAndSave(company, settings, await getProfile(settings), {
    first_name: contact.first_name, last_name: contact.last_name, title: contact.title, email: contact.email,
    confidence: contact.confidence, linkedin: contact.linkedin, sourceUrls: known?.sourceUrls ?? earlier.slice(0, 2),
  }, contact.source);
}

/** Lets the human correct or enter the POC by hand. A hand-edited contact counts as real. */
export async function updateContact(id: number, patch: Row) {
  const rows = await sql(`SELECT * FROM contacts WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error("Contact not found");
  const c = { ...rows[0], ...patch };
  await sql(
    `UPDATE contacts SET first_name = $1, last_name = $2, title = $3, email = $4, source = 'manual' WHERE id = $5`,
    [c.first_name, c.last_name, c.title, c.email, id],
  );
}

// -------------------------------------------------------------------- draft

export async function draftEmail(companyId: number) {
  const company = await getCompany(companyId);
  const settings = await getSettings();
  const profile = await getProfile(settings);
  const contact = (await sql(`SELECT * FROM contacts WHERE company_id = $1`, [companyId]))[0];
  if (!contact) throw new Error("Find the POC before drafting the email");

  // Feedback loop, retrieve + apply: lessons from past human edits for
  // prospects with a similar ICP profile go into the prompt.
  const learned = await retrieveLessons(segmentOf(company, contact, profile), profile.key);
  const { data } = await generateJson<{ subject: string; hook: string; cta: string; body: string }>(
    `Write a cold outreach email.

Seller: ${settings.companyName}. ${settings.product}
Sender: ${settings.senderName || "[Your name]"}${settings.senderTitle ? `, ${settings.senderTitle}` : ""} at ${settings.companyName}

Recipient: ${contact.first_name} ${contact.last_name}, ${String(contact.title).replace(" (placeholder)", "")} at ${company.name}

About their company:
${companyFacts(company, profile)}

What we know about the recipient:
${personNotes(contact.research)}

Why they fit: ${company.fit_reason ?? "matches the ICP"}
${profile.leadWith.label}: ${company.recommended_framework || profile.leadWith.options[0] || "the best fit"}

Their two pain points:
${(contact.pain_points ?? []).map((p: string, i: number) => `${i + 1}. ${p}`).join("\n")}

${learned.promptBlock}
Rules:
- Open with "Hi ${contact.first_name}," then a hook: one sentence about a specific, real fact about
  THEIR company from above (a funding round, a hire, a launch, a market move). Never open with
  "I hope this finds you well", "I came across", or by introducing the sender.
- Weave in both pain points naturally, in their words, not as a list.
- Write for this person's seniority and remit. You may reference one thing we know about them if it is
  clearly relevant to ${profile.painTopic}, but never say where it was found and never sound like you researched them.
- One or two sentences on how ${settings.companyName} removes that pain. No feature lists, no buzzwords.
- End with one low-friction question as the call to action.
- 90-130 words, plain text, short paragraphs, sounds like one human writing to another.
- No exclamation marks, no emojis, no placeholders other than the sender name if it is unknown.
- Use only facts given above. Never invent customers, numbers or events.
- Sign off with the sender's name.
- Subject: under 7 words, lowercase-style, specific to them, not salesy.

Return JSON: {"subject": string, "hook": the hook sentence on its own, "cta": the closing question on its own,
 "body": the full email text}`,
    { temperature: 0.7 },
  );

  // The lesson from the draft being replaced is kept, but no longer tied to it.
  await detachLesson(companyId);
  await sql(
    `INSERT INTO drafts (company_id, contact_id, hook, cta, subject, body, original_subject, original_body, original_hook, original_cta, applied_lessons)
     VALUES ($1,$2,$3,$4,$5,$6,$5,$6,$3,$4,$7::jsonb)
     ON CONFLICT (company_id) DO UPDATE SET contact_id = EXCLUDED.contact_id, hook = EXCLUDED.hook, cta = EXCLUDED.cta,
       subject = EXCLUDED.subject, body = EXCLUDED.body, original_subject = EXCLUDED.original_subject,
       original_body = EXCLUDED.original_body, original_hook = EXCLUDED.original_hook, original_cta = EXCLUDED.original_cta,
       applied_lessons = EXCLUDED.applied_lessons, feedback = '', status = 'draft', sent_at = NULL, provider_id = NULL,
       updated_at = now()`,
    [companyId, contact.id, data.hook ?? "", data.cta ?? "", data.subject, data.body, JSON.stringify(learned.applied)],
  );
}

/**
 * Saves the human's changes. Whenever the email text actually changes, the
 * before/after pair and the written feedback are logged to draft_edits, and
 * the feedback loop captures what was changed.
 */
export async function saveDraft(id: number, patch: { subject?: string; body?: string; feedback?: string }) {
  const rows = await sql(`SELECT * FROM drafts WHERE id = $1`, [id]);
  const draft = rows[0];
  if (!draft) throw new Error("Draft not found");
  // After the send the email is final, but a note on what was wrong with it
  // can still be added: it is saved and the lesson is updated from it.
  const sent = draft.status !== "draft";
  if (sent && ((patch.subject ?? draft.subject) !== draft.subject || (patch.body ?? draft.body) !== draft.body)) {
    throw new Error("This email has already been sent and can no longer be edited");
  }

  const subject = patch.subject ?? draft.subject;
  const body = patch.body ?? draft.body;
  const feedback = patch.feedback ?? draft.feedback;
  const textChanged = subject !== draft.subject || body !== draft.body;

  await sql(
    `UPDATE drafts SET subject = $1, body = $2, feedback = $3, updated_at = now(),
       feedback_saved_at = CASE WHEN $3 IS DISTINCT FROM feedback THEN (CASE WHEN $3 = '' THEN NULL ELSE now() END) ELSE feedback_saved_at END
     WHERE id = $4`,
    [subject, body, feedback, id],
  );
  if (textChanged) {
    await sql(
      `INSERT INTO draft_edits (draft_id, before_subject, before_body, after_subject, after_body, feedback)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, draft.subject, draft.body, subject, body, feedback],
    );
  }

  // Feedback loop trigger: any change to the email or to the written feedback
  // re-captures the lesson for this draft. A capture failure must not lose the save.
  let learned = 0;
  let captureError: string | null = null;
  if (textChanged || feedback !== draft.feedback) {
    try {
      learned = (await captureLesson(id)).learned;
      if (sent) await markSent(id);
    } catch (err) {
      console.error("Feedback capture failed:", err);
      captureError = (err as Error).message;
    }
  }
  return { editLogged: textChanged, learned, captureError };
}

// --------------------------------------------------------------------- send

/**
 * The human pressed send. The email goes out through the recipient lock in
 * mailer.ts, and the after-send conversation (scheduler.ts) starts for this
 * company. While the lock is on, the draft stays open so it can be edited and
 * sent again.
 */
export async function sendDraft(id: number) {
  const draft = (await sql(`SELECT * FROM drafts WHERE id = $1`, [id]))[0];
  if (!draft) throw new Error("Draft not found");
  // Eval SND-03: every press of Send ends in a logged result or a logged error, never silence.
  const log = (ok: boolean, extra: { mode?: string; recipients?: string[]; error?: string }) =>
    sql(`INSERT INTO send_log (draft_id, company_id, ok, mode, recipients, error) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`, [
      id, draft.company_id, ok, extra.mode ?? null, JSON.stringify(extra.recipients ?? []), extra.error ?? null,
    ]).catch((err) => console.error("send_log write failed:", err));
  try {
    if (draft.status !== "draft") throw new Error("This email has already been sent");
    const contact = (await sql(`SELECT * FROM contacts WHERE id = $1`, [draft.contact_id]))[0];
    // Kill guard (eval POC-07): a placeholder contact is never emailed once the test lock is off.
    if (testRecipients().length === 0 && contact?.source === "mock") {
      throw new Error("This is a placeholder contact. Find or enter the real POC before sending.");
    }
    // Kill guard (eval DRF-04): no links or placeholders in an outreach email.
    guard("DRF-04", draftSafety(draft.subject, draft.body));
    // Kill guard (eval SND-06): a second Send of the same draft within 30 seconds is a double-click.
    const recent = await sql(`SELECT 1 FROM send_log WHERE draft_id = $1 AND ok AND created_at > now() - interval '30 seconds' LIMIT 1`, [id]);
    guard("SND-06", recent.length ? "this draft was sent less than 30 seconds ago" : null);

    const result = await deliver({ subject: draft.subject, body: draft.body, prospectEmail: contact?.email ?? null });
    await log(true, { mode: result.mode, recipients: result.delivered });
    // Feedback loop trigger on send: the version that went out is the final one.
    // If the human changed the email or wrote a note and no lesson was captured
    // yet (or the last capture failed), capture it now from the sent version.
    const edited = draft.subject !== draft.original_subject || draft.body !== draft.original_body || String(draft.feedback ?? "").trim() !== "";
    const hasLesson = (await sql(`SELECT 1 FROM lessons WHERE draft_id = $1`, [id])).length > 0;
    if (edited && !hasLesson) {
      try {
        await captureLesson(id);
      } catch (err) {
        console.error("Feedback capture on send failed:", err);
      }
    }
    await markSent(id);
    if (result.mode === "live") await sql(`UPDATE drafts SET status = 'sent', sent_at = now() WHERE id = $1`, [id]);
    if (result.mode === "simulated") await sql(`UPDATE drafts SET status = 'simulated', sent_at = now() WHERE id = $1`, [id]);
    const sentTo = result.mode === "simulated" ? "simulated, Resend not connected" : `to ${result.delivered.join(", ")}${result.gmail ? " from Gmail" : ""}`;
    await startThread(draft.company_id, draft.subject, draft.body, sentTo, result.gmail);
    return { status: result.mode === "live" ? "sent" : result.mode, to: result.delivered.join(", "), failed: result.failed };
  } catch (err) {
    await log(false, { error: (err as Error).message });
    throw err;
  }
}
