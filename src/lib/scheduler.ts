import { sql, type Row } from "./db";
import { converse, generateJson, type Content, type Part, type ToolDeclaration } from "./gemini";
import { deliver, testRecipients } from "./mailer";
import { calendarCancel, gmailReplies, googleAccount, type GmailSent } from "./google";
import { mailApi, requireApis } from "./health";
import { getSettings } from "./icp";
import { MEETING_MINUTES, WORK_END_HOUR, WORK_START_HOUR, bookMeeting, checkCalendar, formatIst, parseIst, slotRule, toIstInput, upcomingEvents, type Availability, type Meeting } from "./calendar";
import { guard, onlyMeetingLink, timeFormatOk, wordCount } from "./evals/checks";

// What happens after the outreach email is sent.
//
// The model decides, the tools act. The model is given the names and
// descriptions of four tools and answers with a decision ("call check_calendar
// with this date"). Nothing runs until this file catches that decision, runs
// the real function, and folds the result back into the conversation.
//
// A state object of six fields travels with every prospect and is saved at
// every checkpoint, so the dashboard can show exactly where each one stands.

// ------------------------------------------------------------ state object

export type State = {
  /** Where the prospect's response stands. */
  reply_status: "no_reply" | "interested" | "not_interested";
  /** Whether check_calendar has run since the prospect last named a time. */
  calendar_checked: boolean;
  /** The slots last sent to the prospect. */
  times_proposed: string[];
  /** 0 for the first proposal; goes up by one for each counter-proposal from the prospect. */
  reply_round: number;
  meeting_status: "unscheduled" | "pending_confirmation" | "confirmed";
  /** Whether the outcome has been written to the campaign record. */
  crm_logged: boolean;
  /** The one persuasive "20 minutes at your convenience" email has gone out (after a "not interested" or silence). Never sent twice. */
  persuasion_sent?: boolean;
  /** They asked not to be contacted again. Nothing more is sent. */
  do_not_contact?: boolean;
};

const INITIAL_STATE: State = {
  reply_status: "no_reply", calendar_checked: false, times_proposed: [], reply_round: 0, meeting_status: "unscheduled", crm_logged: false, persuasion_sent: false, do_not_contact: false,
};

// ------------------------------------------------------------------ limits

/** Silence after an email of ours before the single follow-up goes out. */
export const FOLLOW_UP_AFTER_HOURS = 48;
/** Silence after the follow-up before the prospect is concluded as not responding and handed to a human. */
export const CONCLUDE_AFTER_HOURS = 72;
/** Model turns per reply. The loop always ends here at the latest. */
const MAX_AGENT_STEPS = 8;
const MAX_EMAILS_PER_RUN = 2;

// ------------------------------------------------------------------- tools

// These descriptions are all the model ever sees of the tools: what each one
// does, when to use it, when not to, and what it returns.
const TOOLS: ToolDeclaration[] = [
  {
    name: "check_calendar",
    description:
      "Checks whether a specific date and time is free on the calendar. Use when a prospect proposes or confirms a meeting time, " +
      "and before proposing any time yourself. Do not use to list all upcoming meetings, and do not use for dates more than 30 days out - " +
      "those aren't bookable yet. Returns: free / busy / no-calendar-access.",
    parameters: {
      type: "object",
      properties: { date: { type: "string", description: "The date and time to check, in IST, as YYYY-MM-DDTHH:MM (24-hour), e.g. 2026-11-17T15:15" } },
      required: ["date"],
    },
  },
  {
    name: "propose_times",
    description:
      "Sends the prospect an email proposing specific meeting slots and asking them to confirm one. Use after the prospect has said they are " +
      "interested and every slot has come back free from check_calendar. Do not use for slots you have not checked, and do not use when the " +
      "prospect has already named or confirmed a time - book that instead. Returns: sent / rejected (with the reason).",
    parameters: {
      type: "object",
      properties: {
        times: { type: "array", items: { type: "string" }, description: "Two or three free slots, each in IST as YYYY-MM-DDTHH:MM" },
        message: { type: "string", description: "The opening of the email: greeting plus one or two sentences. The list of slots and the sign-off are added automatically." },
      },
      required: ["times", "message"],
    },
  },
  {
    name: "book_meeting",
    description:
      "Books the meeting on the sender's calendar and creates the meeting link. Use only when the prospect has agreed to that exact date and " +
      "time (they confirmed a proposed slot or proposed it themselves) and check_calendar returned free for it. If a meeting is already booked " +
      "with this prospect, this moves it to the new time and issues a new link. Do not use for a time that was not checked or came back busy. " +
      "Returns: booked (with the time and the meeting link) / rejected (with the reason).",
    parameters: {
      type: "object",
      properties: { date: { type: "string", description: "The agreed date and time, in IST, as YYYY-MM-DDTHH:MM" } },
      required: ["date"],
    },
  },
  {
    name: "send_email",
    description:
      "Sends a plain-text email to the prospect in the current thread. Use to send the meeting link after booking, to ask for a different time " +
      "on another day when the requested slot is busy, to follow up once after silence, or to close politely when they are not interested. " +
      "Do not use to propose specific slots (use propose_times), and never include a meeting link other than the one book_meeting returned. " +
      "Returns: sent / rejected (with the reason).",
    parameters: {
      type: "object",
      properties: { body: { type: "string", description: "The full email text, including greeting and the sender's name as sign-off" } },
      required: ["body"],
    },
  },
];

// ---------------------------------------------------------------- storage

type Thread = Row & { id: number; company_id: number; state: State; meeting: Meeting | null };

