import type Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { competitorSources, type NewCompetitorSource } from "~/db/schema";
import { getDb } from "~/shared/server/db";
import { safeFetch, safeFetchText, SafeFetchError } from "~/shared/server/safe-fetch";
import { withToolSpan } from "~/shared/server/tracer";

// Tools for the per-competitor source-discovery agent (PF-95 / PF-93 phase 2).
//
// Shape mirrors src/agents/fte/tools.ts: definitions exported as DISCOVERY_TOOLS,
// dispatch via executeTool. Errors are returned in-band (isError:true) so the
// agent can react, never thrown.
//
// `record_source` writes directly to `competitor_sources` (no admin gate) and
// reports `recordedNewSource` so the agent loop can detect "no progress for N
// turns" without re-querying the DB. `finish` carries a `finished` flag that
// the loop reads to terminate.

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const FETCH_PAGE_TIMEOUT_MS = 60_000;
const FETCH_PAGE_MAX_CHARS = 8_000;
const FETCH_PAGE_MAX_LINKS = 60;
const FETCH_SITEMAP_TIMEOUT_MS = 15_000;
const FETCH_SITEMAP_MAX_URLS = 200;
const PROBE_RSS_TIMEOUT_MS = 15_000;
const PROBE_RSS_SAMPLE_CHARS = 400;

const SOURCE_TYPES = ["rss", "webpage", "x", "linkedin", "youtube"] as const;
type SourceTypeLiteral = (typeof SOURCE_TYPES)[number];

export const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: "fetch_page",
    description:
      "Fetch a single URL and return its text content as markdown. For inner pages the response is main content only (nav/footer stripped). For homepage URLs (path '/'), the response also includes an 'Outgoing links' section listing every <a href> on the page (including nav and footer) — use it to find product pages and social profiles. Markdown is truncated to ~8,000 characters; the links section is appended after.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Fully-qualified URL to fetch (must start with http:// or https://).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "fetch_sitemap",
    description:
      "Fetch a sitemap (XML) and return the list of URLs it advertises. Accepts a direct sitemap URL or a homepage origin — when given a homepage, probes /sitemap.xml. Handles sitemap-index files by returning child sitemap URLs (not their contents — call fetch_sitemap again on each child). Returns up to 200 URLs.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "Either a direct sitemap URL (e.g. https://example.com/sitemap.xml) or a homepage origin (e.g. https://example.com).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "probe_rss",
    description:
      "Check whether a URL serves an RSS or Atom feed. Returns { is_feed, content_type, sample } — sample is the first ~400 chars of the body so you can sanity-check parseability. Use this to verify candidate feed URLs before calling record_source with source_type='rss'.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Fully-qualified URL to probe (must start with http:// or https://).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "record_source",
    description:
      "Persist a discovered source for the current competitor. Writes a competitor_sources row immediately as 'active' — no approval gate. Idempotent on (competitor_id, source_type, url_or_handle): re-recording the same source is a no-op. Call once per source you've verified. Always supply a one-line rationale.",
    input_schema: {
      type: "object",
      properties: {
        source_type: {
          type: "string",
          enum: ["rss", "webpage", "x", "linkedin", "youtube"],
          description:
            "User-facing source kind. 'rss' and 'webpage' are ingested; 'x', 'linkedin', 'youtube' are recorded inert (URL captured, no fetcher yet).",
        },
        url_or_handle: {
          type: "string",
          description:
            "Absolute http(s) URL for rss/webpage. Profile URL (preferred) or @handle for x/linkedin/youtube.",
        },
        rationale: {
          type: "string",
          description:
            "One-line reason this source was selected (e.g. 'changelog page linked in footer'). Required.",
        },
        config: {
          type: "object",
          description:
            "Optional per-mode tuning hints (e.g. selector). Pass an object or omit. Phase-4 watcher will infer extraction_mode for webpage sources at first fetch.",
        },
      },
      required: ["source_type", "url_or_handle", "rationale"],
    },
  },
  {
    name: "finish",
    description:
      "End the discovery run. Call this once you have recorded every meaningful source — typically after homepage crawl + footer social sweep. Supply a short summary of what you found.",
    input_schema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "≤ 1 sentence describing what was discovered.",
        },
      },
      required: ["summary"],
    },
  },
];

