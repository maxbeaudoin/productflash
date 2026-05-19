import { createHash } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { createPatch } from "diff";
import { getAnthropic, HAIKU_MODEL } from "~/shared/server/anthropic";
import { requireEnv } from "~/shared/server/env";
import { logger } from "~/shared/server/logger";
import type { NormalizedItem } from "./types";

// Webpage watcher (PF-97). Companion to the per-competitor source-discovery
// agent (PF-95): the agent records `webpage` rows into competitor_sources
// with extractionMode = NULL, and this adapter is what actually pulls them.
//
// Two modes, both fed by one Firecrawl scrape:
//
//   - snapshot_diff  → static content page. Hash the markdown; on hash
//                      change, ask Haiku whether the diff is meaningful;
//                      emit one item with the unified diff as body.
//   - list_extract   → listing/index page (blog, changelog). Haiku extracts
//                      one {title, url, publishedAt} per post; the
//                      orchestrator dedupes via raw_items' (source,
//                      source_id) unique index.
//
// First fetch (extractionMode === null) runs an extra Haiku call to pick
// the mode, then proceeds. Subsequent fetches skip inference.
//
// The adapter is pure (no DB). The orchestrator persists newContentHash,
// inferredMode, and lastFetchedAt back onto competitor_sources.

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const DEFAULT_TIMEOUT_MS = 60_000;
// Cap markdown size we hand to Haiku to keep token cost bounded. Real
// listing/changelog pages run 2-15kB after onlyMainContent stripping; the
// occasional 60kB monster page would just blow input tokens for no signal.
const MAX_MARKDOWN_CHARS = 24_000;
// Hard ceiling on extracted listing items per fetch. Real changelogs return
// ≤20; anything beyond is hallucination or a paginated index we'd rather
// truncate than emit hundreds of low-signal rows.
const MAX_LIST_ITEMS = 40;

export type WebpageExtractionMode = "snapshot_diff" | "list_extract";

// Caller passes one of these per competitor_sources row. Mirrors
// CompetitorRef in shape but is keyed on the source, not the competitor —
// one competitor can have N webpage sources.
export interface WebpageSourceRef {
  id: string; // competitor_sources.id
  competitorId: string;
  competitorName: string;
  url: string; // urlOrHandle
  extractionMode: WebpageExtractionMode | null;
  lastContentHash: string | null;
}

export interface WebpageFetchResult {
  sourceId: string;
  competitorId: string;
  items: NormalizedItem[];
  // Persistence side-effects for the orchestrator to apply.
  inferredMode: WebpageExtractionMode | null; // non-null only on first-fetch
  newContentHash: string | null; // present for snapshot_diff; null on errors
  fetchedAt: Date;
  errored: boolean;
}

// All Haiku/Firecrawl IO is injectable so tests can run deterministically
// without hitting external APIs. The production defaults call the real
// services.
export interface WebpageFetchOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  inferModeImpl?: (markdown: string, url: string) => Promise<WebpageExtractionMode>;
  changeMeaningfulImpl?: (prev: string, next: string, url: string) => Promise<boolean>;
  extractListImpl?: (markdown: string, url: string) => Promise<ExtractedListItem[]>;
}

interface ExtractedListItem {
  title: string;
  url: string;
  publishedAt: string | null; // ISO string emitted by Haiku
}

/**
 * Fan-out helper. Sequentially processes each source (Firecrawl quota is
 * the bottleneck, not adapter CPU). Per-source errors are caught and
 * surfaced via `errored: true` so one failing competitor doesn't sink the
 * whole batch.
 */
export async function fetchWebpageForSources(
  sources: WebpageSourceRef[],
  options: WebpageFetchOptions = {},
): Promise<Map<string, WebpageFetchResult>> {
  const results = new Map<string, WebpageFetchResult>();
  for (const src of sources) {
    try {
      const result = await fetchWebpageForSource(src, options);
      results.set(src.id, result);
    } catch (err) {
      logger.warn(
        { err, sourceId: src.id, competitorId: src.competitorId, url: src.url },
        "webpage: source fetch failed",
      );
      results.set(src.id, {
        sourceId: src.id,
        competitorId: src.competitorId,
        items: [],
        inferredMode: null,
        newContentHash: null,
        fetchedAt: new Date(),
        errored: true,
      });
    }
  }
  return results;
}

