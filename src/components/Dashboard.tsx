"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarCard, NotificationsCard, ThreadPanel } from "./Scheduling";
import { card, field, ghostBtn, label, primaryBtn, type CalendarEvent, type Notice, type Rules, type Run, type Thread } from "./shared";

type Contact = {
  id: number;
  first_name: string;
  last_name: string;
  title: string;
  email: string | null;
  confidence: number | null;
  source: "hunter" | "scraped" | "mock" | "manual";
  pain_points: string[];
  linkedin: string | null;
  research: {
    summary: string;
    facts: ({ text: string; verified: boolean; url: string | null; quote: string | null } | string)[];
    steps: { source: string; url: string | null; outcome: string }[];
  } | null;
};

type Draft = {
  id: number;
  hook: string;
  subject: string;
  body: string;
  original_subject: string;
  original_body: string;
  feedback: string;
  status: "draft" | "sent" | "simulated";
  sent_at: string | null;
  updated_at: string;
  applied_lessons: { id: number; match: string; rules: string[] }[];
  lesson: {
    components: Record<string, { changed: boolean; before: string; after: string; lesson: string | null }>;
    rules: string[];
    tone: string | null;
    delta_body: number;
    sent: boolean;
  } | null;
};

type Feedback = {
  lessons: number;
  sentUntouched: number;
  averageDelta: number | null;
  firstFiveDelta: number | null;
  lastFiveDelta: number | null;
  recent: { id: number; persona: string; framework: string; stage: string; rules: string[]; delta: number; sent: boolean }[];
};

type Company = {
  id: number;
  name: string;
  domain: string;
  description: string | null;
  funding_stage: string | null;
  last_funding: string | null;
  hq: string | null;
  employees: string | null;
  target_markets: string | null;
  certifications_held: string | null;
  signals: string[];
  sources: string[];
  fit_score: number | null;
  fit_reason: string | null;
  recommended_framework: string | null;
  info_sufficient: boolean;
  missing_info: string | null;
  status: "candidate" | "shortlisted" | "rejected";
  profile: { industry: string | null; company_type: string | null; technologies: string[] } | null;
  scrape_status: "none" | "pending" | "done" | "failed";
  scrape_summary: {
    exitReason: string;
    exitText: string;
    steps: { source: string; why: string; url: string | null; outcome: string; openAfter: string[] }[];
    pagesRead?: number;
    durationMs?: number;
  } | null;
  contact: Contact | null;
  draft: Draft | null;
  thread: Thread | null;
};

type Settings = { icp: string; product: string; senderName: string; senderTitle: string };

type State = {
  settings: Settings;
  companies: Company[];
  editsLogged: number;
  feedback: Feedback;
  notifications: Notice[];
  calendar: CalendarEvent[];
  rules: Rules;
  config: {
    db: "neon" | "local"; model: string; hunter: boolean; resend: boolean; testRecipient: string | null;
    google: { configured: boolean; email: string | null };
  };
  apis: ApiStatus[];
};

type ApiStatus = { api: string; label: string; ok: boolean; off: boolean; detail: string; short: string; ms: number; checkedAt: string };

