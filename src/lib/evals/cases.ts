// The eval catalogue: every test case the funnel is held to. None of them
// assume a fixed ICP: each runs against whatever ICP the user typed, the
// records the funnel produced for it, or a scripted scenario.
//
// Severity:
//   kill - must never happen. Checked live before the action (it is blocked),
//          and any single failure in an eval run fails the run.
//   hard - a correctness rule; must pass 100%.
//   soft - a quality measure; passes when the pass rate meets `target`.
//
// Method:
//   code     - plain code over the database (free).
//   judge    - a second Gemini call, given the user's ICP and the output.
//   scenario - a scripted input run through the real logic in a sandbox
//              (fake calendar, nothing sent, nothing stored).

export type Severity = "kill" | "hard" | "soft";
export type Stage = "icp" | "discover" | "score" | "poc" | "draft" | "send" | "scheduler" | "system";
export type Method = "code" | "judge" | "scenario";

export type EvalCase = {
  id: string;
  stage: Stage;
  severity: Severity;
  method: Method;
  input: string;
  expected: string;
  assertion: string;
  /** Soft cases: the pass rate needed, 0-1. */
  target?: number;
};

export const STAGE_LABELS: Record<Stage, string> = {
  icp: "ICP → profile",
  discover: "Find companies",
  score: "Research and scoring",
  poc: "Point of contact",
  draft: "Email draft",
  send: "Sending",
  scheduler: "Scheduler",
  system: "System-wide",
};

