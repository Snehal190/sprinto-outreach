import dns from "node:dns";
import { sql, type Row } from "../db";
import { generateJson } from "../gemini";
import { getProfile, getSettings, icpKey, type IcpProfile, type Settings } from "../icp";
import { testRecipients } from "../mailer";
import { apisFor, PAID_ACTIONS } from "../health";
import { LIMITS } from "../research";
import { syncTags } from "../tags";
import { formatIst, parseIst, slotRule, toIstInput } from "../calendar";
import { sandboxRun, type SandboxResult, type SandboxSetup } from "../scheduler";
import { CASES, CASE_BY_ID, STAGE_LABELS, type EvalCase } from "./cases";
import {
  draftEndsWithQuestion, draftGreeting, draftLength, draftSafety, draftSignOff, draftStyle, editShare, linksIn,
  onlyMeetingLink, recipientsAllowed, signalHasSource, subjectLength, timeFormatOk, validEmail, wordCount,
} from "./checks";

// The eval runner. Three moments:
//  1. live guards (checks.ts, called inside the funnel) block Kill failures;
//  2. step checks (runStepChecks) run the code checks for one company right
//     after a funnel step and show failures on its card;
//  3. a full run (runEvals) runs every case: code checks over the current
//     ICP's records, the scripted scenarios, and (optionally) the judge.

export type Result = { case_id: string; company_id?: number | null; subject: string; passed: boolean; detail?: string | null };

const THRESHOLD = 70;
const r = (case_id: string, subject: string, failure: string | null, company_id?: number | null, passDetail?: string): Result => ({
  case_id, subject, company_id: company_id ?? null, passed: failure === null, detail: failure ?? passDetail ?? null,
});

// ------------------------------------------------------------- code checks

/** The code checks that belong to one company: scoring, contact and draft. */
function companyChecks(c: Row, contact: Row | undefined, draft: Row | undefined, settings: Settings, hunterCredits: number, sends: Row[]): Result[] {
  const out: Result[] = [];
  const who = c.name ?? c.domain;
  const scored = c.fit_score !== null && c.fit_score !== undefined;

  if (scored) {
    out.push(r("SCO-01", who, Number.isInteger(c.fit_score) && c.fit_score >= 0 && c.fit_score <= 100 ? null : `score is ${c.fit_score}`, c.id));
    if (c.status !== "rejected" && !c.status_manual) {
      const should = c.fit_score >= THRESHOLD;
      const is = c.status === "shortlisted";
      out.push(r("SCO-02", who, should === is ? null : `score ${c.fit_score} but status is "${c.status}"`, c.id));
    }
    const fields = { funding: c.funding_stage, HQ: c.hq, employees: c.employees, markets: c.target_markets };
    const blank = Object.entries(fields).filter(([, v]) => v === null || v === undefined || String(v).trim() === "").map(([k]) => k);
    if (c.scrape_status !== "pending") out.push(r("SCO-09", who, blank.length ? `left blank instead of "unknown": ${blank.join(", ")}` : null, c.id));
  }
  if (c.scrape_summary?.exitReason === "not_fit") {
    out.push(r("SCO-03", who, c.fit_score <= 10 && (c.status !== "shortlisted" || c.status_manual) ? null : `failed a must-have but scored ${c.fit_score} (${c.status})`, c.id));
  }
  const signals: string[] = Array.isArray(c.signals) ? c.signals : [];
  if (signals.length) {
    const unsourced = signals.filter((s) => !signalHasSource(s));
    out.push(r("SCO-04", who, unsourced.length ? `${unsourced.length} of ${signals.length} signals name no source, e.g. "${unsourced[0].slice(0, 80)}"` : null, c.id));
  }
  if (c.scrape_status === "done" && c.scrape_summary) {
    const pages = Number(c.scrape_summary.pagesRead ?? 0);
    const gapsStated = c.info_sufficient || String(c.missing_info ?? "").trim() !== "";
    out.push(r("SCO-07", who, pages > LIMITS.maxPages ? `read ${pages} pages (limit ${LIMITS.maxPages})` : gapsStated ? null : "facts are insufficient but nothing says what is missing", c.id));
  }
  const sourced = (Array.isArray(c.sources) && c.sources.length > 0) || (c.scrape_summary?.steps ?? []).some((s: Row) => typeof s.url === "string" && s.url.startsWith("http"));
  out.push(r("DIS-06", who, sourced ? null : "no search source or researched page recorded", c.id));

  if (contact) {
    const real = contact.source !== "mock";
    const missing = ["first_name", "title", "email"].filter((k) => !String(contact[k] ?? "").trim());
    out.push(r("POC-01", who, missing.length ? `contact is missing ${missing.join(", ")}` : null, c.id));
    if (real && contact.email) {
      const emailDomain = String(contact.email).split("@")[1]?.toLowerCase() ?? "";
      const domain = String(c.domain).toLowerCase();
      const sameDomain = emailDomain === domain || emailDomain.endsWith(`.${domain}`) || domain.endsWith(`.${emailDomain}`);
      out.push(r("POC-03", who, !validEmail(contact.email) ? "the email is not a valid address" : sameDomain ? null : `email is on ${emailDomain}, not ${domain}`, c.id));
    }
    const facts: Row[] = Array.isArray(contact.research?.facts) ? contact.research.facts : [];
    if (facts.length) {
      const noUrl = facts.filter((f) => typeof f !== "object" || !f.url);
      out.push(r("POC-05", who, noUrl.length ? `${noUrl.length} of ${facts.length} claims have no source URL` : null, c.id));
    }
    if (contact.source === "mock") {
      const live = sends.some((s) => s.ok && s.mode === "live");
      out.push(r("POC-07", who, live ? "an email went to a placeholder contact" : null, c.id));
    }
  }
  out.push(r("POC-02", who, hunterCredits > 1 ? `${hunterCredits} Hunter.io credits used` : null, c.id, `${hunterCredits} credit${hunterCredits === 1 ? "" : "s"} used`));

  if (draft) {
    // The system's own version is graded; what goes out (the current text) is held to the Kill rule.
    const subject = draft.original_subject ?? draft.subject;
    const body = draft.original_body ?? draft.body;
    out.push(r("DRF-01", who, draftLength(body), c.id));
    out.push(r("DRF-02", who, draftGreeting(body, contact?.first_name), c.id));
    out.push(r("DRF-03", who, draftEndsWithQuestion(body), c.id));
    out.push(r("DRF-04", who, draftSafety(draft.subject, draft.body), c.id));
    out.push(r("DRF-05", who, draftStyle(body), c.id));
    out.push(r("DRF-06", who, subjectLength(subject), c.id));
    out.push(r("DRF-07", who, draftSignOff(body, settings.senderName), c.id));
    if (draft.body !== draft.original_body || draft.subject !== draft.original_subject) {
      const share = editShare(draft.original_body, draft.body);
      out.push(r("DRF-12", who, share > 0.2 ? `${Math.round(share * 100)}% of the words changed` : null, c.id, `${Math.round(share * 100)}% changed`));
    }
  }
  return out;
}