async function loadThread(id: number): Promise<Thread> {
  const rows = await sql(`SELECT * FROM threads WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error("Conversation not found");
  return rows[0] as Thread;
}

/** Saves the state object and logs a checkpoint with a snapshot of it. */
async function checkpoint(thread: Thread, kind: "email_out" | "email_in" | "tool" | "branch" | "human", summary: string, body: string | null = null) {
  await sql(`UPDATE threads SET state = $1::jsonb, meeting = $2::jsonb, updated_at = now() WHERE id = $3`, [
    JSON.stringify(thread.state), thread.meeting ? JSON.stringify(thread.meeting) : null, thread.id,
  ]);
  await sql(`INSERT INTO thread_events (thread_id, kind, summary, body, state) VALUES ($1,$2,$3,$4,$5::jsonb)`, [
    thread.id, kind, summary, body, JSON.stringify(thread.state),
  ]);
}

/** A notice for the human on the dashboard. */
type NoticeKind = "meeting_booked" | "meeting_moved" | "needs_human" | "follow_up" | "info";

async function notify(threadId: number, message: string, kind: NoticeKind) {
  await sql(
    `INSERT INTO notifications (thread_id, company_id, kind, message) VALUES ($1, (SELECT company_id FROM threads WHERE id = $1), $2, $3)`,
    [threadId, kind, message],
  );
}

/** Stops the automation for this prospect and asks a human to step in. */
async function flagHuman(thread: Thread, reason: string, who: string) {
  await sql(`UPDATE threads SET needs_human = TRUE, human_reason = $1, awaiting_reply = FALSE WHERE id = $2`, [reason, thread.id]);
  await checkpoint(thread, "human", `Handed to a human: ${reason}`);
  await notify(thread.id, `${who} needs you: ${reason}`, "needs_human");
}

async function context(thread: Thread) {
  const company = (await sql(`SELECT * FROM companies WHERE id = $1`, [thread.company_id]))[0] ?? {};
  const contact = (await sql(`SELECT * FROM contacts WHERE company_id = $1`, [thread.company_id]))[0] ?? {};
  const settings = await getSettings();
  const who = `${contact.first_name ?? "The prospect"} ${contact.last_name ?? ""}`.trim() + (company.name ? ` (${company.name})` : "");
  return { company, contact, sender: settings.senderName || "the sender", seller: settings.companyName, product: `${settings.companyName}: ${settings.product}`, who };
}

/** Sends an email in the thread, through the recipient lock, and logs it. Returns null on success or the error text. */
async function sendInThread(thread: Thread, body: string, label: string, prospectEmail: string | null): Promise<string | null> {
  try {
    // Kill guard (eval SCH-10): the only link a scheduling email may carry is the booked meeting link.
    guard("SCH-10", onlyMeetingLink(body, thread.meeting?.link));
    const result = await deliver({ subject: thread.subject, body, prospectEmail, gmailThreadId: thread.gmail_thread_id, inReplyTo: thread.gmail_last_message_id });
    if (result.gmail) {
      thread.gmail_thread_id = result.gmail.threadId;
      thread.gmail_last_message_id = result.gmail.messageId || thread.gmail_last_message_id;
      await sql(`UPDATE threads SET gmail_thread_id = $1, gmail_last_message_id = $2 WHERE id = $3`, [thread.gmail_thread_id, thread.gmail_last_message_id, thread.id]);
    }
    const where =
      result.mode === "simulated" ? "simulated, Resend not connected" : `to ${result.delivered.join(", ")}` + (result.failed.length ? `; not delivered: ${result.failed.join("; ")}` : "");
    await sql(`UPDATE threads SET last_outbound_at = now(), awaiting_reply = TRUE WHERE id = $1`, [thread.id]);
    await checkpoint(thread, "email_out", `${label} (${where})`, body);
    return null;
  } catch (err) {
    await checkpoint(thread, "email_out", `${label} FAILED: ${(err as Error).message}`, body);
    return (err as Error).message;
  }
}

// ------------------------------------------------------------ thread start

/** Checkpoint 1: called when the outreach email goes out. One conversation per company. */
export async function startThread(companyId: number, subject: string, body: string, sentTo: string, gmail?: GmailSent) {
  const existing = await sql(`SELECT id FROM threads WHERE company_id = $1`, [companyId]);
  if (existing[0]) return;
  const rows = await sql(
    `INSERT INTO threads (company_id, subject, state, last_outbound_at, awaiting_reply, gmail_thread_id, gmail_last_message_id)
     VALUES ($1,$2,$3::jsonb, now(), TRUE, $4, $5) RETURNING *`,
    [companyId, /^re:/i.test(subject) ? subject : `Re: ${subject}`, JSON.stringify(INITIAL_STATE), gmail?.threadId ?? null, gmail?.messageId || null],
  );
  await checkpoint(rows[0] as Thread, "email_out", `Outreach email sent (${sentTo})`, body);
}

/** Who gets the calendar invite: the locked test addresses (minus the sender's own), or the prospect once the lock is lifted. */
async function attendees(prospectEmail: string | null): Promise<string[]> {
  const account = (await googleAccount())?.toLowerCase();
  const locked = testRecipients();
  if (locked.length > 0) return locked.filter((e) => e.toLowerCase() !== account);
  return process.env.ALLOW_PROSPECT_SENDS === "true" && prospectEmail ? [prospectEmail] : [];
}

// ---------------------------------------------------------------- the loop

type Run = { checked: Map<string, string>; emails: number; calls: number; booked: boolean; emailedAfterBooking: boolean };
type Ctx = Awaited<ReturnType<typeof context>>;

/**
 * Everything the tools touch outside the conversation. The real one uses the
 * calendar, the mailer and the database; the eval sandbox swaps in a fake
 * calendar and records emails instead of sending them.
 */
type IO = {
  check: (key: string, thread: Thread) => Promise<Availability>;
  book: (thread: Thread, key: string, ctx: Ctx) => Promise<Meeting>;
  send: (thread: Thread, body: string, label: string, prospectEmail: string | null) => Promise<string | null>;
  checkpoint: (thread: Thread, kind: "email_out" | "email_in" | "tool" | "branch" | "human", summary: string, body?: string | null) => Promise<void>;
  notify: (threadId: number, message: string, kind: NoticeKind) => Promise<void>;
  /** Eval sandbox only: what the tools did. */
  record?: { proposals: string[][]; bookings: string[]; blocked: string[] };
};

const REAL_IO: IO = {
  check: (key, thread) => checkCalendar(key, thread.id, MEETING_MINUTES, thread.meeting?.googleEventId),
  book: async (thread, key, ctx) =>
    bookMeeting(thread.id, key, `${ctx.seller} x ${ctx.company.name ?? "prospect"}`, {
      attendees: await attendees(ctx.contact.email ?? null), previousEventId: thread.meeting?.googleEventId,
    }),
  send: sendInThread,
  checkpoint,
  notify,
};

async function executeTool(name: string, args: Record<string, unknown>, thread: Thread, run: Run, ctx: Ctx, io: IO = REAL_IO): Promise<Record<string, unknown>> {
  run.calls++;
  const slotKey = (text: unknown) => {
    const date = parseIst(String(text ?? ""));
    return date ? toIstInput(date) : null;
  };

  if (name === "check_calendar") {
    const key = slotKey(args.date);
    const result: Availability = key ? await io.check(key, thread) : { status: "busy", reason: "the date could not be read; use YYYY-MM-DDTHH:MM in IST" };
    if (key) run.checked.set(key, result.status);
    thread.state.calendar_checked = true;
    await io.checkpoint(thread, "tool", `check_calendar(${key ? formatIst(parseIst(key)!) : args.date}) → ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
    return result;
  }

  if (name === "propose_times") {
    const keys = (Array.isArray(args.times) ? args.times : []).map(slotKey).filter((k): k is string => !!k);
    const unchecked = keys.filter((k) => run.checked.get(k) !== "free");
    if (keys.length === 0 || unchecked.length > 0) {
      return { status: "rejected", reason: `Every slot must first come back free from check_calendar. Not free or not checked: ${unchecked.join(", ") || "no valid slots given"}` };
    }
    if (run.emails >= MAX_EMAILS_PER_RUN) return { status: "rejected", reason: "email limit for this turn reached" };
    const slots = keys.map((k) => formatIst(parseIst(k)!));
    const opening = String(args.message ?? "").trim();
    if (timeFormatOk(opening)) return { status: "rejected", reason: `The slots are listed for you; leave times out of the opening, or write them like "Tue 17 Nov, 3:15 PM IST".` };
    const body = `${opening}\n\n${slots.map((s) => `- ${s}`).join("\n")}\n\nJust reply with the one that works, or suggest another time.\n\n${ctx.sender}`;
    thread.state.times_proposed = slots;
    thread.state.meeting_status = "pending_confirmation";
    run.emails++;
    io.record?.proposals.push(keys);
    const error = await io.send(thread, body, `propose_times → ${slots.length} slots proposed`, ctx.contact.email ?? null);
    return error ? { status: "rejected", reason: error } : { status: "sent", slots };
  }

  if (name === "book_meeting") {
    const key = slotKey(args.date);
    // Kill guard (evals SCH-02, SCH-03): weekends, out-of-hours and past slots are never booked, whatever the model asks.
    const broken = key ? slotRule(parseIst(key)!) : null;
    if (key && broken) {
      io.record?.blocked.push(key);
      return { status: "rejected", reason: broken };
    }
    // Kill guard (eval SCH-04): only a slot check_calendar returned free for in this turn.
    if (!key || run.checked.get(key) !== "free") return { status: "rejected", reason: "Call check_calendar for this exact date and time first; it must come back free." };
    // Checked again at the moment of booking, in case the calendar changed.
    const again = await io.check(key, thread);
    if (again.status !== "free") return { status: "rejected", reason: `no longer free: ${again.reason ?? again.status}` };
    const moved = !!thread.meeting;
    thread.meeting = await io.book(thread, key, ctx);
    io.record?.bookings.push(key);
    thread.state.meeting_status = "confirmed";
    // The agreed time replaces the earlier proposals, so a moved meeting shows its new time.
    thread.state.times_proposed = [thread.meeting.when];
    thread.state.calendar_checked = true;
    run.booked = true;
    run.emailedAfterBooking = false;
    await io.checkpoint(thread, "tool", `book_meeting → ${moved ? "moved to" : "booked"} ${thread.meeting.when}`);
    await io.notify(thread.id, `Meeting ${moved ? "moved" : "booked"} with ${ctx.who}: ${thread.meeting.when}. Link: ${thread.meeting.link}`, moved ? "meeting_moved" : "meeting_booked");
    return { status: "booked", when: thread.meeting.when, link: thread.meeting.link, minutes: MEETING_MINUTES };
  }

  if (name === "send_email") {
    const body = String(args.body ?? "").trim();
    if (!body) return { status: "rejected", reason: "empty email" };
    if (run.emails >= MAX_EMAILS_PER_RUN) return { status: "rejected", reason: "email limit for this turn reached" };
    if (onlyMeetingLink(body, thread.meeting?.link)) {
      return { status: "rejected", reason: "The only link allowed is the meeting link returned by book_meeting." };
    }
    // Eval SCH-11: times are unambiguous ("Tue 17 Nov, 3:15 PM IST") and the email is short. Rejected here so the model rewrites it.
    const badTime = timeFormatOk(body);
    if (badTime) return { status: "rejected", reason: `Write every time with minutes and the time zone, like "Tue 17 Nov, 3:15 PM IST" (${badTime}). Rewrite and send again.` };
    if (wordCount(body) >= 80) return { status: "rejected", reason: `The email is ${wordCount(body)} words; keep it under 80. Rewrite and send again.` };
    run.emails++;
    const error = await io.send(thread, body, "send_email", ctx.contact.email ?? null);
    if (!error && run.booked && thread.meeting && body.includes(thread.meeting.link)) run.emailedAfterBooking = true;
    return error ? { status: "rejected", reason: error } : { status: "sent" };
  }

  return { status: "rejected", reason: `unknown tool ${name}` };
}

