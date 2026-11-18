import type { Row } from "./db";
import { generate, generateJson } from "./gemini";
import { rankTitle, type FitQuestion, type IcpProfile, type Settings } from "./icp";
import { candidateUrls, loadRobots, scrapePage, store, type Hint, type Link, type PageType, type ScrapedPage, type SitePage } from "./scraper";

// The adaptive part of the scraper. A fixed pipeline reads one page and has to
// qualify the company from whatever it finds. This one reads the homepage,
// asks "can I decide whether this company fits the ICP?", and when it cannot,
// fetches one specific named source for the question that is still open.
//
//   Scrape homepage -> Extract -> Qualify -> needs more info? -> fetch named source -> ...
//
// The loop always ends: see LIMITS and the exit reasons below.

export const LIMITS = {
  /** Pages read per company, including the homepage. */
  maxPages: 8,
  /** Network requests per company, including pages that turn out not to exist. */
  maxRequests: 14,
  /** Wall-clock budget per company. */
  timeBudgetMs: 180_000,
  /** Pages read when looking for a contact. */
  maxContactPages: 3,
  /** Pages read when researching a known contact, before the single web search. */
  maxPersonPages: 2,
  /** Source pages fetched to check researched facts against. */
  maxVerifyPages: 3,
};

// The questions that decide ICP fit come from the ICP profile (icp.ts), each
// with the named sources that can answer it, best first. "Name what you
// fetch": a source that answers two open questions at once wins (for the
// default ICP, missing stage and compliance signal -> the careers page).

export type ExitReason =
  | "decided" // every question answered
  | "not_fit" // a must-have question came back "no": no need to read further
  | "sources_exhausted" // nothing left to fetch for the open questions
  | "page_limit"
  | "request_limit"
  | "time_limit"
  | "site_unreachable";

export type Facts = {
  name: string;
  description: string;
  /** One answer per fit question, keyed by question id. */
  answers: Record<string, string>;
  funding_stage: string;
  last_funding: string;
  hq: string;
  employees: string;
  target_markets: string;
  certifications_held: string;
  signals: string[];
};

export type Step = { source: PageType; why: string; url: string | null; outcome: string; openAfter: string[] };

export type QualifyResult = {
  facts: Facts | null;
  decided: boolean;
  /** Labels of the questions still open. */
  open: string[];
  /** The must-have question that ruled the company out. */
  failed?: string;
  exitReason: ExitReason;
  steps: Step[];
  pagesRead: number;
  requests: number;
  durationMs: number;
};

type Session = {
  companyId: number;
  profile: IcpProfile;
  domain: string;
  origin: string;
  allowed: (path: string) => boolean;
  links: Link[];
  visited: Set<string>;
  tried: Set<PageType>;
  pages: ScrapedPage[];
  requests: number;
  started: number;
};

const unknown = (v: unknown) => !v || /^(unknown|n\/a|none|not (found|stated|specified))$/i.test(String(v).trim());

function pickSource(open: FitQuestion[], tried: Set<PageType>): PageType | null {
  let best: PageType | null = null;
  let bestScore = -1;
  for (const question of open) {
    question.sources.forEach((source, position) => {
      if (tried.has(source)) return;
      const answers = open.filter((q) => (q.sources as PageType[]).includes(source)).length;
      const score = answers * 10 - position;
      if (score > bestScore) {
        best = source;
        bestScore = score;
      }
    });
  }
  return best;
}

const hintsOf = (profile: IcpProfile): Hint[] => profile.keywords.map((k) => [k.label, k.pattern]);

async function openSite(companyId: number, domain: string, profile: IcpProfile): Promise<{ session: Session; home: ScrapedPage } | null> {
  for (const origin of [`https://${domain}`, `https://www.${domain}`]) {
    const result = await scrapePage(origin, "homepage", undefined, hintsOf(profile));
    if ("page" in result) {
      const finalOrigin = new URL(result.page.url).origin;
      const session: Session = {
        companyId, profile, domain, origin: finalOrigin,
        allowed: await loadRobots(finalOrigin),
        links: result.page.links,
        visited: new Set([result.page.url]),
        tried: new Set<PageType>(["homepage"]),
        pages: [result.page],
        requests: 2,
        started: Date.now(),
      };
      return { session, home: result.page };
    }
  }
  return null;
}