async function companyContext(companyId: number) {
  const [contact, draft, credits, sends] = await Promise.all([
    sql(`SELECT * FROM contacts WHERE company_id = $1`, [companyId]),
    sql(`SELECT * FROM drafts WHERE company_id = $1`, [companyId]),
    sql(`SELECT coalesce(sum(credits), 0)::int AS n FROM hunter_usage WHERE company_id = $1`, [companyId]),
    sql(`SELECT * FROM send_log WHERE company_id = $1`, [companyId]),
  ]);
  return { contact: contact[0], draft: draft[0], credits: credits[0]?.n ?? 0, sends };
}

/**
 * Moment 2: the code checks for one company, right after a funnel step. They
 * replace the company's earlier step results; failures show on its card.
 */
export async function runStepChecks(companyId: number): Promise<Result[]> {
  const company = (await sql(`SELECT * FROM companies WHERE id = $1`, [companyId]))[0];
  if (!company) return [];
  const settings = await getSettings();
  const ctx = await companyContext(companyId);
  const results = companyChecks(company, ctx.contact, ctx.draft, settings, ctx.credits, ctx.sends);
  await sql(`DELETE FROM eval_results WHERE run_id IS NULL AND company_id = $1`, [companyId]);
  await saveResults(null, results);
  return results;
}

/** Step facts from a search (DIS-01, DIS-04), stored as step results with no company. */
export async function recordDiscoverStep(result: { added: number; requested: number; returned: number; repeats: number }) {
  const when = formatIst(new Date());
  await saveResults(null, [
    r("DIS-01", `Search at ${when}`, result.added <= result.requested ? null : `added ${result.added} for a request of ${result.requested}`, null, `added ${result.added} of ${result.requested}`),
    r("DIS-04", `Search at ${when}`, result.repeats === 0 ? null : `${result.repeats} of ${result.returned} returned companies were already in the list (dropped)`, null),
  ]);
}

const resolved = new Map<string, boolean>();
async function domainResolves(domain: string): Promise<boolean> {
  if (resolved.has(domain)) return resolved.get(domain)!;
  const ok = await Promise.race([
    dns.promises.lookup(domain).then(() => true, () => dns.promises.lookup(`www.${domain}`).then(() => true, () => false)),
    new Promise<boolean>((res) => setTimeout(() => res(true), 5000)), // a slow resolver is not evidence of a fake domain
  ]);
  resolved.set(domain, ok);
  return ok;
}

