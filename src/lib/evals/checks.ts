// Code checks: the eval assertions that need no model. Each returns null when
// the rule holds, or a short reason when it does not. The same functions are
// used live (as guards before an action) and by the eval runner.

/** Words in a piece of text. */
export function wordCount(text: string): number {
  return String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
}

const URL_RE = /\bhttps?:\/\/[^\s)>\]]+|\bwww\.[^\s)>\]]+/gi;

export function linksIn(text: string): string[] {
  return String(text ?? "").match(URL_RE) ?? [];
}

const PLACEHOLDER_RE = /\[[^\]\n]{1,40}\]|\{\{?[^}\n]{1,40}\}?\}|<[A-Z][A-Za-z _]{1,30}>|\b(?:INSERT|TODO|TBD|XXX)\b/;

/** DRF-04 (Kill): no links and no placeholders like [Name] or {company} in an outreach email. */
export function draftSafety(subject: string, body: string): string | null {
  if (!String(body ?? "").trim()) return "the email body is empty";
  if (!String(subject ?? "").trim()) return "the subject is empty";
  const links = linksIn(`${subject}\n${body}`);
  if (links.length) return `contains a link (${links[0]})`;
  const ph = `${subject}\n${body}`.match(PLACEHOLDER_RE);
  if (ph) return `contains a placeholder (${ph[0]})`;
  return null;
}

/** DRF-01: 90-130 words in the whole email. */
export function draftLength(body: string): string | null {
  const n = wordCount(body);
  return n >= 90 && n <= 130 ? null : `${n} words (expected 90-130)`;
}

/** DRF-02: opens with "Hi {first name},". */
export function draftGreeting(body: string, firstName: string | null | undefined): string | null {
  const first = String(body ?? "").trim().split("\n")[0].trim();
  const name = String(firstName ?? "").trim();
  if (!name) return /^Hi [^,]+,$/.test(first) ? null : `first line is "${first.slice(0, 40)}"`;
  return first === `Hi ${name},` ? null : `first line is "${first.slice(0, 40)}", expected "Hi ${name},"`;
}

/** The email without its sign-off: trailing short lines with no question mark (the name, "Best,"...). */
function withoutSignOff(body: string): string {
  const lines = String(body ?? "").trim().split("\n");
  while (lines.length > 1) {
    const last = lines[lines.length - 1].trim();
    if (last === "" || (wordCount(last) <= 4 && !last.includes("?"))) lines.pop();
    else break;
  }
  return lines.join("\n").trim();
}

/** DRF-03: the last sentence before the sign-off is a question, and there is exactly one closing question. */
export function draftEndsWithQuestion(body: string): string | null {
  const main = withoutSignOff(body);
  return main.endsWith("?") ? null : `ends with "${main.slice(-50)}"`;
}

const BANNED_OPENERS = [/i hope this (email |message )?finds you well/i, /i came across/i, /my name is/i, /i wanted to reach out/i];
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

/** DRF-05: no exclamation marks, emojis or banned openers. */
export function draftStyle(body: string): string | null {
  if (body.includes("!")) return "contains an exclamation mark";
  if (EMOJI_RE.test(body)) return "contains an emoji";
  const banned = BANNED_OPENERS.find((r) => r.test(body));
  return banned ? `uses a banned phrase (${banned.source.replace(/\\/g, "")})` : null;
}

/** DRF-06: subject under 7 words. */
export function subjectLength(subject: string): string | null {
  const n = wordCount(subject);
  return n > 0 && n < 7 ? null : `${n} words (expected 1-6)`;
}

/** DRF-07: the last line is the sender's name. */
export function draftSignOff(body: string, sender: string | null | undefined): string | null {
  const name = String(sender ?? "").trim();
  if (!name) return null; // nothing to check against
  const last = String(body ?? "").trim().split("\n").filter((l) => l.trim()).pop()?.trim() ?? "";
  return last === name || last.endsWith(name) ? null : `last line is "${last.slice(0, 40)}", expected "${name}"`;
}