/** Fetches one named source. Returns the page, or a short reason it could not be read. */
async function fetchSource(session: Session, source: PageType, purpose: "qualify" | "contacts", company: Row): Promise<ScrapedPage | string> {
  session.tried.add(source);

  if (source === "funding_search" || source === "news_search") {
    session.requests++;
    const prompt =
      source === "funding_search"
        ? `Use Google Search to find the most recent funding round of the company "${company.name}" (website ${session.domain}).
Answer in at most three sentences: the round (Seed, Series A, B, C...), the amount, the date and the lead investor.
State only what you found. If you cannot find a funding round, answer exactly "unknown".`
        : `Use Google Search for news from the last 12 months about the company "${company.name}" (website ${session.domain})
that shows ${session.profile.newsQuery}.
Answer with at most five bullet points, each with its date and source. State only what you found.
If you find nothing relevant, answer exactly "nothing found".`;
    const result = await generate(prompt, { search: true, fast: true, temperature: 0.1 });
    const page: ScrapedPage = {
      pageType: source, url: `google-search:${source === "funding_search" ? "funding" : "news"}`, status: 200,
      title: source === "funding_search" ? "Funding lookup" : "News lookup", description: "",
      text: result.text.trim(), links: [], emails: [], hints: [], thin: false,
    };
    session.pages.push(page);
    await store(session.companyId, purpose, page);
    return page;
  }
  if (source === "homepage" || source === "contact_source" || source === "person_search") return "not a site page";

  let reason = "no such page on the site";
  for (const url of candidateUrls(source as SitePage, session.domain, session.origin, session.links)) {
    if (session.visited.has(url)) continue;
    const parsed = new URL(url);
    if (parsed.origin === session.origin && !session.allowed(parsed.pathname)) {
      reason = "blocked by robots.txt";
      continue;
    }
    if (session.requests >= LIMITS.maxRequests) return "request limit reached";
    session.requests++;
    session.visited.add(url);
    const result = await scrapePage(url, source, undefined, hintsOf(session.profile));
    if ("error" in result) continue;
    if (session.visited.has(result.page.url) && result.page.url !== url) continue; // redirected to a page already read
    session.visited.add(result.page.url);
    session.links.push(...result.page.links);
    session.pages.push(result.page);
    await store(session.companyId, purpose, result.page);
    return result.page;
  }
  return reason;
}

function pagesForPrompt(pages: ScrapedPage[]): string {
  return pages
    .map(
      (p) => `=== ${p.pageType.toUpperCase()} (${p.url}) ===
Title: ${p.title || "-"}
Meta description: ${p.description || "-"}
Keyword findings: ${p.hints.join("; ") || "none"}
${p.thin ? "(This page had almost no readable text, it is probably rendered by JavaScript.)\n" : ""}${p.text}`,
    )
    .join("\n\n");
}

