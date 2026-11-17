"use client";

import { useState } from "react";
import { card, field, ghostBtn, label, primaryBtn, type CalendarEvent, type Notice, type Rules, type Run, type Thread, type ThreadState } from "./shared";

// Everything that happens after the email is sent: the state object, the
// checkpoints, the reply box, notifications and the sender's calendar.

const FIELDS: (keyof ThreadState)[] = ["reply_status", "calendar_checked", "times_proposed", "reply_round", "meeting_status", "crm_logged"];

function show(value: ThreadState[keyof ThreadState]): string {
  if (Array.isArray(value)) return value.length ? value.join(" · ") : "none";
  return String(value);
}

/** The six state fields as chips. Fields that differ from `previous` are highlighted, as in a checkpoint table. */
function StateRow({ state, previous, compact }: { state: ThreadState; previous?: ThreadState; compact?: boolean }) {
  return (
    <div className={`grid gap-1.5 ${compact ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-3"}`}>
      {FIELDS.map((name) => {
        const changed = previous ? show(previous[name]) !== show(state[name]) : false;
        return (
          <div key={name} className={`rounded-xl px-3 py-2 ${changed ? "bg-primary text-white" : "bg-ink/[0.04] text-ink"}`}>
            <p className={`text-[10px] font-bold tracking-wide ${changed ? "text-white/70" : "text-ink/50"}`}>{name}</p>
            <p className={`break-words font-semibold ${compact ? "text-xs" : "text-sm"}`}>{show(state[name])}</p>
          </div>
        );
      })}
    </div>
  );
}

const KIND_LABEL: Record<string, string> = { email_out: "Email sent", email_in: "Reply received", tool: "Tool call", branch: "Branch", human: "Human" };

