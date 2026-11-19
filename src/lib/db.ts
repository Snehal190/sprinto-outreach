import path from "node:path";
import fs from "node:fs";
import dns from "node:dns";

// Database access. Uses Neon Postgres when DATABASE_URL is set; otherwise an
// embedded Postgres (PGlite) stored in ./.data so the app runs before the
// Neon connection string is available. Both speak the same SQL.

export type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Query = (text: string, params?: unknown[]) => Promise<Row[]>;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS companies (
     id SERIAL PRIMARY KEY,
     name TEXT NOT NULL,
     domain TEXT NOT NULL UNIQUE,
     description TEXT,
     funding_stage TEXT,
     last_funding TEXT,
     hq TEXT,
     employees TEXT,
     target_markets TEXT,
     certifications_held TEXT,
     signals JSONB NOT NULL DEFAULT '[]',
     sources JSONB NOT NULL DEFAULT '[]',
     fit_score INT,
     fit_reason TEXT,
     recommended_framework TEXT,
     info_sufficient BOOLEAN NOT NULL DEFAULT TRUE,
     missing_info TEXT,
     status TEXT NOT NULL DEFAULT 'candidate',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS contacts (
     id SERIAL PRIMARY KEY,
     company_id INT NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
     first_name TEXT,
     last_name TEXT,
     title TEXT,
     email TEXT,
     confidence INT,
     source TEXT NOT NULL,
     pain_points JSONB NOT NULL DEFAULT '[]',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS drafts (
     id SERIAL PRIMARY KEY,
     company_id INT NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
     contact_id INT REFERENCES contacts(id) ON DELETE SET NULL,
     hook TEXT,
     subject TEXT NOT NULL,
     body TEXT NOT NULL,
     original_subject TEXT NOT NULL,
     original_body TEXT NOT NULL,
     feedback TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'draft',
     provider_id TEXT,
     sent_at TIMESTAMPTZ,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Every human edit to a draft is logged here. This is the raw material the
  // feedback loop will learn from once it is built.
  `CREATE TABLE IF NOT EXISTS draft_edits (
     id SERIAL PRIMARY KEY,
     draft_id INT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
     before_subject TEXT NOT NULL,
     before_body TEXT NOT NULL,
     after_subject TEXT NOT NULL,
     after_body TEXT NOT NULL,
     feedback TEXT NOT NULL DEFAULT '',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Scraper state on the company: none | pending | done | failed, plus the trail of what was fetched and why.
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS scrape_status TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS scrape_summary JSONB`,
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin TEXT`,
  // What the scraper found out about the person: { summary, facts[], steps[] }.
  `ALTER TABLE contacts ADD COLUMN IF NOT EXISTS research JSONB`,
  // Company profile from Hunter.io (industry, headcount, technologies...).
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS profile JSONB`,
  // Hunter.io answers are cached per domain so repeat lookups cost no credits.
  `CREATE TABLE IF NOT EXISTS hunter_cache (
     domain TEXT PRIMARY KEY,
     people JSONB NOT NULL,
     profile JSONB,
     fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Feedback loop: the parts of the system's own draft, kept for comparison with what the human sends.
  `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS cta TEXT`,
  `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS original_hook TEXT`,
  `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS original_cta TEXT`,
  `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS applied_lessons JSONB NOT NULL DEFAULT '[]'`,
  // Feedback loop store: one lesson per edited draft. The ICP profile (persona,
  // framework, stage) is copied onto the lesson so it survives the draft or
  // company being deleted and can be retrieved for similar prospects.
  `CREATE TABLE IF NOT EXISTS lessons (
     id SERIAL PRIMARY KEY,
     draft_id INT UNIQUE REFERENCES drafts(id) ON DELETE SET NULL,
     company_name TEXT,
     title TEXT,
     persona TEXT NOT NULL,
     framework TEXT NOT NULL,
     stage TEXT NOT NULL,
     components JSONB NOT NULL DEFAULT '{}',
     rules JSONB NOT NULL DEFAULT '[]',
     tone TEXT,
     feedback TEXT NOT NULL DEFAULT '',
     delta_subject REAL NOT NULL DEFAULT 0,
     delta_body REAL NOT NULL DEFAULT 0,
     sent BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // After the send: one conversation per company, carrying the state object.
  `CREATE TABLE IF NOT EXISTS threads (
     id SERIAL PRIMARY KEY,
     company_id INT NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
     subject TEXT NOT NULL,
     state JSONB NOT NULL,
     meeting JSONB,
     awaiting_reply BOOLEAN NOT NULL DEFAULT FALSE,
     last_outbound_at TIMESTAMPTZ,
     follow_up_sent_at TIMESTAMPTZ,
     needs_human BOOLEAN NOT NULL DEFAULT FALSE,
     human_reason TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS gmail_thread_id TEXT`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS gmail_last_message_id TEXT`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS gmail_seen JSONB NOT NULL DEFAULT '[]'`,
  // Every checkpoint: an email in or out, a tool call, a branch. Each row holds a snapshot of the state object.
  `CREATE TABLE IF NOT EXISTS thread_events (
     id SERIAL PRIMARY KEY,
     thread_id INT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     summary TEXT NOT NULL,
     body TEXT,
     state JSONB NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS notifications (
     id SERIAL PRIMARY KEY,
     thread_id INT REFERENCES threads(id) ON DELETE CASCADE,
     message TEXT NOT NULL,
     read BOOLEAN NOT NULL DEFAULT FALSE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // The sender's calendar while Google Calendar is not connected: busy blocks and booked meetings.
  `CREATE TABLE IF NOT EXISTS calendar_events (
     id SERIAL PRIMARY KEY,
     start_at TIMESTAMPTZ NOT NULL,
     end_at TIMESTAMPTZ NOT NULL,
     title TEXT NOT NULL,
     thread_id INT,
     link TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // The scraper's Store stage: one row per page read, holding the cleaned text.
  `CREATE TABLE IF NOT EXISTS scraped_pages (
     id SERIAL PRIMARY KEY,
     company_id INT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
     purpose TEXT NOT NULL,
     page_type TEXT NOT NULL,
     url TEXT NOT NULL,
     http_status INT,
     title TEXT,
     text TEXT NOT NULL,
     hints JSONB NOT NULL DEFAULT '[]',
     fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  // Companies and lessons belong to the ICP they were found under (icp.ts).
  // "default" is the built-in ICP; the same website may appear under several ICPs.
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS icp_key TEXT NOT NULL DEFAULT 'default'`,
  `ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_domain_key`,
  `CREATE UNIQUE INDEX IF NOT EXISTS companies_domain_icp ON companies (domain, icp_key)`,
  `ALTER TABLE lessons ADD COLUMN IF NOT EXISTS icp_key TEXT NOT NULL DEFAULT 'default'`,
  // Structured tags (kept in sync by tags.ts), so the database can be queried
  // directly for where each company stands, without reading JSON.
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'found'`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS qualified BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ`,
  `ALTER TABLE companies ADD COLUMN IF NOT EXISTS stage_updated_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS companies_icp_stage ON companies (icp_key, stage)`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS reply_status TEXT`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS meeting_status TEXT`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS meeting_start TIMESTAMPTZ`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS meeting_end TIMESTAMPTZ`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS meeting_link TEXT`,
  `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS company_id INT REFERENCES companies(id) ON DELETE CASCADE`,
  `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS kind TEXT`,
  `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ`,
  `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS edited BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE drafts ADD COLUMN IF NOT EXISTS feedback_saved_at TIMESTAMPTZ`,
];

async function connect(): Promise<Query> {
  let query: Query;
  const url = process.env.DATABASE_URL;
  if (url) {
    const { neon, neonConfig } = await import("@neondatabase/serverless");
    const { Agent, fetch: undiciFetch } = await import("undici");
    // Query the database host directly. The driver's default rewrites the host
    // to an "api." address, which does not resolve for this Neon endpoint.
    neonConfig.fetchEndpoint = (host) => `https://${host}/sql`;
    // Some networks' DNS refuses neon.tech hostnames. Look the host up through
    // the system resolver first and fall back to a public one.
    const publicDns = new dns.promises.Resolver();
    publicDns.setServers(["1.1.1.1", "8.8.8.8"]);
    const dispatcher = new Agent({
      connect: {
        lookup: (hostname, options, callback) => {
          dns.lookup(hostname, options, (err, address, family) => {
            if (!err) return callback(null, address, family);
            publicDns
              .resolve4(hostname)
              .then((ips) => (options.all ? callback(null, ips.map((ip) => ({ address: ip, family: 4 }))) : callback(null, ips[0], 4)))
              .catch(() => callback(err, "", 4));
          });
        },
      },
    });
    neonConfig.fetchFunction = (input: string, init: object) => undiciFetch(input, { ...init, dispatcher });
    const sql = neon(url);
    query = async (text, params = []) => (await sql.query(text, params)) as Row[];
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = path.join(process.cwd(), ".data", "pglite");
    fs.mkdirSync(dir, { recursive: true });
    const db = new PGlite(dir);
    query = async (text, params = []) => (await db.query(text, params)).rows as Row[];
  }
  for (const statement of SCHEMA) await query(statement);
  return query;
}

// Kept on globalThis so dev-mode hot reloads reuse one connection.
const holder = globalThis as unknown as { __sprintoDb?: Promise<Query> };

export async function sql(text: string, params: unknown[] = []): Promise<Row[]> {
  if (!holder.__sprintoDb) {
    holder.__sprintoDb = connect().catch((err) => {
      holder.__sprintoDb = undefined;
      throw err;
    });
  }
  return (await holder.__sprintoDb)(text, params);
}

export function dbMode(): "neon" | "local" {
  return process.env.DATABASE_URL ? "neon" : "local";
}
