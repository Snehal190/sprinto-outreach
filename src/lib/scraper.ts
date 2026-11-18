import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import net from "node:net";
import { sql } from "./db";

// The scraper pipeline. Every page goes through the same five stages:
//
//   Request -> Parse -> Extract -> Clean -> Store
//
// Extraction here is heuristics-based: generic structural rules that work on
// any site with no setup and no AI cost. It finds the right region of the page,
// not exact fields. The model-based pass that pulls specific fields out of the
// cleaned text lives in research.ts.

export type PageType =
  | "homepage" | "careers" | "about" | "security" | "pricing"
  | "product" | "customers" | "press" | "team" | "funding_search"
  // Used when researching a person: a page their email was found on, and a web search for them.
  | "contact_source" | "person_search"
  // A web search for recent news that shows buying intent for the ICP.
  | "news_search";

/** Page types that are found by following the site's own links. */
export type SitePage = Exclude<PageType, "homepage" | "funding_search" | "contact_source" | "person_search" | "news_search">;

export type Link = { url: string; text: string };

export type ScrapedPage = {
  pageType: PageType;
  url: string;
  status: number;
  title: string;
  description: string;
  text: string;
  links: Link[];
  emails: string[];
  /** Cheap keyword findings from the whole page, including the footer. */
  hints: string[];
  /** True when the page had almost no readable text (usually a JavaScript-rendered site). */
  thin: boolean;
};

const TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 3_000_000;
const MAX_TEXT_CHARS = 6_000;
const USER_AGENT = "Mozilla/5.0 (compatible; OutreachResearchBot/0.1)";

// ------------------------------------------------------------------ Request

function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

/** Websites come from user input, so refuse anything that is not a public http(s) address. */
async function assertPublicUrl(url: URL) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https are allowed");
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error("Address is not public");
  }
}

export type Fetched = { ok: true; url: string; status: number; html: string } | { ok: false; url: string; status: number; error: string };

export async function request(target: string): Promise<Fetched> {
  let current = target;
  try {
    for (let hop = 0; hop < 6; hop++) {
      const url = new URL(current);
      await assertPublicUrl(url);
      const res = await fetch(url, {
        redirect: "manual",
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, url).toString();
        continue;
      }
      if (!res.ok) return { ok: false, url: current, status: res.status, error: `HTTP ${res.status}` };
      const type = res.headers.get("content-type") ?? "";
      if (type && !/html|text\/plain/i.test(type)) return { ok: false, url: current, status: res.status, error: `Not a web page (${type})` };
      if (Number(res.headers.get("content-length") ?? 0) > MAX_HTML_BYTES) return { ok: false, url: current, status: res.status, error: "Page too large" };
      const html = (await res.text()).slice(0, MAX_HTML_BYTES);
      return { ok: true, url: current, status: res.status, html };
    }
    return { ok: false, url: current, status: 0, error: "Too many redirects" };
  } catch (err) {
    return { ok: false, url: current, status: 0, error: (err as Error).message };
  }
}

/** Reads robots.txt once per site and answers whether a path may be fetched. */
export async function loadRobots(origin: string): Promise<(path: string) => boolean> {
  const res = await request(`${origin}/robots.txt`);
  if (!res.ok || /<html/i.test(res.html.slice(0, 500))) return () => true;
  const disallowed: string[] = [];
  let applies = false;
  let lastWasAgent = false;
  for (const raw of res.html.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    const [key, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (/^user-agent$/i.test(key)) {
      applies = lastWasAgent ? applies || value === "*" : value === "*";
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (applies && /^disallow$/i.test(key) && value) disallowed.push(value);
  }
  return (path) => !disallowed.some((rule) => path.startsWith(rule.replace(/\*.*$/, "")) && rule.replace(/\*.*$/, "") !== "");
}

// ------------------------------------------------- Parse + Extract (heuristics)

const NOISE = "script, style, noscript, svg, iframe, template, nav, footer, aside, form, [role=navigation], [role=contentinfo], [aria-hidden=true]";
const NOISE_NAMES = /cookie|consent|banner|popup|modal|newsletter|subscribe|breadcrumb|sidebar/i;
const BLOCKS = "p, div, section, article, li, h1, h2, h3, h4, h5, h6, tr, br, dt, dd, blockquote";

/** A keyword finding: its label and a case-insensitive regular expression. */
export type Hint = [label: string, pattern: string];

// Findings that matter for any ICP. The ICP profile adds its own (icp.ts).
const BASE_HINTS: [string, RegExp][] = [
  ["has an enterprise offering", /\benterprise (plan|tier|pricing|customers|grade|ready|sales)\b|contact sales/i],
  ["mentions a funding round", /\b(series\s[a-e]|seed round|pre-seed|raised \$[\d.]+\s?(m|million|b|billion))\b/i],
];

function compileHints(extra: Hint[]): [string, RegExp][] {
  const compiled = extra.flatMap(([label, pattern]): [string, RegExp][] => {
    try {
      return [[label, new RegExp(pattern, "i")]];
    } catch {
      return [];
    }
  });
  return [...compiled, ...BASE_HINTS];
}

function parse(html: string, pageUrl: string, pageType: PageType, status: number, maxChars: number, extraHints: Hint[] = []): ScrapedPage {
  const $ = cheerio.load(html);
  const base = new URL(pageUrl);

  // Collected from the whole document before anything is dropped: navigation
  // and footers are noise for content but are where links and badges live.
  const title = $("title").first().text().trim();
  const description = ($('meta[name="description"]').attr("content") ?? $('meta[property="og:description"]').attr("content") ?? "").trim();
  const links: Link[] = [];
  const emails = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") ?? "").trim();
    if (/^mailto:/i.test(href)) {
      const email = href.replace(/^mailto:/i, "").split("?")[0].trim().toLowerCase();
      if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) emails.add(email);
      return;
    }
    if (!href || /^(#|javascript:|tel:)/i.test(href)) return;
    try {
      const url = new URL(href, base);
      url.hash = "";
      links.push({ url: url.toString(), text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 80) });
    } catch {
      /* ignore malformed links */
    }
  });
  const fullText = $("body").text().replace(/\s+/g, " ");
  const hints = compileHints(extraHints).filter(([, re]) => re.test(fullText)).map(([name]) => name);

  // Heuristic region selection: drop navigation, footers and other chrome,
  // then keep the largest text block.
  $(NOISE).remove();
  $("[class], [id]").each((_, el) => {
    const name = `${$(el).attr("class") ?? ""} ${$(el).attr("id") ?? ""}`;
    if (NOISE_NAMES.test(name) && $(el).text().length < 1500) $(el).remove();
  });
  $(BLOCKS).each((_, el) => {
    $(el).append("\n");
  });
  let region = $("body");
  let longest = 0;
  $("main, [role=main], article").each((_, el) => {
    const length = $(el).text().length;
    if (length > longest) {
      longest = length;
      region = $(el);
    }
  });
  if (longest < Math.max(400, $("body").text().length * 0.4)) region = $("body");

  const text = clean(region.text(), maxChars);
  return { pageType, url: pageUrl, status, title, description, text, links, emails: [...emails], hints, thin: text.length < 200 };
}

