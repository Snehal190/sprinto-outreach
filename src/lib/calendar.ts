import { sql, type Row } from "./db";
import { calendarBook, calendarCancel, calendarEvents, googleAccount } from "./google";

// The sender's calendar. This is the code behind the check_calendar and
// book_meeting tools. With Google connected it is the sender's real Google
// Calendar and meetings get a Google Meet link. Otherwise it is a calendar kept
// in the app's own database (calendar_events), which the dashboard can add
// busy blocks to, and meetings get a Jitsi link. All meeting times are handled in IST (UTC+5:30, no daylight saving).

export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 18;
export const MAX_DAYS_AHEAD = 30;
export const MEETING_MINUTES = 20;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Reads "YYYY-MM-DDTHH:MM" as an IST time. Returns null when the text is not a valid date and time. */
export function parseIst(text: string): Date | null {
  const m = String(text ?? "").trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return null;
  const date = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+05:30`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "YYYY-MM-DDTHH:MM" in IST, the format the tools take and return. */
export function toIstInput(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 16);
}

/** For people: "Tue 17 Nov, 3:15 PM IST". */
export function formatIst(date: Date): string {
  const text = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true,
  }).format(date);
  return `${text.replace(/\b(am|pm)\b/i, (x) => x.toUpperCase())} IST`;
}

export type Availability = { status: "free" | "busy" | "no-calendar-access"; reason?: string };

/**
 * The meeting rules that hold whatever the calendar says: not in the past, not
 * more than 30 days out, Monday to Friday only, and between 09:00 and 18:00
 * IST. Returns the broken rule, or null when the slot is allowed. Used by
 * check_calendar, by book_meeting as a last guard, and by the evals.
 */
export function slotRule(start: Date, minutes = MEETING_MINUTES, now = Date.now()): string | null {
  if (start.getTime() <= now) return "that time is in the past";
  if (start.getTime() - now > MAX_DAYS_AHEAD * 86_400_000) return `more than ${MAX_DAYS_AHEAD} days out, not bookable yet`;
  const ist = new Date(start.getTime() + IST_OFFSET_MS);
  if (ist.getUTCDay() === 0 || ist.getUTCDay() === 6) return "that is a weekend; meetings are Monday to Friday only";
  const startMinutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  if (startMinutes < WORK_START_HOUR * 60 || startMinutes + minutes > WORK_END_HOUR * 60) {
    return `outside meeting hours (${WORK_START_HOUR}:00 to ${WORK_END_HOUR}:00 IST)`;
  }
  return null;
}

/**
 * Is this exact date and time free for a meeting? Besides clashes with other
 * events, a slot counts as busy when it is in the past, on a Saturday or
 * Sunday, outside 09:00-18:00 IST, or more than 30 days out. `ignoreThreadId` leaves out that prospect's
 * own existing booking, so a meeting can be moved to an overlapping time.
 */
export async function checkCalendar(dateText: string, ignoreThreadId?: number, minutes = MEETING_MINUTES, ignoreGoogleEventId?: string): Promise<Availability> {
  const start = parseIst(dateText);
  if (!start) return { status: "busy", reason: "the date could not be read; use YYYY-MM-DDTHH:MM in IST" };
  const end = new Date(start.getTime() + minutes * 60_000);
  const broken = slotRule(start, minutes);
  if (broken) return { status: "busy", reason: broken };

  try {
    if (await googleAccount()) {
      // Timed events only: an all-day entry (a holiday, a birthday) does not block a meeting.
      const events = await calendarEvents(start, end);
      const clash = events.some((e) => e.id !== ignoreGoogleEventId && !!e.start?.dateTime);
      return clash ? { status: "busy", reason: "another event is at that time" } : { status: "free" };
    }
    const clashes = await sql(
      `SELECT title FROM calendar_events WHERE start_at < $1 AND end_at > $2 AND ($3::int IS NULL OR thread_id IS DISTINCT FROM $3::int) LIMIT 1`,
      [end.toISOString(), start.toISOString(), ignoreThreadId ?? null],
    );
    return clashes.length > 0 ? { status: "busy", reason: "another event is at that time" } : { status: "free" };
  } catch {
    return { status: "no-calendar-access" };
  }
}

export type Meeting = { start: string; end: string; when: string; link: string; eventId: number; googleEventId?: string };

/**
 * Puts the meeting on the calendar and creates its link. Any earlier booking
 * for the same prospect is removed first, so calling this again reschedules.
 * The link is a Jitsi room, which needs no account; with Google Calendar
 * connected this is where a Google Meet link would be created instead.
 */
export async function bookMeeting(
  threadId: number, dateText: string, title: string,
  google: { attendees: string[]; previousEventId?: string } = { attendees: [] }, minutes = MEETING_MINUTES,
): Promise<Meeting> {
  const start = parseIst(dateText);
  if (!start) throw new Error("The date could not be read");
  // Kill guard (eval SCH-02/SCH-03): never book a slot that breaks the meeting rules, whatever called this.
  const broken = slotRule(start, minutes);
  if (broken) throw new Error(`Booking blocked: ${broken}`);
  const end = new Date(start.getTime() + minutes * 60_000);
  if (await googleAccount()) {
    // Google Calendar: create the new event (with a Meet link, inviting the
    // attendees) before cancelling the old one, so a failure leaves the old meeting in place.
    const created = await calendarBook({ start, end, title, attendees: google.attendees });
    if (google.previousEventId) await calendarCancel(google.previousEventId);
    return { start: start.toISOString(), end: end.toISOString(), when: formatIst(start), link: created.link, eventId: 0, googleEventId: created.id };
  }
  const room = `${title.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30)}-${Math.random().toString(36).slice(2, 10)}`;
  const link = `https://meet.jit.si/${room}`;
  await sql(`DELETE FROM calendar_events WHERE thread_id = $1`, [threadId]);
  const rows = await sql(
    `INSERT INTO calendar_events (start_at, end_at, title, thread_id, link) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [start.toISOString(), end.toISOString(), title, threadId, link],
  );
  return { start: start.toISOString(), end: end.toISOString(), when: formatIst(start), link, eventId: rows[0].id };
}

/** A busy block added by hand from the dashboard, for testing how the agent handles clashes. */
export async function addBusy(dateText: string, minutes: number, title: string) {
  if (await googleAccount()) throw new Error("Google Calendar is connected. Add the busy block there instead.");
  const start = parseIst(dateText);
  if (!start) throw new Error("Use a date and time like 2026-11-17T15:00");
  const end = new Date(start.getTime() + Math.max(15, Math.min(480, minutes || 60)) * 60_000);
  await sql(`INSERT INTO calendar_events (start_at, end_at, title) VALUES ($1,$2,$3)`, [start.toISOString(), end.toISOString(), title || "Busy"]);
}

export async function removeEvent(id: number) {
  await sql(`DELETE FROM calendar_events WHERE id = $1`, [id]);
}

export async function upcomingEvents(): Promise<Row[]> {
  if (await googleAccount()) {
    try {
      const events = await calendarEvents(new Date(), new Date(Date.now() + 14 * 86_400_000));
      return events
        .filter((e) => e.start?.dateTime && e.end?.dateTime)
        .map((e, i) => ({
          id: i, title: e.summary ?? "(no title)", link: e.hangoutLink ?? null, thread_id: -1, when: formatIst(new Date(e.start!.dateTime!)),
          minutes: Math.round((new Date(e.end!.dateTime!).getTime() - new Date(e.start!.dateTime!).getTime()) / 60_000),
        }));
    } catch (err) {
      console.error("Could not read Google Calendar:", err);
      return [];
    }
  }
  const rows = await sql(`SELECT * FROM calendar_events WHERE end_at > now() ORDER BY start_at ASC LIMIT 50`);
  return rows.map((e) => ({ ...e, when: formatIst(new Date(e.start_at)), minutes: Math.round((new Date(e.end_at).getTime() - new Date(e.start_at).getTime()) / 60_000) }));
}