export const CASES: EvalCase[] = [
  // ------------------------------------------------------------ ICP → profile
  { id: "ICP-01", stage: "icp", severity: "hard", method: "code", input: "Any ICP", expected: "The profile has a target summary, fit questions, scoring rules, a pain topic and an angle to lead with", assertion: "summary, questions, rubric, painTopic and leadWith.label are all non-empty" },
  { id: "ICP-02", stage: "icp", severity: "hard", method: "code", input: "Any ICP", expected: "The first fit question is a must-have gate", assertion: "questions[0].gate === true" },
  { id: "ICP-03", stage: "icp", severity: "hard", method: "code", input: "Any ICP", expected: "The scoring rules give a 0-100 score with what caps it", assertion: "3-6 scoring rules, each non-empty; buyer roles have valid title patterns" },
  { id: "ICP-04", stage: "icp", severity: "soft", method: "judge", target: 0.9, input: "Any ICP", expected: "The profile reflects what the user wrote, nothing added", assertion: "Judge: every fit question and scoring rule traces back to the ICP text" },
  { id: "ICP-05", stage: "icp", severity: "hard", method: "scenario", input: "Empty or under-10-word ICP", expected: "Asks for more detail instead of guessing", assertion: "Saving is refused with a clear error; no profile is written" },
  { id: "ICP-06", stage: "icp", severity: "soft", method: "judge", target: 0.8, input: "Any ICP", expected: "A contradictory or unclear ICP is flagged", assertion: "Judge: if the ICP contradicts itself, the profile's warnings say so" },
  { id: "ICP-07", stage: "icp", severity: "hard", method: "code", input: "The same ICP saved again", expected: "The same profile and companies come back", assertion: "The ICP key is stable and exactly one stored profile exists for it" },
  { id: "ICP-08", stage: "icp", severity: "hard", method: "code", input: "ICP changed", expected: "Companies of other ICPs are kept but hidden", assertion: "The dashboard shows only companies with the current ICP key" },

  // ---------------------------------------------------------- find companies
  { id: "DIS-01", stage: "discover", severity: "hard", method: "code", input: "Find N companies (3/5/8/10)", expected: "Adds at most N companies", assertion: "added ≤ N on every search (checked at the step)" },
  { id: "DIS-02", stage: "discover", severity: "kill", method: "code", input: "Any search", expected: "No duplicate companies within the ICP", assertion: "No two companies share a domain or a normalised name in this ICP" },
  { id: "DIS-03", stage: "discover", severity: "hard", method: "code", input: "Any search", expected: "Every domain is real", assertion: "Each company domain resolves in DNS" },
  { id: "DIS-04", stage: "discover", severity: "hard", method: "code", input: "Search again", expected: "Companies already in the list are not returned again", assertion: "0 returned domains overlap the existing list (checked at the step)" },
  { id: "DIS-05", stage: "discover", severity: "soft", method: "judge", target: 0.8, input: "Any search", expected: "Results are the kind of company the ICP describes", assertion: "Judge per company: right kind of business for this ICP" },
  { id: "DIS-06", stage: "discover", severity: "hard", method: "code", input: "Any search", expected: "Each company has a source for why it was found", assertion: "Search sources or researched page URLs are recorded" },
  { id: "DIS-07", stage: "discover", severity: "hard", method: "scenario", input: "Pasted websites, including junk lines", expected: "Each website becomes a clean domain; junk is skipped; at most 25", assertion: "Normalised domains match; invalid lines are reported; the cap of 25 holds" },
  { id: "DIS-08", stage: "discover", severity: "soft", method: "code", target: 0.8, input: "Any search", expected: "Never padded with poor matches", assertion: "Searched companies scoring 40 or more" },

  // ------------------------------------------------------ research and score
  { id: "SCO-01", stage: "score", severity: "hard", method: "code", input: "Every scored company", expected: "Score from 0 to 100", assertion: "fit_score is an integer in 0-100" },
  { id: "SCO-02", stage: "score", severity: "kill", method: "code", input: "Every scored company", expected: "Status matches the score", assertion: "≥ 70 is shortlisted, < 70 is not (unless the user shortlisted or rejected it by hand)" },
  { id: "SCO-03", stage: "score", severity: "hard", method: "code", input: "Must-have gate fails", expected: "Not fit, whatever else it has", assertion: "Score ≤ 10 and not shortlisted" },
  { id: "SCO-04", stage: "score", severity: "hard", method: "code", input: "Every intent signal", expected: "Each signal names its source", assertion: "Every signal ends with its source, e.g. \"(Homepage)\", or contains a URL or date" },
  { id: "SCO-05", stage: "score", severity: "soft", method: "judge", target: 0.9, input: "Every fit reason", expected: "The fit reason is backed by the research", assertion: "Judge: every claim in the fit reason is supported by the facts and signals" },
  { id: "SCO-06", stage: "score", severity: "soft", method: "judge", target: 0.85, input: "Every shortlisted company", expected: "It really matches the ICP", assertion: "Judge with the ICP as rubric: fits" },
  { id: "SCO-07", stage: "score", severity: "hard", method: "code", input: "Researched company", expected: "Pages read stay within the limit; open gaps are stated", assertion: "pagesRead ≤ limit; when facts are insufficient, what is missing is written down" },
  { id: "SCO-08", stage: "score", severity: "soft", method: "judge", target: 0.8, input: "Re-score the same facts", expected: "Score is stable", assertion: "A second scoring is within ±10 points" },
  { id: "SCO-09", stage: "score", severity: "hard", method: "code", input: "Every company", expected: "Unknown facts say \"unknown\", never left blank", assertion: "Funding, HQ, employees and markets are a value or \"unknown\"" },

  // ------------------------------------------------------- point of contact
  { id: "POC-01", stage: "poc", severity: "hard", method: "code", input: "Company with a contact", expected: "Exactly one complete contact", assertion: "One contact with first name, title and email" },
  { id: "POC-02", stage: "poc", severity: "kill", method: "code", input: "Find POC", expected: "At most one Hunter credit per company", assertion: "Hunter credits logged for the company ≤ 1 (checked live before each paid call)" },
  { id: "POC-03", stage: "poc", severity: "hard", method: "code", input: "Find POC", expected: "The email is valid and on the company's domain", assertion: "Valid format and the email domain matches the company domain" },
  { id: "POC-04", stage: "poc", severity: "soft", method: "judge", target: 0.85, input: "Find POC", expected: "Right role for what is sold", assertion: "Judge: this title is a plausible buyer for the product" },
  { id: "POC-05", stage: "poc", severity: "hard", method: "code", input: "Person research", expected: "Every claim has a source and a verified flag", assertion: "0 claims without a URL" },
  { id: "POC-06", stage: "poc", severity: "kill", method: "judge", input: "Draft written after person research", expected: "Only verified claims about the person are used", assertion: "Judge: the email uses none of the unverified claims" },
  { id: "POC-07", stage: "poc", severity: "kill", method: "code", input: "No contact found", expected: "A placeholder contact is never emailed", assertion: "No email went to a placeholder contact outside the test lock" },

  // -------------------------------------------------------------- email draft
  { id: "DRF-01", stage: "draft", severity: "hard", method: "code", input: "Every draft", expected: "90-130 words", assertion: "Word count of the body" },
  { id: "DRF-02", stage: "draft", severity: "hard", method: "code", input: "Every draft", expected: "Opens with \"Hi {first name},\"", assertion: "First line equals \"Hi <contact first name>,\"" },
  { id: "DRF-03", stage: "draft", severity: "hard", method: "code", input: "Every draft", expected: "Ends with one question", assertion: "The last sentence before the sign-off ends with \"?\"" },
  { id: "DRF-04", stage: "draft", severity: "kill", method: "code", input: "Every draft", expected: "No links and no placeholders like [Name] or {company}", assertion: "None found (checked live before sending)" },
  { id: "DRF-05", stage: "draft", severity: "hard", method: "code", input: "Every draft", expected: "No exclamation marks, emojis or banned openers", assertion: "None found" },
  { id: "DRF-06", stage: "draft", severity: "hard", method: "code", input: "Every draft", expected: "Subject under 7 words", assertion: "Subject word count 1-6" },
  { id: "DRF-07", stage: "draft", severity: "hard", method: "code", input: "Every draft", expected: "Signed with the sender's name", assertion: "Last line is the sender name" },
  { id: "DRF-08", stage: "draft", severity: "kill", method: "judge", input: "Every draft", expected: "No invented facts", assertion: "Judge: every factual claim appears in the research or verified person facts" },
  { id: "DRF-09", stage: "draft", severity: "soft", method: "judge", target: 0.85, input: "Every draft", expected: "The hook is a specific, real fact about their company", assertion: "Judge: specific to this company and found in the research" },
  { id: "DRF-10", stage: "draft", severity: "soft", method: "judge", target: 0.85, input: "Every draft", expected: "Both pain points are woven in", assertion: "Judge: both pain points are present" },
  { id: "DRF-11", stage: "draft", severity: "soft", method: "judge", target: 0.8, input: "Drafts written with past lessons", expected: "Past lessons are followed", assertion: "Judge: the applied lessons are followed" },
  { id: "DRF-12", stage: "draft", severity: "soft", method: "code", target: 0.8, input: "Drafts the human edited", expected: "Little editing needed", assertion: "20% or less of the words changed between draft and final" },

  // ------------------------------------------------------------------ sending
  { id: "SND-01", stage: "send", severity: "kill", method: "code", input: "Any email while the lock is on", expected: "Goes only to the test addresses", assertion: "Every recipient is a test address (checked live in the mailer)" },
  { id: "SND-02", stage: "send", severity: "kill", method: "code", input: "Any send", expected: "The API check passes before the call", assertion: "Every paid step is mapped to an API check that runs first" },
  { id: "SND-03", stage: "send", severity: "hard", method: "code", input: "Send pressed", expected: "Either sends or shows an error, never silent", assertion: "Every send attempt is logged with a result or an error" },
  { id: "SND-04", stage: "send", severity: "hard", method: "code", input: "Edited draft or written feedback, then sent", expected: "A lesson is captured", assertion: "A lesson exists for every sent draft that was edited or has feedback" },
  { id: "SND-05", stage: "send", severity: "hard", method: "code", input: "Successful send", expected: "An email thread is started and logged", assertion: "A thread with an outbound email event exists" },
  { id: "SND-06", stage: "send", severity: "kill", method: "code", input: "Double-click on Send", expected: "Only one email goes out", assertion: "No two successful sends of the same draft within 30 seconds (blocked live)" },

  // ---------------------------------------------------------------- scheduler
  { id: "SCH-01", stage: "scheduler", severity: "hard", method: "scenario", input: "\"Sounds interesting, happy to chat\" (no time)", expected: "Checks the calendar, then proposes 2-3 free slots", assertion: "2-3 slots proposed, every one checked free; nothing booked" },
  { id: "SCH-02", stage: "scheduler", severity: "kill", method: "scenario", input: "\"Saturday at 5 PM works\"", expected: "Does not book; offers a weekday", assertion: "No booking on Saturday or Sunday" },
  { id: "SCH-03", stage: "scheduler", severity: "kill", method: "scenario", input: "\"How about 8 PM tonight?\"", expected: "Does not book; asks for 9 AM-6 PM", assertion: "No booking outside 9 AM-6 PM IST" },
  { id: "SCH-04", stage: "scheduler", severity: "kill", method: "scenario", input: "Confirms one of the proposed slots", expected: "Checks, books, then sends the link", assertion: "Booking only after a free check; the email carries that booking's link" },
  { id: "SCH-05", stage: "scheduler", severity: "hard", method: "scenario", input: "Asks for a time that is busy", expected: "Does not book; asks for another day", assertion: "No booking; one email sent" },
  { id: "SCH-06", stage: "scheduler", severity: "hard", method: "scenario", input: "\"Can we push it 15 minutes?\"", expected: "Moves the meeting; the new link is sent", assertion: "Booked 15 minutes later than the existing meeting" },
  { id: "SCH-07", stage: "scheduler", severity: "hard", method: "scenario", input: "\"Not interested, thanks\"", expected: "Short polite close, then stops", assertion: "Exactly one email, under 50 words, no question, nothing booked" },
  { id: "SCH-08", stage: "scheduler", severity: "hard", method: "scenario", input: "No reply for 48 hours", expected: "Exactly one follow-up", assertion: "One follow-up email in the sandbox; at most one per real thread" },
  { id: "SCH-09", stage: "scheduler", severity: "hard", method: "scenario", input: "\"Who is this?\"", expected: "Hands it to a person", assertion: "Classified as other; no email, no booking" },
  { id: "SCH-10", stage: "scheduler", severity: "kill", method: "scenario", input: "Every scheduling email", expected: "The only link is the booked meeting link", assertion: "0 other URLs in sandbox and real thread emails" },
  { id: "SCH-11", stage: "scheduler", severity: "soft", method: "scenario", target: 0.9, input: "Every scheduling email", expected: "Under 80 words; times like \"Tue 17 Nov, 3:15 PM IST\"", assertion: "Word count and time format" },
  { id: "SCH-12", stage: "scheduler", severity: "hard", method: "scenario", input: "\"Does <weekday> at 3 work?\"", expected: "Works out the right date in IST", assertion: "Booked date and time equal the expected slot" },
  { id: "SCH-13", stage: "scheduler", severity: "soft", method: "scenario", target: 0.9, input: "Every scripted reply", expected: "Intent classified correctly", assertion: "Classified intent matches the scripted label" },

  // ------------------------------------------------------------- system-wide
  { id: "SYS-01", stage: "system", severity: "kill", method: "code", input: "Any paid API call", expected: "The free check runs first", assertion: "Every paid step and the Hunter lookup call the API check before spending" },
  { id: "SYS-02", stage: "system", severity: "hard", method: "code", input: "Any step", expected: "Database tags match the data", assertion: "A tag sync right after the run makes no corrections" },
  { id: "SYS-03", stage: "system", severity: "kill", method: "code", input: "Any step", expected: "No secrets in stored data or responses", assertion: "No API key or token value appears in the dashboard state, events or notifications" },
  { id: "SYS-04", stage: "system", severity: "soft", method: "code", target: 0.9, input: "Each funnel step", expected: "Completes in time", assertion: "Each step finishes in under 120 s" },
];

export const CASE_BY_ID = new Map(CASES.map((c) => [c.id, c]));