/** The code checks over every record of the current ICP, plus the system-wide ones. */
async function codeChecks(settings: Settings, profile: IcpProfile, key: string): Promise<Result[]> {
  const out: Result[] = [];
  const companies = await sql(`SELECT * FROM companies WHERE icp_key = $1 ORDER BY id`, [key]);

  // ICP → profile
  const missing = [
    !profile.summary && "summary", !profile.questions?.length && "fit questions", !profile.rubric?.length && "scoring rules",
    !profile.painTopic && "pain topic", !profile.leadWith?.label && "angle to lead with",
  ].filter(Boolean);
  out.push(r("ICP-01", "Current ICP", missing.length ? `missing: ${missing.join(", ")}` : null));
  out.push(r("ICP-02", "Current ICP", profile.questions?.[0]?.gate ? null : `the first fit question ("${profile.questions?.[0]?.label ?? "none"}") is not a must-have gate`));
  const badRoles = (profile.roles ?? []).filter((x) => {
    try {
      new RegExp(x.pattern, "i");
      return false;
    } catch {
      return true;
    }
  });
  const rules = (profile.rubric ?? []).filter((x) => String(x).trim());
  out.push(r("ICP-03", "Current ICP", rules.length < 3 || rules.length > 6 ? `${rules.length} scoring rules (expected 3-6)` : badRoles.length ? `invalid title pattern for ${badRoles[0].persona}` : null));
  const stable = icpKey(settings) === icpKey({ ...settings }) && icpKey(settings) === key;
  const stored = key === "default" ? 1 : (await sql(`SELECT count(*)::int AS n FROM settings WHERE key = $1`, [`icp_profile:${key}`]))[0]?.n ?? 0;
  out.push(r("ICP-07", "Current ICP", !stable ? "the ICP key changes between reads" : stored === 1 ? null : `${stored} stored profiles for this ICP`));
  const shown = await sql(`SELECT count(*)::int AS n FROM companies WHERE icp_key <> $1`, [key]);
  const { getState } = await import("../funnel");
  const state = await getState();
  const leaked = state.companies.filter((c: Row) => c.icp_key !== key);
  out.push(r("ICP-08", "Dashboard", leaked.length ? `${leaked.length} companies from another ICP are shown` : null, null, `${shown[0]?.n ?? 0} companies of other ICPs kept and hidden`));

  // Find companies: duplicates and real domains
  const byName = new Map<string, Row[]>();
  for (const c of companies) {
    const n = String(c.name ?? "").toLowerCase().replace(/\(.*?\)/g, "").replace(/[^a-z0-9]/g, "");
    if (n) byName.set(n, [...(byName.get(n) ?? []), c]);
  }
  const dupes = [...byName.values()].filter((g) => g.length > 1);
  out.push(r("DIS-02", "Company list", dupes.length ? `duplicates: ${dupes.map((g) => g.map((c) => c.domain).join(" = ")).join("; ")}` : null, null, `${companies.length} companies, no duplicates`));
  const dnsResults = await Promise.all(companies.map(async (c) => [c, await domainResolves(c.domain)] as const));
  for (const [c, ok] of dnsResults) out.push(r("DIS-03", c.name ?? c.domain, ok ? null : `${c.domain} does not resolve`, c.id));
  for (const c of companies.filter((x) => Array.isArray(x.sources) && x.sources.length > 0 && x.fit_score !== null)) {
    out.push(r("DIS-08", c.name, c.fit_score >= 40 ? null : `found by search but scored ${c.fit_score}`, c.id));
  }
  // The latest search steps (DIS-01, DIS-04).
  const steps = await sql(`SELECT * FROM eval_results WHERE run_id IS NULL AND company_id IS NULL AND case_id IN ('DIS-01','DIS-04') ORDER BY id DESC LIMIT 20`);
  for (const s of steps) out.push({ case_id: s.case_id, subject: s.subject, passed: s.passed, detail: s.detail, company_id: null });

  // Per company
  for (const c of companies) {
    const ctx = await companyContext(c.id);
    out.push(...companyChecks(c, ctx.contact, ctx.draft, settings, ctx.credits, ctx.sends));
  }

  // Sending
  const ids = companies.map((c) => c.id);
  const sends = ids.length ? await sql(`SELECT * FROM send_log WHERE company_id = ANY($1::int[]) ORDER BY id`, [ids]) : [];
  const locked = testRecipients();
  const events = ids.length
    ? await sql(`SELECT e.*, t.company_id, t.meeting FROM thread_events e JOIN threads t ON t.id = e.thread_id WHERE t.company_id = ANY($1::int[]) AND e.kind = 'email_out' ORDER BY e.id`, [ids])
    : [];
  const addresses = (text: string) => (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/gi) ?? []);
  const outsideLock = [...events.map((e) => addresses(e.summary)), ...sends.map((s) => (s.recipients ?? []) as string[])].map((list) => recipientsAllowed(list, locked)).filter(Boolean);
  out.push(r("SND-01", "Every email sent for this ICP", locked.length === 0 ? null : outsideLock.length ? `${outsideLock.length} emails ${outsideLock[0]}` : null, null, locked.length ? `${events.length + sends.length} sends, all to test addresses` : "lock is off: prospects receive emails"));
  const unmapped: string[] = [];
  for (const action of PAID_ACTIONS) if ((await apisFor(action)).length === 0) unmapped.push(action);
  out.push(r("SND-02", "Send step", unmapped.includes("send") ? "the send step has no API check" : null));
  out.push(r("SYS-01", "Paid steps", unmapped.length ? `no API check for: ${unmapped.join(", ")}` : null, null, `${PAID_ACTIONS.length} paid steps checked first; Hunter checked before each credit`));
  const silent = sends.filter((s) => !s.ok && !String(s.error ?? "").trim());
  out.push(r("SND-03", "Send attempts", silent.length ? `${silent.length} failed sends with no error recorded` : null, null, `${sends.length} attempts, each with a result`));
  for (const c of companies) {
    const okSends = sends.filter((s) => s.company_id === c.id && s.ok);
    if (okSends.length === 0) continue;
    const ctx = await companyContext(c.id);
    const d = ctx.draft;
    if (d && (d.subject !== d.original_subject || d.body !== d.original_body || String(d.feedback ?? "").trim())) {
      const lesson = await sql(`SELECT 1 FROM lessons WHERE draft_id = $1`, [d.id]);
      out.push(r("SND-04", c.name, lesson.length ? null : "edited and sent, but no lesson was captured", c.id));
    }
    const thread = events.some((e) => e.company_id === c.id);
    out.push(r("SND-05", c.name, thread ? null : "sent, but no email thread was started", c.id));
    const doubles = okSends.filter((s, i) => i > 0 && new Date(s.created_at).getTime() - new Date(okSends[i - 1].created_at).getTime() < 30_000);
    out.push(r("SND-06", c.name, doubles.length ? `${doubles.length} sends within 30 seconds of the previous one` : null, c.id));
  }
  // Real scheduling emails: the only links are meeting links.
  for (const e of events.filter((x) => x.body)) {
    const bad = linksIn(e.body).filter((l) => !/^https:\/\/(meet\.google\.com|meet\.jit\.si)\//.test(l));
    if (linksIn(e.body).length) out.push(r("SCH-10", `Sent email #${e.id}`, bad.length ? `contains ${bad[0]}` : null, e.company_id));
  }

  // System-wide: tags in sync, no secrets, step times.
  const snapshot = async () =>
    JSON.stringify([
      await sql(`SELECT id, stage, qualified FROM companies ORDER BY id`),
      await sql(`SELECT id, reply_status, meeting_status, meeting_link FROM threads ORDER BY id`),
      await sql(`SELECT id, kind, company_id FROM notifications ORDER BY id`),
    ]);
  const before = await snapshot();
  await syncTags();
  out.push(r("SYS-02", "Database tags", before === (await snapshot()) ? null : "the tag sync had to correct stored tags"));
  const secrets = Object.entries(process.env).filter(([k, v]) => /KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL/i.test(k) && v && v.length >= 12);
  const haystack = [
    JSON.stringify(state),
    ...(await sql(`SELECT summary, coalesce(body, '') AS body FROM thread_events ORDER BY id DESC LIMIT 500`)).map((e) => e.summary + e.body),
    ...(await sql(`SELECT message FROM notifications`)).map((n) => n.message),
    ...(await sql(`SELECT coalesce(error, '') AS e FROM step_log ORDER BY id DESC LIMIT 500`)).map((x) => x.e),
    ...(await sql(`SELECT coalesce(error, '') AS e FROM send_log`)).map((x) => x.e),
  ].join("\n");
  const leakedKeys = secrets.filter(([, v]) => haystack.includes(v!)).map(([k]) => k);
  out.push(r("SYS-03", "Stored data and dashboard", leakedKeys.length ? `secret value found for ${leakedKeys.join(", ")}` : null, null, `${secrets.length} secrets checked`));
  for (const s of await sql(`SELECT * FROM step_log ORDER BY id DESC LIMIT 100`)) {
    out.push(r("SYS-04", `${s.action}${s.company_id ? ` (company ${s.company_id})` : ""}`, s.ms < 120_000 ? null : `took ${Math.round(s.ms / 1000)} s`, s.company_id, `${(s.ms / 1000).toFixed(1)} s`));
  }
  return out;
}

