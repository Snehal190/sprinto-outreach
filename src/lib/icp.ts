import crypto from "node:crypto";
import { sql } from "./db";
import { generateJson } from "./gemini";
import { requireApis } from "./health";

// The ICP profile: everything in the funnel that depends on who we sell to.
// The user types an ICP and what they sell; every step reads its rules from
// here instead of having them written into the code:
//
//   discovery    - which intent signals to search for, which companies to avoid
//   scraper      - the questions that decide fit, and which pages answer each one
//   scoring      - the rubric and what to lead the email with
//   contact      - which roles to look for, best first
//   draft        - the topic of the pain points and the seller's name
//
// The default ICP (Sprinto's) uses the hand-written profile below, so it runs
// exactly as designed. Any other ICP gets its profile written by the model
// once, when the settings are saved, and cached under the ICP's key.

export type Settings = { icp: string; product: string; companyName: string; senderName: string; senderTitle: string };

export const DEFAULT_SETTINGS: Settings = {
  icp: "SaaS companies, typically Series A-C, that are either preparing for a compliance audit or are under pressure from enterprise customers to get certified.",
  product: "Sprinto automates compliance certifications - SOC 2, ISO 27001, GDPR - for SaaS companies.",
  companyName: "Sprinto",
  senderName: "",
  senderTitle: "",
};

/** Sources the scraper can fetch to answer a question. */
export const QUESTION_SOURCES = ["product", "pricing", "about", "careers", "security", "customers", "press", "funding_search", "news_search"] as const;
export type QuestionSource = (typeof QUESTION_SOURCES)[number];

export type FitQuestion = {
  /** snake_case id, shown in the scraper trail. */
  id: string;
  /** "whether it is a SaaS company" */
  label: string;
  /** yes_no: answered yes / no / unknown. value: a short value such as a funding stage. */
  kind: "yes_no" | "value";
  /** How to answer it from the material. */
  rule: string;
  /** A clear "no" rules the company out, so the scraper stops early. */
  gate: boolean;
  /** Absence of evidence is not a "no": stays open until all its sources were tried, then counts as no evidence. */
  evidence: boolean;
  /** Sources that can answer it, best first. */
  sources: QuestionSource[];
};

export type IcpProfile = {
  key: string;
  custom: boolean;
  /** One line describing the target, for the dashboard. */
  summary: string;
  questions: FitQuestion[];
  rubric: string[];
  leadWith: { label: string; options: string[]; guide: string };
  discovery: { signals: string; avoid: string };
  /** What recent news would show buying intent (the scraper's news search). */
  newsQuery: string;
  /** What the prospect already has that we would replace or add to, e.g. certifications held. */
  incumbent: { label: string; example: string };
  /** Tools that mean the prospect already has a vendor for this. */
  competitors: string[];
  /** Buyer roles, best first. `pattern` is a case-insensitive regular expression matched against job titles. */
  roles: { persona: string; pattern: string }[];
  /** Hunter.io departments that hold the buyer. */
  hunterDepartments: string[];
  /** What to search for about the person, e.g. "security, compliance, engineering or scaling the company". */
  researchTopics: string;
  /** The pain points are about this. */
  painTopic: string;
  /** Cheap keyword findings the scraper notes on every page. `pattern` is a case-insensitive regular expression. */
  keywords: { label: string; pattern: string }[];
};

const HUNTER_DEPARTMENTS = ["executive", "it", "finance", "management", "sales", "legal", "support", "hr", "marketing", "communication", "education", "design", "health", "operations"];

