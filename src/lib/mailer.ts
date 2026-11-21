import { gmailSend, googleAccount, type GmailSent } from "./google";
import { forgetApiTest } from "./health";
import { guard, recipientsAllowed } from "./evals/checks";

// Outbound email. Every email the app sends goes through deliver(), so the
// recipient lock is enforced in exactly one place. With Google connected the
// email is sent from the sender's own Gmail; otherwise through Resend.

/** The only addresses emails may go to while the funnel is being tested. Empty means live sending to prospects. */
export function testRecipients(): string[] {
  return (process.env.TEST_RECIPIENTS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e));
}

export function resendLive(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL;
}

export type Delivery = {
  /** test = sent to the locked test addresses; live = sent to the prospect; simulated = Resend not connected, nothing sent. */
  mode: "test" | "live" | "simulated";
  delivered: string[];
  failed: string[];
  /** Set when the email went out through Gmail: what a later reply in the same thread needs. */
  gmail?: GmailSent;
};

async function sendOne(to: string, subject: string, body: string): Promise<string | null> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: process.env.RESEND_FROM_EMAIL, to: [to], subject, text: body }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return data?.message ?? `HTTP ${res.status}`;
}

/**
 * Sends one email. While TEST_RECIPIENTS is set it goes to those addresses and
 * nowhere else; the prospect's own address is only used when the lock is
 * cleared AND ALLOW_PROSPECT_SENDS is "true". Throws when nothing could be delivered.
 */
export async function deliver(email: {
  subject: string; body: string; prospectEmail?: string | null; gmailThreadId?: string | null; inReplyTo?: string | null;
}): Promise<Delivery> {
  const account = await googleAccount();
  if (!account && !resendLive()) return { mode: "simulated", delivered: [], failed: [] };

  const locked = testRecipients();
  let recipients = locked;
  if (locked.length === 0) {
    if (process.env.ALLOW_PROSPECT_SENDS !== "true") {
      throw new Error("Sending to prospects is switched off. Emails only go to the test addresses in TEST_RECIPIENTS.");
    }
    if (!email.prospectEmail) throw new Error("There is no email address for this contact");
    recipients = [email.prospectEmail];
  }
  // Kill guard (eval SND-01): while the lock is on, nothing may go anywhere but the test addresses.
  guard("SND-01", recipientsAllowed(recipients, locked));

  if (account) {
    // Sent from the sender's own Gmail. Their own address is left off the "To"
    // line (the email is already in their Sent folder) unless it is the only one.
    const others = recipients.filter((r) => r.toLowerCase() !== account.toLowerCase());
    const to = others.length > 0 ? others : recipients;
    const gmail = await gmailSend({ to, subject: email.subject, body: email.body, threadId: email.gmailThreadId, inReplyTo: email.inReplyTo }).catch((err) => {
      forgetApiTest("google");
      throw err;
    });
    return { mode: locked.length > 0 ? "test" : "live", delivered: to, failed: [], gmail };
  }

  // One request per address, so one address being refused does not block the others.
  const delivered: string[] = [];
  const failed: string[] = [];
  for (const to of recipients) {
    const error = await sendOne(to, email.subject, email.body);
    if (error) failed.push(`${to} (${error})`);
    else delivered.push(to);
  }
  if (delivered.length === 0) {
    forgetApiTest("resend");
    throw new Error(`Resend refused every recipient: ${failed.join("; ")}`);
  }
  return { mode: locked.length > 0 ? "test" : "live", delivered, failed };
}