// Model-based extraction: reads the cleaned text for meaning, so it survives
// any site layout. One call per round, over everything read so far.
async function extractFacts(session: Session, company: Row, settings: Settings): Promise<Facts> {
  const { questions, incumbent } = session.profile;
  const { data } = await generateJson<Facts>(
    `You are qualifying a company for a seller. Extract facts ONLY from the material below.

Seller: ${settings.companyName}. ${settings.product}
ICP: ${settings.icp}

Already known from earlier research (keep unless the website contradicts it):
name: ${company.name}; description: ${company.description ?? "unknown"}; funding stage: ${company.funding_stage ?? "unknown"} (${company.last_funding ?? "unknown"});
hq: ${company.hq ?? "unknown"}; employees: ${company.employees ?? "unknown"}; sells to: ${company.target_markets ?? "unknown"};
${incumbent.label.toLowerCase()}: ${company.certifications_held ?? "unknown"}; signals: ${(company.signals ?? []).join("; ") || "none"}

Material read from ${session.domain}:
${pagesForPrompt(session.pages)}

Rules:
- Write "unknown" for anything the material does not state. Never guess a funding stage from company size or tone.
- answers: one entry per question below, keyed by its id. For yes/no questions answer "yes", "no" or "unknown";
  answer "no" only when the material clearly shows it - missing evidence is "unknown". For value questions give
  the short value, or "unknown".
${questions.map((q) => `  - ${q.id} (${q.kind === "value" ? "value" : "yes/no"}): ${q.label}. ${q.rule}`).join("\n")}
- signals: up to 6 short factual signals relevant to the ICP, each naming the page it came from.

Return JSON:
{"name": company name, "description": one sentence on what the company does,
 "answers": {${questions.map((q) => `"${q.id}": string`).join(", ")}},
 "funding_stage": "Seed"|"Series A"|"Series B"|"Series C"|"Series D+"|"Bootstrapped"|"Public"|"unknown",
 "last_funding": string, "hq": string, "employees": string, "target_markets": string,
 "certifications_held": ${incumbent.label.toLowerCase()}, e.g. ${incumbent.example},
 "signals": [string]}`,
    { temperature: 0.1, fast: true },
  );
  const answers: Record<string, string> = {};
  for (const q of questions) answers[q.id] = String(data.answers?.[q.id] ?? "unknown").trim() || "unknown";
  return { ...data, answers, signals: Array.isArray(data.signals) ? data.signals : [] };
}

/** Which questions are still open. Decided in code, not by the model, so it is predictable. */
function openQuestions(facts: Facts, tried: Set<PageType>, profile: IcpProfile): FitQuestion[] {
  return profile.questions.filter((q) => {
    const answer = facts.answers[q.id];
    if (q.evidence) {
      // "No evidence" only counts as an answer once the sources that would show it have been tried.
      return !/^yes$/i.test(answer ?? "") && !q.sources.every((s) => tried.has(s));
    }
    return unknown(answer);
  });
}

/** The must-have question this company clearly fails, if any. */
function failedGate(facts: Facts, profile: IcpProfile): FitQuestion | undefined {
  return profile.questions.find((q) => q.gate && /^no$/i.test(facts.answers[q.id] ?? ""));
}

export function describeOpen(open: string[]): string {
  return open.join(", ");
}

export async function qualifyFromWebsite(company: Row, settings: Settings, profile: IcpProfile): Promise<QualifyResult> {
  const started = Date.now();
  const steps: Step[] = [];
  const ids = (qs: FitQuestion[]) => qs.map((q) => q.id);
  const finish = (session: Session | null, facts: Facts | null, open: FitQuestion[], exitReason: ExitReason, failed?: string): QualifyResult => ({
    facts, open: open.map((q) => q.label), exitReason, steps, failed,
    decided: exitReason === "decided" || exitReason === "not_fit",
    pagesRead: session?.pages.length ?? 0,
    requests: session?.requests ?? 2,
    durationMs: Date.now() - started,
  });

  const opened = await openSite(company.id, company.domain, profile);
  if (!opened) {
    steps.push({ source: "homepage", why: "starting point", url: `https://${company.domain}`, outcome: "could not be reached", openAfter: ids(profile.questions) });
    return finish(null, null, profile.questions, "site_unreachable");
  }
  const { session, home } = opened;
  await store(company.id, "qualify", home);

  let facts = await extractFacts(session, company, settings);
  let open = openQuestions(facts, session.tried, profile);
  steps.push({ source: "homepage", why: "starting point", url: home.url, outcome: home.thin ? "read, but almost no text" : "read", openAfter: ids(open) });

  // Each pass either answers a question, uses up a source, or hits a limit, so
  // the loop cannot run more than (number of sources) times.
  for (;;) {
    const failed = failedGate(facts, profile);
    if (failed) return finish(session, facts, [], "not_fit", failed.label);
    if (open.length === 0) return finish(session, facts, open, "decided");
    if (session.pages.length >= LIMITS.maxPages) return finish(session, facts, open, "page_limit");
    if (session.requests >= LIMITS.maxRequests) return finish(session, facts, open, "request_limit");
    if (Date.now() - started > LIMITS.timeBudgetMs) return finish(session, facts, open, "time_limit");

    const source = pickSource(open, session.tried);
    if (!source) return finish(session, facts, open, "sources_exhausted");

    const why = `to find ${open.filter((q) => (q.sources as PageType[]).includes(source)).map((q) => q.label).join(", ")}`;
    const result = await fetchSource(session, source, "qualify", company);
    if (typeof result === "string") {
      open = openQuestions(facts, session.tried, profile);
      steps.push({ source, why, url: null, outcome: result, openAfter: ids(open) });
      continue;
    }
    facts = await extractFacts(session, company, settings);
    open = openQuestions(facts, session.tried, profile);
    steps.push({ source, why, url: result.url, outcome: result.thin ? "read, but almost no text" : "read", openAfter: ids(open) });
  }
}