export default function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [filter, setFilter] = useState<"shortlisted" | "candidate" | "rejected" | "all">("shortlisted");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/state")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setState(d.state);
        else setError(d.error);
        // A failed Google sign-in comes back as ?google_error=... on the address.
        const googleError = new URLSearchParams(window.location.search).get("google_error");
        if (googleError) {
          setError(`Google: ${googleError}`);
          window.history.replaceState(null, "", "/");
        }
      })
      .catch((e) => setError(e.message));
  }, []);

  // Refresh once a minute while idle. Loading the state also runs the silence
  // checks on the server, so follow-ups and handoffs happen while the dashboard is open.
  const idle = busy === null;
  useEffect(() => {
    if (!idle) return;
    const timer = setInterval(() => {
      fetch("/api/state")
        .then((r) => r.json())
        .then((d) => d.ok && setState(d.state))
        .catch(() => {});
    }, 60_000);
    return () => clearInterval(timer);
  }, [idle]);

  const run: Run = useCallback(async (action, payload = {}, busyKey) => {
    setBusy(busyKey ?? action);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setState(data.state);
      if (action === "discover") {
        setNotice(data.result.added ? `Added ${data.result.added} new companies.` : "No new companies were found this time.");
      }
      if (action === "addCompanies") {
        setNotice(data.result.added ? `Added ${data.result.added} companies. Researching their websites now.` : "Those companies are already in the list.");
      }
      if (action === "receiveReply") {
        setNotice(
          data.result.intent === "other"
            ? "That reply needs a person. It has been flagged for you."
            : `Reply handled (${String(data.result.intent).replace("_", " ")})${data.result.booked ? ". Meeting booked and the link sent." : "."}`,
        );
      }
      if (action === "testApis") {
        const broken = (data.result as ApiStatus[]).filter((a) => !a.ok && !a.off);
        setNotice(broken.length ? `API test failed: ${broken.map((a) => `${a.label}: ${a.detail}`).join(" · ")}` : "API test: everything that is set up is working.");
      }
      if (action === "checkInbox") {
        setNotice(data.result.handled ? `Handled ${data.result.handled} new repl${data.result.handled === 1 ? "y" : "ies"} from the inbox.` : "No new replies in the inbox.");
      }
      if (action === "saveDraft") {
        setNotice(
          data.result.captureError
            ? `Saved, but the feedback loop could not analyse the edit: ${data.result.captureError}`
            : data.result.learned
              ? `Saved. The feedback loop captured ${data.result.learned} lesson${data.result.learned === 1 ? "" : "s"} from your changes.`
              : "Saved.",
        );
      }
      if (action === "send") {
        setNotice(
          data.result.status === "sent"
            ? "Email sent."
            : data.result.status === "test"
              ? `Test email sent to ${data.result.to}. Nothing went to the prospect, and the draft is still open.` +
                (data.result.failed?.length ? ` Not delivered: ${data.result.failed.join("; ")}` : "")
              : "Send simulated. No email went out because Resend is not connected yet.",
        );
      }
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  // Scrape queue: companies waiting for research are scraped one at a time.
  // Each company is attempted once per page load, so a failure cannot loop.
  const attempted = useRef(new Set<number>());
  useEffect(() => {
    if (!state || busy !== null) return;
    const next = state.companies.find((c) => c.scrape_status === "pending" && !attempted.current.has(c.id));
    if (!next) return;
    attempted.current.add(next.id);
    run("scrape", { id: next.id }, `scrape-${next.id}`);
  }, [state, busy, run]);

  if (!state) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <p className="font-serif text-3xl italic text-primary">{error ?? "Loading the funnel…"}</p>
      </main>
    );
  }

  const { companies, config } = state;
  const count = (fn: (c: Company) => boolean) => companies.filter(fn).length;
  const stats = [
    { name: "Companies found", value: companies.length },
    { name: "Shortlisted", value: count((c) => c.status === "shortlisted") },
    { name: "POCs found", value: count((c) => !!c.contact) },
    { name: "Emails drafted", value: count((c) => !!c.draft) },
    { name: "Sent", value: count((c) => c.draft?.status === "sent" || c.draft?.status === "simulated") },
  ];
  const queued = count((c) => c.scrape_status === "pending");
  const visible = companies.filter((c) => filter === "all" || c.status === filter);
  const selected = companies.find((c) => c.id === selectedId) ?? visible[0] ?? null;

  return (
    <div className="relative overflow-x-clip">
      <div className="pointer-events-none absolute -right-40 -top-40 h-[30rem] w-[30rem] rounded-full bg-primary/10 blur-[120px]" />
      <div className="pointer-events-none absolute -left-40 top-[40rem] h-[26rem] w-[26rem] rounded-full bg-primary/10 blur-[100px]" />

      <header className="fixed inset-x-0 top-0 z-20 border-b border-ink/5 bg-white/80 backdrop-blur-[12px]">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-8">
          <div className="group flex items-center gap-3">
            <span className="flex h-9 w-9 rotate-3 items-center justify-center rounded-lg bg-primary font-serif text-xl font-bold italic text-white transition duration-300 group-hover:rotate-12">
              S
            </span>
            <span className="text-sm font-bold text-ink">Sprinto Outreach</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {state.apis.map((a) => (
              <ApiPill key={a.api} status={a} />
            ))}
            {config.google.email ? null : config.google.configured ? (
              <a href="/api/google/connect" className="rounded-full bg-primary px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-white hover:bg-primary-dark">
                Connect Google
              </a>
            ) : (
              <Pill ok={false} text="Google not set up" />
            )}
            <Pill ok text={config.model} />
            <button
              disabled={busy !== null}
              onClick={() => run("testApis", {}, "testApis")}
              className="rounded-full border border-primary/30 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-primary hover:border-primary disabled:opacity-50"
            >
              {busy === "testApis" ? "Testing…" : "Test APIs"}
            </button>
          </div>
        </div>
      </header>

      <main className="relative mx-auto max-w-7xl px-4 pb-24 pt-32 sm:px-8">
        <section className="animate-fade-up text-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-blush px-4 py-1.5 text-xs font-bold text-primary">
            ✦ ICP to inbox, with a human on send
          </span>
          <h1 className="mt-6 font-serif text-6xl leading-[0.95] tracking-tight text-ink sm:text-8xl">
            Find the right company.
            <br />
            <span className="italic text-primary">Write the right email.</span>
          </h1>
        </section>

        <section className="mt-12 grid animate-fade-up grid-cols-2 gap-3 sm:grid-cols-5">
          {stats.map((s, i) => (
            <div key={s.name} className="rounded-3xl border border-ink/5 bg-white p-5">
              <p className={label}>
                {i + 1}. {s.name}
              </p>
              <p className="mt-2 font-serif text-5xl text-ink">{s.value}</p>
            </div>
          ))}
        </section>

        {queued > 0 && (
          <div role="status" className="mt-6 rounded-3xl bg-ink px-6 py-4 text-sm font-semibold text-white">
            Researching company websites… {queued} left. Each one takes up to two minutes.
          </div>
        )}

        <NotificationsCard
          notices={state.notifications}
          run={run}
          busy={busy}
          onOpen={(companyId) => {
            setFilter("all");
            setSelectedId(companyId);
          }}
        />

        {(error || notice) && (
          <div
            role="status"
            className={`mt-6 rounded-3xl px-6 py-4 text-sm font-semibold ${error ? "bg-primary text-white" : "bg-blush text-primary"}`}
          >
            {error ?? notice}
          </div>
        )}

        <SettingsCard key={JSON.stringify(state.settings)} settings={state.settings} run={run} busy={busy} />

        <section className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className={`${card} self-start lg:sticky lg:top-24`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-serif text-4xl tracking-tight">Companies</h2>
              <div className="flex flex-wrap gap-1 rounded-full bg-blush p-1">
                {(["shortlisted", "candidate", "rejected", "all"] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`rounded-full px-3 py-1.5 text-xs font-bold capitalize transition ${filter === f ? "bg-primary text-white" : "text-ink/70 hover:text-primary"}`}
                  >
                    {f === "candidate" ? "Below bar" : f}
                  </button>
                ))}
              </div>
            </div>
            <ul className="mt-6 space-y-3">
              {visible.length === 0 && (
                <li className="rounded-3xl bg-blush px-5 py-8 text-center text-sm text-ink/70">
                  {companies.length === 0 ? "No companies yet. Press “Find companies” above to start the funnel." : "Nothing in this view."}
                </li>
              )}
              {visible.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setSelectedId(c.id)}
                    className={`w-full rounded-3xl border p-4 text-left transition duration-300 ease-out-expo ${selected?.id === c.id ? "border-primary bg-blush" : "border-ink/5 bg-white hover:border-primary/40"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-base font-bold text-ink">{c.name}</p>
                        <p className="truncate text-xs text-ink/60">
                          {c.domain} · {c.funding_stage ?? "stage unknown"}
                        </p>
                      </div>
                      <span className="shrink-0 font-serif text-4xl leading-none text-primary">{c.fit_score ?? "–"}</span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {c.recommended_framework && <Tag>{c.recommended_framework}</Tag>}
                      {busy === `scrape-${c.id}` ? (
                        <Tag dark>Researching…</Tag>
                      ) : c.scrape_status === "pending" ? (
                        <Tag dark>Queued</Tag>
                      ) : c.scrape_status === "done" ? (
                        <Tag>{c.info_sufficient ? "Researched" : "Researched, gaps remain"}</Tag>
                      ) : (
                        !c.info_sufficient && <Tag dark>Needs research</Tag>
                      )}
                      {c.contact && <Tag>POC</Tag>}
                      {c.draft && !c.thread && <Tag>{c.draft.status === "draft" ? "Drafted" : c.draft.status === "sent" ? "Sent" : "Send simulated"}</Tag>}
                      {c.thread && <Tag dark={c.thread.needs_human}>{c.thread.status_label}</Tag>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {selected ? (
            <Detail company={selected} run={run} busy={busy} config={config} rules={state.rules} />
          ) : (
            <div className={`${card} flex items-center justify-center text-sm text-ink/60`}>Select a company to see its POC and draft.</div>
          )}
        </section>

        <CalendarCard events={state.calendar} rules={state.rules} run={run} busy={busy} google={config.google.email} />

        <FeedbackCard feedback={state.feedback} />

        <p className="mt-10 text-center text-[11px] font-bold uppercase tracking-widest text-ink/40">
          {state.editsLogged} human edits logged · evals come next
        </p>
      </main>
    </div>
  );
}

function FeedbackCard({ feedback }: { feedback: Feedback }) {
  return (
    <section className={`${card} mt-8`}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <div>
          <h2 className="font-serif text-4xl tracking-tight">
            Feedback <span className="italic text-primary">loop</span>
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-ink/70">
            Every edit you save is compared with the system&apos;s own draft. What changed in the subject, hook, angle and call to action is stored, and applied to
            the next draft for a similar prospect.
          </p>
          <dl className="mt-5 grid grid-cols-3 gap-3">
            <div>
              <dt className={label}>Lessons</dt>
              <dd className="font-serif text-4xl text-ink">{feedback.lessons}</dd>
            </div>
            <div>
              <dt className={label}>Avg. rewrite</dt>
              <dd className="font-serif text-4xl text-ink">{feedback.averageDelta === null ? "–" : `${feedback.averageDelta}%`}</dd>
            </div>
            <div>
              <dt className={label}>Sent as drafted</dt>
              <dd className="font-serif text-4xl text-ink">{feedback.sentUntouched}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-ink/60">
            {feedback.firstFiveDelta !== null && feedback.lastFiveDelta !== null
              ? `Rewrite needed: ${feedback.firstFiveDelta}% on the first five edited drafts, ${feedback.lastFiveDelta}% on the latest five.`
              : "Avg. rewrite is the share of the email body you changed. The trend appears after ten edited drafts."}
          </p>
        </div>
        <div>
          <p className={label}>Latest lessons learned</p>
          {feedback.recent.length === 0 ? (
            <p className="mt-3 rounded-3xl bg-blush px-5 py-6 text-sm text-ink/70">Nothing learned yet. Edit a draft and save it to teach the system.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {feedback.recent.map((l) => (
                <li key={l.id} className="rounded-2xl border border-ink/5 px-4 py-3 text-sm">
                  <p className="text-xs font-semibold text-ink/60">
                    {l.persona} · {l.stage} · {l.framework} · {l.delta}% rewritten{l.sent && " · sent"}
                  </p>
                  <ul className="mt-1.5 space-y-1 text-ink">
                    {l.rules.map((r, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="text-primary">✦</span>
                        {r}
                      </li>
                    ))}
                    {l.rules.length === 0 && <li className="text-ink/50">No general lesson (a one-off correction).</li>}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

/** One API's last test: green when working, maroon when failing, grey when not set up. Hover for the detail. */
function ApiPill({ status }: { status: ApiStatus }) {
  const tested = status.checkedAt !== "";
  const dot = !tested ? "bg-ink/20 animate-pulse" : status.ok ? "bg-emerald-600" : status.off ? "bg-ink/30" : "bg-primary";
  const when = tested ? ` · tested ${new Date(status.checkedAt).toLocaleTimeString()} in ${status.ms} ms` : "";
  return (
    <span
      title={`${status.label}: ${status.detail}${when}`}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-semibold ${tested && !status.ok && !status.off ? "border-primary/40 bg-blush text-primary" : "border-ink/10 bg-white text-ink/80"}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {status.label} · {status.short}
    </span>
  );
}

function Pill({ ok, text }: { ok: boolean; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-ink/10 bg-white px-3 py-1 text-[11px] font-semibold text-ink/80">
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-primary" : "bg-ink/30"}`} />
      {text}
    </span>
  );
}