async function conversationText(threadId: number): Promise<string> {
  const events = await sql(`SELECT kind, body, created_at FROM thread_events WHERE thread_id = $1 AND kind IN ('email_out','email_in') AND body IS NOT NULL ORDER BY id ASC`, [threadId]);
  return events
    .slice(-8)
    .map((e) => `[${e.kind === "email_in" ? "PROSPECT" : "US"}, ${formatIst(new Date(e.created_at))}]\n${String(e.body).slice(0, 1200)}`)
    .join("\n\n");
}

/** Runs the model-decides / code-acts loop for one trigger. Ends when the model stops calling tools or at MAX_AGENT_STEPS. */
async function runAgent(thread: Thread, ctx: Ctx, trigger: string, toolNames: string[], io: IO = REAL_IO): Promise<Run> {
  const run: Run = { checked: new Map(), emails: 0, calls: 0, booked: false, emailedAfterBooking: false };
  const now = new Date();
  const system = `You are the scheduling assistant for ${ctx.sender} at ${ctx.seller}, handling the email thread with ${ctx.who}, ${ctx.contact.title ?? "a prospect"}.
You decide what to do; tools do it. Act only through tools. When nothing more needs doing, reply with one short sentence saying what you did.

Now: ${formatIst(now)} (${toIstInput(now)}). All times are IST. Meetings are ${MEETING_MINUTES} minutes and must sit between ${WORK_START_HOUR}:00 and ${WORK_END_HOUR}:00 IST, Monday to Friday only. Never propose or book a Saturday or Sunday.

How to handle each situation:
- Prospect is interested but named no time: call check_calendar on three candidate slots across the next two or three working days
  (for example 11:00, 14:00 and 16:00), then call propose_times once with the two or three that came back free.
- Prospect confirms a slot we proposed, or proposes their own time: call check_calendar for that exact time.
  If free: call book_meeting, then send_email with the confirmed time and the meeting link.
  If busy: do NOT book. Call send_email to say that time is taken and ask them for another time on another day.
- A meeting is already booked and the prospect asks to move it (even by a few minutes): call check_calendar for the new time.
  If free: call book_meeting for the new time, then send_email with the new time and the new meeting link.
  If busy: call send_email asking for another time; the existing meeting stays.
- If the requested time is on a Saturday or Sunday: do not book it. Check the same time on the next working day (Monday, or
  Friday before it) and send_email offering that weekday instead, explaining that meetings run Monday to Friday.
- Prospect is not interested, or has gone silent: the trigger tells you whether this is the one persuasion attempt or the close.
  Persuasion (only once per prospect): call send_email once. Thank them, name one specific way ${ctx.seller} helps their
  company, tied to one of their pain points, and ask for just ${MEETING_MINUTES} minutes at a time that suits them (they pick the time;
  do not propose slots). Warm and respectful: no pressure, no guilt, no fake urgency.
  Close (they decline again, or say they do not need it right now): call send_email once: thank them, and say they can
  bookmark us and let us know - if we can help in the future, we are always happy to get on a call. No pitch, no question.
- Prospect asks not to be contacted (stop, unsubscribe, remove me): call send_email once: say you are not following up for now,
  and that they can bookmark us and let us know if they need us in the future - you would be happy to connect. Never write
  "I will not email you again". No pitch, no question.

Rules:
- Never state that a time is free or booked unless a tool told you so in this turn.
- Work out relative times ("3:15 instead of 3", "tomorrow", "Thursday") from the current time, the proposed slots and the booked meeting.
- Emails are plain text, under 80 words, warm and direct, addressed "Hi ${ctx.contact.first_name ?? "there"}," and signed "${ctx.sender}". Write times like "Tue 17 Nov, 3:15 PM IST".
- Never invent a meeting link. Use only the link book_meeting returns.
- Never invent statistics, customers, integrations or product claims. All you may say about the product is: ${ctx.product}`;

  const contents: Content[] = [{ role: "user", parts: [{ text: trigger }] }];
  const tools = TOOLS.filter((t) => toolNames.includes(t.name));
  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const reply = await converse({ system, contents, tools });
    contents.push(reply);
    const calls = reply.parts.filter((p) => p.functionCall);
    if (calls.length === 0) break;
    const results: Part[] = [];
    for (const part of calls) {
      const call = part.functionCall!;
      const response = toolNames.includes(call.name) ? await executeTool(call.name, call.args ?? {}, thread, run, ctx, io) : { status: "rejected", reason: "tool not available now" };
      results.push({ functionResponse: { name: call.name, response, ...(call.id ? { id: call.id } : {}) } });
    }
    contents.push({ role: "user", parts: results });
  }
  return run;
}