export const DISCOVERY_TOOL_NAMES = DISCOVERY_TOOLS.map((t) => t.name);

export interface DiscoveryToolContext {
  competitorId: string;
  competitorName: string;
  homepageUrl: string;
}

export interface DiscoveryToolExecutionResult {
  content: string;
  isError: boolean;
  payload: Record<string, unknown>;
  // Set when record_source actually inserted a new row (not a dup hit).
  // The agent loop uses this for no-progress detection.
  recordedNewSource?: boolean;
  // Terminal signal from `finish` — loop exits when set.
  finished?: boolean;
  finishSummary?: string;
}

export async function executeTool(
  ctx: DiscoveryToolContext,
  name: string,
  input: unknown,
): Promise<DiscoveryToolExecutionResult> {
  return withToolSpan(name, input, () => dispatchTool(ctx, name, input));
}

async function dispatchTool(
  ctx: DiscoveryToolContext,
  name: string,
  input: unknown,
): Promise<DiscoveryToolExecutionResult> {
  switch (name) {
    case "fetch_page":
      return runFetchPage(input);
    case "fetch_sitemap":
      return runFetchSitemap(input);
    case "probe_rss":
      return runProbeRss(input);
    case "record_source":
      return runRecordSource(ctx, input);
    case "finish":
      return runFinish(input);
    default:
      return {
        content: `Unknown tool: ${name}`,
        isError: true,
        payload: { name },
      };
  }
}

// --- fetch_page --------------------------------------------------------

async function runFetchPage(input: unknown): Promise<DiscoveryToolExecutionResult> {
  const url = pickString(input, "url");
  if (!url) return errorResult("fetch_page requires a url string", { input });
  if (!/^https?:\/\//i.test(url)) {
    return errorResult("fetch_page requires a fully-qualified http(s) URL", { url });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return errorResult("FIRECRAWL_API_KEY not configured", { url });

  // Homepage URLs need nav + footer in scope so the agent can see product
  // pages and social profiles. Firecrawl's `links` format respects
  // `onlyMainContent`, so we flip both for the homepage call only.
  const isHomepage = isHomepageUrl(url);

  try {
    // The outbound target is the fixed Firecrawl SaaS endpoint — model-supplied
    // `url` rides in the body, and Firecrawl applies its own SSRF protections.
    const res = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        url,
        formats: isHomepage ? [{ type: "markdown" }, { type: "links" }] : [{ type: "markdown" }],
        onlyMainContent: !isHomepage,
        timeout: FETCH_PAGE_TIMEOUT_MS,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return errorResult(`fetch_page HTTP ${res.status}`, {
        url,
        status: res.status,
        body: body.slice(0, 300),
      });
    }
    const json = (await res.json()) as {
      success?: boolean;
      data?: { markdown?: string | null; links?: string[] | null };
      error?: string;
    };
    if (!json.success || !json.data) {
      return errorResult(`fetch_page failed: ${json.error ?? "unknown"}`, { url });
    }
    const md = (json.data.markdown ?? "").trim();
    if (md.length === 0) return errorResult("fetch_page returned empty content", { url });

    const truncated = md.length > FETCH_PAGE_MAX_CHARS;
    const mdSlice = truncated ? `${md.slice(0, FETCH_PAGE_MAX_CHARS)}…` : md;

    const links = isHomepage ? dedupeLinks(json.data.links).slice(0, FETCH_PAGE_MAX_LINKS) : [];
    const content =
      links.length > 0
        ? `${mdSlice}\n\n--- Outgoing links (${links.length}) ---\n${links.join("\n")}`
        : mdSlice;

    return {
      content,
      isError: false,
      payload: { url, bytes: md.length, truncated, links },
    };
  } catch (err) {
    return errorResult(`fetch_page threw: ${describeError(err)}`, { url });
  }
}

function isHomepageUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname === "" || u.pathname === "/";
  } catch {
    return false;
  }
}

