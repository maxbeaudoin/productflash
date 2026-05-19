import type Anthropic from "@anthropic-ai/sdk";
import { eq, sql } from "drizzle-orm";
import { enqueueDiscovery } from "~/agents/discovery/job";
import {
  competitors as competitorsTable,
  itemScores,
  userCompetitors,
  users as usersTable,
} from "~/db/schema";
import { getBoss } from "~/shared/server/boss";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { autodetectRSSForHomepage } from "~/sources/rss";

// Tool definitions + executors for the FTE agent (#28).
//
// Tools advertised to Sonnet:
//   - fetch_url(url)                      — plain-text extraction (Firecrawl)
//   - discover_rss(homepage_url)          — RSS autodetect (shipped in #5)
//   - add_competitor({...})               — upsert competitors + user_competitors
//   - save_profile({...})                 — write back to users
//
// The server-side web_search tool (web_search_20250305) is wired in agent.ts
// — it's handled by the API, not by us.

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const FETCH_URL_TIMEOUT_MS = 60_000;
const FETCH_URL_MAX_CHARS = 8_000;

export const FTE_TOOLS: Anthropic.Tool[] = [
  {
    name: "fetch_url",
    description:
      "Fetch a single URL and return its main text content as plain markdown (no nav/footer chrome). Use this to read a competitor homepage, blog post, pricing page, or any web page you want to inspect in detail. Output is truncated to ~8,000 characters.",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The fully-qualified URL to fetch (must start with http:// or https://).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "discover_rss",
    description:
      "Given a company homepage URL, attempt to discover its RSS/Atom feed. Tries the homepage's <link rel='alternate'> declarations first, then probes common paths (/feed, /rss, /changelog.rss, …). Returns the absolute feed URL or null if none was found. Use this before add_competitor to populate the rss_url field when possible.",
    input_schema: {
      type: "object",
      properties: {
        homepage_url: {
          type: "string",
          description: "The company homepage URL (e.g. https://linear.app).",
        },
      },
      required: ["homepage_url"],
    },
  },
  {
    name: "add_competitor",
    description:
      "Register a competitor for the current user. Upserts the competitor in the shared competitors table (keyed by homepage_url) and links it to the user. Safe to call multiple times — duplicate entries are ignored. Call once per competitor you identify; do not batch.",
    input_schema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: 'Display name of the competitor (e.g. "Linear", "Mixpanel").',
        },
        homepage_url: {
          type: "string",
          description:
            "Canonical homepage URL of the competitor (e.g. https://linear.app). Lowercase scheme + host; no trailing slash.",
        },
        rss_url: {
          type: "string",
          description: "Optional RSS/Atom feed URL discovered via discover_rss. Omit if unknown.",
        },
      },
      required: ["name", "homepage_url"],
    },
  },
  {
    name: "save_profile",
    description:
      "Persist the user's profile back to the database. Call this exactly once, near the end of the run, after you've identified competitors and have a confident read on the user's role + goals. The run will not flip the user to 'active' status unless this is called at least once.",
    input_schema: {
      type: "object",
      properties: {
        position: {
          type: "string",
          description:
            "The user's job title (e.g. 'Head of Product', 'Senior PM, Growth'). Mirror what they wrote on signup if it was reasonable; otherwise refine.",
        },
        company_name: {
          type: "string",
          description: "Display name of the user's own company, inferred from their company_url.",
        },
        ultimate_goal: {
          type: "string",
          description:
            "One-sentence description of what success looks like for this user (≤ 30 words). Use the user's own words from signup as the anchor; refine for clarity.",
        },
        focus_areas: {
          type: "array",
          items: { type: "string" },
          description:
            "3–6 short tags representing themes the user wants the daily digest to amplify (e.g. 'pricing changes', 'AI features', 'enterprise positioning'). Derived from their goal + role + the competitive landscape you found.",
        },
      },
      required: ["position", "ultimate_goal", "focus_areas"],
    },
  },
];

export const FTE_TOOL_NAMES = FTE_TOOLS.map((t) => t.name);

export interface ToolContext {
  userId: string;
  runId: string;
}

export interface ToolExecutionResult {
  // Plain-text payload Sonnet receives as tool_result content. Errors are
  // reported in-band by setting `isError: true` — never thrown — so the
  // agent can react and try a different approach.
  content: string;
  isError: boolean;
  // Structured payload mirrored into fte_events so the frontend (#29) can
  // render a richer view than just the text Sonnet saw.
  payload: Record<string, unknown>;
}