export async function fetchWebpageForSource(
  src: WebpageSourceRef,
  options: WebpageFetchOptions = {},
): Promise<WebpageFetchResult> {
  const fetchedAt = new Date();
  const rawMarkdown = await firecrawlScrape(src.url, options);
  const normalized = normalizeContent(rawMarkdown);
  const truncated =
    normalized.length > MAX_MARKDOWN_CHARS ? normalized.slice(0, MAX_MARKDOWN_CHARS) : normalized;

  // First fetch: ask Haiku which mode to use, then continue with it.
  let mode: WebpageExtractionMode;
  let inferredMode: WebpageExtractionMode | null = null;
  if (src.extractionMode === null) {
    const infer = options.inferModeImpl ?? inferExtractionMode;
    mode = await infer(truncated, src.url);
    inferredMode = mode;
    logger.info(
      { sourceId: src.id, url: src.url, mode },
      "webpage: extraction mode inferred at first fetch",
    );
  } else {
    mode = src.extractionMode;
  }

  if (mode === "snapshot_diff") {
    return runSnapshotDiff(src, normalized, inferredMode, fetchedAt, options);
  }
  return runListExtract(src, truncated, inferredMode, fetchedAt, options);
}

async function runSnapshotDiff(
  src: WebpageSourceRef,
  normalized: string,
  inferredMode: WebpageExtractionMode | null,
  fetchedAt: Date,
  options: WebpageFetchOptions,
): Promise<WebpageFetchResult> {
  const contentHash = sha256Hex(normalized);

  // No baseline yet → record the snapshot and exit silently. Matches the
  // firecrawl pricing-page adapter's first-snapshot behavior.
  if (!src.lastContentHash) {
    return {
      sourceId: src.id,
      competitorId: src.competitorId,
      items: [],
      inferredMode,
      newContentHash: contentHash,
      fetchedAt,
      errored: false,
    };
  }

  // Cost gate: hashes match → skip the Haiku change-judgement call.
  if (src.lastContentHash === contentHash) {
    return {
      sourceId: src.id,
      competitorId: src.competitorId,
      items: [],
      inferredMode,
      newContentHash: contentHash,
      fetchedAt,
      errored: false,
    };
  }

  // Hash changed — but is the change meaningful? Cosmetic re-renders
  // (timestamps, build hashes, anti-bot tokens) still slip through the
  // normalizer; let Haiku judge before we emit an item.
  const judge = options.changeMeaningfulImpl ?? judgeChangeMeaningful;
  // We don't store the previous content, only its hash, so the judge has to
  // work off the new snapshot alone. That's fine: it's pattern-matching
  // "is this a real content update vs. a styling tweak", which the new
  // page text supports on its own.
  const meaningful = await judge("", normalized, src.url);
  if (!meaningful) {
    logger.info(
      {
        sourceId: src.id,
        url: src.url,
        oldHash: src.lastContentHash.slice(0, 12),
        newHash: contentHash.slice(0, 12),
      },
      "webpage: hash changed but Haiku judged it cosmetic; no item emitted",
    );
    return {
      sourceId: src.id,
      competitorId: src.competitorId,
      items: [],
      inferredMode,
      newContentHash: contentHash,
      fetchedAt,
      errored: false,
    };
  }

  // We don't have the previous content body (only its hash), so the "diff"
  // we emit is degenerate: a synthesized patch from empty → new. The
  // classifier reads body for context; the full new snapshot is the most
  // useful payload we can hand it.
  const diff = createPatch(src.url, "", normalized, "previous", fetchedAt.toISOString());

  const item: NormalizedItem = {
    source: "webpage",
    sourceId: `${src.id}:${contentHash.slice(0, 16)}`,
    url: src.url,
    title: `Page updated: ${src.competitorName} — ${urlPath(src.url)}`,
    body: diff,
    publishedAt: fetchedAt,
  };

  return {
    sourceId: src.id,
    competitorId: src.competitorId,
    items: [item],
    inferredMode,
    newContentHash: contentHash,
    fetchedAt,
    errored: false,
  };
}