/** SND-01 (Kill): while the lock is on, every recipient is one of the test addresses. */
export function recipientsAllowed(recipients: string[], locked: string[]): string | null {
  if (locked.length === 0) return null;
  const allowed = new Set(locked.map((e) => e.toLowerCase()));
  const bad = recipients.filter((r) => !allowed.has(r.trim().toLowerCase()));
  return bad.length ? `would go to ${bad.length} address${bad.length === 1 ? "" : "es"} outside the test list` : null;
}

/** SCH-10 (Kill): the only link in a scheduling email is the booked meeting link. */
export function onlyMeetingLink(body: string, meetingLink: string | null | undefined): string | null {
  const links = linksIn(body);
  const bad = links.filter((l) => !meetingLink || !l.startsWith(meetingLink));
  return bad.length ? `contains a link that is not the meeting link (${bad[0]})` : null;
}

/** "Tue 17 Nov, 3:15 PM IST": every clock time is written as H:MM AM/PM with IST in the same phrase (SCH-11). Ranges like "9:00 AM to 6:00 PM IST" count. */
export function timeFormatOk(body: string): string | null {
  const re = /\b\d{1,2}(?::\d{2})?\s?(?:am|pm|AM|PM)\b/g;
  for (const m of String(body ?? "").matchAll(re)) {
    const t = m[0];
    const after = body.slice(m.index! + t.length, m.index! + t.length + 30);
    if (!/^\d{1,2}:\d{2} (AM|PM)$/.test(t)) return `time written as "${t}" (expected like "3:15 PM IST")`;
    if (!/^\s*IST\b/.test(after) && !/^\s*(to|-|–|and)\s*\d{1,2}:\d{2} (AM|PM) IST\b/.test(after)) return `"${t}" is not followed by IST`;
  }
  return null;
}

export function validEmail(email: string | null | undefined): boolean {
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(String(email ?? ""));
}

/** Changed share of words between two texts (0 = identical, 1 = completely rewritten), via word-level LCS. */
export function editShare(before: string, after: string): number {
  const a = String(before ?? "").split(/\s+/).filter(Boolean);
  const b = String(after ?? "").split(/\s+/).filter(Boolean);
  if (a.length === 0 && b.length === 0) return 0;
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
}

const NAMED_SOURCE = /\b(homepage|page|website|site|blog|press release|announcement|job (post|posting|listing)|careers|linkedin|crunchbase|techcrunch|hunter\.io|trust (center|centre))\b/i;

/** SCO-04: a signal says where it came from: "(Source)" at the end, a URL, a named page, or a date. */
export function signalHasSource(signal: string): boolean {
  const s = String(signal ?? "");
  return /\([^()]{2,80}\)\s*\.?$/.test(s) || linksIn(s).length > 0 || NAMED_SOURCE.test(s) || /\b(19|20)\d{2}\b/.test(s) || /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/.test(s);
}

/** "Something happened (Source)" from a model's {text, source}; null when no source is named (an unsourced signal is not evidence). */
export function sourcedSignal(item: unknown): string | null {
  if (typeof item === "string") return signalHasSource(item) ? item.trim() : null;
  const o = (item ?? {}) as { text?: unknown; source?: unknown; page?: unknown };
  const text = String(o.text ?? "").trim().replace(/\s*\.$/, "");
  const source = String(o.source ?? o.page ?? "").trim();
  if (!text || !source || /^(unknown|none|n\/a)$/i.test(source)) return null;
  return `${text} (${source})`;
}

/** The ICP text needs enough detail to build a profile from (ICP-05). */
export function icpDetail(icp: string): string | null {
  const n = wordCount(icp);
  return n >= 10 ? null : `the ICP has ${n} word${n === 1 ? "" : "s"}; describe who you sell to in at least 10 words (industry, size or stage, region, and what makes them need you)`;
}

/** Thrown by a live guard: the action is blocked before it happens. */
export class GuardError extends Error {
  constructor(public caseId: string, reason: string) {
    super(`Blocked by safety check ${caseId}: ${reason}`);
  }
}

export function guard(caseId: string, reason: string | null) {
  if (reason) throw new GuardError(caseId, reason);
}