// ----------------------------------------------------------------- contacts

export type Person = {
  first_name: string;
  last_name: string;
  title: string;
  email: string | null;
  confidence: number | null;
  linkedin?: string | null;
  seniority?: string | null;
  department?: string | null;
  /** Public pages Hunter.io found this person's email on. */
  sourceUrls?: string[];
};

/** A researched claim. Only facts with verified = true are used in pain points and emails. */
export type Fact = { text: string; verified: boolean; url: string | null; quote: string | null };

export type PersonResearch = { summary: string; facts: Fact[]; steps: Step[] };


/**
 * Fallback for when Hunter.io has nobody for the company: the same pipeline,
 * pointed at the team and about pages. Stops as soon as one of the ICP's top
 * two buyer roles is found, or after LIMITS.maxContactPages pages.
 */
export async function findContactsOnWebsite(company: Row, profile: IcpProfile): Promise<{ people: Person[]; steps: Step[] }> {
  const steps: Step[] = [];
  const opened = await openSite(company.id, company.domain, profile);
  if (!opened) return { people: [], steps: [{ source: "homepage", why: "starting point", url: null, outcome: "could not be reached", openAfter: [] }] };
  const { session } = opened;

  const people: Person[] = [];
  const readPeople = async (page: ScrapedPage) => {
    if (page.thin) return;
    const { data } = await generateJson<{ people: Person[] }>(
      `From this web page of ${company.name} (${session.domain}), list the people who work at the company and are named
on the page together with their job title. Include only founders, executives, and these roles:
${profile.roles.map((r) => r.persona).join(", ")}. Skip investors, advisors, board members, customers and testimonials.
"email" is an address printed on the page for that exact person, otherwise null. Never construct or guess an email.
Emails seen on the page: ${page.emails.join(", ") || "none"}

Page text:
${page.text}

Return JSON: {"people": [{"first_name": string, "last_name": string, "title": string, "email": string|null}]}`,
      { temperature: 0, fast: true },
    );
    for (const p of data.people ?? []) {
      if (!p.first_name || !p.title) continue;
      if (people.some((x) => `${x.first_name} ${x.last_name}`.toLowerCase() === `${p.first_name} ${p.last_name}`.toLowerCase())) continue;
      people.push({ first_name: p.first_name, last_name: p.last_name ?? "", title: p.title, email: p.email || null, confidence: null });
    }
  };

  for (const source of ["team", "about"] as PageType[]) {
    if (session.pages.length - 1 >= LIMITS.maxContactPages) break;
    const result = await fetchSource(session, source, "contacts", company);
    if (typeof result === "string") {
      steps.push({ source, why: "to find a named contact", url: null, outcome: result, openAfter: [] });
      continue;
    }
    await readPeople(result);
    steps.push({ source, why: "to find a named contact", url: result.url, outcome: `read, ${people.length} people found so far`, openAfter: [] });
    if (people.some((p) => rankTitle(p.title, profile) <= 1)) break;
  }
  // Small companies often name their founders on the homepage only.
  if (people.length === 0) {
    await readPeople(session.pages[0]);
    steps.push({ source: "homepage", why: "no team page had names", url: session.pages[0].url, outcome: `read, ${people.length} people found`, openAfter: [] });
  }

  people.sort((a, b) => rankTitle(a.title, profile) - rankTitle(b.title, profile) || Number(!!b.email) - Number(!!a.email));
  return { people, steps };
}

