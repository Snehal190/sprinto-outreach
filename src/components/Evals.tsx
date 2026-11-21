"use client";

import { useEffect, useState } from "react";
import { card, label } from "./shared";

// The Evals tab: a read-only report. The full suite runs on its own every
// Monday at 9:00 AM IST (Vercel Cron, /api/cron/evals); nothing here starts a run.

type Severity = "kill" | "hard" | "soft";
type CaseRow = {
  id: string; stage: string; severity: Severity; method: "code" | "judge" | "scenario"; input: string; expected: string; assertion: string; target?: number;
  total: number; passed: number; rate: number | null; status: "pass" | "fail" | "warn" | "not_run";
};
type Report = {
  nextRun: string;
  run: { id: number; status: string; passed: boolean | null; error: string | null; options: { judge: boolean; scenarios: boolean }; started_at: string; finished_at: string | null } | null;
  summary: {
    passed: boolean; killFailed: number; hardFailed: number; softBelow: number; casesRun: number; casesTotal: number;
    stages: { stage: string; label: string; run: number; pass: number; fail: number; warn: number }[];
    cases: CaseRow[];
  };
  results: { case_id: string; company_id: number | null; subject: string; passed: boolean; detail: string | null }[];
  history: { id: number; trigger: string; passed: boolean | null; kill: number | null; hard: number | null; soft: number | null; started_at: string; status: string }[];
};

const SEVERITY: Record<Severity, { text: string; className: string; help: string }> = {
  kill: { text: "Kill", className: "bg-ink text-white", help: "Must never happen. Blocked live before the action; one failure fails the run." },
  hard: { text: "Hard", className: "bg-primary text-white", help: "Correctness rule. Must pass 100%." },
  soft: { text: "Soft", className: "border border-ink/20 text-ink/70", help: "Quality measure. Passes when the pass rate meets its target." },
};

const STATUS: Record<CaseRow["status"], { text: string; className: string }> = {
  pass: { text: "Pass", className: "bg-emerald-50 text-emerald-700" },
  fail: { text: "Fail", className: "bg-primary text-white" },
  warn: { text: "Below target", className: "bg-amber-50 text-amber-700" },
  not_run: { text: "No data", className: "bg-mist text-ink/50" },
};

const METHOD: Record<CaseRow["method"], string> = { code: "Code", judge: "Judge (Gemini)", scenario: "Scripted" };

function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
}