async function runListExtract(
  src: WebpageSourceRef,
  truncatedMarkdown: string,
  inferredMode: WebpageExtractionMode | null,
  fetchedAt: Date,
  options: WebpageFetchOptions,
): Promise<WebpageFetchResult> {
  const extract = options.extractListImpl ?? extractListItems;
  const extracted = await extract(truncatedMarkdown, src.url);

  // Resolve relative URLs against the source URL, drop duplicates within
  // the batch (Haiku occasionally lists the same post twice in nav + main).
  const seen = new Set<string>();
  const items: NormalizedItem[] = [];
  for (const raw of extracted.slice(0, MAX_LIST_ITEMS)) {
    const resolved = resolveUrl(raw.url, src.url);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    const sourceId = `${src.id}:${sha256Hex(resolved).slice(0, 16)}`;
    items.push({
      source: "webpage",
      sourceId,
      url: resolved,
      title: raw.title.trim().slice(0, 500),
      body: null,
      publishedAt: parseIsoDate(raw.publishedAt),
    });
  }

  return {
    sourceId: src.id,
    competitorId: src.competitorId,
    items,
    inferredMode,
    newContentHash: null,
    fetchedAt,
    errored: false,
  };
}

// --- Haiku calls -----------------------------------------------------------

const INFER_TOOL: Anthropic.Tool = {
  name: "record_extraction_mode",
  description:
    "Record whether this webpage is a single static content page (snapshot_diff) or a listing/index of posts (list_extract).",
  input_schema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["snapshot_diff", "list_extract"],
        description:
          "snapshot_diff = a single product/marketing/docs page whose content evolves in place; list_extract = a blog index, changelog, release-notes index, or feed of dated posts.",
      },
      reason: { type: "string", description: "One short sentence explaining the choice." },
    },
    required: ["mode", "reason"],
  },
};

const INFER_SYSTEM = [
  "You decide how Product Flash should watch a competitor's webpage.",
  "Pick `list_extract` only when the page is clearly a list/index of dated posts (blog index, changelog, release-notes, news feed).",
  "Pick `snapshot_diff` for everything else — product/marketing/docs pages, pricing pages, landing pages — where the meaningful signal is the page text changing in place.",
  "When in doubt, prefer `snapshot_diff`: it's the safer default. We can re-evaluate later if it stays empty.",
  "Always call the record_extraction_mode tool — never reply in prose.",
].join("\n");

async function inferExtractionMode(markdown: string, url: string): Promise<WebpageExtractionMode> {
  const client = getAnthropic();
  const userMessage = [`URL: ${url}`, "", "<page_markdown>", markdown, "</page_markdown>"].join(
    "\n",
  );
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    system: INFER_SYSTEM,
    tools: [INFER_TOOL],
    tool_choice: { type: "tool", name: INFER_TOOL.name },
    messages: [{ role: "user", content: userMessage }],
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!block) {
    throw new Error(`webpage: inferExtractionMode got no tool_use (stop=${response.stop_reason})`);
  }
  const input = block.input as { mode?: unknown };
  if (input.mode !== "snapshot_diff" && input.mode !== "list_extract") {
    throw new Error(
      `webpage: inferExtractionMode returned invalid mode ${JSON.stringify(input.mode)}`,
    );
  }
  return input.mode;
}

const JUDGE_TOOL: Anthropic.Tool = {
  name: "record_change_judgement",
  description:
    "Decide whether the new webpage snapshot represents a meaningful product/content update worth surfacing to a competing PM.",
  input_schema: {
    type: "object",
    properties: {
      meaningful: {
        type: "boolean",
        description:
          "true = real content/product/pricing/positioning update; false = cosmetic re-render (whitespace, timestamps, build hashes, A/B style tweaks, anti-bot tokens).",
      },
      reason: { type: "string", description: "One short sentence explaining the call." },
    },
    required: ["meaningful", "reason"],
  },
};

const JUDGE_SYSTEM = [
  "You guard the cost of Product Flash's competitor watcher.",
  "A competitor webpage's hash changed since last fetch. Decide whether the new snapshot represents a meaningful update or just a cosmetic re-render.",
  "Meaningful: product/feature/pricing/positioning text changed, new sections added, copy materially rewritten.",
  "NOT meaningful: timestamps, build hashes, CSRF/anti-bot tokens, navigation reorder, footer year bump, A/B tweaks of unchanged copy.",
  "When you can't tell because the old content wasn't shown, default to meaningful only if the new snapshot clearly describes a recent product/marketing change. Otherwise default to NOT meaningful.",
  "Always call the record_change_judgement tool — never reply in prose.",
].join("\n");

