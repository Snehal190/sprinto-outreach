import { sql, type Row } from "./db";
import { generateJson } from "./gemini";
import { rankTitle } from "./research";

// The feedback loop. Goal: shrink the gap between the email the system drafts
// and the email the human actually sends.
//
//   Act      - the system drafts an email            (funnel.draftEmail)
//   Signal   - the delta between draft and sent      (delta, below)
//   Capture  - what changed in subject, hook, angle and CTA, and why
//   Store    - one lesson per draft, in the lessons table
//   Retrieve - past lessons from prospects with a similar ICP profile
//   Apply    - those lessons are written into the next draft's prompt
//
// It is triggered internally every time a human saves a change to a draft or
// writes feedback on it, and again when the email is sent.

// ----------------------------------------------------------------- segment

/** The ICP profile a lesson belongs to. Lessons are retrieved by similarity on these three fields. */
export type Segment = { persona: string; framework: string; stage: string };

const PERSONAS = ["security or compliance leader", "engineering leader", "founder or executive", "engineer", "other role"];

export function segmentOf(company: Row, contact: Row | undefined): Segment {
  return {
    persona: PERSONAS[rankTitle(String(contact?.title ?? ""))] ?? "other role",
    framework: company.recommended_framework || "unknown",
    stage: company.funding_stage || "unknown",
  };
}

// ------------------------------------------------------------------ signal

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}'$%.-]+/gu) ?? [];

/**
 * How much of the text changed, from 0 (identical) to 1 (completely rewritten),
 * measured on words using the longest common subsequence. This is the number
 * the loop is trying to drive towards zero.
 */
