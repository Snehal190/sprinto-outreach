import { getState } from "./funnel";
import { runTimers } from "./scheduler";

/** Runs a funnel step and returns the fresh dashboard state, or a readable error. */
export async function respond(step?: () => Promise<unknown>) {
  try {
    const result = step ? await step() : undefined;
    // Silence checks ride along with every dashboard load (at most once a minute).
    await runTimers().catch((err) => console.error("Silence check failed:", err));
    return Response.json({ ok: true, result, state: await getState() });
  } catch (err) {
    console.error(err);
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }
}