export function EvalsView() {
  const [report, setReport] = useState<Report | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [onlyProblems, setOnlyProblems] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "evalReport" }) })
      .then((res) => res.json())
      .then((data) => {
        if (!alive) return;
        if (data.ok) setReport(data.result);
        else setLoadError(data.error);
      })
      .catch((e) => alive && setLoadError((e as Error).message));
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (id: string) =>
    setOpen((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const s = report?.summary;
  const r = report?.run;

  return (
    <section className="mt-8 space-y-6">
      <div className={card}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="font-serif text-4xl tracking-tight">Evals</h2>
            <p className="mt-2 text-sm text-ink/70">
              {s?.casesTotal ?? 67} test cases for the current ICP. Kill checks run live before every send, booking and Hunter credit, and code checks run after
              each funnel step (failures show on the company card). Once a week the full suite also runs the scripted scheduler replies and the Gemini judge; it uses
              no Hunter credits, sends no email, and a failed run shows up on the bell.
            </p>
          </div>
          {report && (
            <div className="rounded-3xl bg-mist px-5 py-3 text-sm">
              <p className={label}>Runs automatically</p>
              <p className="mt-1 font-semibold text-ink">Every Monday, 9:00 AM IST</p>
              <p className="text-xs text-ink/60">Next run: {when(report.nextRun)}</p>
            </div>
          )}
        </div>

        {loadError && <p className="mt-4 rounded-2xl bg-blush px-4 py-3 text-sm text-primary">Could not load the report: {loadError}</p>}

        {r && s && (
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className={`rounded-3xl px-5 py-4 ${s.passed ? "bg-emerald-50" : "bg-primary text-white"}`}>
              <p className={`${label} ${s.passed ? "" : "text-white/70"}`}>Run #{r.id}</p>
              <p className="mt-1 font-serif text-3xl">{s.passed ? "Passed" : "Failed"}</p>
              <p className={`mt-1 text-xs ${s.passed ? "text-ink/60" : "text-white/80"}`}>
                {when(r.finished_at ?? r.started_at)} · {r.options?.judge ? "full run" : "code checks"}
              </p>
            </div>
            <Stat title="Kill failures" value={s.killFailed} bad={s.killFailed > 0} note="must be 0" />
            <Stat title="Hard failures" value={s.hardFailed} bad={s.hardFailed > 0} note="must be 0" />
            <Stat title="Soft below target" value={s.softBelow} bad={false} warn={s.softBelow > 0} note="quality to improve" />
            <Stat title="Cases with data" value={`${s.casesRun}/${s.casesTotal}`} bad={false} note="the rest need more activity" />
          </div>
        )}
        {!r && report && <p className="mt-6 rounded-2xl bg-mist px-4 py-6 text-center text-sm text-ink/70">No eval run yet for this ICP. The first one happens on {when(report.nextRun)}.</p>}
      </div>

      {s && (
        <div className={card}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-serif text-2xl">By stage</h3>
            <label className="flex items-center gap-2 text-xs font-semibold text-ink/70">
              <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} className="accent-primary" />
              Only show failures and warnings
            </label>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {s.stages.map((st) => (
              <a key={st.stage} href={`#stage-${st.stage}`} className="rounded-3xl border border-ink/5 bg-mist/60 px-4 py-3 transition hover:border-primary/40">
                <p className="text-sm font-bold text-ink">{st.label}</p>
                <p className="mt-1 text-xs text-ink/60">
                  {st.run === 0 ? "no data yet" : `${st.pass} pass`}
                  {st.fail > 0 && <span className="font-bold text-primary"> · {st.fail} fail</span>}
                  {st.warn > 0 && <span className="font-bold text-amber-700"> · {st.warn} below target</span>}
                </p>
              </a>
            ))}
          </div>

          <div className="mt-8 space-y-8">
            {s.stages.map((st) => {
              const rows = s.cases.filter((c) => c.stage === st.stage && (!onlyProblems || c.status === "fail" || c.status === "warn"));
              if (rows.length === 0) return null;
              return (
                <div key={st.stage} id={`stage-${st.stage}`} className="scroll-mt-28">
                  <h4 className={label}>{st.label}</h4>
                  <ul className="mt-3 divide-y divide-ink/5 overflow-hidden rounded-3xl border border-ink/5">
                    {rows.map((c) => {
                      const results = report!.results.filter((x) => x.case_id === c.id);
                      const failures = results.filter((x) => !x.passed);
                      const isOpen = open.has(c.id);
                      return (
                        <li key={c.id} className="bg-white">
                          <button onClick={() => toggle(c.id)} aria-expanded={isOpen} className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-mist/50">
                            <span className="w-16 shrink-0 font-mono text-xs font-bold text-ink">{c.id}</span>
                            <span title={SEVERITY[c.severity].help} className={`shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${SEVERITY[c.severity].className}`}>
                              {SEVERITY[c.severity].text}
                            </span>
                            <span className="min-w-0 flex-1 text-sm text-ink">{c.expected}</span>
                            <span className="shrink-0 text-xs text-ink/50">
                              {c.total > 0 && `${c.passed}/${c.total}`}
                              {c.severity === "soft" && c.target ? ` · target ${Math.round(c.target * 100)}%` : ""}
                            </span>
                            <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-bold ${STATUS[c.status].className}`}>{STATUS[c.status].text}</span>
                          </button>
                          {isOpen && (
                            <div className="space-y-3 bg-mist/40 px-4 pb-4 pt-1 text-sm">
                              <dl className="grid gap-2 sm:grid-cols-[8rem_1fr]">
                                <dt className={label}>Input</dt>
                                <dd className="text-ink/80">{c.input}</dd>
                                <dt className={label}>Expected</dt>
                                <dd className="text-ink/80">{c.expected}</dd>
                                <dt className={label}>Assertion</dt>
                                <dd className="text-ink/80">{c.assertion}</dd>
                                <dt className={label}>Method</dt>
                                <dd className="text-ink/80">{METHOD[c.method]}</dd>
                              </dl>
                              {results.length > 0 && (
                                <ul className="space-y-1.5">
                                  {(failures.length ? failures : results).slice(0, 30).map((x, i) => (
                                    <li key={i} className={`rounded-2xl px-3 py-2 text-xs ${x.passed ? "bg-white text-ink/70" : "bg-blush text-ink"}`}>
                                      <span className={`font-bold ${x.passed ? "text-emerald-700" : "text-primary"}`}>{x.passed ? "Pass" : "Fail"}</span> · <span className="font-semibold">{x.subject}</span>
                                      {x.detail && <span className="text-ink/70"> — {x.detail}</span>}
                                    </li>
                                  ))}
                                  {(failures.length || results.length) > 30 && <li className="text-xs text-ink/50">and {(failures.length || results.length) - 30} more</li>}
                                </ul>
                              )}
                              {results.length === 0 && <p className="text-xs text-ink/60">No records to check yet for this case (or it was not part of this run).</p>}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {report && report.history.length > 1 && (
        <div className={card}>
          <h3 className="font-serif text-2xl">Earlier runs</h3>
          <ul className="mt-4 divide-y divide-ink/5 text-sm">
            {report.history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="font-semibold">Run #{h.id} <span className="font-normal text-ink/50">· {h.trigger === "weekly" ? "weekly" : "manual"}</span></span>
                <span className="text-ink/60">{when(h.started_at)}</span>
                <span className="text-xs text-ink/70">
                  {h.status !== "done" ? h.status : `${h.kill ?? 0} kill · ${h.hard ?? 0} hard · ${h.soft ?? 0} soft`}
                </span>
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${h.passed ? "bg-emerald-50 text-emerald-700" : "bg-blush text-primary"}`}>
                  {h.status !== "done" ? "—" : h.passed ? "Passed" : "Failed"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function Stat({ title, value, bad, warn, note }: { title: string; value: number | string; bad: boolean; warn?: boolean; note: string }) {
  return (
    <div className={`rounded-3xl px-5 py-4 ${bad ? "bg-blush" : warn ? "bg-amber-50" : "bg-mist"}`}>
      <p className={label}>{title}</p>
      <p className={`mt-1 font-serif text-3xl ${bad ? "text-primary" : warn ? "text-amber-700" : "text-ink"}`}>{value}</p>
      <p className="mt-1 text-xs text-ink/60">{note}</p>
    </div>
  );
}