function Tag({ children, dark }: { children: React.ReactNode; dark?: boolean }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold ${dark ? "bg-ink text-white" : "bg-white text-primary ring-1 ring-primary/20"}`}>
      {children}
    </span>
  );
}

function SettingsCard({ settings, run, busy }: { settings: Settings; run: Run; busy: string | null }) {
  const [form, setForm] = useState(settings);
  const [count, setCount] = useState(5);
  const [websites, setWebsites] = useState("");
  const dirty = JSON.stringify(form) !== JSON.stringify(settings);
  const set = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm({ ...form, [k]: e.target.value });
  const dark = "w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition placeholder:text-white/30 focus:border-white/40";
  const darkLabel = "text-[11px] font-bold uppercase tracking-widest text-white/50";

  return (
    <section className="mt-8 rounded-[3rem] bg-ink p-6 text-white sm:p-10">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <div>
          <h2 className="font-serif text-5xl tracking-tight">
            The <span className="italic">ideal customer</span>
          </h2>
          <label className="mt-6 block">
            <span className={darkLabel}>ICP definition</span>
            <textarea rows={3} value={form.icp} onChange={set("icp")} className={`${dark} mt-2`} />
          </label>
          <label className="mt-4 block">
            <span className={darkLabel}>What we sell</span>
            <textarea rows={2} value={form.product} onChange={set("product")} className={`${dark} mt-2`} />
          </label>
        </div>
        <div className="flex flex-col">
          <span className={darkLabel}>Emails are signed by</span>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <input aria-label="Sender name" placeholder="Your name" value={form.senderName} onChange={set("senderName")} className={dark} />
            <input aria-label="Sender title" placeholder="Your title" value={form.senderTitle} onChange={set("senderTitle")} className={dark} />
          </div>
          <button
            disabled={!dirty || busy !== null}
            onClick={() => run("saveSettings", { settings: form })}
            className="mt-3 self-start rounded-[30px] border-2 border-white/20 px-5 py-2.5 text-xs font-bold uppercase tracking-wider transition hover:border-white disabled:opacity-40"
          >
            {busy === "saveSettings" ? "Saving…" : dirty ? "Save changes" : "Saved"}
          </button>

          <div className="mt-auto pt-8">
            <span className={darkLabel}>Search the web for matching companies</span>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <select aria-label="How many companies" value={count} onChange={(e) => setCount(Number(e.target.value))} className={`${dark} w-auto`}>
                {[3, 5, 8, 10].map((n) => (
                  <option key={n} value={n} className="text-ink">
                    {n} companies
                  </option>
                ))}
              </select>
              <button disabled={busy !== null || dirty} onClick={() => run("discover", { count })} className={primaryBtn}>
                {busy === "discover" ? "Searching… about a minute" : "Find companies"}
              </button>
            </div>
            {dirty && <p className="mt-2 text-xs text-white/50">Save your changes before searching.</p>}

            <label className="mt-6 block">
              <span className={darkLabel}>Or paste your own company websites, one per line</span>
              <textarea
                rows={3}
                value={websites}
                placeholder={"acme.com\nexample.io"}
                onChange={(e) => setWebsites(e.target.value)}
                className={`${dark} mt-2`}
              />
            </label>
            <button
              disabled={busy !== null || dirty || !websites.trim()}
              onClick={async () => {
                if (await run("addCompanies", { websites: websites.split(/[\s,]+/).filter(Boolean) })) setWebsites("");
              }}
              className={`${primaryBtn} mt-3`}
            >
              {busy === "addCompanies" ? "Adding…" : "Add and research"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Detail({ company: c, run, busy, config, rules }: { company: Company; run: Run; busy: string | null; config: State["config"]; rules: Rules }) {
  const facts: [string, string | null][] = [
    ["Funding", c.last_funding && c.last_funding !== "unknown" ? c.last_funding : c.funding_stage],
    ["HQ", c.hq],
    ["Employees", c.employees],
    ["Sells to", c.target_markets],
    ["Certifications held", c.certifications_held],
    ...(c.profile
      ? ([
          ["Industry (Hunter.io)", [c.profile.industry, c.profile.company_type].filter(Boolean).join(" · ") || null],
          ["Technologies (Hunter.io)", c.profile.technologies.slice(0, 12).join(", ") || null],
        ] as [string, string | null][])
      : []),
  ];
  const working = busy !== null;

  return (
    <div className={`${card} animate-fade-up`} key={c.id}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-serif text-5xl tracking-tight">{c.name}</h2>
          <a href={`https://${c.domain}`} target="_blank" rel="noreferrer" className="text-sm font-semibold text-primary hover:underline">
            {c.domain} ↗
          </a>
        </div>
        <div className="flex gap-2">
          {c.status !== "shortlisted" && (
            <button disabled={working} onClick={() => run("setStatus", { id: c.id, status: "shortlisted" })} className={ghostBtn}>
              Shortlist
            </button>
          )}
          {c.status !== "rejected" && (
            <button disabled={working} onClick={() => run("setStatus", { id: c.id, status: "rejected" })} className={ghostBtn}>
              Reject
            </button>
          )}
          <button
            disabled={working}
            onClick={() => {
              if (window.confirm(`Remove ${c.name} and its contact, draft and research from the list?`)) run("deleteCompany", { id: c.id });
            }}
            className={ghostBtn}
          >
            Remove
          </button>
        </div>
      </div>

      <p className="mt-4 text-sm leading-relaxed text-ink/80">{c.description}</p>

      <div className="mt-5 rounded-3xl bg-blush p-5">
        <p className={label}>
          ICP fit · {c.fit_score ?? "not scored"}
          {c.fit_score !== null && "/100"}
          {c.recommended_framework && ` · lead with ${c.recommended_framework}`}
        </p>
        <p className="mt-2 text-sm leading-relaxed text-ink">{c.fit_reason ?? "No score yet."}</p>
        {!c.info_sufficient && (
          <p className="mt-3 text-sm text-ink/70">
            <strong className="text-ink">Gaps:</strong> {c.missing_info || "not enough information to judge fit confidently."}
          </p>
        )}
      </div>

      <dl className="mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt className={label}>{k}</dt>
            <dd className="mt-0.5 text-sm text-ink">{v || "unknown"}</dd>
          </div>
        ))}
      </dl>

      {c.signals.length > 0 && (
        <div className="mt-5">
          <p className={label}>Intent signals</p>
          <ul className="mt-2 space-y-1.5 text-sm text-ink/80">
            {c.signals.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-primary">✦</span>
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}

      <hr className="my-7 border-ink/5" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-serif text-3xl">Website research</h3>
        <button disabled={working} onClick={() => run("scrape", { id: c.id }, `scrape-${c.id}`)} className={ghostBtn}>
          {busy === `scrape-${c.id}` ? "Researching… up to 2 min" : c.scrape_summary ? "Research again" : "Research website"}
        </button>
      </div>
      {c.scrape_summary ? (
        <div className="mt-3">
          <p className="text-sm font-semibold text-ink">
            {c.scrape_summary.exitText}
            {c.scrape_summary.pagesRead !== undefined && (
              <span className="font-normal text-ink/60">
                {" "}
                {c.scrape_summary.pagesRead} pages read in {Math.round((c.scrape_summary.durationMs ?? 0) / 1000)}s.
              </span>
            )}
          </p>
          <ol className="mt-3 space-y-2">
            {c.scrape_summary.steps.map((step, i) => (
              <li key={i} className="flex gap-3 rounded-2xl border border-ink/5 px-4 py-3 text-sm">
                <span className="font-serif text-2xl leading-none text-primary">{i + 1}</span>
                <div className="min-w-0">
                  <p className="text-ink">
                    <strong className="capitalize">{step.source.replace("_", " ")}</strong> <span className="text-ink/60">{step.why}</span> · {step.outcome}
                  </p>
                  {step.url?.startsWith("http") && <p className="truncate text-xs text-ink/50">{step.url}</p>}
                  <p className="mt-0.5 text-xs text-ink/60">
                    {step.openAfter.length ? `Still open: ${step.openAfter.join(", ").replaceAll("_", " ")}` : "Nothing left open"}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <p className="mt-3 text-sm text-ink/60">
          Reads the homepage, then fetches further pages (careers, security, about…) only while a question about ICP fit is still open.
        </p>
      )}

      <hr className="my-7 border-ink/5" />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-serif text-3xl">Point of contact</h3>
        <button disabled={working} onClick={() => run("findPoc", { id: c.id }, `poc-${c.id}`)} className={c.contact ? ghostBtn : primaryBtn}>
          {busy === `poc-${c.id}` ? "Finding and researching…" : c.contact ? "Find again" : "Find POC"}
        </button>
      </div>
      {c.contact ? (
        <ContactEditor key={JSON.stringify(c.contact)} contact={c.contact} companyId={c.id} run={run} busy={busy} />
      ) : (
        <p className="mt-3 text-sm text-ink/60">
          {config.hunter ? "Looks up the right person on Hunter.io (falling back to the company's website), researches them" : "Hunter.io is not connected yet, so this looks for a named person on the company's website"}, then works out
          their two pain points.
        </p>
      )}

      {c.contact && (
        <>
          <hr className="my-7 border-ink/5" />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-serif text-3xl">Email draft</h3>
            <button
              disabled={working || c.draft?.status === "sent"}
              onClick={() => {
                if (!c.draft || window.confirm("Replace the current draft with a newly generated one?")) run("draft", { id: c.id }, `draft-${c.id}`);
              }}
              className={c.draft ? ghostBtn : primaryBtn}
            >
              {busy === `draft-${c.id}` ? "Writing…" : c.draft ? "Regenerate" : "Draft email"}
            </button>
          </div>
          {c.draft ? (
            <DraftEditor key={`${c.draft.id}-${c.draft.updated_at}-${c.draft.status}`} draft={c.draft} contact={c.contact} run={run} busy={busy} config={config} />
          ) : (
            <p className="mt-3 text-sm text-ink/60">Writes a personalised email with a hook and both pain points.</p>
          )}
        </>
      )}

      {c.thread && (
        <>
          <hr className="my-7 border-ink/5" />
          <h3 className="font-serif text-3xl">After the send</h3>
          <ThreadPanel key={c.thread.id} thread={c.thread} rules={rules} run={run} busy={busy} inbox={!!config.google.email} />
        </>
      )}
    </div>
  );
}

function ContactEditor({ contact, companyId, run, busy }: { contact: Contact; companyId: number; run: Run; busy: string | null }) {
  const [form, setForm] = useState({ first_name: contact.first_name, last_name: contact.last_name, title: contact.title, email: contact.email ?? "" });
  const dirty = (Object.keys(form) as (keyof typeof form)[]).some((k) => form[k] !== (contact[k] ?? ""));
  const input = (k: keyof typeof form, name: string) => (
    <label className="block">
      <span className={label}>{name}</span>
      <input value={form[k] ?? ""} onChange={(e) => setForm({ ...form, [k]: e.target.value })} className={`${field} mt-1`} />
    </label>
  );
  const sourceText =
    contact.source === "hunter"
      ? `From Hunter.io${contact.confidence ? ` · ${contact.confidence}% confidence` : ""}`
      : contact.source === "scraped"
        ? contact.email
          ? "Found on the company's website"
          : "Name found on the company's website, but no email. Add the email to be able to send."
        : contact.source === "manual"
        ? "Entered by hand"
        : "Placeholder contact. Replace with the real person, or connect Hunter.io.";

  return (
    <div className="mt-4">
      <p className={`text-xs font-semibold ${contact.source === "mock" || !contact.email ? "text-primary" : "text-ink/60"}`}>{sourceText}</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {input("first_name", "First name")}
        {input("last_name", "Last name")}
        {input("title", "Title")}
        {input("email", "Email")}
      </div>
      {dirty && (
        <button disabled={busy !== null} onClick={() => run("updateContact", { id: contact.id, contact: form })} className={`${ghostBtn} mt-3`}>
          {busy === "updateContact" ? "Saving…" : "Save contact"}
        </button>
      )}
      {contact.research && (
        <div className="mt-5">
          <p className={label}>
            About this person
            {contact.linkedin && (
              <>
                {" · "}
                <a href={contact.linkedin.startsWith("http") ? contact.linkedin : `https://www.linkedin.com/in/${contact.linkedin}`} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                  LinkedIn ↗
                </a>
              </>
            )}
          </p>
          <p className="mt-2 text-sm leading-relaxed text-ink/70">{contact.research.summary}</p>
          {contact.research.facts.length > 0 && (
            <ul className="mt-3 space-y-2 text-sm">
              {contact.research.facts.map((raw, i) => {
                const f = typeof raw === "string" ? { text: raw, verified: false, url: null, quote: null } : raw;
                return (
                  <li key={i} className={`rounded-2xl border px-4 py-3 ${f.verified ? "border-primary/20 bg-white" : "border-ink/5 bg-ink/[0.03]"}`}>
                    <p className={f.verified ? "text-ink" : "text-ink/50"}>
                      <span className={`mr-2 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${f.verified ? "bg-primary text-white" : "bg-ink/10 text-ink/60"}`}>
                        {f.verified ? "Verified" : "Unverified, not used"}
                      </span>
                      {f.text}
                    </p>
                    {f.verified && f.url && (
                      <p className="mt-1.5 text-xs text-ink/60">
                        “{f.quote}” ·{" "}
                        <a href={f.url} target="_blank" rel="noreferrer" className="font-semibold text-primary hover:underline">
                          source ↗
                        </a>
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-ink/50">
            Researched from: {contact.research.steps.map((s) => `${s.source.replace("_", " ")} (${s.outcome})`).join(" → ")}
          </p>
        </div>
      )}
      {contact.source !== "mock" && (
        <button disabled={busy !== null} onClick={() => run("researchPoc", { id: companyId }, "researchPoc")} className={`${ghostBtn} mt-3`}>
          {busy === "researchPoc" ? "Researching and verifying…" : contact.research ? "Research again (no Hunter credit)" : "Research this person"}
        </button>
      )}
      <p className={`${label} mt-5`}>Their two pain points</p>
      <ol className="mt-2 space-y-2">
        {contact.pain_points.map((p, i) => (
          <li key={i} className="flex gap-3 rounded-2xl bg-blush px-4 py-3 text-sm text-ink">
            <span className="font-serif text-2xl leading-none text-primary">{i + 1}</span>
            {p}
          </li>
        ))}
      </ol>
    </div>
  );
}

function DraftEditor({ draft, contact, run, busy, config }: { draft: Draft; contact: Contact; run: Run; busy: string | null; config: State["config"] }) {
  const [subject, setSubject] = useState(draft.subject);
  const [body, setBody] = useState(draft.body);
  const [feedback, setFeedback] = useState(draft.feedback);
  const done = draft.status !== "draft";
  const dirty = subject !== draft.subject || body !== draft.body || feedback !== draft.feedback;
  const edited = draft.subject !== draft.original_subject || draft.body !== draft.original_body;
  const words = body.trim().split(/\s+/).filter(Boolean).length;

  const send = async () => {
    const target = config.resend && config.testRecipient
      ? `Test mode: send this email to ${config.testRecipient}? Nothing goes to the prospect.`
      : config.resend
      ? `Send this email to ${contact.email}? This cannot be undone.`
      : "Resend is not connected, so this will only be recorded as a simulated send. Continue?";
    if (!window.confirm(target)) return;
    if (dirty && !(await run("saveDraft", { id: draft.id, draft: { subject, body, feedback } }))) return;
    await run("send", { id: draft.id });
  };

  return (
    <div className="mt-4">
      {draft.hook && (
        <p className="rounded-2xl border-l-4 border-primary bg-blush px-4 py-3 text-sm italic text-ink">
          <span className={`${label} not-italic`}>Hook · </span>
          {draft.hook}
        </p>
      )}
      {draft.applied_lessons?.length > 0 && (
        <details className="mt-3 rounded-2xl border border-primary/20 px-4 py-3 text-sm">
          <summary className="cursor-pointer font-semibold text-primary">
            Written using {draft.applied_lessons.length} lesson{draft.applied_lessons.length === 1 ? "" : "s"} from your past edits
          </summary>
          <ul className="mt-2 space-y-2 text-ink/80">
            {draft.applied_lessons.map((l) => (
              <li key={l.id}>
                <span className="text-xs font-semibold text-ink/50">{l.match}</span>
                <br />
                {l.rules.join(" ")}
              </li>
            ))}
          </ul>
        </details>
      )}
      <label className="mt-4 block">
        <span className={label}>To</span>
        {config.testRecipient ? (
          <p className="mt-1 text-sm text-ink">
            {config.testRecipient}
            <span className="block text-xs text-ink/60">
              Testing: sends go only to these addresses. The email is written for {contact.first_name} {contact.last_name}, but their address is not used.
            </span>
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink">
            {contact.first_name} {contact.last_name} &lt;{contact.email || "no email yet"}&gt;
          </p>
        )}
      </label>
      <label className="mt-4 block">
        <span className={label}>Subject</span>
        <input value={subject} disabled={done} onChange={(e) => setSubject(e.target.value)} className={`${field} mt-1 disabled:bg-ink/5`} />
      </label>
      <label className="mt-4 block">
        <span className={label}>
          Email · {words} words{edited && " · edited by you"}
        </span>
        <textarea rows={13} value={body} disabled={done} onChange={(e) => setBody(e.target.value)} className={`${field} mt-1 leading-relaxed disabled:bg-ink/5`} />
      </label>
      <label className="mt-4 block">
        <span className={label}>Feedback: what was wrong with the draft?</span>
        <textarea
          rows={3}
          value={feedback}
          disabled={done}
          placeholder="e.g. The hook was too generic, and the tone was too formal for a founder."
          onChange={(e) => setFeedback(e.target.value)}
          className={`${field} mt-1 disabled:bg-ink/5`}
        />
      </label>

      {draft.lesson && (
        <div className="mt-4 rounded-2xl bg-blush px-4 py-4 text-sm">
          <p className={label}>
            What the system learned from your changes · {Math.round(draft.lesson.delta_body * 100)}% of the email rewritten
          </p>
          <ul className="mt-2 space-y-2">
            {(["subject", "hook", "angle", "cta"] as const).map((name) => {
              const part = draft.lesson!.components?.[name];
              if (!part?.changed) return null;
              return (
                <li key={name}>
                  <strong className="uppercase text-primary">{name === "cta" ? "CTA" : name}</strong>{" "}
                  <span className="text-ink/50 line-through">{part.before}</span> → <span className="text-ink">{part.after}</span>
                  {part.lesson && <p className="mt-0.5 text-xs text-ink/70">Lesson: {part.lesson}</p>}
                </li>
              );
            })}
            {draft.lesson.tone && <li className="text-ink/80">Tone: {draft.lesson.tone}</li>}
            {draft.lesson.rules.length === 0 && <li className="text-ink/60">No general lesson taken (looks like a one-off correction).</li>}
          </ul>
        </div>
      )}

      {done ? (
        <p className="mt-5 rounded-2xl bg-ink px-5 py-4 text-sm font-semibold text-white">
          {draft.status === "sent" ? "Sent" : "Send simulated (no email went out)"}
          {draft.sent_at && ` · ${new Date(draft.sent_at).toLocaleString()}`}
        </p>
      ) : (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button disabled={busy !== null || !dirty} onClick={() => run("saveDraft", { id: draft.id, draft: { subject, body, feedback } })} className={ghostBtn}>
            {busy === "saveDraft" ? "Saving…" : "Save changes"}
          </button>
          <button disabled={busy !== null || (!contact.email && !config.testRecipient)} onClick={send} className={primaryBtn}>
            {busy === "send" ? "Sending…" : !config.resend ? "Send (simulated)" : config.testRecipient ? "Send to test addresses" : "Send email"}
          </button>
        </div>
      )}
    </div>
  );
}
