import { sql } from "./db";

// Structured tags. The funnel's working data lives partly in JSON (a thread's
// state and meeting) and partly across tables (contact, draft, thread). These
// columns copy the answers to "where does this stand?" into plain, indexed
// columns, so the database itself can be queried and read without the app:
//
//   companies.stage          found → below_bar / rejected / qualified → researching
//                            → poc_found → email_drafted → email_sent → awaiting_reply
//                            → in_conversation → meeting_proposed → meeting_scheduled
//                            → meeting_done (or not_interested / needs_human)
//   companies.qualified      fit score at or above the bar, or shortlisted by hand
//   threads.meeting_status   unscheduled / proposed / scheduled / done
//   threads.reply_status     no_reply / interested / not_interested
//   notifications.kind       meeting_booked / meeting_moved / needs_human / follow_up / info
//
// sync() is idempotent and only writes rows whose tags changed. It runs before
// every dashboard load, which is also when a meeting's time passing turns
// "scheduled" into "done".

export const STAGES = [
  "found", "below_bar", "rejected", "qualified", "researching", "poc_found", "email_drafted", "email_sent",
  "awaiting_reply", "in_conversation", "meeting_proposed", "meeting_scheduled", "meeting_done", "not_interested", "needs_human",
] as const;
export type Stage = (typeof STAGES)[number];

export async function syncTags() {
  // Threads: copy the JSON state into columns; a confirmed meeting whose end has passed is "done".
  await sql(`
    UPDATE threads t SET
      reply_status = x.reply_status, meeting_status = x.meeting_status,
      meeting_start = x.meeting_start, meeting_end = x.meeting_end, meeting_link = x.meeting_link
    FROM (
      SELECT id,
        COALESCE(state->>'reply_status', 'no_reply') AS reply_status,
        CASE
          WHEN state->>'meeting_status' = 'confirmed' AND (meeting->>'end')::timestamptz < now() THEN 'done'
          WHEN state->>'meeting_status' = 'confirmed' THEN 'scheduled'
          WHEN state->>'meeting_status' = 'pending_confirmation' THEN 'proposed'
          ELSE 'unscheduled'
        END AS meeting_status,
        (meeting->>'start')::timestamptz AS meeting_start,
        (meeting->>'end')::timestamptz AS meeting_end,
        meeting->>'link' AS meeting_link
      FROM threads
    ) x
    WHERE t.id = x.id AND (t.reply_status, t.meeting_status, t.meeting_start, t.meeting_end, t.meeting_link)
      IS DISTINCT FROM (x.reply_status, x.meeting_status, x.meeting_start, x.meeting_end, x.meeting_link)`);

  // Drafts: whether the human changed the system's version.
  await sql(`
    UPDATE drafts SET edited = (subject <> original_subject OR body <> original_body)
    WHERE edited IS DISTINCT FROM (subject <> original_subject OR body <> original_body)`);

  // Companies: one stage for where each stands, plus the qualified flag.
  await sql(`
    UPDATE companies c SET stage = x.stage, qualified = x.qualified, stage_updated_at = now(),
      qualified_at = CASE WHEN x.qualified THEN COALESCE(c.qualified_at, now()) ELSE NULL END
    FROM (
      SELECT c.id, c.status = 'shortlisted' AS qualified,
        CASE
          WHEN c.status = 'rejected' THEN 'rejected'
          WHEN t.needs_human THEN 'needs_human'
          WHEN t.reply_status = 'not_interested' THEN 'not_interested'
          WHEN t.meeting_status = 'done' THEN 'meeting_done'
          WHEN t.meeting_status = 'scheduled' THEN 'meeting_scheduled'
          WHEN t.meeting_status = 'proposed' THEN 'meeting_proposed'
          WHEN t.reply_status = 'interested' THEN 'in_conversation'
          WHEN t.id IS NOT NULL THEN 'awaiting_reply'
          WHEN d.status IN ('sent', 'simulated') THEN 'email_sent'
          WHEN d.id IS NOT NULL THEN 'email_drafted'
          WHEN p.id IS NOT NULL THEN 'poc_found'
          WHEN c.scrape_status = 'pending' THEN 'researching'
          WHEN c.status = 'shortlisted' THEN 'qualified'
          WHEN c.status = 'candidate' AND c.fit_score IS NOT NULL THEN 'below_bar'
          ELSE 'found'
        END AS stage
      FROM companies c
      LEFT JOIN threads t ON t.company_id = c.id
      LEFT JOIN drafts d ON d.company_id = c.id
      LEFT JOIN contacts p ON p.company_id = c.id
    ) x
    WHERE c.id = x.id AND (c.stage, c.qualified) IS DISTINCT FROM (x.stage, x.qualified)`);

  // Notifications: which company, what kind, and when it was seen.
  await sql(`
    UPDATE notifications n SET
      company_id = COALESCE(n.company_id, t.company_id),
      kind = COALESCE(n.kind, CASE
        WHEN n.message LIKE 'Meeting booked%' THEN 'meeting_booked'
        WHEN n.message LIKE 'Meeting moved%' THEN 'meeting_moved'
        WHEN n.message ILIKE '%follow-up%' OR n.message ILIKE '%follow up%' THEN 'follow_up'
        WHEN n.message ILIKE '%needs you%' OR n.message ILIKE '%needs a person%' OR n.message ILIKE '%handoff%' THEN 'needs_human'
        ELSE 'info' END),
      read_at = CASE WHEN n.read THEN COALESCE(n.read_at, now()) ELSE NULL END
    FROM notifications n2 LEFT JOIN threads t ON t.id = n2.thread_id
    WHERE n.id = n2.id AND (n.kind IS NULL OR (n.company_id IS NULL AND t.company_id IS NOT NULL) OR (n.read AND n.read_at IS NULL) OR (NOT n.read AND n.read_at IS NOT NULL))`);
}