// ---------------------------------------------------------- person research

// -------------------------------------------------------------- verification

const VERIFY_TEXT_CHARS = 12_000;
const normalise = (t: string) => t.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, " ").trim();

/**
 * Checks researched claims against the pages they came from. A claim counts as
 * verified only when (1) the model points to a passage that supports it and
 * (2) that exact passage really is in the page text we fetched ourselves. The
 * second check is done in code, so the model cannot approve its own claim.
 * Budget: LIMITS.maxVerifyPages fetched pages and one model call.
 */
async function verifyFacts(companyId: number, claims: string[], sourceUrls: string[], alreadyRead: { url: string; text: string }[]): Promise<{ facts: Fact[]; pagesRead: number }> {
  const unverified = (): Fact[] => claims.map((text) => ({ text, verified: false, url: null, quote: null }));
  if (claims.length === 0) return { facts: [], pagesRead: 0 };

  const sources = [...alreadyRead];
  let pagesRead = 0;
  for (const url of sourceUrls.slice(0, 6)) {
    if (pagesRead >= LIMITS.maxVerifyPages) break;
    const result = await scrapePage(url, "contact_source", VERIFY_TEXT_CHARS);
    if ("error" in result || result.page.thin || sources.some((s) => s.url === result.page.url)) continue;
    pagesRead++;
    await store(companyId, "contacts", result.page);
    sources.push({ url: result.page.url, text: result.page.text });
  }
  if (sources.length === 0) return { facts: unverified(), pagesRead };

  type Verdict = { claim: number; supported: boolean; source: number; quote: string };
  let verdicts: Verdict[] = [];
  try {
    const { data } = await generateJson<{ verdicts: Verdict[] }>(
      `Check each claim against the source texts. Be strict.

Claims:
${claims.map((c, i) => `[${i}] ${c}`).join("\n")}

Sources:
${sources.map((s, i) => `--- SOURCE ${i} (${s.url}) ---\n${s.text}`).join("\n\n")}

For each claim: "supported" is true only if a source states it directly (same person, same company, same fact).
If only part of a claim is stated, it is not supported. "quote" is the supporting passage copied EXACTLY,
character for character, from that source (8 to 30 words). If not supported: supported false, quote "".

Return JSON: {"verdicts": [{"claim": number, "supported": boolean, "source": number, "quote": string}]}`,
      { temperature: 0, fast: true },
    );
    verdicts = Array.isArray(data.verdicts) ? data.verdicts : [];
  } catch {
    return { facts: unverified(), pagesRead };
  }

  const facts = claims.map((text, i): Fact => {
    const verdict = verdicts.find((v) => v.claim === i);
    const source = verdict ? sources[verdict.source] : undefined;
    const quote = (verdict?.quote ?? "").trim();
    const confirmed = !!verdict?.supported && !!source && quote.length >= 20 && normalise(source.text).includes(normalise(quote));
    return { text, verified: confirmed, url: confirmed ? source!.url : null, quote: confirmed ? quote : null };
  });
  return { facts, pagesRead };
}

/** Heuristic extraction: the lines of a page that mention the person, with a little context. */
function mentionsOf(text: string, person: Person): string {
  const lines = text.split("\n");
  const last = person.last_name.toLowerCase();
  const first = person.first_name.toLowerCase();
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if ((last.length > 2 && lower.includes(last)) || lower.includes(`${first} ${last}`)) {
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 2); j++) keep.add(j);
    }
  });
  return [...keep].sort((a, b) => a - b).map((i) => lines[i]).join("\n").slice(0, 1200);
}

/**
 * Researches the point of contact once we know who they are, so the pain
 * points and the email are about this person and not just their job title.
 * Same pipeline, with named sources and a fixed budget:
 *   1. up to LIMITS.maxPersonPages pages their email was found on (from Hunter.io),
 *      or the company's team page when Hunter gave none;
 *   2. exactly one web search for the person.
 * It always exits after step 2. Only public, professional information is used.
 */
