import crypto from "node:crypto";
import { sql } from "./db";

// Google connection: one OAuth sign-in gives the app the sender's Gmail (send
// and read replies) and Google Calendar (check availability, book with a Meet
// link). The refresh token is stored in the settings table.
//
// Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.local, from an OAuth
// client whose authorised redirect URIs include <site>/api/google/callback for
// every address the app runs on (http://localhost:3000 locally, the Vercel URL
// when deployed).

/** Where Google sends the browser back to, on the same site the sign-in started from. */
export function redirectUri(origin: string): string {
  return `${origin}/api/google/callback`;
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.events",
];

type Stored = { refresh_token?: string; email?: string; pending_state?: string };

export function googleConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

async function readStored(): Promise<Stored> {
  return (await sql(`SELECT value FROM settings WHERE key = 'google'`))[0]?.value ?? {};
}

async function writeStored(value: Stored) {
  await sql(`INSERT INTO settings (key, value) VALUES ('google', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(value)]);
  cache.status = null;
}

const cache = globalThis as unknown as { status: { at: number; email: string | null } | null; token: { value: string; expires: number } | null };
cache.status ??= null;
cache.token ??= null;

/** The connected Google account's address, or null when Google is not connected. Cached briefly. */
export async function googleAccount(): Promise<string | null> {
  if (!googleConfigured()) return null;
  if (cache.status && Date.now() - cache.status.at < 30_000) return cache.status.email;
  const stored = await readStored();
  const email = stored.refresh_token ? (stored.email ?? "connected") : null;
  cache.status = { at: Date.now(), email };
  return email;
}

// ----------------------------------------------------------------- sign-in

/** Where to send the browser to ask for consent. */
export async function consentUrl(origin: string): Promise<string> {
  if (!googleConfigured()) throw new Error("Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.local first");
  const state = crypto.randomBytes(16).toString("hex");
  await writeStored({ ...(await readStored()), pending_state: state });
  const query = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(origin), response_type: "code", scope: SCOPES.join(" "),
    access_type: "offline", prompt: "consent", state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${query}`;
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET!, ...params }),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sign-in failed: ${data.error_description ?? data.error ?? res.status}`);
  return data as { access_token: string; expires_in: number; refresh_token?: string };
}

/** Finishes the sign-in: swaps the code for tokens and stores the refresh token. */
export async function completeSignIn(code: string, state: string, origin: string) {
  const stored = await readStored();
  if (!stored.pending_state || stored.pending_state !== state) throw new Error("Sign-in could not be verified. Start again from the dashboard.");
  const tokens = await tokenRequest({ code, redirect_uri: redirectUri(origin), grant_type: "authorization_code" });
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token. Remove the app's access in your Google account and connect again.");
  cache.token = { value: tokens.access_token, expires: Date.now() + (tokens.expires_in - 60) * 1000 };
  await writeStored({ refresh_token: tokens.refresh_token });
  const profile = await api<{ emailAddress: string }>("https://gmail.googleapis.com/gmail/v1/users/me/profile");
  await writeStored({ refresh_token: tokens.refresh_token, email: profile.emailAddress });
}

export async function disconnectGoogle() {
  await writeStored({});
  cache.token = null;
}

async function accessToken(): Promise<string> {
  if (cache.token && cache.token.expires > Date.now()) return cache.token.value;
  const stored = await readStored();
  if (!stored.refresh_token) throw new Error("Google is not connected");
  const tokens = await tokenRequest({ refresh_token: stored.refresh_token, grant_type: "refresh_token" });
  cache.token = { value: tokens.access_token, expires: Date.now() + (tokens.expires_in - 60) * 1000 };
  return cache.token.value;
}

/**
 * Tests the stored sign-in without touching Gmail or Calendar: asks Google for
 * a fresh access token. Fails when the sign-in has expired or been revoked
 * (testing-mode sign-ins last 7 days), which is the usual reason Google calls break.
 */
export async function checkGoogleSignIn(): Promise<{ ok: boolean; detail: string }> {
  if (!googleConfigured()) return { ok: false, detail: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set" };
  const stored = await readStored();
  if (!stored.refresh_token) return { ok: false, detail: "not connected" };
  try {
    const tokens = await tokenRequest({ refresh_token: stored.refresh_token, grant_type: "refresh_token" });
    cache.token = { value: tokens.access_token, expires: Date.now() + (tokens.expires_in - 60) * 1000 };
    return { ok: true, detail: `signed in as ${stored.email ?? "connected account"}` };
  } catch (err) {
    cache.token = null;
    const message = (err as Error).message;
    return { ok: false, detail: /invalid_grant|expired|revoked/i.test(message) ? "sign-in expired: press Connect Google again" : message };
  }
}

async function api<T>(url: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${await accessToken()}`, ...(init.body ? { "content-type": "application/json" } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 204) return {} as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API: ${data?.error?.message ?? res.status}`);
  return data as T;
}

// ------------------------------------------------------------------- Gmail

const b64url = (input: string | Buffer) => Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export type GmailSent = { threadId: string; messageId: string };

/** Sends a plain-text email from the connected Gmail account. Pass threadId and inReplyTo to keep it in an existing thread. */
export async function gmailSend(email: { to: string[]; subject: string; body: string; threadId?: string | null; inReplyTo?: string | null }): Promise<GmailSent> {
  const headers = [
    `To: ${email.to.join(", ")}`,
    `Subject: =?UTF-8?B?${Buffer.from(email.subject).toString("base64")}?=`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    ...(email.inReplyTo ? [`In-Reply-To: ${email.inReplyTo}`, `References: ${email.inReplyTo}`] : []),
  ];
  const body = Buffer.from(email.body).toString("base64").replace(/(.{76})/g, "$1\r\n");
  const sent = await api<{ id: string; threadId: string }>("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    body: { raw: b64url(`${headers.join("\r\n")}\r\n\r\n${body}`), ...(email.threadId ? { threadId: email.threadId } : {}) },
  });
  // The Message-ID header is what a later reply in the same thread must reference.
  const meta = await api<{ payload?: { headers?: { name: string; value: string }[] } }>(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${sent.id}?format=metadata&metadataHeaders=Message-ID`,
  ).catch(() => ({ payload: undefined }));
  const messageId = meta.payload?.headers?.find((h) => /^message-id$/i.test(h.name))?.value ?? "";
  return { threadId: sent.threadId, messageId };
}

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[]; headers?: { name: string; value: string }[] };

