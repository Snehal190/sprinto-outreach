// Style strings and types shared by the dashboard components.

export const card = "rounded-[2rem] border border-ink/5 bg-white p-6 sm:p-8";
export const label = "text-[11px] font-bold uppercase tracking-widest text-ink/50";
export const field =
  "w-full rounded-2xl border border-ink/10 bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/15";
export const primaryBtn =
  "inline-flex items-center justify-center gap-2 rounded-[30px] bg-primary px-6 py-3 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-primary/20 transition duration-300 ease-out-expo hover:bg-primary-dark disabled:cursor-not-allowed disabled:opacity-50";
export const ghostBtn =
  "inline-flex items-center justify-center gap-2 rounded-[30px] border-2 border-ink/10 px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-ink transition duration-300 ease-out-expo hover:border-primary hover:text-primary disabled:cursor-not-allowed disabled:opacity-50";

/** Runs a dashboard action on the server and refreshes the state. Resolves to true on success. */
export type Run = (action: string, payload?: Record<string, unknown>, busyKey?: string) => Promise<boolean>;

/** The six fields that travel with every prospect after the email is sent. */
export type ThreadState = {
  reply_status: "no_reply" | "interested" | "not_interested";
  calendar_checked: boolean;
  times_proposed: string[];
  reply_round: number;
  meeting_status: "unscheduled" | "pending_confirmation" | "confirmed";
  crm_logged: boolean;
};

export type Thread = {
  id: number;
  state: ThreadState;
  status_label: string;
  needs_human: boolean;
  human_reason: string | null;
  /** The time that matters right now: the meeting time, or the proposed slots. */
  status_detail: string | null;
  meeting: { when: string; link: string } | null;
  silent_hours: number | null;
  follow_up_sent_at: string | null;
  /** When the latest checkpoint happened. */
  updated_at: string | null;
};

export type Notice = { id: number; message: string; at: string; company_id: number | null };
export type CalendarEvent = { id: number; when: string; minutes: number; title: string; link: string | null; thread_id: number | null };
export type Rules = { followUpAfterHours: number; concludeAfterHours: number; workHours: string; meetingMinutes: number };
