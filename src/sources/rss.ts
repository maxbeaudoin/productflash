import RSSParser from "rss-parser";
import { logger } from "~/shared/server/logger";
import { safeFetchText, SafeFetchError } from "~/shared/server/safe-fetch";
import { withSpan } from "~/shared/server/tracer";
import type { CompetitorRef, NormalizedItem } from "./types";

// RSS / Atom source adapter.
//
// Wraps `rss-parser` (handles both RSS 2.0 and Atom 1.0 transparently). We do
// the HTTP fetch ourselves rather than calling parser.parseURL so we can:
//   - inject a custom fetchImpl in tests
//   - set a strict timeout via AbortController (rss-parser's `timeout` option
//     is fragile across redirects)
//   - set a real UA string — some changelog hosts (Vercel/Cloudflare-fronted)
//     403 the default node UA
//
// Dedupe key per RSS 2.0 spec: prefer <guid>, fall back to <link>. If both
// are missing, we drop the item (no stable identity → would re-ingest forever).
//
// Autodetect: tries the homepage's <link rel="alternate" type="application/rss+xml">
// declaration first (the standard mechanism), then path-probes common suffixes.
// Path order is influenced by the task spec (/feed, /rss, /changelog.rss,
// /blog/feed) plus a few high-yield variants observed in seeded competitors
// (e.g. Vercel uses /atom, Linear uses /changelog/rss.xml).

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_UA = "Mozilla/5.0 (compatible; ProductFlashBot/0.1; +https://productflash.ai)";

const parser = new RSSParser();

export interface RSSFetchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

export async function fetchRSS(
  competitor: CompetitorRef,
  options: RSSFetchOptions = {},
): Promise<NormalizedItem[]> {
  return withSpan("rss.fetch", () => fetchRSSImpl(competitor, options), {
    "competitor.id": competitor.id,
    "competitor.name": competitor.name,
    "rss.url": competitor.rssUrl ?? "",
  });
}

async function fetchRSSImpl(
  competitor: CompetitorRef,
  options: RSSFetchOptions,
): Promise<NormalizedItem[]> {
  if (!competitor.rssUrl) {
    logger.warn(
      { competitorId: competitor.id, name: competitor.name },
      "rss: competitor has no rssUrl, skipping",
    );
    return [];
  }

  let xml: string;
  try {
    xml = await fetchFeedXml(competitor.rssUrl, options);
  } catch (err) {
    logger.warn(
      { err, competitorId: competitor.id, name: competitor.name, rssUrl: competitor.rssUrl },
      "rss: fetch failed",
    );
    return [];
  }

  let feed: Awaited<ReturnType<typeof parser.parseString>>;
  try {
    feed = await parser.parseString(xml);
  } catch (err) {
    logger.warn(
      { err, competitorId: competitor.id, name: competitor.name, rssUrl: competitor.rssUrl },
      "rss: parse failed",
    );
    return [];
  }

  const out: NormalizedItem[] = [];
  const seen = new Set<string>();
  for (const raw of feed.items ?? []) {
    const item = toNormalizedItem(raw);
    if (!item) continue;
    if (seen.has(item.sourceId)) continue;
    seen.add(item.sourceId);
    out.push(item);
  }
  return out;
}

/**
 * Fan-out helper. Independent network calls so we parallelize, but bounded so
 * we don't open 100 sockets if the seed list grows.
 */
export async function fetchRSSForCompetitors(
  competitors: CompetitorRef[],
  options: RSSFetchOptions = {},
): Promise<Map<string, NormalizedItem[]>> {
  const result = new Map<string, NormalizedItem[]>();
  for (const c of competitors) result.set(c.id, []);

  const concurrency = 6;
  let cursor = 0;
  async function worker() {
    while (true) {
      const idx = cursor++;
      if (idx >= competitors.length) return;
      const c = competitors[idx];
      if (!c.rssUrl) continue;
      const items = await fetchRSS(c, options);
      result.set(c.id, items);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, competitors.length) }, worker));

  return result;
}

function toNormalizedItem(raw: RSSParser.Item): NormalizedItem | null {
  const url = (raw.link ?? "").trim();
  const guid = (raw.guid ?? "").trim();
  const sourceId = guid || url;
  if (!sourceId) return null;
  if (!url) return null;

  const title = sanitizeFeedText((raw.title ?? "").trim()) || "(untitled)";
  const body = pickBody(raw);
  const publishedAt = parseDate(raw.isoDate) ?? parseDate(raw.pubDate);

  return {
    source: "rss",
    sourceId,
    url,
    title,
    body,
    publishedAt,
  };
}

function pickBody(raw: RSSParser.Item): string | null {
  // contentSnippet is the plain-text version; content is HTML. For LLM
  // consumption downstream we prefer the snippet — Haiku doesn't need markup.
  const snippet = raw.contentSnippet?.trim();
  if (snippet) return sanitizeFeedText(snippet);
  const summary = raw.summary?.trim();
  if (summary) return sanitizeFeedText(summary);
  const content = raw.content?.trim();
  if (content) return sanitizeFeedText(content);
  return null;
}

// Defense-in-depth against prompt injection in feed content. The classifier
// and synthesizer already wrap untrusted text in <feed_body> tags with a
// "treat as data" instruction (see src/lib/classify.ts, src/lib/synthesize.ts),
// but this strip-pass at ingest narrows the surface for the obvious
// "ignore prior instructions" / fake-role-tag patterns. Stripped patterns
// are replaced with `[redacted]` so the model still sees that something
// was filtered (better than silent removal — preserves intent signal).
const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions/gi,
  /<\/?(?:system|user|assistant)>/gi,
  /<\/?feed_(?:title|body)>/gi, // prevent feed text from closing our own delimiter
];
const MAX_FEED_TEXT_CHARS = 4000;