function plainText(part: GmailPart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  for (const child of part.parts ?? []) {
    const text = plainText(child);
    if (text) return text;
  }
  return "";
}

/** Drops the quoted earlier emails from a reply, leaving what the person actually wrote. */
function withoutQuotes(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const cut = lines.findIndex((line) => /^On .+ wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message/i.test(line.trim()) || /^From: .+/.test(line.trim()));
  return (cut === -1 ? lines : lines.slice(0, cut)).filter((line) => !line.trim().startsWith(">")).join("\n").trim();
}

export type GmailMessage = { id: string; from: string; text: string; messageId: string };

/** Every message in a Gmail thread that was not sent by the connected account, oldest first. */
export async function gmailReplies(threadId: string): Promise<GmailMessage[]> {
  const me = (await googleAccount())?.toLowerCase() ?? "";
  const thread = await api<{ messages?: { id: string; payload?: GmailPart }[] }>(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`);
  const header = (m: { payload?: GmailPart }, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
  return (thread.messages ?? [])
    .map((m) => ({
      id: m.id,
      from: (header(m, "from").match(/<([^>]+)>/)?.[1] ?? header(m, "from")).trim().toLowerCase(),
      text: withoutQuotes(plainText(m.payload)),
      messageId: header(m, "message-id"),
    }))
    .filter((m) => m.from && m.from !== me && m.text);
}

// ---------------------------------------------------------------- Calendar

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

export type GoogleEvent = { id: string; summary?: string; status?: string; transparency?: string; hangoutLink?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } };

/** Events on the primary calendar that overlap the window. Cancelled and "free" (transparent) events are left out. */
export async function calendarEvents(start: Date, end: Date): Promise<GoogleEvent[]> {
  const query = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "50" });
  const data = await api<{ items?: GoogleEvent[] }>(`${CALENDAR}?${query}`);
  return (data.items ?? []).filter((e) => e.status !== "cancelled" && e.transparency !== "transparent");
}

/** Creates the meeting with a Google Meet link and invites the attendees. */
export async function calendarBook(event: { start: Date; end: Date; title: string; attendees: string[] }): Promise<{ id: string; link: string }> {
  const created = await api<GoogleEvent>(`${CALENDAR}?conferenceDataVersion=1&sendUpdates=all`, {
    method: "POST",
    body: {
      summary: event.title,
      start: { dateTime: event.start.toISOString(), timeZone: "Asia/Kolkata" },
      end: { dateTime: event.end.toISOString(), timeZone: "Asia/Kolkata" },
      attendees: event.attendees.map((email) => ({ email })),
      conferenceData: { createRequest: { requestId: crypto.randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
    },
  });
  if (!created.hangoutLink) throw new Error("Google Calendar created the event but returned no Meet link");
  return { id: created.id, link: created.hangoutLink };
}

export async function calendarCancel(eventId: string) {
  await api(`${CALENDAR}/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE" }).catch(() => {});
}