export function delta(before: string, after: string): number {
  const a = words(before);
  const b = words(after);
  if (a.length === 0 && b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  const common = previous[b.length];
  return Math.round((1 - (2 * common) / (a.length + b.length)) * 1000) / 1000;
}

// ----------------------------------------------------------------- capture

type Part = { changed: boolean; before: string; after: string; lesson: string | null };
type Captured = {
  components: { subject: Part; hook: Part; angle: Part; cta: Part };
  tone: string | null;
  rules: string[];
};

/**
 * Compares the system's draft with the human's current version, extracts what
 * changed in each part of the email, and stores it as the lesson for this
 * draft. Called on every saved edit, so the lesson always reflects the latest
 * version; when the human reverts everything and has no feedback, the lesson
 * is removed.
 */
export async function captureLesson(draftId: number): Promise<{ learned: number }> {
  const draft = (await sql(`SELECT * FROM drafts WHERE id = $1`, [draftId]))[0];
  if (!draft) return { learned: 0 };
  const company = (await sql(`SELECT * FROM companies WHERE id = $1`, [draft.company_id]))[0];
  const contact = (await sql(`SELECT * FROM contacts WHERE id = $1`, [draft.contact_id]))[0];

  const deltaSubject = delta(draft.original_subject, draft.subject);
  const deltaBody = delta(draft.original_body, draft.body);
  const feedback = String(draft.feedback ?? "").trim();
  if (deltaSubject === 0 && deltaBody === 0 && !feedback) {
    await sql(`DELETE FROM lessons WHERE draft_id = $1`, [draftId]);
    return { learned: 0 };
  }

  const segment = segmentOf(company ?? {}, contact);
  const { data } = await generateJson<Captured>(
    `A salesperson edited an AI-drafted cold email before sending it. Work out exactly what they changed, and what
the drafting system should learn so that its next draft for a similar prospect needs fewer edits.

Prospect profile: ${contact?.title ?? "unknown title"} (${segment.persona}) at a ${segment.stage} SaaS company; the email leads with ${segment.framework}.

ORIGINAL DRAFT (written by the system)
Subject: ${draft.original_subject}
Hook: ${draft.original_hook || draft.hook || "(first sentence after the greeting)"}
Call to action: ${draft.original_cta || "(the closing ask)"}
Body:
${draft.original_body}

FINAL VERSION (after the human's edits)
Subject: ${draft.subject}
Body:
${draft.body}

The human's own note on what was wrong with the draft: ${feedback || "(none given)"}

Break the email into four parts and compare original with final:
- subject: the subject line.
- hook: the opening sentence(s) after the greeting.
- angle: the middle of the email - which pain or value it argues, and how it is framed.
- cta: the closing ask.

For each part return: "changed" (true/false), "before" and "after" (the actual text for subject, hook and cta;
a one-sentence description for angle), and "lesson": one sentence telling the drafting system what to do
differently next time. A lesson must generalise to other prospects with a similar profile - never mention this
company or person by name. Use null when the part was not changed.

"tone": one sentence on any change in tone, length or style, or null.
"rules": 1 to 4 short imperative rules for future drafts, most important first, combining the edits and the
human's note. If the human only fixed a typo or corrected a fact specific to this company, that is not a
generalisable lesson - return an empty rules list.

Return JSON: {"components": {"subject": {"changed": boolean, "before": string, "after": string, "lesson": string|null},
 "hook": {...}, "angle": {...}, "cta": {...}}, "tone": string|null, "rules": [string]}`,
    { temperature: 0.1 },
  );
  const rules = Array.isArray(data.rules) ? data.rules.slice(0, 4).map(String) : [];

  await sql(
    `INSERT INTO lessons (draft_id, company_name, title, persona, framework, stage, components, rules, tone, feedback, delta_subject, delta_body)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12)
     ON CONFLICT (draft_id) DO UPDATE SET components = EXCLUDED.components, rules = EXCLUDED.rules, tone = EXCLUDED.tone,
       feedback = EXCLUDED.feedback, delta_subject = EXCLUDED.delta_subject, delta_body = EXCLUDED.delta_body,
       title = EXCLUDED.title, persona = EXCLUDED.persona, framework = EXCLUDED.framework, stage = EXCLUDED.stage,
       updated_at = now()`,
    [draftId, company?.name ?? "", contact?.title ?? "", segment.persona, segment.framework, segment.stage,
     JSON.stringify(data.components ?? {}), JSON.stringify(rules), data.tone ?? null, feedback, deltaSubject, deltaBody],
  );
  return { learned: rules.length };
}

/** Marks the lesson as coming from an email that was actually sent: the final, approved version. */
export async function markSent(draftId: number) {
  await sql(`UPDATE lessons SET sent = TRUE WHERE draft_id = $1`, [draftId]);
}

/**
 * A draft is about to be regenerated. Its lesson is still valid learning, so
 * it is kept but detached, and the new draft starts with a clean slate.
 */
export async function detachLesson(companyId: number) {
  await sql(`UPDATE lessons SET draft_id = NULL WHERE draft_id IN (SELECT id FROM drafts WHERE company_id = $1)`, [companyId]);
}

// ---------------------------------------------------------------- retrieve

export type Applied = { id: number; match: string; rules: string[] };

const MAX_LESSONS = 5;

/**
 * The most relevant past lessons for a prospect. Relevance is how closely the
 * lesson's ICP profile matches (same kind of person matters most, then the
 * certification, then the funding stage), with lessons from emails that were
 * actually sent and newer lessons breaking ties.
 */
export async function retrieveLessons(segment: Segment): Promise<{ applied: Applied[]; promptBlock: string }> {
  const rows = await sql(`SELECT * FROM lessons WHERE jsonb_array_length(rules) > 0 ORDER BY updated_at DESC LIMIT 200`);
  const scored = rows
    .map((lesson, recency) => {
      const same = [
        lesson.persona === segment.persona ? "same kind of contact" : null,
        lesson.framework === segment.framework ? `same certification (${segment.framework})` : null,
        lesson.stage === segment.stage ? `same stage (${segment.stage})` : null,
      ].filter(Boolean) as string[];
      const score = (lesson.persona === segment.persona ? 3 : 0) + (lesson.framework === segment.framework ? 2 : 0) + (lesson.stage === segment.stage ? 2 : 0) + (lesson.sent ? 1 : 0);
      return { lesson, score, recency, match: same.join(", ") || "general style lesson" };
    })
    .sort((a, b) => b.score - a.score || a.recency - b.recency)
    .slice(0, MAX_LESSONS);
  if (scored.length === 0) return { applied: [], promptBlock: "" };

  const example = (name: string, part: Row | undefined) =>
    part?.changed && part.before && part.after ? `\n   ${name} the human rejected: "${part.before}"\n   ${name} the human wrote instead: "${part.after}"` : "";
  const promptBlock = `
LESSONS FROM PAST HUMAN EDITS (most relevant first). A human rewrote earlier drafts for similar prospects before
sending them. Apply these lessons; where they conflict with the rules below, the lessons win. Learn the pattern
from the examples - do not copy their wording.
${scored
  .map(
    ({ lesson, match }, i) =>
      `${i + 1}. [${lesson.persona}, ${lesson.stage}, ${lesson.framework} - ${match}]\n   ${(lesson.rules as string[]).join("\n   ")}` +
      example("Subject", lesson.components?.subject) + example("Hook", lesson.components?.hook) + example("CTA", lesson.components?.cta),
  )
  .join("\n")}
`;
  return { applied: scored.map(({ lesson, match }) => ({ id: lesson.id, match, rules: lesson.rules })), promptBlock };
}

// ------------------------------------------------------------------- stats

/** Numbers for the dashboard: is the delta between draft and sent shrinking? */
export async function feedbackStats() {
  const lessons = await sql(`SELECT * FROM lessons ORDER BY created_at ASC`);
  const untouched = await sql(
    `SELECT count(*)::int AS n FROM drafts d WHERE d.status <> 'draft' AND NOT EXISTS (SELECT 1 FROM lessons l WHERE l.draft_id = d.id)`,
  );
  const average = (rows: Row[]) => (rows.length ? Math.round((rows.reduce((sum, r) => sum + Number(r.delta_body), 0) / rows.length) * 100) : null);
  return {
    lessons: lessons.length,
    sentUntouched: untouched[0]?.n ?? 0,
    averageDelta: average(lessons),
    firstFiveDelta: lessons.length >= 10 ? average(lessons.slice(0, 5)) : null,
    lastFiveDelta: lessons.length >= 10 ? average(lessons.slice(-5)) : null,
    recent: lessons.slice(-5).reverse().map((l) => ({
      id: l.id, persona: l.persona, framework: l.framework, stage: l.stage, rules: l.rules, delta: Math.round(Number(l.delta_body) * 100), sent: l.sent,
    })),
  };
}