function dedupeLinks(links: unknown): string[] {
  if (!Array.isArray(links)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const link of links) {
    if (typeof link !== "string") continue;
    const trimmed = link.trim();
    if (trimmed.length === 0) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// --- fetch_sitemap -----------------------------------------------------

async function runFetchSitemap(input: unknown): Promise<DiscoveryToolExecutionResult> {
  const inputUrl = pickString(input, "url");
  if (!inputUrl) return errorResult("fetch_sitemap requires a url string", { input });
  if (!/^https?:\/\//i.test(inputUrl)) {
    return errorResult("fetch_sitemap requires a fully-qualified http(s) URL", { url: inputUrl });
  }

  // If the caller passed a homepage origin (no path or `/`), probe /sitemap.xml.
  let target: string;
  try {
    const parsed = new URL(inputUrl);
    target =
      parsed.pathname === "" || parsed.pathname === "/"
        ? new URL("/sitemap.xml", parsed.origin).toString()
        : inputUrl;
  } catch {
    return errorResult("fetch_sitemap: invalid URL", { url: inputUrl });
  }

  let xml: string;
  try {
    xml = await safeFetchText(target, { timeoutMs: FETCH_SITEMAP_TIMEOUT_MS });
  } catch (err) {
    return errorResult(`fetch_sitemap fetch failed: ${describeError(err)}`, { url: target });
  }

  const { urls, isIndex } = parseSitemap(xml);
  if (urls.length === 0) {
    return errorResult("fetch_sitemap: no <loc> entries found (not a sitemap?)", {
      url: target,
      sample: xml.slice(0, 200),
    });
  }

  const capped = urls.slice(0, FETCH_SITEMAP_MAX_URLS);
  const truncated = urls.length > FETCH_SITEMAP_MAX_URLS;
  const header = isIndex
    ? `Sitemap index — ${urls.length} child sitemap(s):`
    : `Sitemap — ${urls.length} URL(s):`;
  const body = capped.join("\n");
  const suffix = truncated ? `\n…(${urls.length - FETCH_SITEMAP_MAX_URLS} more truncated)` : "";
  return {
    content: `${header}\n${body}${suffix}`,
    isError: false,
    payload: {
      url: target,
      is_index: isIndex,
      count: urls.length,
      urls: capped,
      truncated,
    },
  };
}

function parseSitemap(xml: string): { urls: string[]; isIndex: boolean } {
  const isIndex = /<sitemapindex\b/i.test(xml);
  const urls: string[] = [];
  // Cheap regex pull rather than a full XML parser — sitemap shape is
  // narrow enough that a <loc> sniff is reliable.
  const locRe = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  for (const m of xml.matchAll(locRe)) {
    const u = m[1];
    if (u) urls.push(u);
  }
  return { urls, isIndex };
}

// --- probe_rss ---------------------------------------------------------

async function runProbeRss(input: unknown): Promise<DiscoveryToolExecutionResult> {
  const url = pickString(input, "url");
  if (!url) return errorResult("probe_rss requires a url string", { input });
  if (!/^https?:\/\//i.test(url)) {
    return errorResult("probe_rss requires a fully-qualified http(s) URL", { url });
  }

  let res: Response;
  try {
    res = await safeFetch(url, {
      method: "GET",
      timeoutMs: PROBE_RSS_TIMEOUT_MS,
      headers: {
        Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5",
      },
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      return errorResult(`probe_rss blocked: ${err.code}`, { url });
    }
    return errorResult(`probe_rss fetch threw: ${describeError(err)}`, { url });
  }

  if (!res.ok) {
    return {
      content: `probe_rss: HTTP ${res.status} for ${url}`,
      isError: false,
      payload: { url, is_feed: false, http_status: res.status },
    };
  }

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const body = await res.text();
  const head = body.slice(0, 1024).trimStart();
  const looksLikeFeed =
    /application\/(rss|atom)\+xml|application\/xml|text\/xml/.test(contentType) ||
    /^<\?xml/i.test(head) ||
    /^<rss\b/i.test(head) ||
    /^<feed\b/i.test(head);
  const sample = body.slice(0, PROBE_RSS_SAMPLE_CHARS);

  return {
    content: looksLikeFeed
      ? `probe_rss: feed detected (content-type=${contentType || "n/a"}).`
      : `probe_rss: not a feed (content-type=${contentType || "n/a"}).`,
    isError: false,
    payload: {
      url,
      is_feed: looksLikeFeed,
      content_type: contentType || null,
      sample,
    },
  };
}

// --- record_source -----------------------------------------------------

async function runRecordSource(
  ctx: DiscoveryToolContext,
  input: unknown,
): Promise<DiscoveryToolExecutionResult> {
  const sourceType = pickString(input, "source_type");
  const urlOrHandle = pickString(input, "url_or_handle");
  const rationale = pickString(input, "rationale");
  const config = pickObject(input, "config");

  if (!sourceType || !urlOrHandle || !rationale) {
    return errorResult("record_source requires source_type, url_or_handle, and rationale", {
      input,
    });
  }
  if (!isSourceType(sourceType)) {
    return errorResult(`record_source: unknown source_type '${sourceType}'`, {
      source_type: sourceType,
    });
  }

  // rss/webpage require absolute http(s). Socials accept @handle OR URL.
  if (sourceType === "rss" || sourceType === "webpage") {
    if (!/^https?:\/\//i.test(urlOrHandle)) {
      return errorResult(`record_source: ${sourceType} url_or_handle must be http(s)`, {
        source_type: sourceType,
        url_or_handle: urlOrHandle,
      });
    }
  } else if (!urlOrHandle.startsWith("@") && !/^https?:\/\//i.test(urlOrHandle)) {
    return errorResult(`record_source: ${sourceType} url_or_handle must be a URL or @handle`, {
      source_type: sourceType,
      url_or_handle: urlOrHandle,
    });
  }

  // extraction_mode is deterministic for rss, inferred at first fetch for
  // webpage (phase 4), null/inert for socials.
  const extractionMode: NewCompetitorSource["extractionMode"] =
    sourceType === "rss" ? "feed_poll" : null;

  const row: NewCompetitorSource = {
    competitorId: ctx.competitorId,
    sourceType,
    extractionMode,
    urlOrHandle,
    status: "active",
    config: config ?? {},
    agentRationale: rationale,
  };

  const db = getDb();
  try {
    // ON CONFLICT DO NOTHING + RETURNING isolates whether this call newly
    // wrote a row (length 1) or hit the existing dup (length 0). Drives the
    // loop's no-progress detector.
    const inserted = await db
      .insert(competitorSources)
      .values(row)
      .onConflictDoNothing({
        target: [
          competitorSources.competitorId,
          competitorSources.sourceType,
          competitorSources.urlOrHandle,
        ],
      })
      .returning({ id: competitorSources.id });

    if (inserted.length === 0) {
      // Dup — fetch the existing row's id for transparency.
      const [existing] = await db
        .select({ id: competitorSources.id })
        .from(competitorSources)
        .where(
          and(
            eq(competitorSources.competitorId, ctx.competitorId),
            eq(competitorSources.sourceType, sourceType),
            eq(competitorSources.urlOrHandle, urlOrHandle),
          ),
        );
      return {
        content: `Already recorded: ${sourceType} ${urlOrHandle}.`,
        isError: false,
        recordedNewSource: false,
        payload: {
          source_type: sourceType,
          url_or_handle: urlOrHandle,
          competitor_source_id: existing?.id ?? null,
          duplicate: true,
        },
      };
    }

    const id = inserted[0]!.id;
    return {
      content: `Recorded ${sourceType} ${urlOrHandle}.`,
      isError: false,
      recordedNewSource: true,
      payload: {
        source_type: sourceType,
        url_or_handle: urlOrHandle,
        competitor_source_id: id,
        extraction_mode: extractionMode,
        rationale,
        duplicate: false,
      },
    };
  } catch (err) {
    return errorResult(`record_source threw: ${describeError(err)}`, {
      source_type: sourceType,
      url_or_handle: urlOrHandle,
    });
  }
}

// --- finish ------------------------------------------------------------

function runFinish(input: unknown): DiscoveryToolExecutionResult {
  const summary = pickString(input, "summary");
  return {
    content: summary ? `Run summary: ${summary}` : "Run finished.",
    isError: false,
    finished: true,
    finishSummary: summary,
    payload: { summary },
  };
}

// --- helpers -----------------------------------------------------------

function isSourceType(s: string): s is SourceTypeLiteral {
  return (SOURCE_TYPES as readonly string[]).includes(s);
}

function pickString(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v.trim() : "";
}

function pickObject(input: unknown, key: string): Record<string, unknown> | null {
  if (!input || typeof input !== "object") return null;
  const v = (input as Record<string, unknown>)[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

function errorResult(
  message: string,
  payload: Record<string, unknown>,
): DiscoveryToolExecutionResult {
  return { content: message, isError: true, payload: { ...payload, error: message } };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
