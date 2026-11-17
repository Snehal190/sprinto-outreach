# Sprinto Outreach

An outreach funnel for Sprinto, which automates compliance certifications (SOC 2, ISO 27001, GDPR) for SaaS companies. It finds companies that fit the ICP, researches them and the right contact, drafts a personalised email for a human to approve, and handles the reply and meeting booking after the email is sent.

**ICP:** SaaS companies, typically Series A–C, preparing for a compliance audit or under pressure from enterprise customers to get certified.

## The funnel

1. **Find companies:** Gemini with Google Search grounding suggests companies that fit the ICP.
2. **Scrape and score:** the scraper reads the homepage, then fetches further named pages (pricing, careers, security, press) only while an ICP question is still open. It works within fixed page, request and time limits, with a defined exit reason.
3. **Find the contact:** Hunter.io domain search (cached per domain, so each domain costs one credit), falling back to the company website.
4. **Research the contact:** grounded research, with each fact checked against a quote on the source page.
5. **Draft:** subject, hook and two pain points, using lessons learned from earlier human edits.
6. **Human sends:** the draft is edited and approved on the dashboard.
7. **Feedback loop:** the difference between the draft and what the human sent is stored as a lesson and applied to the next draft for a similar contact.
8. **After send:** a tool-calling agent (`check_calendar`, `propose_times`, `book_meeting`, `send_email`) handles replies, counter-proposals and reschedules, sends one follow-up after 48 hours of silence, and hands the prospect to a human 72 hours after that.

Every API is tested with a free check (key validity, credits left, sign-in) before a step calls it, so a broken key stops the step in about a second.

## Stack

Next.js 16 (App Router), Neon Postgres (PGlite locally when no `DATABASE_URL` is set), Gemini, Hunter.io, Gmail and Google Calendar, with Resend as the fallback mailer.

## Running it

```bash
npm install
npm run dev
```

Create `.env.local` with:

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY_1`, `_2`, `_3` | Gemini keys, tried in order with failover |
| `GEMINI_MODEL` | defaults to `gemini-flash-latest` |
| `DATABASE_URL` | Neon connection string; leave empty for a local embedded database |
| `HUNTER_API_KEY` | Hunter.io; without it, contacts come from the website only |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | OAuth web client; add `<site>/api/google/callback` as an authorised redirect URI |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | fallback mailer when Google is not connected |
| `TEST_RECIPIENTS` | comma-separated; while set, every email goes only to these addresses |
| `ALLOW_PROSPECT_SENDS` | must be `true` (with `TEST_RECIPIENTS` empty) before any prospect is emailed |