const DEFAULT_PROFILE: IcpProfile = {
  key: "default",
  custom: false,
  summary: "Series A-C SaaS companies under compliance pressure",
  questions: [
    {
      id: "is_saas", label: "whether it is a SaaS company", kind: "yes_no", gate: true, evidence: false,
      rule: `"yes" only if they sell software delivered as a subscription/cloud service; "no" if clearly something else (agency, hardware, marketplace, consultancy, consumer app with no B2B software); otherwise "unknown".`,
      sources: ["product", "pricing", "about"],
    },
    {
      id: "funding_stage", label: "its funding stage", kind: "value", gate: false, evidence: false,
      rule: `the funding stage: Seed, Series A, Series B, Series C, Series D+, Bootstrapped or Public. "unknown" if the material does not state it; never guess it from company size or tone.`,
      sources: ["about", "careers", "press", "funding_search"],
    },
    {
      id: "compliance_pressure", label: "whether it is under compliance pressure", kind: "yes_no", gate: false, evidence: true,
      rule: `"yes" only with concrete evidence that they are preparing for a compliance audit or are pushed by enterprise customers to certify - e.g. hiring a security/compliance role, a certification stated as in progress, selling to enterprises or regulated industries while holding no certification, a trust page promising SOC 2 / ISO 27001. Otherwise "unknown".`,
      sources: ["careers", "security", "customers", "news_search"],
    },
  ],
  rubric: [
    "Must be a SaaS company. If it is not, score below 20.",
    "Funding stage Series A-C is the sweet spot. Seed or Series D+ lowers the score.",
    "Intent matters most: evidence they are preparing for a compliance audit, or are under enterprise customer pressure to get certified. Strong evidence = high score. No evidence = at most 55.",
    "Already holding the relevant certifications lowers the score sharply.",
  ],
  leadWith: {
    label: "Certification to lead with",
    options: ["SOC 2", "ISO 27001", "GDPR"],
    guide: `"SOC 2" (selling to US enterprise), "ISO 27001" (EU / international enterprise) or "GDPR" (processing EU personal data)`,
  },
  discovery: {
    signals: "a recent Series A-C round, moving upmarket to enterprise customers, hiring for security/compliance/GRC roles, selling into regulated industries (fintech, healthtech, HR, legal), handling sensitive customer data, expanding into the US or EU, or publicly stating a certification is \"in progress\"",
    avoid: "Prefer companies that do NOT already hold SOC 2 / ISO 27001.",
  },
  newsQuery: "pressure to get security or compliance certified: enterprise customer wins, expansion into the US or EU, customers in regulated industries, security or compliance hires, a security incident, or a certification (SOC 2, ISO 27001, GDPR) announced or in progress",
  incumbent: { label: "Certifications held", example: `"none found" or "SOC 2 Type II, ISO 27001"` },
  competitors: ["Vanta", "Drata", "Secureframe", "Thoropass", "Scrut", "Scytale", "Hyperproof", "Anecdotes"],
  roles: [
    { persona: "security or compliance leader", pattern: "ciso|security|compliance|grc|risk|trust" },
    { persona: "engineering leader", pattern: "\\bcto\\b|chief technology|vp.*engineering|head of engineering|vp.*infrastructure|head of (it|infra|platform)" },
    { persona: "founder or executive", pattern: "founder|\\bceo\\b|\\bcoo\\b|chief executive|chief operating" },
    { persona: "engineer", pattern: "engineering|devops|infrastructure|platform|\\bit\\b" },
  ],
  hunterDepartments: ["it", "executive", "management"],
  researchTopics: "security, compliance, engineering or scaling the company",
  painTopic: "compliance certification",
  keywords: [
    { label: "mentions SOC 2", pattern: "\\bsoc\\s?(2|ii)\\b" },
    { label: "mentions ISO 27001", pattern: "\\biso[\\s/-]?(iec\\s)?27001\\b" },
    { label: "mentions GDPR", pattern: "\\bgdpr\\b" },
    { label: "mentions HIPAA", pattern: "\\bhipaa\\b" },
    { label: "has a trust or security centre", pattern: "trust (center|centre|portal)|security (center|centre|portal)" },
    { label: "says a certification is in progress", pattern: "(soc\\s?2|iso\\s?27001|certification|audit)[^.]{0,60}(in progress|underway|working towards|coming soon|pursuing)" },
    { label: "hiring for a security or compliance role", pattern: "\\b(security|compliance|grc|risk|infosec|privacy)\\s+(engineer|manager|lead|analyst|officer|director|specialist|counsel)\\b|\\bciso\\b" },
  ],
};

const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Companies, scores and lessons belong to the ICP they were found for. The
 * key changes when the ICP, the product or the company name changes; sender
 * details do not count. The default ICP keeps the readable key "default".
 */
export function icpKey(settings: Settings): string {
  const parts = [settings.icp, settings.product, settings.companyName].map(normalise);
  const defaults = [DEFAULT_SETTINGS.icp, DEFAULT_SETTINGS.product, DEFAULT_SETTINGS.companyName].map(normalise);
  if (parts.every((p, i) => p === defaults[i])) return "default";
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 12);
}

export async function getSettings(): Promise<Settings> {
  const rows = await sql(`SELECT value FROM settings WHERE key = 'funnel'`);
  return { ...DEFAULT_SETTINGS, ...(rows[0]?.value ?? {}) };
}

/** A pattern the model wrote. Invalid regular expressions are matched as plain text instead. */
export function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
}