// ------------------------------------------------------------ inbound reply

type Intent = "interested" | "not_interested" | "not_now" | "do_not_contact" | "confirms_time" | "counter_proposal" | "reschedule" | "other";

/** The branch: what kind of reply is this? One model call, no tools. Shared by real replies and the eval sandbox. */
async function classifyReply(state: State, meetingWhen: string | null, history: string, reply: string): Promise<{ intent: Intent; reason: string }> {
  const { data } = await generateJson<{ intent: Intent; reason: string }>(
    `Classify the prospect's latest reply in a sales email thread about booking a call.

State: ${JSON.stringify(state)}
Meeting currently booked: ${meetingWhen ?? "none"}
Slots we last proposed: ${state.times_proposed.join("; ") || "none"}

Thread so far:
${history}

Latest reply from the prospect:
"""${reply}"""

Choose one intent:
- "interested": wants to talk, but names no specific time.
- "confirms_time": accepts one of the slots we proposed.
- "counter_proposal": no meeting is booked yet and they name a different time of their own.
- "reschedule": a meeting is already booked and they ask to move it, even by a few minutes.
- "not_now": says they do not need it right now - not the right time, maybe later, come back next quarter, already busy with other priorities.
- "not_interested": declines without pointing to timing (no thanks, not relevant, not for us) - but does not ask us to stop emailing.
- "do_not_contact": asks us to stop emailing, unsubscribe or remove them, or calls it spam.
- "other": anything else - a question, an out-of-office, a referral to a colleague, unclear.

Return JSON: {"intent": string, "reason": one short sentence}`,
    { temperature: 0, fast: true },
  );
  const intent: Intent = ["interested", "not_interested", "not_now", "do_not_contact", "confirms_time", "counter_proposal", "reschedule", "other"].includes(data.intent) ? data.intent : "other";
  return { intent, reason: String(data.reason ?? "") };
}