async function judgeChangeMeaningful(_prev: string, next: string, url: string): Promise<boolean> {
  const client = getAnthropic();
  const userMessage = [`URL: ${url}`, "", "<new_snapshot>", next, "</new_snapshot>"].join("\n");
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 200,
    system: JUDGE_SYSTEM,
    tools: [JUDGE_TOOL],
    tool_choice: { type: "tool", name: JUDGE_TOOL.name },
    messages: [{ role: "user", content: userMessage }],
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!block) {
    throw new Error(
      `webpage: judgeChangeMeaningful got no tool_use (stop=${response.stop_reason})`,
    );
  }
  const input = block.input as { meaningful?: unknown };
  return input.meaningful === true;
}

const EXTRACT_TOOL: Anthropic.Tool = {
  name: "record_list_items",
  description:
    "Record the list of dated posts/items found on this webpage (blog index, changelog, release-notes, news feed).",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        maxItems: MAX_LIST_ITEMS,
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Post title as it appears in the listing.",
            },
            url: {
              type: "string",
              description:
                "URL to the post. Either an absolute URL or a path; relative paths will be resolved against the source URL.",
            },
            publishedAt: {
              type: ["string", "null"],
              description:
                "ISO-8601 timestamp if a date is visible (e.g. '2026-04-15' or '2026-04-15T00:00:00Z'); null when no date is shown.",
            },
          },
          required: ["title", "url", "publishedAt"],
        },
      },
    },
    required: ["items"],
  },
};

const EXTRACT_SYSTEM = [
  "You extract the list of posts shown on a competitor's blog index, changelog, or release-notes page.",
  "Include only items in the main listing — skip navigation, footer links, sidebar 'recent posts' widgets, and 'related posts' rails.",
  "Use titles exactly as shown. If a date is visible next to the item, capture it in ISO format; otherwise set publishedAt to null.",
  "URLs may be absolute or relative — return whatever the page shows; relative paths will be resolved later.",
  "Always call the record_list_items tool — never reply in prose.",
].join("\n");

async function extractListItems(markdown: string, url: string): Promise<ExtractedListItem[]> {
  const client = getAnthropic();
  const userMessage = [`URL: ${url}`, "", "<page_markdown>", markdown, "</page_markdown>"].join(
    "\n",
  );
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 2048,
    system: EXTRACT_SYSTEM,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: "tool", name: EXTRACT_TOOL.name },
    messages: [{ role: "user", content: userMessage }],
  });
  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!block) {
    throw new Error(`webpage: extractListItems got no tool_use (stop=${response.stop_reason})`);
  }
  const input = block.input as { items?: unknown };
  if (!Array.isArray(input.items)) return [];
  const out: ExtractedListItem[] = [];
  for (const raw of input.items) {
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as { title?: unknown; url?: unknown; publishedAt?: unknown };
    if (typeof obj.title !== "string" || typeof obj.url !== "string") continue;
    if (obj.title.trim().length === 0 || obj.url.trim().length === 0) continue;
    const publishedAt =
      typeof obj.publishedAt === "string" && obj.publishedAt.trim().length > 0
        ? obj.publishedAt
        : null;
    out.push({ title: obj.title.trim(), url: obj.url.trim(), publishedAt });
  }
  return out;
}

// --- Firecrawl + helpers ---------------------------------------------------

interface FirecrawlScrapeResponse {
  success?: boolean;
  error?: string;
  data?: {
    markdown?: string | null;
    metadata?: { statusCode?: number; sourceURL?: string; url?: string } | null;
  };
}

async function firecrawlScrape(url: string, options: WebpageFetchOptions): Promise<string> {
  const apiKey = requireEnv("FIRECRAWL_API_KEY");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const res = await fetchImpl(FIRECRAWL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      url,
      formats: [{ type: "markdown" }],
      onlyMainContent: true,
      timeout: timeoutMs,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Firecrawl ${res.status} for ${url}: ${text.slice(0, 300)}`);
  }
  const json = (await res.json()) as FirecrawlScrapeResponse;
  if (!json.success || !json.data) {
    throw new Error(`Firecrawl returned !success for ${url}: ${json.error ?? "unknown"}`);
  }
  const md = json.data.markdown;
  if (!md || md.trim().length === 0) {
    throw new Error(`Firecrawl returned empty markdown for ${url}`);
  }
  return md;
}

// Identical to firecrawl.ts — same volatility strip. Kept duplicated rather
// than shared so the two adapters can evolve independently if their tuning
// diverges (pricing pages strip differently than blog listings).
function normalizeContent(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function urlPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : `${u.hostname}${u.pathname}`;
  } catch {
    return url;
  }
}

function resolveUrl(candidate: string, base: string): string | null {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return null;
  }
}

function parseIsoDate(value: string | null): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}