// ----------------------------------------------------------------- scenarios

const DAY = 86_400_000;
const IST = 5.5 * 3_600_000;

/** The first Monday-to-Friday date at least `minDays` ahead, at `hour`:`minute` IST, as YYYY-MM-DDTHH:MM. */
function weekdaySlot(minDays: number, hour: number, minute = 0, skip = 0): string {
  let found = 0;
  for (let d = minDays; d < minDays + 14; d++) {
    const date = new Date(Date.now() + IST + d * DAY);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (found++ < skip) continue;
    return `${date.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  }
  throw new Error("no weekday found");
}
function saturdaySlot(hour: number): string {
  for (let d = 1; d < 9; d++) {
    const date = new Date(Date.now() + IST + d * DAY);
    if (date.getUTCDay() === 6) return `${date.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00`;
  }
  throw new Error("no Saturday found");
}
/** "Tue 24 Nov at 11 AM" - how a person writes a time. */
function spoken(key: string): string {
  return formatIst(parseIst(key)!).replace(/, (\d+):00 (AM|PM) IST/, " at $1 $2").replace(/, (\d+:\d+) (AM|PM) IST/, " at $1 $2");
}
const weekdayName = (key: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "long" }).format(parseIst(key)!);
const plus = (key: string, minutes: number) => toIstInput(new Date(parseIst(key)!.getTime() + minutes * 60_000));

type Scenario = { id: string; expect: string; setup: SandboxSetup; judge: (res: SandboxResult) => string | null };

function scenarios(): Scenario[] {
  const a = weekdaySlot(2, 11);
  const b = weekdaySlot(2, 15, 0, 1);
  const busy = weekdaySlot(3, 14);
  const meeting = weekdaySlot(3, 15);
  const evening = weekdaySlot(2, 20);
  const sat = saturdaySlot(17);
  const rel = weekdaySlot(2, 15, 0, 2);
  const noWeekend = (res: SandboxResult) => {
    const bad = res.bookings.filter((k) => /weekend/.test(slotRule(parseIst(k)!, 30, 0) ?? ""));
    return bad.length ? `booked ${spoken(bad[0])}` : null;
  };
  return [
    {
      id: "SCH-01", expect: "interested", setup: { reply: "Sounds interesting - happy to have a quick chat." },
      judge: (res) => {
        if (res.bookings.length) return `booked ${spoken(res.bookings[0])} although no time was agreed`;
        const p = res.proposals.at(-1);
        if (!p) return "no slots were proposed";
        if (p.length < 2 || p.length > 3) return `${p.length} slots proposed (expected 2-3)`;
        const unchecked = p.filter((k) => !res.checks.some((c) => c.slot === k && c.status === "free"));
        return unchecked.length ? `proposed ${spoken(unchecked[0])} without a free check` : null;
      },
    },
    {
      id: "SCH-02", expect: "counter_proposal", setup: { reply: `${spoken(sat).replace(/^\w+ /, "Saturday ")} works for me.` },
      judge: (res) => noWeekend(res) ?? (res.emails.length === 0 ? "no reply was sent offering a weekday" : null),
    },
    {
      id: "SCH-03", expect: "counter_proposal", setup: { reply: `How about ${weekdayName(evening)} at 8 PM?` },
      judge: (res) => {
        const bad = res.bookings.filter((k) => /outside meeting hours/.test(slotRule(parseIst(k)!, 30, 0) ?? ""));
        return bad.length ? `booked ${spoken(bad[0])}` : res.emails.length === 0 ? "no reply was sent asking for working hours" : null;
      },
    },
    {
      id: "SCH-04", expect: "confirms_time",
      setup: { reply: `${spoken(a)} works for me.`, state: { times_proposed: [formatIst(parseIst(a)!), formatIst(parseIst(b)!)], meeting_status: "pending_confirmation" } },
      judge: (res) => {
        if (res.bookings.length !== 1 || res.bookings[0] !== a) return res.bookings.length ? `booked ${spoken(res.bookings[0])} instead of ${spoken(a)}` : "nothing was booked";
        if (!res.checks.some((c) => c.slot === a && c.status === "free")) return "booked without a free calendar check";
        return res.emails.some((e) => res.meetingLink && e.includes(res.meetingLink)) ? null : "the meeting link was not emailed";
      },
    },
    {
      id: "SCH-05", expect: "counter_proposal", setup: { reply: `Can we do ${spoken(busy)}?`, busy: [busy] },
      judge: (res) => (res.bookings.length ? `booked ${spoken(res.bookings[0])} although ${spoken(busy)} is busy` : res.emails.length === 1 ? null : `${res.emails.length} emails sent (expected 1)`),
    },
    {
      id: "SCH-06", expect: "reschedule", setup: { reply: "Something came up - can we push it by 15 minutes?", meetingAt: meeting },
      judge: (res) => (res.bookings.at(-1) === plus(meeting, 15) ? null : res.bookings.length ? `moved to ${spoken(res.bookings.at(-1)!)} (expected ${spoken(plus(meeting, 15))})` : "the meeting was not moved"),
    },
    {
      id: "SCH-07", expect: "not_interested", setup: { reply: "Thanks, but we're not interested." },
      judge: (res) => {
        if (res.bookings.length) return "booked a meeting";
        if (res.emails.length !== 1) return `${res.emails.length} emails sent (expected 1)`;
        const e = res.emails[0];
        return wordCount(e) >= 50 ? `${wordCount(e)} words (expected under 50)` : e.includes("?") ? "asks a question in the close" : null;
      },
    },
    { id: "SCH-08", expect: "", setup: {}, judge: (res) => (res.emails.length === 1 ? null : `${res.emails.length} follow-up emails (expected 1)`) },
    {
      id: "SCH-09", expect: "other", setup: { reply: "Sorry, who is this?" },
      judge: (res) => (res.intent !== "other" ? `classified as ${res.intent}, not handed to a person` : res.emails.length || res.bookings.length ? "acted instead of handing to a person" : null),
    },
    {
      id: "SCH-12", expect: "counter_proposal", setup: { reply: `Does ${weekdayName(rel)} at 3 PM work for you?` },
      judge: (res) => (res.bookings.at(-1) === rel ? null : res.bookings.length ? `booked ${spoken(res.bookings.at(-1)!)} (expected ${spoken(rel)})` : `nothing booked (expected ${spoken(rel)})`),
    },
  ];
}

async function pool<T, U>(items: T[], size: number, fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function scenarioChecks(): Promise<Result[]> {
  const out: Result[] = [];
  // ICP-05: thin ICPs are refused, a detailed one is accepted (no model call, nothing saved).
  const { validateSettings, normaliseWebsites } = await import("../funnel");
  const settings = await getSettings();
  const refuses = (icp: string) => {
    try {
      validateSettings({ ...settings, icp });
      return false;
    } catch {
      return true;
    }
  };
  for (const [label, icp] of [["Empty ICP", ""], ["4-word ICP", "SaaS companies in India"]] as const) {
    out.push(r("ICP-05", label, refuses(icp) ? null : "was accepted"));
  }
  out.push(r("ICP-05", "Detailed ICP", refuses("Series A to C fintech companies in India with 50 to 500 staff preparing for audits") ? "a detailed ICP was refused" : null));
  // DIS-07: pasted websites.
  const pasted = ["https://www.Example.com/about", "example.com", "not a website", "bad", "sub.domain.io/page?x=1", ...Array.from({ length: 30 }, (_, i) => `site${i}.com`)];
  const n = normaliseWebsites(pasted);
  const problems = [
    n.domains[0] !== "example.com" && `first domain is ${n.domains[0]}`,
    n.domains.filter((d) => d === "example.com").length !== 1 && "duplicate not merged",
    !n.domains.includes("sub.domain.io") && "sub.domain.io missing",
    n.domains.length > 25 && `${n.domains.length} domains kept (cap 25)`,
    !n.skipped.includes("bad") && "junk line not reported",
  ].filter(Boolean);
  out.push(r("DIS-07", "Pasted list of 35 lines", problems.length ? problems.join("; ") : null, null, `${n.domains.length} domains kept, ${n.skipped.length} lines skipped`));

  // Scheduler: scripted replies in the sandbox.
  const list = scenarios();
  const runs = await pool(list, 3, async (s) => ({ s, res: await sandboxRun(s.setup) }));
  for (const { s, res } of runs) {
    const failure = res.error ? `the run failed: ${res.error}` : s.judge(res);
    const notes = [res.intent !== "follow_up" && `intent ${res.intent}`, res.blocked.length && `guard blocked ${res.blocked.map(spoken).join(", ")}`, res.emails.length && `${res.emails.length} email(s)`].filter(Boolean).join(" · ");
    out.push(r(s.id, `"${s.setup.reply ?? "48 hours of silence"}"`, failure, null, notes));
    if (s.expect) out.push(r("SCH-13", `"${s.setup.reply}"`, res.intent === s.expect ? null : `classified as ${res.intent}, expected ${s.expect}`));
    for (const [i, e] of res.emails.entries()) {
      out.push(r("SCH-10", `${s.id} email ${i + 1}`, onlyMeetingLink(e, res.meetingLink)));
      const words = wordCount(e);
      out.push(r("SCH-11", `${s.id} email ${i + 1}`, words >= 80 ? `${words} words` : timeFormatOk(e)));
    }
  }
  return out;
}

// --------------------------------------------------------------------- judge

type CompanyVerdict = { right_kind: boolean; right_kind_why: string; reason_supported: boolean; reason_why: string; fits_icp: boolean; fits_why: string; buyer_role: boolean | null; role_why: string };
type DraftVerdict = { invented_facts: string[]; uses_unverified: string[]; hook_specific: boolean; hook_why: string; both_pains: boolean; pains_why: string; lessons_followed: boolean | null; lessons_why: string };

function facts(c: Row): string {
  return [
    `Name: ${c.name} (${c.domain})`, `What they do: ${c.description ?? "unknown"}`, `Funding: ${c.funding_stage ?? "unknown"} (${c.last_funding ?? "unknown"})`,
    `HQ: ${c.hq ?? "unknown"}`, `Employees: ${c.employees ?? "unknown"}`, `Sells to: ${c.target_markets ?? "unknown"}`, `Already has: ${c.certifications_held ?? "unknown"}`,
    `Signals: ${(c.signals ?? []).join("; ") || "none"}`,
  ].join("\n");
}

async function judgeChecks(settings: Settings, profile: IcpProfile, key: string): Promise<Result[]> {
  const out: Result[] = [];
  const seller = `${settings.companyName}: ${settings.product}`;

  // ICP-04, ICP-06
  try {
    const { data } = await generateJson<{ traces: boolean; traces_why: string; contradictory: boolean; contradiction: string }>(
      `You grade a prospecting funnel's ICP profile. Answer strictly.

Seller: ${seller}
The user's ICP, exactly as typed: """${settings.icp}"""

Profile the system built from it:
Fit questions: ${profile.questions.map((q) => `${q.label}${q.gate ? " (must-have)" : ""}`).join("; ")}
Scoring rules: ${profile.rubric.join(" | ")}

1. traces: does every fit question and scoring rule follow from the ICP text or the seller description (nothing invented
   that the user did not ask for)? Reasonable defaults like "must be the right kind of business" count as following.
2. contradictory: does the ICP text contradict itself or is it too vague to search for?

Return JSON: {"traces": boolean, "traces_why": one sentence, "contradictory": boolean, "contradiction": one sentence or ""}`,
      { temperature: 0 },
    );
    out.push(r("ICP-04", "Current ICP", data.traces ? null : data.traces_why, null, data.traces_why));
    const warned = (profile.warnings ?? []).length > 0;
    out.push(r("ICP-06", "Current ICP", !data.contradictory || warned ? null : `unflagged problem: ${data.contradiction}`, null, data.contradictory ? `flagged: ${profile.warnings?.join(" ")}` : "the ICP is clear"));
  } catch (err) {
    out.push(r("ICP-04", "Current ICP", `judge failed: ${(err as Error).message}`));
  }

  // Companies: DIS-05, SCO-05, SCO-06, POC-04
  const companies = (await sql(`SELECT * FROM companies WHERE icp_key = $1 AND fit_score IS NOT NULL ORDER BY fit_score DESC LIMIT 25`, [key]));
  const contacts = await sql(`SELECT * FROM contacts WHERE company_id = ANY($1::int[])`, [companies.map((c) => c.id)]);
  await pool(companies, 4, async (c) => {
    const p = contacts.find((x) => x.company_id === c.id && x.source !== "mock");
    try {
      const { data } = await generateJson<CompanyVerdict>(
        `You grade a B2B prospecting funnel against the user's own ICP. Judge only from what is given. Be strict but fair.

Seller: ${seller}
The user's ICP: """${settings.icp}"""
Scoring rules: ${profile.rubric.join(" | ")}

Company facts found by the system:
${facts(c)}

System's fit score: ${c.fit_score}/100. System's fit reason: "${c.fit_reason ?? ""}"
${p ? `Contact the system chose: ${p.title}` : "No contact chosen yet."}

Answer:
- right_kind: is this the kind of business the ICP describes (industry/business model), whatever its score?
- reason_supported: is every claim in the fit reason supported by the facts above?
- fits_icp: taking everything together, does this company fit the ICP well enough to email?
- buyer_role: ${p ? "is this job title a plausible buyer or decision-maker for what the seller sells?" : "null"}

Return JSON: {"right_kind": boolean, "right_kind_why": short, "reason_supported": boolean, "reason_why": short,
 "fits_icp": boolean, "fits_why": short, "buyer_role": boolean or null, "role_why": short}`,
        { temperature: 0 },
      );
      out.push(r("DIS-05", c.name, data.right_kind ? null : data.right_kind_why, c.id, data.right_kind_why));
      if (c.fit_reason) out.push(r("SCO-05", c.name, data.reason_supported ? null : data.reason_why, c.id, data.reason_why));
      if (c.status === "shortlisted") out.push(r("SCO-06", c.name, data.fits_icp ? null : data.fits_why, c.id, data.fits_why));
      if (p && data.buyer_role !== null) out.push(r("POC-04", `${c.name} · ${p.title}`, data.buyer_role ? null : data.role_why, c.id, data.role_why));
    } catch (err) {
      out.push(r("DIS-05", c.name, `judge failed: ${(err as Error).message}`, c.id));
    }
  });

  // SCO-08: re-score up to five companies from their stored facts.
  const { scoreCompanies } = await import("../funnel");
  const sample = companies.filter((c) => c.scrape_summary?.exitReason !== "not_fit").slice(0, 5);
  if (sample.length) {
    try {
      const again = await scoreCompanies(settings, profile, sample.map((c) => ({
        name: c.name, domain: c.domain, description: c.description, funding_stage: c.funding_stage, last_funding: c.last_funding, hq: c.hq,
        employees: c.employees, target_markets: c.target_markets, certifications_held: c.certifications_held, signals: c.signals, ...(c.scrape_summary?.answers ?? {}),
      })));
      for (const c of sample) {
        const s = again.find((x) => String(x.domain).replace(/^www\./, "") === c.domain);
        if (!s) continue;
        const diff = Math.abs(Math.round(Number(s.fit_score)) - c.fit_score);
        out.push(r("SCO-08", c.name, diff <= 10 ? null : `scored ${c.fit_score}, then ${Math.round(Number(s.fit_score))}`, c.id, `${c.fit_score} → ${Math.round(Number(s.fit_score))}`));
      }
    } catch (err) {
      out.push(r("SCO-08", "Re-score", `judge failed: ${(err as Error).message}`));
    }
  }

  // Drafts: DRF-08, POC-06, DRF-09, DRF-10, DRF-11
  const drafts = await sql(`SELECT d.*, c.name, c.domain, c.description, c.funding_stage, c.last_funding, c.hq, c.employees, c.target_markets, c.certifications_held, c.signals, c.fit_reason
    FROM drafts d JOIN companies c ON c.id = d.company_id WHERE c.icp_key = $1`, [key]);
  await pool(drafts, 4, async (d) => {
    const p = (await sql(`SELECT * FROM contacts WHERE company_id = $1`, [d.company_id]))[0];
    const all: Row[] = Array.isArray(p?.research?.facts) ? p.research.facts : [];
    const verified = all.filter((f) => f.verified).map((f) => f.text);
    const unverified = all.filter((f) => !f.verified).map((f) => f.text);
    const lessons = (d.applied_lessons ?? []).flatMap((l: Row) => l.rules ?? []);
    try {
      const { data } = await generateJson<DraftVerdict>(
        `You grade a sales email the system drafted. Judge only from what is given.

Seller: ${seller}
Company facts:
${facts(d)}
Fit reason: ${d.fit_reason ?? ""}
Verified facts about the person (allowed): ${verified.join(" | ") || "none"}
UNVERIFIED claims about the person (not allowed in the email): ${unverified.join(" | ") || "none"}
The two pain points it had to use: ${(p?.pain_points ?? []).join(" | ") || "none"}
Lessons it had to follow: ${lessons.join(" | ") || "none"}

The email (subject: "${d.original_subject}"):
"""${d.original_body}"""

Answer:
- invented_facts: factual claims about the company, the person or the seller's results that appear in NONE of the facts
  above (numbers, customers, events). Generic statements about the seller's product are fine. Empty list if none.
- uses_unverified: which UNVERIFIED claims the email uses. Empty list if none.
- hook_specific: is the opening hook a specific, real fact about this company found in the facts above?
- both_pains: are both pain points present (in any wording)?
- lessons_followed: ${lessons.length ? "are the lessons followed?" : "null"}

Return JSON: {"invented_facts": [string], "uses_unverified": [string], "hook_specific": boolean, "hook_why": short,
 "both_pains": boolean, "pains_why": short, "lessons_followed": boolean or null, "lessons_why": short}`,
        { temperature: 0 },
      );
      const inv = (data.invented_facts ?? []).filter(Boolean);
      const unv = (data.uses_unverified ?? []).filter(Boolean);
      out.push(r("DRF-08", d.name, inv.length ? `invented: ${inv.join("; ")}` : null, d.company_id));
      if (unverified.length) out.push(r("POC-06", d.name, unv.length ? `uses unverified: ${unv.join("; ")}` : null, d.company_id, `${unverified.length} unverified claims kept out`));
      out.push(r("DRF-09", d.name, data.hook_specific ? null : data.hook_why, d.company_id, data.hook_why));
      out.push(r("DRF-10", d.name, data.both_pains ? null : data.pains_why, d.company_id, data.pains_why));
      if (lessons.length && data.lessons_followed !== null) out.push(r("DRF-11", d.name, data.lessons_followed ? null : data.lessons_why, d.company_id, data.lessons_why));
    } catch (err) {
      out.push(r("DRF-08", d.name, `judge failed: ${(err as Error).message}`, d.company_id));
    }
  });
  return out;
}

// ---------------------------------------------------------------- the run

async function saveResults(runId: number | null, results: Result[]) {
  for (let i = 0; i < results.length; i += 200) {
    const chunk = results.slice(i, i + 200);
    const values: unknown[] = [];
    const rows = chunk.map((x, j) => {
      const c = CASE_BY_ID.get(x.case_id)!;
      values.push(runId, x.case_id, c.stage, c.severity, x.company_id ?? null, x.subject.slice(0, 300), x.passed, x.detail ? String(x.detail).slice(0, 600) : null);
      const b = j * 8;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`;
    });
    if (rows.length) await sql(`INSERT INTO eval_results (run_id, case_id, stage, severity, company_id, subject, passed, detail) VALUES ${rows.join(",")}`, values);
  }
}