/**
 * What to do with a reply, decided in code: the model writes the email, but
 * whether we persuade, close or stop is not left to it.
 *  - asks to stop: confirm and stop, never persuade;
 *  - does not need it right now: the "bookmark us" close, never persuade;
 *  - not interested, first time: the one persuasive "20 minutes" email;
 *  - not interested after that: the "bookmark us" close, then stop;
 *  - anything else: the normal scheduling tools.
 */
type ReplyMode = "stop" | "persuade" | "close" | "schedule";
function replyMode(intent: Intent, state: State): ReplyMode {
  if (intent === "do_not_contact") return "stop";
  if (intent === "not_now") return "close";
  if (intent === "not_interested") return state.persuasion_sent ? "close" : "persuade";
  return "schedule";
}

function painLines(ctx: Ctx): string {
  const pains: string[] = Array.isArray(ctx.contact.pain_points) ? ctx.contact.pain_points : [];
  return pains.length ? pains.map((p, i) => `${i + 1}. ${p}`).join("\n") : "none recorded; use what the thread says about them";
}

const MODE_TEXT: Record<Exclude<ReplyMode, "schedule">, (ctx: Ctx) => string> = {
  persuade: (ctx) => `This is the ONE persuasion attempt for this prospect. Send one email, under 80 words: thank them for replying, name one
specific way ${ctx.seller} would help ${ctx.company.name ?? "their company"} (tie it to one of their pain points below), and ask for just
${MEETING_MINUTES} minutes at a time that suits them. Let them pick the time; do not propose slots. Respectful, no pressure, no guilt, no fake urgency.
Their pain points:
${painLines(ctx)}`,
  close: () => `This is the last email. Send a short, warm close: thank them, and say they can bookmark us and let us know - if we can
help them in the future, we are always happy to get on a call with them. No pitch, no question, no meeting ask now.`,
  stop: () => `They asked not to be contacted. This is the last email. In two short lines, say we are not following up for now, and
that they can bookmark us and let us know if they need us in the future - we would be happy to connect. Do not say "I will not
email you again" or anything like it. No pitch, no question.`,
};

/** The silence follow-up: it is the prospect's one persuasion attempt. */
function followUpTrigger(thread: Thread, ctx: Ctx, silentHours: number, history: string): string {
  return `The prospect has not replied for ${Math.round(silentHours)} hours. Send the one follow-up. ${MODE_TEXT.persuade(ctx)}

State object: ${JSON.stringify(thread.state)}
Slots we last proposed: ${thread.state.times_proposed.join("; ") || "none"}

Thread so far:
${history}`;
}

/** What the agent is told when a reply comes in. */
function replyTrigger(thread: Thread, intent: Intent, history: string, reply: string, mode: ReplyMode = "schedule", ctx?: Ctx): string {
  return `The prospect just replied. Classified as: ${intent}.
${mode !== "schedule" && ctx ? `\n${MODE_TEXT[mode](ctx)}\n` : ""}
State object: ${JSON.stringify(thread.state)}
Meeting currently booked: ${thread.meeting ? `${thread.meeting.when} (${toIstInput(new Date(thread.meeting.start))}), link ${thread.meeting.link}` : "none"}
Slots we last proposed: ${thread.state.times_proposed.join("; ") || "none"}

Thread so far:
${history}

Latest reply from the prospect:
"""${reply}"""

Handle it.`;
}

/**
 * A reply from the prospect arrived. First the branch: what kind of reply is
 * it (a decision, no tool call), which updates the state object. Then the
 * agent loop acts on it with the tools.
 */
export function receiveReply(threadId: number, text: string) {
  // One reply at a time per conversation: a second reply (pasted on the
  // dashboard while Gmail delivers one, say) waits for the first to finish, so
  // it sees the state and calendar the first one left behind.
  const queue = (holder.__replies ??= new Map());
  const turn = (queue.get(threadId) ?? Promise.resolve()).catch(() => {}).then(() => handleReply(threadId, text));
  queue.set(threadId, turn);
  return turn;
}