export async function executeTool(
  ctx: ToolContext,
  name: string,
  input: unknown,
): Promise<ToolExecutionResult> {
  switch (name) {
    case "fetch_url":
      return runFetchUrl(ctx, input);
    case "discover_rss":
      return runDiscoverRss(ctx, input);
    case "add_competitor":
      return runAddCompetitor(ctx, input);
    case "save_profile":
      return runSaveProfile(ctx, input);
    default:
      return {
        content: `Unknown tool: ${name}`,
        isError: true,
        payload: { name },
      };
  }
}

// --- fetch_url ---------------------------------------------------------

async function runFetchUrl(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
  const url = pickString(input, "url");
  if (!url) {
    return errorResult("fetch_url requires a url string", { input });
  }
  if (!/^https?:\/\//i.test(url)) {
    return errorResult("fetch_url requires a fully-qualified http(s) URL", { url });
  }

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return errorResult("FIRECRAWL_API_KEY not configured", { url });
  }

  try {
    // The outbound target is the fixed Firecrawl SaaS endpoint, not
    // user-controlled — safeFetch is unnecessary at this hop. The
    // model-supplied `url` rides in the body; Firecrawl runs externally
    // and applies its own SSRF protections to that payload.
    const res = await fetch(FIRECRAWL_ENDPOINT, {
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
        timeout: FETCH_URL_TIMEOUT_MS,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return errorResult(`fetch_url HTTP ${res.status}`, {
        url,
        status: res.status,
        body: body.slice(0, 300),
      });
    }
    const json = (await res.json()) as {
      success?: boolean;
      data?: { markdown?: string | null };
      error?: string;
    };
    if (!json.success || !json.data) {
      return errorResult(`fetch_url failed: ${json.error ?? "unknown"}`, { url });
    }
    const md = (json.data.markdown ?? "").trim();
    if (md.length === 0) {
      return errorResult("fetch_url returned empty content", { url });
    }
    const truncated = md.length > FETCH_URL_MAX_CHARS;
    const content = truncated ? `${md.slice(0, FETCH_URL_MAX_CHARS)}…` : md;
    return {
      content,
      isError: false,
      payload: { url, bytes: md.length, truncated },
    };
  } catch (err) {
    return errorResult(`fetch_url threw: ${describeError(err)}`, { url });
  }
}

// --- discover_rss ------------------------------------------------------

async function runDiscoverRss(_ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
  const homepageUrl = pickString(input, "homepage_url");
  if (!homepageUrl) {
    return errorResult("discover_rss requires a homepage_url string", { input });
  }
  if (!/^https?:\/\//i.test(homepageUrl)) {
    return errorResult("discover_rss requires a fully-qualified http(s) URL", {
      homepage_url: homepageUrl,
    });
  }

  try {
    const feedUrl = await autodetectRSSForHomepage(homepageUrl);
    if (!feedUrl) {
      return {
        content: `No RSS/Atom feed found for ${homepageUrl}.`,
        isError: false,
        payload: { homepage_url: homepageUrl, feed_url: null },
      };
    }
    return {
      content: `Discovered feed: ${feedUrl}`,
      isError: false,
      payload: { homepage_url: homepageUrl, feed_url: feedUrl },
    };
  } catch (err) {
    return errorResult(`discover_rss threw: ${describeError(err)}`, { homepageUrl });
  }
}

// --- add_competitor ----------------------------------------------------