export function ThreadPanel({ thread, rules, run, busy, inbox }: { thread: Thread; rules: Rules; run: Run; busy: string | null; inbox: boolean }) {
  const [reply, setReply] = useState("");
  const working = busy !== null;
  const replyKey = `reply-${thread.id}`;

  return (
    <div className="mt-4">
      <div className={`rounded-2xl px-5 py-4 text-sm font-semibold ${thread.needs_human ? "bg-primary text-white" : "bg-ink text-white"}`}>
        {thread.status_label}
        {thread.needs_human && thread.human_reason && <span className="font-normal">: {thread.human_reason}</span>}
        {thread.silent_hours !== null && !thread.needs_human && <span className="font-normal text-white/70"> · silent for {thread.silent_hours}h</span>}
        {thread.needs_human && (
          <button disabled={working} onClick={() => run("resolveThread", { id: thread.id })} className="ml-3 rounded-full border border-white/40 px-3 py-1 text-xs font-bold uppercase tracking-wider hover:border-white">
            Mark as handled
          </button>
        )}
      </div>

      {thread.meeting && (
        <p className="mt-3 rounded-2xl border border-primary/20 px-4 py-3 text-sm text-ink">
          <strong>Meeting:</strong> {thread.meeting.when} ·{" "}
          <a href={thread.meeting.link} target="_blank" rel="noreferrer" className="font-semibold text-primary hover:underline">
            {thread.meeting.link} ↗
          </a>
        </p>
      )}

      <p className={`${label} mt-5`}>State object</p>
      <div className="mt-2">
        <StateRow state={thread.state} />
      </div>

      <label className="mt-5 block">
        <span className={label}>Prospect&apos;s reply</span>
        <textarea
          rows={3}
          value={reply}
          placeholder="Paste what the prospect wrote back, e.g. “Hey, running 10 min late, can we push to 3:15 instead of 3?”"
          onChange={(e) => setReply(e.target.value)}
          className={`${field} mt-1`}
        />
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          disabled={working || !reply.trim()}
          onClick={async () => {
            if (await run("receiveReply", { id: thread.id, text: reply }, replyKey)) setReply("");
          }}
          className={primaryBtn}
        >
          {busy === replyKey ? "Assistant is working…" : "Process reply"}
        </button>
        {inbox ? (
          <>
            <button disabled={working} onClick={() => run("checkInbox", {}, "checkInbox")} className={ghostBtn}>
              {busy === "checkInbox" ? "Checking…" : "Check inbox now"}
            </button>
            <span className="text-xs text-ink/60">Replies in Gmail are picked up automatically once a minute while this page is open. Pasting one here also works.</span>
          </>
        ) : (
          <span className="text-xs text-ink/60">Replies are pasted in by hand until Google is connected.</span>
        )}
      </div>

      <p className={`${label} mt-6`}>Checkpoints</p>
      <ol className="mt-2 space-y-2">
        {thread.events.map((event, i) => (
          <li key={event.id} className="rounded-2xl border border-ink/5 px-4 py-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="min-w-0 text-ink">
                <span className="mr-2 font-serif text-xl text-primary">{i + 1}</span>
                <span className="mr-2 rounded-full bg-blush px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-primary">{KIND_LABEL[event.kind] ?? event.kind}</span>
                {event.summary}
              </p>
              <span className="shrink-0 text-xs text-ink/50">{event.at}</span>
            </div>
            {event.body && (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-semibold text-primary">Show email</summary>
                <p className="mt-2 whitespace-pre-wrap rounded-xl bg-ink/[0.04] px-3 py-2 text-sm text-ink/80">{event.body}</p>
              </details>
            )}
            <div className="mt-2">
              <StateRow state={event.state} previous={i > 0 ? thread.events[i - 1].state : undefined} compact />
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-5 rounded-2xl border border-dashed border-ink/20 px-4 py-3">
        <p className={label}>Testing</p>
        <p className="mt-1 text-xs text-ink/60">
          A follow-up goes out after {rules.followUpAfterHours} hours of silence; {rules.concludeAfterHours} hours after that, the prospect is handed to you. These buttons pretend that time has passed.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button disabled={working} onClick={() => run("skipTime", { id: thread.id, hours: rules.followUpAfterHours }, "skipTime")} className={ghostBtn}>
            {busy === "skipTime" ? "Working…" : `Skip ${rules.followUpAfterHours} hours`}
          </button>
          <button disabled={working} onClick={() => run("skipTime", { id: thread.id, hours: rules.concludeAfterHours }, "skipTime")} className={ghostBtn}>
            Skip {rules.concludeAfterHours} hours
          </button>
          <button
            disabled={working}
            onClick={() => {
              if (window.confirm("Delete this conversation and its booking so the email can be sent again?")) run("resetThread", { id: thread.id });
            }}
            className={ghostBtn}
          >
            Reset conversation
          </button>
        </div>
      </div>
    </div>
  );
}

export function NotificationsCard({ notices, run, busy, onOpen }: { notices: Notice[]; run: Run; busy: string | null; onOpen: (companyId: number) => void }) {
  if (notices.length === 0) return null;
  return (
    <section className="mt-6 rounded-[2rem] border border-primary/20 bg-blush p-6">
      <h2 className="font-serif text-3xl tracking-tight">
        Notifications <span className="italic text-primary">({notices.length})</span>
      </h2>
      <ul className="mt-3 space-y-2">
        {notices.map((n) => (
          <li key={n.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-white px-4 py-3 text-sm">
            <p className="min-w-0 break-words text-ink">
              {n.message}
              <span className="block text-xs text-ink/50">{n.at}</span>
            </p>
            <span className="flex shrink-0 gap-2">
              {n.company_id !== null && (
                <button onClick={() => onOpen(n.company_id!)} className="text-xs font-bold uppercase tracking-wider text-primary hover:underline">
                  Open
                </button>
              )}
              <button disabled={busy !== null} onClick={() => run("dismissNotification", { id: n.id })} className="text-xs font-bold uppercase tracking-wider text-ink/50 hover:text-ink">
                Dismiss
              </button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CalendarCard({ events, rules, run, busy, google }: { events: CalendarEvent[]; rules: Rules; run: Run; busy: string | null; google: string | null }) {
  const [date, setDate] = useState("");
  const [title, setTitle] = useState("");
  return (
    <section className={`${card} mt-8`}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <div>
          <h2 className="font-serif text-4xl tracking-tight">
            Sender&apos;s <span className="italic text-primary">calendar</span>
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink/70">
            What <code>check_calendar</code> reads and <code>book_meeting</code> writes. Meetings are {rules.meetingMinutes} minutes, {rules.workHours}.{" "}
            {google ? `This is the Google Calendar of ${google}; meetings get a Google Meet link.` : "This is the app's own calendar; Google Calendar is not connected yet."}
          </p>
          {google && (
            <button
              disabled={busy !== null}
              onClick={() => {
                if (window.confirm("Disconnect Google? Emails will go back to Resend and the calendar to the app's own.")) run("disconnectGoogle");
              }}
              className={`${ghostBtn} mt-4`}
            >
              Disconnect Google
            </button>
          )}
          <div className={google ? "hidden" : ""}>
          <p className={`${label} mt-5`}>Add a busy block to test clashes</p>
          <input type="datetime-local" aria-label="Start, in IST" value={date} onChange={(e) => setDate(e.target.value)} className={`${field} mt-2`} />
          <input aria-label="Title" placeholder="Title, e.g. Team standup" value={title} onChange={(e) => setTitle(e.target.value)} className={`${field} mt-2`} />
          <button
            disabled={busy !== null || !date}
            onClick={async () => {
              if (await run("addBusy", { date, minutes: 60, title: title || "Busy" })) {
                setDate("");
                setTitle("");
              }
            }}
            className={`${ghostBtn} mt-3`}
          >
            Add 1-hour block (IST)
          </button>
          </div>
        </div>
        <div>
          <p className={label}>{google ? "Next 14 days" : "Upcoming"}</p>
          {events.length === 0 ? (
            <p className="mt-3 rounded-3xl bg-blush px-5 py-6 text-sm text-ink/70">Nothing on the calendar, so every slot inside meeting hours is free.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink/5 px-4 py-3 text-sm">
                  <p className="min-w-0 text-ink">
                    <strong>{e.when}</strong> · {e.minutes} min · {e.title}
                    {e.link && (
                      <a href={e.link} target="_blank" rel="noreferrer" className="block truncate text-xs font-semibold text-primary hover:underline">
                        {e.link}
                      </a>
                    )}
                  </p>
                  {e.thread_id === null && (
                    <button disabled={busy !== null} onClick={() => run("removeEvent", { id: e.id })} className="text-xs font-bold uppercase tracking-wider text-ink/50 hover:text-primary">
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