export type CaseSummary = EvalCase & { total: number; passed: number; rate: number | null; status: "pass" | "fail" | "warn" | "not_run" };

export function summarise(results: Result[]) {
  const cases: CaseSummary[] = CASES.map((c) => {
    const mine = results.filter((x) => x.case_id === c.id);
    const passed = mine.filter((x) => x.passed).length;
    const rate = mine.length ? passed / mine.length : null;
    const status: CaseSummary["status"] =
      mine.length === 0 ? "not_run" : c.severity === "soft" ? (rate! >= (c.target ?? 1) ? "pass" : "warn") : passed === mine.length ? "pass" : "fail";
    return { ...c, total: mine.length, passed, rate, status };
  });
  const count = (sev: string, st: string) => cases.filter((c) => c.severity === sev && c.status === st).length;
  const stages = Object.entries(STAGE_LABELS).map(([stage, label]) => {
    const mine = cases.filter((c) => c.stage === stage && c.status !== "not_run");
    return { stage, label, run: mine.length, pass: mine.filter((c) => c.status === "pass").length, fail: mine.filter((c) => c.status === "fail").length, warn: mine.filter((c) => c.status === "warn").length };
  });
  return {
    passed: count("kill", "fail") === 0 && count("hard", "fail") === 0,
    killFailed: count("kill", "fail"), hardFailed: count("hard", "fail"), softBelow: count("soft", "warn"),
    casesRun: cases.filter((c) => c.status !== "not_run").length, casesTotal: cases.length, stages, cases,
  };
}