function sanitizeFeedText(text: string): string {
  let out = text;
  for (const pattern of INJECTION_PATTERNS) out = out.replace(pattern, "[redacted]");
  // Strip control chars (except common whitespace) — feed sources sometimes
  // smuggle U+0000-U+001F that breaks downstream tokenization.
  // oxlint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
  if (out.length > MAX_FEED_TEXT_CHARS) out = `${out.slice(0, MAX_FEED_TEXT_CHARS)}…`;
  return out;
}

function parseDate(input: string | undefined): Date | null {
  if (!input) return null;
  const d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

// --- autodetect ---------------------------------------------------------

const AUTODETECT_PATHS = [
  "/feed",
  "/rss",
  "/rss.xml",
  "/feed.xml",
  "/atom",
  "/atom.xml",
  "/changelog/rss.xml",
  "/changelog.rss",
  "/blog/feed",
  "/blog/rss",
  "/blog/rss.xml",
];

export interface RSSAutodetectOptions extends RSSFetchOptions {
  /** Max number of candidate URLs to probe (incl. <link rel> declarations). */
  maxProbes?: number;
}

/**
 * Given a competitor homepage URL, try to discover its RSS/Atom feed.
 *
 * Strategy:
 *  1. GET the homepage HTML, scan for `<link rel="alternate" type="application/rss+xml|atom+xml">`.
 *  2. Probe common paths (/feed, /rss, /changelog.rss, /blog/feed, …).
 *  3. For each candidate, do a parseable-feed check (must yield ≥1 item).
 *
 * Returns the absolute URL of the first feed that parses with items, or null.
 */
export async function autodetectRSSForHomepage(
  homepageUrl: string,
  options: RSSAutodetectOptions = {},
): Promise<string | null> {
  const maxProbes = options.maxProbes ?? 16;
  const candidates = new Set<string>();

  // Step 1: <link rel="alternate"> sniff.
  try {
    const html = await fetchText(homepageUrl, options);
    for (const url of extractAlternateFeedLinks(html, homepageUrl)) {
      candidates.add(url);
    }
  } catch (err) {
    logger.debug(
      { err, homepageUrl },
      "rss autodetect: homepage fetch failed, falling back to path probe",
    );
  }

  // Step 2: path probes from homepage origin.
  let origin: URL;
  try {
    origin = new URL(homepageUrl);
  } catch {
    logger.warn({ homepageUrl }, "rss autodetect: invalid homepageUrl");
    return null;
  }
  for (const path of AUTODETECT_PATHS) {
    candidates.add(new URL(path, origin.origin).toString());
  }

  // Step 3: validate candidates in declared order.
  let probed = 0;
  for (const candidate of candidates) {
    if (probed >= maxProbes) break;
    probed++;
    try {
      const xml = await fetchFeedXml(candidate, options);
      const feed = await parser.parseString(xml);
      if ((feed.items?.length ?? 0) > 0) {
        logger.info(
          { homepageUrl, feedUrl: candidate, items: feed.items!.length },
          "rss autodetect: resolved",
        );
        return candidate;
      }
    } catch {
      // Try the next candidate. Common: 404, HTML returned instead of XML,
      // empty feed, parse error on truncated body. None are fatal.
    }
  }

  logger.warn({ homepageUrl, probed }, "rss autodetect: no feed found");
  return null;
}

function extractAlternateFeedLinks(html: string, base: string): string[] {
  const out: string[] = [];
  // Cheap regex sniff — full HTML parse is overkill for a <link> tag in <head>.
  // Matches: <link ... rel="alternate" ... type="application/rss+xml|atom+xml" ... href="...">
  // (attribute order varies, hence two passes.)
  const linkRe = /<link\b[^>]*>/gi;
  for (const match of html.matchAll(linkRe)) {
    const tag = match[0];
    if (!/rel\s*=\s*["']alternate["']/i.test(tag)) continue;
    if (!/type\s*=\s*["']application\/(rss|atom)\+xml["']/i.test(tag)) continue;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      out.push(new URL(href, base).toString());
    } catch {
      // skip
    }
  }
  return out;
}

// --- shared HTTP --------------------------------------------------------

async function fetchFeedXml(url: string, options: RSSFetchOptions): Promise<string> {
  return fetchText(
    url,
    options,
    "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  );
}

// All RSS fetches funnel through safeFetchText — the URL originates from a
// user-supplied homepage (addCompetitor) or an autodetect probe based on one,
// so it MUST be guarded against pointing at Railway-internal addresses.
// `options.fetchImpl` is preserved for tests that want to inject a stub; that
// path bypasses the safe wrapper because tests run with controlled fixture
// URLs.
async function fetchText(url: string, options: RSSFetchOptions, accept = "*/*"): Promise<string> {
  const ua = options.userAgent ?? DEFAULT_UA;
  const headers = { "User-Agent": ua, Accept: accept };
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (options.fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await options.fetchImpl(url, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    return await safeFetchText(url, { headers, timeoutMs });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      // Surface as a generic "fetch failed" so the autodetect path can log +
      // skip without leaking the specific reject reason to a probing user.
      throw new Error(`HTTP fetch blocked for ${url} (${err.code})`);
    }
    throw err;
  }
}