// -------------------------------------------------------------------- Clean

const BOILERPLATE = /^(skip to (main )?content|all rights reserved|accept( all)?( cookies)?|we use cookies|menu|close|toggle navigation|loading\.*|©.*)$/i;

function clean(raw: string, maxChars: number): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const piece of raw.split("\n")) {
    const line = piece.replace(/\s+/g, " ").trim();
    if (line.length < 2 || BOILERPLATE.test(line)) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines.join("\n").slice(0, maxChars);
}

// -------------------------------------------------------------------- Store

export async function store(companyId: number, purpose: "qualify" | "contacts", page: ScrapedPage) {
  await sql(
    `INSERT INTO scraped_pages (company_id, purpose, page_type, url, http_status, title, text, hints)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [companyId, purpose, page.pageType, page.url, page.status, page.title, page.text, JSON.stringify(page.hints)],
  );
}

// ---------------------------------------------------------------- one page

/** Runs Request -> Parse -> Extract -> Clean on a single URL. Storing is done by the caller. */
export async function scrapePage(url: string, pageType: PageType, maxChars = MAX_TEXT_CHARS, extraHints: Hint[] = []): Promise<{ page: ScrapedPage } | { error: string; status: number }> {
  const fetched = await request(url);
  if (!fetched.ok) return { error: fetched.error, status: fetched.status };
  return { page: parse(fetched.html, fetched.url, pageType, fetched.status, maxChars, extraHints) };
}

// ------------------------------------------------------ finding a named page

// How each named source is recognised from a link, and where to look if the
// site does not link to it.
const SOURCES: Record<SitePage, { match: RegExp; paths: string[] }> = {
  careers: { match: /career|jobs?\b|join[- ]us|work[- ]with[- ]us|we.?re hiring|open[- ](roles|positions)/i, paths: ["/careers", "/jobs"] },
  about: { match: /about|our[- ]story|who[- ]we[- ]are|\/company\b/i, paths: ["/about", "/about-us", "/company"] },
  security: { match: /security|trust|compliance/i, paths: ["/security", "/trust"] },
  pricing: { match: /pricing|plans/i, paths: ["/pricing"] },
  product: { match: /product|platform|features|solutions|how[- ]it[- ]works/i, paths: ["/product", "/platform", "/features"] },
  customers: { match: /customers|case[- ]stud|enterprise/i, paths: ["/customers", "/enterprise"] },
  press: { match: /press|newsroom|\bnews\b|announcement|blog/i, paths: ["/press", "/news", "/blog"] },
  team: { match: /team|leadership|people|founders|management/i, paths: ["/team", "/about", "/leadership", "/company"] },
};

// Job boards a careers link is allowed to lead to, even though they are off-site.
const JOB_BOARDS = /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|bamboohr\.com|teamtailor\.com|recruitee\.com|breezy\.hr)$/i;

/** Candidate URLs for a named page type: links found on the site first, then common paths. */
export function candidateUrls(pageType: SitePage, domain: string, origin: string, links: Link[]): string[] {
  const source = SOURCES[pageType];
  const matches = links
    .filter((link) => {
      let url: URL;
      try {
        url = new URL(link.url);
      } catch {
        return false;
      }
      const onSite = url.hostname === domain || url.hostname.endsWith(`.${domain}`);
      const jobBoard = pageType === "careers" && JOB_BOARDS.test(url.hostname);
      if (!onSite && !jobBoard) return false;
      if (/\.(pdf|png|jpe?g|zip|mp4)$/i.test(url.pathname)) return false;
      if (jobBoard) return true;
      if (url.pathname === "/" || url.pathname === "") return false;
      return source.match.test(url.pathname) || source.match.test(link.text);
    })
    .map((link) => link.url)
    .sort((a, b) => a.length - b.length);
  // Top-level links first (/careers), then the usual paths, then deeper links
  // (/blog/why-careers-matter), which are more often articles than the page itself.
  const depth = (u: string) => new URL(u).pathname.split("/").filter(Boolean).length;
  const offSite = (u: string) => new URL(u).origin !== origin;
  const top = matches.filter((u) => offSite(u) || depth(u) <= 1);
  const deep = matches.filter((u) => !offSite(u) && depth(u) > 1);
  return [...new Set([...top, ...source.paths.map((p) => `${origin}${p}`), ...deep])].slice(0, 4);
}