async function handleReply(threadId: number, text: string) {
  const reply = text.trim();
  if (!reply) throw new Error("Paste the prospect's reply first");
  // Handling a reply needs the model, the calendar and the mail route. Test them
  // first, so a broken key stops here instead of after the reply is logged.
  await requireApis(["gemini", ...(await mailApi())]);
  const thread = await loadThread(threadId);
  const ctx = await context(thread);
  await sql(`UPDATE threads SET awaiting_reply = FALSE, needs_human = FALSE, human_reason = NULL WHERE id = $1`, [threadId]);
  await checkpoint(thread, "email_in", "Prospect replied", reply);

  const history = await conversationText(threadId);
  const data = await classifyReply(thread.state, thread.meeting ? thread.meeting.when : null, history, reply);
  const intent = data.intent;

  if (intent === "other") {
    await flagHuman(thread, `their reply needs a person to answer ("${reply.slice(0, 120)}")`, ctx.who);
    return { intent };
  }
  const mode = replyMode(intent, thread.state);
  thread.state.reply_status = ["not_interested", "not_now", "do_not_contact"].includes(intent) ? "not_interested" : "interested";
  if (intent === "do_not_contact") thread.state.do_not_contact = true;
  if (intent === "counter_proposal" || intent === "reschedule") {
    // A new time is on the table: the calendar has not been checked for it yet.
    thread.state.calendar_checked = false;
    thread.state.reply_round += 1;
  }
  await checkpoint(thread, "branch", `Branch: prospect ${intent.replace(/_/g, " ")} (${data.reason})${mode === "persuade" ? " → one persuasion email" : mode === "close" ? " → polite close" : mode === "stop" ? " → confirm and stop" : ""}`);

  const run = await runAgent(thread, ctx, replyTrigger(thread, intent, history, reply, mode, ctx), mode === "schedule" ? TOOLS.map((t) => t.name) : ["send_email"]);
  if (mode === "persuade" && run.emails > 0) {
    // The one persuasion attempt is spent: no silence nudge after it; a human takes over if they stay silent.
    thread.state.persuasion_sent = true;
    await sql(`UPDATE threads SET follow_up_sent_at = now() WHERE id = $1`, [threadId]);
  }

  // Safety nets, in code: the outcome must not depend on the model remembering the last step.
  if (run.booked && !run.emailedAfterBooking && thread.meeting) {
    await sendInThread(
      thread,
      `Hi ${ctx.contact.first_name ?? "there"},\n\nYou're booked for ${thread.meeting.when}.\n\nMeeting link: ${thread.meeting.link}\n\nSee you then.\n\n${ctx.sender}`,
      "Meeting link sent", ctx.contact.email ?? null,
    );
  }
  const finished = mode === "close" || mode === "stop";
  if (thread.state.meeting_status === "confirmed" || finished) thread.state.crm_logged = true;
  if (finished) await sql(`UPDATE threads SET awaiting_reply = FALSE WHERE id = $1`, [threadId]);
  if (thread.state.meeting_status === "confirmed") await sql(`UPDATE threads SET awaiting_reply = FALSE WHERE id = $1`, [threadId]);
  await checkpoint(thread, "branch", thread.state.crm_logged ? "Outcome logged to the campaign record" : "Turn finished");
  if (run.calls === 0 || (run.emails === 0 && !run.booked)) {
    await flagHuman(thread, "the assistant could not act on their reply", ctx.who);
  }
  return { intent, booked: run.booked };
}

// -------------------------------------------------------------------- inbox

/**
 * Reads new replies from Gmail for every conversation that went out through
 * Gmail, and handles each one. While the recipient lock is on, only replies
 * from the locked test addresses are acted on. Each Gmail message is marked as
 * seen before it is handled, so it can never be processed twice.
 */
export function checkInbox(): Promise<{ handled: number }> {
  // The dashboard's once-a-minute timer and the "Check inbox now" button can
  // fire together. Both share the one check that is already running.
  holder.__inbox ??= readInbox().finally(() => {
    holder.__inbox = undefined;
  });
  return holder.__inbox;
}

async function readInbox(): Promise<{ handled: number }> {
  if (!(await googleAccount())) return { handled: 0 };
  await requireApis(["google"]);
  const locked = testRecipients().map((e) => e.toLowerCase());
  let handled = 0;
  const threads = await sql(`SELECT * FROM threads WHERE gmail_thread_id IS NOT NULL`);
  for (const thread of threads) {
    const seen: string[] = thread.gmail_seen ?? [];
    const contact = (await sql(`SELECT email FROM contacts WHERE company_id = $1`, [thread.company_id]))[0];
    for (const message of await gmailReplies(thread.gmail_thread_id)) {
      if (seen.includes(message.id)) continue;
      // Claim the message in one statement: only the caller whose UPDATE adds
      // the id gets a row back, so two checks can never both handle it.
      const claimed = await sql(
        `UPDATE threads SET gmail_seen = gmail_seen || $1::jsonb, gmail_last_message_id = COALESCE(NULLIF($2, ''), gmail_last_message_id)
         WHERE id = $3 AND NOT (gmail_seen @> $1::jsonb) RETURNING id`,
        [JSON.stringify([message.id]), message.messageId, thread.id],
      );
      if (claimed.length === 0) continue;
      const allowed = locked.length > 0 ? locked.includes(message.from) : message.from === String(contact?.email ?? "").toLowerCase();
      if (!allowed) continue;
      await receiveReply(thread.id, message.text);
      handled++;
    }
  }
  return { handled };
}

// ------------------------------------------------------------------ silence

const holder = globalThis as unknown as { __timersAt?: number; __timersRunning?: boolean; __inbox?: Promise<{ handled: number }>; __replies?: Map<number, Promise<unknown>> };

/**
 * Silence handling. Runs whenever the dashboard loads or refreshes (at most
 * once a minute). After FOLLOW_UP_AFTER_HOURS without a reply the agent sends
 * exactly one follow-up; after a further CONCLUDE_AFTER_HOURS the prospect is
 * concluded as not responding and handed to a human on the dashboard.
 */