export async function researchPerson(company: Row, person: Person, profile: IcpProfile): Promise<PersonResearch> {
  const steps: Step[] = [];
  const snippets: string[] = [];
  const readPages: { url: string; text: string }[] = [];
  let pagesRead = 0;

  for (const url of (person.sourceUrls ?? []).slice(0, 4)) {
    if (pagesRead >= LIMITS.maxPersonPages) break;
    const result = await scrapePage(url, "contact_source");
    if ("error" in result) {
      steps.push({ source: "contact_source", why: "a page their email appears on", url, outcome: result.error, openAfter: [] });
      continue;
    }
    pagesRead++;
    await store(company.id, "contacts", result.page);
    readPages.push({ url: result.page.url, text: result.page.text });
    const found = mentionsOf(result.page.text, person);
    if (found) snippets.push(`From ${result.page.url}:\n${found}`);
    steps.push({ source: "contact_source", why: "a page their email appears on", url: result.page.url, outcome: found ? "read, mentions them" : "read, no mention in the text", openAfter: [] });
  }

  if (snippets.length === 0 && pagesRead < LIMITS.maxPersonPages) {
    const opened = await openSite(company.id, company.domain, profile);
    if (opened) {
      const result = await fetchSource(opened.session, "team", "contacts", company);
      if (typeof result === "string") {
        steps.push({ source: "team", why: "to see how the company describes them", url: null, outcome: result, openAfter: [] });
      } else {
        readPages.push({ url: result.url, text: result.text });
        const found = mentionsOf(result.text, person);
        if (found) snippets.push(`From ${result.url}:\n${found}`);
        steps.push({ source: "team", why: "to see how the company describes them", url: result.url, outcome: found ? "read, mentions them" : "read, no mention in the text", openAfter: [] });
      }
    }
  }

  const name = `${person.first_name} ${person.last_name}`.trim();
  const search = await generate(
    `Research this business contact so a B2B sales email to them can be relevant.

Person: ${name}, ${person.title || "role unknown"} at ${company.name} (${company.domain}).
LinkedIn: ${person.linkedin || "unknown"}

Mentions of them found on web pages:
${snippets.join("\n\n") || "none"}

Use Google Search to find public, professional information about this exact person: what they are responsible
for, roughly how long they have been in the role, relevant previous roles, and anything they have said or published
(talks, posts, interviews, podcasts) about ${profile.researchTopics}.

Rules:
- Professional, public information only. Nothing about their private life, family, home or personal accounts.
- If you are not sure a result is about this same person at this company, leave it out.
- Never invent. Fewer true facts beat more doubtful ones.

Answer in plain text, exactly in this shape (plain text keeps the source links attached to the answer):
SUMMARY: one or two sentences on who they are and what they own
- one short fact, ending with its source in brackets
- (up to 5 such lines)
If you find nothing beyond their title, answer exactly: SUMMARY: No public information found beyond their title.`,
    { search: true, fast: true, temperature: 0.1 },
  );
  const answer = search.text.split("\n").map((line) => line.trim());
  const summary = (answer.find((line) => /^SUMMARY:/i.test(line)) ?? "").replace(/^SUMMARY:\s*/i, "") || "No public information found beyond their title.";
  const claims = answer.filter((line) => /^[-*•]\s+/.test(line)).map((line) => line.replace(/^[-*•]\s+/, "").replace(/\*\*/g, "")).slice(0, 5);
  // The search answer is only a lead. Each claim is checked against the text
  // of the pages it came from before it may be used.
  const checked = await verifyFacts(company.id, claims, search.sourceUrls, readPages);
  const facts = checked.facts;
  await store(company.id, "contacts", {
    pageType: "person_search", url: "google-search:person", status: 200, title: `Search: ${name}`, description: "",
    text: [summary, ...claims].join("\n"), links: [], emails: [], hints: [], thin: false,
  });
  steps.push({ source: "person_search", why: "one web search for their public professional background", url: null, outcome: `${claims.length} claims found`, openAfter: [] });
  if (claims.length > 0) {
    steps.push({
      source: "contact_source", why: "to verify the claims against their sources", url: null,
      outcome: `${checked.pagesRead} source pages read, ${facts.filter((f) => f.verified).length} of ${facts.length} claims verified`, openAfter: [],
    });
  }
  return { summary, facts, steps };
}
