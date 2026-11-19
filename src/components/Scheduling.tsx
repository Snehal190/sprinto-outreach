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

/** The notification bell's panel: what needs the human, newest first. */
export function NotificationList({ notices, run, busy, onOpen }: { notices: Notice[]; run: Run; busy: string | null; onOpen: (companyId: number) => void }) {
  if (notices.length === 0) return <p className="px-2 py-6 text-center text-sm text-ink/60">You are all caught up.</p>;
  return (
    <ul className="space-y-2">
      {notices.map((n) => (
        <li key={n.id} className="rounded-2xl bg-mist px-4 py-3 text-sm">
          <p className="break-words text-ink">{n.message}</p>
          <div className="mt-1.5 flex items-center justify-between gap-3">
            <span className="text-xs text-ink/50">{n.at}</span>
            <span className="flex shrink-0 gap-3">
              {n.company_id !== null && (
                <button onClick={() => onOpen(n.company_id!)} className="text-xs font-bold uppercase tracking-wider text-primary hover:underline">
                  Open
                </button>
              )}
              <button disabled={busy !== null} onClick={() => run("dismissNotification", { id: n.id })} className="text-xs font-bold uppercase tracking-wider text-ink/50 hover:text-ink">
                Dismiss
              </button>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}