export async function runTimers(force = false) {
  if (holder.__timersRunning || (!force && Date.now() - (holder.__timersAt ?? 0) < 60_000)) return;
  holder.__timersRunning = true;
  holder.__timersAt = Date.now();
  try {
    await checkInbox().catch((err) => console.error("Inbox check failed:", err));
    const waiting = await sql(`SELECT * FROM threads WHERE awaiting_reply = TRUE AND needs_human = FALSE AND last_outbound_at IS NOT NULL`);
    for (const row of waiting) {
      const thread = row as Thread;
      const silentHours = (Date.now() - new Date(thread.last_outbound_at).getTime()) / 3_600_000;
      const ctx = await context(thread);
      if (!thread.follow_up_sent_at && silentHours >= FOLLOW_UP_AFTER_HOURS) {
        await requireApis(["gemini", ...(await mailApi())]);
        if (thread.state.do_not_contact) continue;
        const run = await runAgent(thread, ctx, followUpTrigger(thread, ctx, silentHours, await conversationText(thread.id)), ["send_email"]);
        if (run.emails > 0) {
          thread.state.persuasion_sent = true;
          await checkpoint(thread, "branch", "Silence follow-up sent (the one persuasion email)");
          await sql(`UPDATE threads SET follow_up_sent_at = now() WHERE id = $1`, [thread.id]);
        }
        else await flagHuman(thread, "the follow-up could not be sent", ctx.who);
      } else if (thread.follow_up_sent_at && silentHours >= CONCLUDE_AFTER_HOURS) {
        await flagHuman(thread, `no reply ${CONCLUDE_AFTER_HOURS} hours after the follow-up`, ctx.who);
      }
    }
  } finally {
    holder.__timersRunning = false;
  }
}

// ---------------------------------------------------------- dashboard hooks

/** Testing aid: makes a conversation look `hours` older, then runs the silence check. */
export async function skipTime(threadId: number, hours: number) {
  const h = Math.max(1, Math.min(240, hours));
  await sql(`UPDATE threads SET last_outbound_at = last_outbound_at - ($1 || ' hours')::interval WHERE id = $2`, [String(h), threadId]);
  await runTimers(true);
}

/** Testing aid: wipes the conversation and its booking so the same email can be sent again. */
export async function resetThread(threadId: number) {
  const meeting = (await sql(`SELECT meeting FROM threads WHERE id = $1`, [threadId]))[0]?.meeting as Meeting | null;
  if (meeting?.googleEventId) await calendarCancel(meeting.googleEventId);
  await sql(`DELETE FROM calendar_events WHERE thread_id = $1`, [threadId]);
  await sql(`DELETE FROM threads WHERE id = $1`, [threadId]);
}

/** The human has dealt with it. */
export async function resolveThread(threadId: number) {
  const thread = await loadThread(threadId);
  await sql(`UPDATE threads SET needs_human = FALSE, human_reason = NULL WHERE id = $1`, [threadId]);
  await checkpoint(thread, "human", "Marked as handled by a human");
}

export async function dismissNotification(id: number) {
  await sql(`UPDATE notifications SET read = TRUE, read_at = now() WHERE id = $1`, [id]);
}

/** The booked meeting's end time has passed. */
function meetingDone(t: Row): boolean {
  const end = t.meeting?.end ?? t.meeting?.start;
  return (t.state as State).meeting_status === "confirmed" && !!end && new Date(end).getTime() < Date.now();
}

function statusLabel(t: Row): string {
  const s = t.state as State;
  if (t.needs_human) return "Needs you";
  if (s.meeting_status === "confirmed") return meetingDone(t) ? "Meeting done" : "Meeting booked";
  if (s.do_not_contact) return "Asked not to be contacted";
  if (s.reply_status === "not_interested") return t.awaiting_reply ? "Not interested · follow-up sent" : "Not interested";
  if (s.meeting_status === "pending_confirmation") return "Waiting for them to confirm a time";
  if (s.reply_status === "interested") return "In conversation";
  return t.follow_up_sent_at ? "Follow-up sent, waiting" : "Waiting for a reply";
}

/** One line under the status: the time that matters right now. */
function statusDetail(t: Row): string | null {
  const s = t.state as State;
  if (t.needs_human) return t.human_reason ?? null;
  if (s.meeting_status === "confirmed" && t.meeting?.when) return t.meeting.when;
  if (s.meeting_status === "pending_confirmation" && s.times_proposed.length) return `Proposed: ${s.times_proposed.join(" · ")}`;
  return null;
}

export async function schedulingSnapshot() {
  const [threads, events, notifications, calendar] = await Promise.all([
    sql(`SELECT * FROM threads`),
    sql(`SELECT * FROM thread_events ORDER BY id ASC`),
    sql(`SELECT n.*, t.company_id FROM notifications n LEFT JOIN threads t ON t.id = n.thread_id ORDER BY n.id DESC LIMIT 50`),
    upcomingEvents(),
  ]);
  return {
    threads: threads.map((t): Row => ({
      ...t,
      status_label: statusLabel(t),
      status_detail: statusDetail(t),
      meeting_done: meetingDone(t),
      silent_hours: t.awaiting_reply && t.last_outbound_at ? Math.floor((Date.now() - new Date(t.last_outbound_at).getTime()) / 3_600_000) : null,
      // The checkpoints stay in thread_events for the agent and for audits; the dashboard shows only when the latest one happened.
      updated_at: (() => {
        const last = events.filter((e) => e.thread_id === t.id).at(-1);
        return last ? formatIst(new Date(last.created_at)) : null;
      })(),
    })),
    // Dismissed notifications are kept as history: the bell shows them under "Earlier".
    notifications: notifications.map((n): Row => ({ ...n, at: formatIst(new Date(n.created_at)), created_at: new Date(n.created_at).toISOString() })),
    calendar,
    rules: { followUpAfterHours: FOLLOW_UP_AFTER_HOURS, concludeAfterHours: CONCLUDE_AFTER_HOURS, workHours: `${WORK_START_HOUR}:00 to ${WORK_END_HOUR}:00 IST`, meetingMinutes: MEETING_MINUTES },
  };
}

