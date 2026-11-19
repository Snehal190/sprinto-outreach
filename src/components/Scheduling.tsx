"use client";

import { useState } from "react";
import { field, ghostBtn, label, primaryBtn, type Notice, type Rules, type Run, type Thread } from "./shared";

// After the email is sent: only where the conversation stands now. The state
// object and every checkpoint are kept on the server (thread_events) for the
// agent; the dashboard shows the latest status, the meeting and the reply box.

export function ThreadPanel({ thread, rules, run, busy, inbox }: { thread: Thread; rules: Rules; run: Run; busy: string | null; inbox: boolean }) {
  const [reply, setReply] = useState("");
  const working = busy !== null;
  const replyKey = `reply-${thread.id}`;

  return (
    <div className="mt-4">
      <div className={`rounded-2xl px-5 py-4 ${thread.needs_human ? "bg-primary text-white" : "bg-ink text-white"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-semibold">
            {thread.status_label}
            {thread.silent_hours !== null && !thread.needs_human && <span className="font-normal text-white/70"> · silent for {thread.silent_hours}h</span>}
          </p>
          {thread.needs_human && (
            <button disabled={working} onClick={() => run("resolveThread", { id: thread.id })} className="rounded-full border border-white/40 px-3 py-1 text-xs font-bold uppercase tracking-wider hover:border-white">
              Mark as handled
            </button>
          )}
        </div>
        {thread.status_detail && <p className="mt-1 font-serif text-2xl leading-snug">{thread.status_detail}</p>}
        {thread.meeting && thread.state.meeting_status === "confirmed" && (
          <a href={thread.meeting.link} target="_blank" rel="noreferrer" className="mt-1 inline-block break-all text-sm font-semibold text-white/80 underline-offset-4 hover:underline">
            {thread.meeting.link} ↗
          </a>
        )}
        {thread.updated_at && <p className="mt-2 text-xs text-white/50">Updated {thread.updated_at}</p>}
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
            <span className="text-xs text-ink/60">Gmail replies are picked up automatically while this page is open.</span>
          </>
        ) : (
          <span className="text-xs text-ink/60">Replies are pasted in by hand until Google is connected.</span>
        )}
      </div>

      <details className="mt-5 rounded-2xl border border-dashed border-ink/20 px-4 py-3">
        <summary className={`${label} cursor-pointer`}>Testing tools</summary>
        <p className="mt-2 text-xs text-ink/60">
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
      </details>
    </div>
  );
}

const IST = "Asia/Kolkata";
const dayKey = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

/** "Today, 3:13 PM", "Yesterday, 9:02 AM" or "Thu 12 Nov, 3:13 PM", all in IST. */
export function when(iso: string): string {
  const date = new Date(iso);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: IST, hour: "numeric", minute: "2-digit" }).format(date);
  const today = dayKey(new Date());
  const yesterday = dayKey(new Date(Date.now() - 86_400_000));
  const day = dayKey(date);
  if (day === today) return `Today, ${time}`;
  if (day === yesterday) return `Yesterday, ${time}`;
  const date_ = new Intl.DateTimeFormat("en-GB", { timeZone: IST, weekday: "short", day: "numeric", month: "short" }).format(date);
  return `${date_}, ${time}`;
}

/**
 * The notification bell's panel. New notifications first; dismissed ones stay
 * underneath as "Earlier", with their dates, so nothing disappears.
 */
export function NotificationList({ notices, run, busy, onOpen, meetingsDone }: { notices: Notice[]; run: Run; busy: string | null; onOpen: (companyId: number) => void; meetingsDone: Set<number> }) {
  if (notices.length === 0) return <p className="px-2 py-6 text-center text-sm text-ink/60">No notifications yet.</p>;
  const fresh = notices.filter((n) => !n.read);
  const old = notices.filter((n) => n.read);
  const item = (n: Notice) => {
    const done = n.company_id !== null && meetingsDone.has(n.company_id) && /^Meeting (booked|moved)/.test(n.message);
    return (
      <li key={n.id} className={`rounded-2xl px-4 py-3 text-sm ${n.read ? "border border-ink/5 bg-white text-ink/60" : "bg-mist text-ink"}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[11px] font-bold uppercase tracking-wider ${n.read ? "text-ink/40" : "text-primary"}`}>{when(n.created_at)}</span>
          {n.read && <span className="rounded-full bg-ink/5 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-ink/50">Old</span>}
          {done && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-emerald-800">Meeting done</span>}
        </div>
        <p className="mt-1 break-words">{n.message}</p>
        <div className="mt-1.5 flex justify-end gap-3">
          {n.company_id !== null && (
            <button onClick={() => onOpen(n.company_id!)} className="text-xs font-bold uppercase tracking-wider text-primary hover:underline">
              Open
            </button>
          )}
          {!n.read && (
            <button disabled={busy !== null} onClick={() => run("dismissNotification", { id: n.id })} className="text-xs font-bold uppercase tracking-wider text-ink/50 hover:text-ink">
              Mark as seen
            </button>
          )}
        </div>
      </li>
    );
  };
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 px-1 text-[11px] font-bold uppercase tracking-widest text-ink/50">New · {fresh.length}</p>
        {fresh.length ? <ul className="space-y-2">{fresh.map(item)}</ul> : <p className="px-1 text-sm text-ink/50">You are all caught up.</p>}
      </div>
      {old.length > 0 && (
        <div>
          <p className="mb-2 px-1 text-[11px] font-bold uppercase tracking-widest text-ink/40">Earlier</p>
          <ul className="space-y-2">{old.map(item)}</ul>
        </div>
      )}
    </div>
  );
}