async function runAddCompetitor(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
  const name = pickString(input, "name");
  const homepageUrl = pickString(input, "homepage_url");
  const rssUrlRaw = pickString(input, "rss_url");
  const rssUrl = rssUrlRaw === "" ? null : rssUrlRaw;

  if (!name || !homepageUrl) {
    return errorResult("add_competitor requires name and homepage_url", { input });
  }
  if (!/^https?:\/\//i.test(homepageUrl)) {
    return errorResult("add_competitor: homepage_url must be http(s)", { homepageUrl });
  }
  if (rssUrl && !/^https?:\/\//i.test(rssUrl)) {
    return errorResult("add_competitor: rss_url must be http(s)", { rssUrl });
  }

  const db = getDb();

  try {
    // Upsert competitor on (homepage_url unique). Update name + rss_url only
    // when the new caller provided a non-null value — letting earlier writes
    // win for missing fields would mean a later good name overrides an
    // earlier "Co." style placeholder.
    //
    // `xmax = 0` on the returned row is the Postgres signal for "this row
    // was inserted, not updated" — we use it to fire source-discovery
    // (PF-93 phase 5) exactly once per shared competitor row across all
    // users + agents that touch it.
    const competitor = await db
      .insert(competitorsTable)
      .values({
        name,
        homepageUrl,
        rssUrl: rssUrl ?? null,
      })
      .onConflictDoUpdate({
        target: competitorsTable.homepageUrl,
        set: {
          name: sql`excluded.name`,
          rssUrl: sql`coalesce(excluded.rss_url, ${competitorsTable.rssUrl})`,
        },
      })
      .returning({
        id: competitorsTable.id,
        name: competitorsTable.name,
        homepageUrl: competitorsTable.homepageUrl,
        rssUrl: competitorsTable.rssUrl,
        wasInserted: sql<boolean>`(xmax = 0)`.as("was_inserted"),
      });

    const c = competitor[0];
    if (!c) {
      return errorResult("add_competitor: upsert returned no row", { name, homepageUrl });
    }

    await db
      .insert(userCompetitors)
      .values({ userId: ctx.userId, competitorId: c.id })
      .onConflictDoNothing();

    if (c.wasInserted) {
      try {
        const boss = await getBoss();
        const { runId, enqueued } = await enqueueDiscovery(boss, c.id);
        logger.info(
          { competitorId: c.id, name: c.name, runId, enqueued, userId: ctx.userId },
          "fte add_competitor: discovery enqueued",
        );
      } catch (err) {
        // Don't fail the tool call if enqueue fails — the competitor row
        // is already persisted, FTE can continue, admin can re-trigger.
        logger.error(
          { err, competitorId: c.id, name: c.name },
          "fte add_competitor: discovery enqueue failed",
        );
      }
    }

    return {
      content: `Added ${c.name} (${c.homepageUrl})${c.rssUrl ? ` rss=${c.rssUrl}` : ""}.`,
      isError: false,
      payload: {
        competitor_id: c.id,
        name: c.name,
        homepage_url: c.homepageUrl,
        rss_url: c.rssUrl,
      },
    };
  } catch (err) {
    return errorResult(`add_competitor threw: ${describeError(err)}`, {
      name,
      homepageUrl,
    });
  }
}

// --- save_profile ------------------------------------------------------

async function runSaveProfile(ctx: ToolContext, input: unknown): Promise<ToolExecutionResult> {
  const position = pickString(input, "position");
  const companyName = pickString(input, "company_name");
  const ultimateGoal = pickString(input, "ultimate_goal");
  const focusAreas = pickStringArray(input, "focus_areas");

  if (!position || !ultimateGoal || focusAreas.length === 0) {
    return errorResult(
      "save_profile requires position, ultimate_goal, and a non-empty focus_areas[]",
      { input },
    );
  }

  const db = getDb();

  try {
    const updated = await db
      .update(usersTable)
      .set({
        position,
        companyName: companyName || null,
        ultimateGoal,
        focusAreas,
        updatedAt: new Date(),
      })
      .where(eq(usersTable.id, ctx.userId))
      .returning({ id: usersTable.id });

    if (updated.length === 0) {
      return errorResult("save_profile: user not found", { userId: ctx.userId });
    }

    // Profile fields are baked into Haiku scoring (#35). Drop any stale
    // cache from earlier runs so the next score pass re-classifies under
    // the new context — relevant for FTE re-runs from admin (#16).
    await db.delete(itemScores).where(eq(itemScores.userId, ctx.userId));

    return {
      content: `Profile saved. Position=${position}; focus_areas=${focusAreas.join(", ")}.`,
      isError: false,
      payload: {
        position,
        company_name: companyName || null,
        ultimate_goal: ultimateGoal,
        focus_areas: focusAreas,
      },
    };
  } catch (err) {
    return errorResult(`save_profile threw: ${describeError(err)}`, { userId: ctx.userId });
  }
}

// Look up whether save_profile was called during this run — drives the
// status flip in agent.ts. Distinct from in-memory tracking so we survive
// partial state restores in the future.
export async function hasUserCompetitor(userId: string): Promise<boolean> {
  return (await countUserCompetitors(userId)) > 0;
}

export async function countUserCompetitors(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userCompetitors)
    .where(eq(userCompetitors.userId, userId));
  return row?.count ?? 0;
}

export async function isProfileSaved(userId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({
      hasPosition: usersTable.position,
      hasGoal: usersTable.ultimateGoal,
      hasFocus: usersTable.focusAreas,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!row) return false;
  return !!(row.hasPosition && row.hasGoal && row.hasFocus && row.hasFocus.length > 0);
}

// --- helpers -----------------------------------------------------------

function pickString(input: unknown, key: string): string {
  if (!input || typeof input !== "object") return "";
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v.trim() : "";
}

function pickStringArray(input: unknown, key: string): string[] {
  if (!input || typeof input !== "object") return [];
  const v = (input as Record<string, unknown>)[key];
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
}

function errorResult(message: string, payload: Record<string, unknown>): ToolExecutionResult {
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