/**
 * Moment 3: the full suite for the current ICP. Code checks always run; the
 * scripted scenarios and the judge (both call Gemini) run unless switched off.
 * No Hunter credits are used and no email is sent.
 */
export async function runEvals(options: { judge?: boolean; scenarios?: boolean; trigger?: string } = {}) {
  const opts = { judge: options.judge !== false, scenarios: options.scenarios !== false };
  const settings = await getSettings();
  const profile = await getProfile(settings);
  const key = icpKey(settings);
  const run = (await sql(`INSERT INTO eval_runs (icp_key, trigger, options) VALUES ($1, $2, $3::jsonb) RETURNING id`, [key, options.trigger ?? "manual", JSON.stringify(opts)]))[0];
  try {
    const [code, scen, judged] = await Promise.all([
      codeChecks(settings, profile, key),
      opts.scenarios ? scenarioChecks() : Promise.resolve([]),
      opts.judge ? judgeChecks(settings, profile, key) : Promise.resolve([]),
    ]);
    const results = [...code, ...scen, ...judged];
    await saveResults(run.id, results);
    // Refresh every company's card checks too.
    for (const c of await sql(`SELECT id FROM companies WHERE icp_key = $1`, [key])) await runStepChecks(c.id).catch(() => {});
    const summary = summarise(results);
    const { cases, ...stored } = summary;
    await sql(`UPDATE eval_runs SET status = 'done', passed = $1, summary = $2::jsonb, finished_at = now() WHERE id = $3`, [
      summary.passed, JSON.stringify({ ...stored, cases: cases.map((c) => ({ id: c.id, status: c.status, total: c.total, passed: c.passed, rate: c.rate })) }), run.id,
    ]);
    // A scheduled run that fails lands on the bell, so nobody has to check the Evals tab.
    if (options.trigger === "weekly" && !summary.passed) {
      await notifyEvals(`Weekly evals failed (run #${run.id}): ${summary.killFailed} Kill and ${summary.hardFailed} Hard case${summary.hardFailed === 1 ? "" : "s"} failing${summary.softBelow ? `, ${summary.softBelow} below target` : ""}. Open the Evals tab for details.`);
    }
    return { runId: run.id, ...stored };
  } catch (err) {
    await sql(`UPDATE eval_runs SET status = 'failed', error = $1, finished_at = now() WHERE id = $2`, [(err as Error).message, run.id]);
    if (options.trigger === "weekly") await notifyEvals(`The weekly eval run could not finish: ${(err as Error).message}`).catch(() => {});
    throw err;
  }
}

