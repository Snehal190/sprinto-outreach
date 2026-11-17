import * as funnel from "@/lib/funnel";
import { respond } from "@/lib/respond";
import * as scheduler from "@/lib/scheduler";
import * as calendar from "@/lib/calendar";
import { googleAccount } from "@/lib/google";
import { mailApi, requireApis, testAllApis, type ApiName } from "@/lib/health";

export const maxDuration = 300;

/** The APIs each step calls. They are tested (free, cached) before the step starts. */
async function apisFor(action: string): Promise<ApiName[]> {
  const google: ApiName[] = (await googleAccount()) ? ["google"] : [];
  switch (action) {
    case "discover":
    case "scrape":
    case "researchPoc":
    case "draft":
    case "findPoc": // Hunter is tested inside the lookup, only when the domain is not cached
      return ["gemini"];
    case "send":
      return mailApi();
    case "checkInbox":
    case "resetThread":
      return google;
    default:
      return [];
  }
}

// One endpoint for every funnel step the dashboard can trigger.
export async function POST(request: Request) {
  const body = await request.json();
  const id = Number(body.id);
  return respond(async () => {
    await requireApis(await apisFor(body.action));
    switch (body.action) {
      case "testApis":
        return testAllApis(true);
      case "saveSettings":
        return funnel.saveSettings(body.settings);
      case "discover":
        return funnel.discoverCompanies(Math.max(1, Math.min(10, Number(body.count) || 5)));
      case "addCompanies":
        return funnel.addCompanies(Array.isArray(body.websites) ? body.websites.slice(0, 25).map(String) : []);
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
      default:
        throw new Error(`Unknown action: ${body.action}`);
    }
  });
}