function clean(raw: Partial<IcpProfile>, key: string): IcpProfile {
  const text = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback);
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []);
  const questions = (Array.isArray(raw.questions) ? raw.questions : [])
    .map((q, i): FitQuestion => ({
      id: text(q?.id, `question_${i + 1}`).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || `question_${i + 1}`,
      label: text(q?.label, `question ${i + 1}`),
      kind: q?.kind === "value" ? "value" : "yes_no",
      rule: text(q?.rule, ""),
      gate: q?.kind !== "value" && !!q?.gate,
      evidence: q?.kind !== "value" && !!q?.evidence,
      sources: list(q?.sources).filter((s): s is QuestionSource => (QUESTION_SOURCES as readonly string[]).includes(s)).slice(0, 4),
    }))
    .filter((q) => q.sources.length > 0)
    .slice(0, 3);
  if (questions.length === 0) throw new Error("Could not turn this ICP into fit questions. Try describing it more concretely.");
  const roles = (Array.isArray(raw.roles) ? raw.roles : [])
    .map((r) => ({ persona: text(r?.persona, ""), pattern: text(r?.pattern, "") }))
    .filter((r) => r.persona && r.pattern)
    .slice(0, 5);
  return {
    key,
    custom: true,
    summary: text(raw.summary, "custom ICP"),
    questions,
    rubric: list(raw.rubric).slice(0, 6),
    leadWith: {
      label: text(raw.leadWith?.label, "Angle to lead with"),
      options: list(raw.leadWith?.options).slice(0, 5),
      guide: text(raw.leadWith?.guide, "the angle that best fits this company"),
    },
    discovery: { signals: text(raw.discovery?.signals, ""), avoid: text(raw.discovery?.avoid, "") },
    newsQuery: text(raw.newsQuery, "signs they need what the seller offers"),
    incumbent: { label: text(raw.incumbent?.label, "Already uses"), example: text(raw.incumbent?.example, `"none found"`) },
    competitors: list(raw.competitors).slice(0, 12),
    roles: roles.length ? roles : [{ persona: "founder or executive", pattern: "founder|\\bceo\\b|chief|president|owner" }],
    hunterDepartments: list(raw.hunterDepartments).map((d) => d.toLowerCase()).filter((d) => HUNTER_DEPARTMENTS.includes(d)).slice(0, 4),
    researchTopics: text(raw.researchTopics, "their work and the company's growth"),
    painTopic: text(raw.painTopic, "the problem the seller solves"),
    keywords: (Array.isArray(raw.keywords) ? raw.keywords : [])
      .map((k) => ({ label: text(k?.label, ""), pattern: text(k?.pattern, "") }))
      .filter((k) => k.label && k.pattern)
      .slice(0, 8),
  };
}

/** Has the model turn the ICP and product into a profile. One call, made only when a new ICP is saved. */
async function writeProfile(settings: Settings, key: string): Promise<IcpProfile> {
  await requireApis(["gemini"]);
  const { data } = await generateJson<Partial<IcpProfile>>(
    `You configure a B2B outbound prospecting funnel. From the seller and their ideal customer profile (ICP) below,
write the rules each step of the funnel uses. Be concrete and specific to this ICP. Here is an example of a
finished profile for a different seller, to show the shape and level of detail expected:

${JSON.stringify({ ...DEFAULT_PROFILE, key: undefined, custom: undefined }, null, 1)}

Now the real one.
Seller: ${settings.companyName}. ${settings.product}
ICP: ${settings.icp}

Rules:
- questions: the 2 or 3 facts that decide whether a company fits this ICP and can be found on its website or in the
  news. Put a must-have (e.g. the right kind of business) first with gate true. Use kind "value" for things like
  stage or size, "yes_no" otherwise. Set evidence true for buying-intent questions where silence is not a "no".
  sources: from ${QUESTION_SOURCES.join(", ")} only, best first.
- rubric: 3 to 5 scoring rules out of 100, most important first, including what caps the score.
- leadWith: what the email should lead with (a product line, use case or angle) and when each applies.
- roles: the buyer roles at the prospect, best first, each with a case-insensitive JavaScript regular expression
  that matches their job titles. Up to 5.
- hunterDepartments: 1 to 4 of ${HUNTER_DEPARTMENTS.join(", ")} where the buyer sits.
- keywords: up to 7 case-insensitive JavaScript regular expressions that flag useful signals on a web page.
- competitors: tools or vendors that mean the prospect already has a solution. Empty list if none.
- incumbent: what to record that the prospect already has (label and an example value).

Return JSON with exactly these keys: summary, questions, rubric, leadWith, discovery, newsQuery, incumbent,
competitors, roles, hunterDepartments, researchTopics, painTopic, keywords.`,
    { temperature: 0.2 },
  );
  return clean(data, key);
}

/** The profile for the current settings. Uses the cache; writes one only if this ICP has none yet. */
export async function getProfile(settings?: Settings): Promise<IcpProfile> {
  const s = settings ?? (await getSettings());
  const key = icpKey(s);
  if (key === "default") return DEFAULT_PROFILE;
  const hit = (await sql(`SELECT value FROM settings WHERE key = $1`, [`icp_profile:${key}`]))[0];
  if (hit) return hit.value as IcpProfile;
  const profile = await writeProfile(s, key);
  await sql(`INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [
    `icp_profile:${key}`,
    JSON.stringify(profile),
  ]);
  return profile;
}

/** Ranks a job title against the profile's buyer roles: 0 is the best match, roles.length means no match. */
export function rankTitle(title: string, profile: IcpProfile): number {
  const i = profile.roles.findIndex((r) => safeRegex(r.pattern).test(title ?? ""));
  return i === -1 ? profile.roles.length : i;
}

export function personaOf(title: string, profile: IcpProfile): string {
  return profile.roles[rankTitle(title, profile)]?.persona ?? "other role";
}