// ------------------------------------------------------------- eval sandbox

export type SandboxSetup = {
  /** The prospect's reply. Leave out to run the silence follow-up instead. */
  reply?: string;
  state?: Partial<State>;
  /** A meeting already booked, as YYYY-MM-DDTHH:MM in IST. */
  meetingAt?: string;
  /** Slots that are busy on the fake calendar, as YYYY-MM-DDTHH:MM in IST. */
  busy?: string[];
};

export type SandboxResult = {
  intent: Intent | "follow_up";
  reason: string;
  humanFlagged: boolean;
  checks: { slot: string; status: string }[];
  proposals: string[][];
  bookings: string[];
  blocked: string[];
  emails: string[];
  meetingLink: string | null;
  error?: string;
};

/**
 * Runs one scripted reply through the real classifier, agent loop and tool
 * rules, with a fake calendar and a fake mailer: nothing is sent, booked or
 * stored. Used by the scheduler evals (SCH-01 to SCH-13).
 */
export async function sandboxRun(setup: SandboxSetup): Promise<SandboxResult> {
  const settings = await getSettings();
  const busy = (setup.busy ?? []).map((k) => parseIst(k)!.getTime());
  const record = { proposals: [] as string[][], bookings: [] as string[], blocked: [] as string[] };
  const emails: string[] = [];
  const checks: { slot: string; status: string }[] = [];
  const meetingFor = (key: string): Meeting => {
    const start = parseIst(key)!;
    return { start: start.toISOString(), end: new Date(start.getTime() + MEETING_MINUTES * 60_000).toISOString(), when: formatIst(start), link: `https://meet.google.com/sbx-${Math.random().toString(36).slice(2, 8)}`, eventId: 0 };
  };
  const io: IO = {
    check: async (key) => {
      const start = parseIst(key)!;
      const broken = slotRule(start);
      const clash = busy.some((b) => b < start.getTime() + MEETING_MINUTES * 60_000 && b + MEETING_MINUTES * 60_000 > start.getTime());
      const result: Availability = broken ? { status: "busy", reason: broken } : clash ? { status: "busy", reason: "another event is at that time" } : { status: "free" };
      checks.push({ slot: key, status: result.status });
      return result;
    },
    book: async (_thread, key) => meetingFor(key),
    send: async (_thread, body) => {
      emails.push(body);
      return null;
    },
    checkpoint: async () => {},
    notify: async () => {},
    record,
  };
  const thread = {
    id: -1, company_id: -1, subject: "Re: quick question",
    state: { ...INITIAL_STATE, reply_status: "interested", ...(setup.state ?? {}) } as State,
    meeting: setup.meetingAt ? meetingFor(setup.meetingAt) : null,
  } as Thread;
  if (setup.meetingAt) thread.state.meeting_status = "confirmed";
  const ctx: Ctx = {
    company: { name: "Acme Test Co" },
    contact: {
      first_name: "Alex", last_name: "Rivera", title: "CTO", email: null,
      pain_points: ["Enterprise deals are stalling in security review because Acme has no SOC 2 report yet.", "Two engineers are losing weeks to collecting audit evidence by hand."],
    },
    sender: settings.senderName || "Sam", seller: settings.companyName, product: `${settings.companyName}: ${settings.product}`, who: "Alex Rivera (Acme Test Co)",
  };
  const history = `[US]\nHi Alex,\n\nA short note from ${ctx.seller} about ${settings.product.slice(0, 120)}.\n\nWorth a quick call?\n\n${ctx.sender}`;
  const out = (intent: SandboxResult["intent"], reason: string, humanFlagged: boolean, error?: string): SandboxResult => ({
    intent, reason, humanFlagged, checks, proposals: record.proposals, bookings: record.bookings, blocked: record.blocked, emails, meetingLink: thread.meeting?.link ?? null, error,
  });
  try {
    if (!setup.reply) {
      const run = await runAgent(thread, ctx, followUpTrigger(thread, ctx, FOLLOW_UP_AFTER_HOURS, history), ["send_email"], io);
      return out("follow_up", "", run.emails === 0);
    }
    const { intent, reason } = await classifyReply(thread.state, thread.meeting?.when ?? null, history, setup.reply);
    if (intent === "other") return out(intent, reason, true);
    const mode = replyMode(intent, thread.state);
    thread.state.reply_status = ["not_interested", "not_now", "do_not_contact"].includes(intent) ? "not_interested" : "interested";
    if (intent === "counter_proposal" || intent === "reschedule") {
      thread.state.calendar_checked = false;
      thread.state.reply_round += 1;
    }
    const run = await runAgent(thread, ctx, replyTrigger(thread, intent, history, setup.reply, mode, ctx), mode === "schedule" ? TOOLS.map((t) => t.name) : ["send_email"], io);
    // The same safety net as a real reply: a booking always ends with the link going out.
    if (run.booked && !run.emailedAfterBooking && thread.meeting) emails.push(`Hi Alex,\n\nYou're booked for ${thread.meeting.when}.\n\nMeeting link: ${thread.meeting.link}\n\nSee you then.\n\n${ctx.sender}`);
    return out(intent, reason, run.calls === 0 || (run.emails === 0 && !run.booked));
  } catch (err) {
    return out("other", "", true, (err as Error).message);
  }
}
