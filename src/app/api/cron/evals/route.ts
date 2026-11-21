import { runEvals } from "@/lib/evals/runner";

// The weekly eval run (moment 3 of the evals), triggered by Vercel Cron: see
// vercel.json. Every Monday at 03:30 UTC (9:00 AM IST). Vercel sends
// "Authorization: Bearer <CRON_SECRET>"; anything else is refused, so nobody
// else can start a run that spends Gemini calls.

export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await runEvals({ judge: true, scenarios: true, trigger: "weekly" });
    return Response.json({ ok: true, runId: result.runId, passed: result.passed, killFailed: result.killFailed, hardFailed: result.hardFailed, softBelow: result.softBelow });
  } catch (err) {
    console.error("Weekly evals failed to run:", err);
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
