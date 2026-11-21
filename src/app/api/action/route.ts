import * as funnel from "@/lib/funnel";
import { respond } from "@/lib/respond";
import * as scheduler from "@/lib/scheduler";
import * as calendar from "@/lib/calendar";
import { apisFor, requireApis, testAllApis } from "@/lib/health";
import { sql } from "@/lib/db";
import { evalReport, recordDiscoverStep, runStepChecks } from "@/lib/evals/runner";

export const maxDuration = 300;

// One endpoint for every funnel step the dashboard can trigger.
export async function POST(request: Request) {
  const body = await request.json();
  const id = Number(body.id);
  return respond(async () => {
    const started = Date.now();
    const timed = !["testApis", "evalReport", "dismissNotification"].includes(body.action);
    try {
      const result = await step(body, id);
      if (timed) await logStep(body.action, id, started, null);
      // Moment 2 of the evals: the code checks for the company this step touched.
      if (["scrape", "findPoc", "researchPoc", "draft", "saveDraft", "updateContact", "setStatus", "send"].includes(body.action)) {
        const companyId = ["saveDraft", "send"].includes(body.action)
          ? (await sql(`SELECT company_id FROM drafts WHERE id = $1`, [id]))[0]?.company_id
          : body.action === "updateContact" ? (await sql(`SELECT company_id FROM contacts WHERE id = $1`, [id]))[0]?.company_id : id;
        if (companyId) await runStepChecks(companyId).catch((err) => console.error("Step checks failed:", err));
      }
      if (body.action === "discover" && result && typeof result === "object" && "requested" in result) {
        await recordDiscoverStep(result as { added: number; requested: number; returned: number; repeats: number }).catch((err) => console.error("Step checks failed:", err));
        const fresh = await sql(`SELECT id FROM companies WHERE created_at > now() - ($1 || ' milliseconds')::interval`, [String(Date.now() - started + 2000)]);
        for (const c of fresh) await runStepChecks(c.id).catch(() => {});
      }
      return result;
    } catch (err) {
      if (timed) await logStep(body.action, id, started, (err as Error).message);
      throw err;
    }
  });
}

async function logStep(action: string, id: number, started: number, error: string | null) {
  await sql(`INSERT INTO step_log (action, company_id, ms, ok, error) VALUES ($1, $2, $3, $4, $5)`, [
    action, Number.isFinite(id) && ["scrape", "findPoc", "researchPoc", "draft", "setStatus", "deleteCompany"].includes(action) ? id : null, Date.now() - started, error === null, error?.slice(0, 500) ?? null,
  ]).catch((err) => console.error("step_log write failed:", err));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function step(body: any, id: number) {
    await requireApis(await apisFor(body.action));
    switch (body.action) {
      case "testApis":
        return testAllApis(true);
      case "saveSettings":
        return funnel.saveSettings(body.settings);
      case "discover":
        return funnel.discoverCompanies(Math.max(1, Math.min(10, Number(body.count) || 5)));
      case "addCompanies":
        return funnel.addCompanies(Array.isArray(body.websites) ? body.websites.slice(0, 200).map(String) : []);
      case "scrape":
        return funnel.scrapeCompany(id);
      case "deleteCompany":
        return funnel.deleteCompany(id);
      case "setStatus":
        return funnel.setCompanyStatus(id, body.status);
      case "findPoc":
        return funnel.findPoc(id);
      case "researchPoc":
        return funnel.researchPoc(id);
      case "updateContact":
        return funnel.updateContact(id, body.contact);
      case "draft":
        return funnel.draftEmail(id);
      case "saveDraft":
        return funnel.saveDraft(id, body.draft);
      case "send":
        return funnel.sendDraft(id);
      case "receiveReply":
        return scheduler.receiveReply(id, String(body.text ?? ""));
      case "checkInbox":
        return scheduler.checkInbox();
      case "disconnectGoogle":
        return (await import("@/lib/google")).disconnectGoogle();
      case "skipTime":
        return scheduler.skipTime(id, Number(body.hours) || 48);
      case "resetThread":
        return scheduler.resetThread(id);
      case "resolveThread":
        return scheduler.resolveThread(id);
      case "dismissNotification":
        return scheduler.dismissNotification(id);
      case "addBusy":
        return calendar.addBusy(String(body.date ?? ""), Number(body.minutes) || 60, String(body.title ?? "Busy"));
      case "removeEvent":
        return calendar.removeEvent(id);
      case "evalReport":
        return evalReport();
      default:
        throw new Error(`Unknown action: ${body.action}`);
    }
}