async function notifyEvals(message: string) {
  await sql(`INSERT INTO notifications (thread_id, company_id, kind, message) VALUES (NULL, NULL, 'evals', $1)`, [message]);
}

/** When the weekly run fires: Mondays 03:30 UTC (9:00 AM IST), as set in vercel.json. */
export function nextWeeklyRun(now = new Date()): string {
  const next = new Date(now);
  next.setUTCHours(3, 30, 0, 0);
  const days = (1 - next.getUTCDay() + 7) % 7;
  next.setUTCDate(next.getUTCDate() + days);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString();
}

/** The last finished run for the current ICP, with every result, for the Evals tab. */
export async function evalReport() {
  const key = icpKey(await getSettings());
  const run = (await sql(`SELECT * FROM eval_runs WHERE icp_key = $1 AND status <> 'running' ORDER BY id DESC LIMIT 1`, [key]))[0] ?? null;
  const results = run ? await sql(`SELECT case_id, company_id, subject, passed, detail FROM eval_results WHERE run_id = $1 ORDER BY id`, [run.id]) : [];
  const history = await sql(`SELECT id, trigger, passed, summary->'killFailed' AS kill, summary->'hardFailed' AS hard, summary->'softBelow' AS soft, started_at, finished_at, status FROM eval_runs WHERE icp_key = $1 ORDER BY id DESC LIMIT 10`, [key]);
  return {
    nextRun: nextWeeklyRun(),
    run: run ? { id: run.id, status: run.status, passed: run.passed, error: run.error, options: run.options, started_at: run.started_at, finished_at: run.finished_at } : null,
    summary: run ? summarise(results as Result[]) : summarise([]),
    results,
    history,
  };
}

/** Step-check failures per company, for the company cards. */
export async function stepFailures(companyIds: number[]): Promise<Row[]> {
  if (companyIds.length === 0) return [];
  return sql(`SELECT company_id, case_id, severity, detail FROM eval_results WHERE run_id IS NULL AND company_id = ANY($1::int[]) AND NOT passed ORDER BY case_id`, [companyIds]);
}
