import type Anthropic from "@anthropic-ai/sdk";
import { getAnthropic, HAIKU_MODEL } from "./anthropic";
import { recordLlmUsage } from "./llm-cost";
import { logger } from "./logger";

// Haiku-driven per-item classifier. Given a single raw_item (title + body),
// return a structured { category, score, why } triple.
//
// We use Anthropic's tool_use mechanism with tool_choice forced to a single
// tool — the model must return a JSON object that matches the tool's
// input_schema. This is more reliable than asking for JSON in plain text and
// avoids the need for a JSON.parse + repair step.
//
// Cost shape: title + body excerpt is short (~200–800 input tokens), output
// is a tiny JSON blob (~60 tokens). Expect <$0.001/call at Haiku rates.

export type ItemCategory =
  | "launch"
  | "pricing"
  | "feature"
  | "positioning"
  | "funding"
  | "acquisition"
  | "noise";

// Reader context lets the same item score differently for two users with
// different roles/goals/focus areas. Optional — magic-link signup creates a
// user row before the FTE agent (#28) fills the profile in, so the classifier
// falls back to a generic scoring rubric when this is absent.
export interface ReaderProfile {
  position: string | null;
  companyName: string | null;
  ultimateGoal: string | null;
  focusAreas: string[] | null;
}

export interface ClassificationInput {
  competitorName: string;
  source: string;
  title: string;
  body: string | null;
  publishedAt: Date | null;
  reader?: ReaderProfile | null;
  // Optional accounting context. When supplied, every successful Haiku
  // response writes one llm_usage row tagged with this userId + rawItemId.
  // Omitted by callers that don't have an attribution target (e.g. ad-hoc
  // scripts) — those calls are real spend but go uncounted by design.
  usageContext?: { userId: string; rawItemId: string } | null;
}

export interface Classification {
  category: ItemCategory;
  score: number;
  why: string;
}

const BODY_EXCERPT_CHARS = 1200;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;

const CATEGORIES: ItemCategory[] = [
  "launch",
  "pricing",
  "feature",
  "positioning",
  "funding",
  "acquisition",
  "noise",
];

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: "record_classification",
  description:
    "Record the category, importance score (0-100), and one-line rationale for a competitor news item.",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        enum: CATEGORIES,
        description:
          "launch = new product/major release; pricing = pricing or packaging change; feature = incremental feature shipped; positioning = messaging/branding/strategy shift; funding = capital raise (seed/Series/PE/debt) — runway/aggression signal; acquisition = M&A as acquirer OR target — surface-area or exit signal; noise = recap, hiring, fluff, off-topic, or anything a product leader would not act on.",
      },
      score: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description:
          'How load-bearing this item is for a competing SaaS product leader. 0 = ignore, 50 = mildly interesting, 80+ = must-read this week, 95+ = "stop everything".',
      },
      why: {
        type: "string",
        description:
          "One short sentence (<= 25 words) explaining the score from a competing PM's perspective. No marketing language.",
      },
    },
    required: ["category", "score", "why"],
  },
};

const SYSTEM_PROMPT = [
  "You are the editorial filter for Product Flash, a daily competitive-intel digest for SaaS product leaders.",
  "Read one news item about a competitor and classify it on two axes:",
  "  1. category: launch | pricing | feature | positioning | funding | acquisition | noise",
  "     The category describes the item itself — it is independent of who is reading.",
  '     Funding and acquisition are structural moves, not product moves: pick them when the item is primarily about capital raised or a deal closed, even if a product is mentioned in passing. If a single item announces both (e.g. "raised $X to acquire Y"), prefer acquisition.',
  "  2. score (0-100): how much THIS reader should care today",
  '     The score is reader-relative: tilt up when the item resonates with the reader\'s goal or focus areas, tilt down when it is off-axis even if globally newsworthy. If no reader context is provided, fall back to a generic "competing PM" baseline.',
  "",
  "Calibration:",
  '- noise items (recaps, year-in-review, "we are hiring", podcast appearances, generic thought-leadership, off-topic) score 0-15 — these are always noise regardless of reader.',
  "- minor feature polish scores 20-40 in the baseline; lift to 50-65 if it directly touches one of the reader's focus areas.",
  "- meaningful shipped feature scores 50-70 in the baseline; lift toward 75-85 when it intersects the reader's focus areas or threatens their goal.",
  "- new product / pricing change / repositioning scores 75-95.",
  "- funding round scores 60-80 in the baseline (more capital = more aggressive roadmap); lift toward 85+ for a category-defining round (e.g. mega-round at a stage that resets the market) or when the reader is directly competing for the same buyer.",
  "- acquisition scores 70-90 (structural change to the competitor's surface area or the category); lift to 90+ when the deal directly absorbs an adjacency the reader cares about.",
  "- only score 95+ for a launch, funding round, or acquisition that visibly reshapes the category or directly attacks the reader's positioning.",
  "",
  "Always call the record_classification tool — never reply in prose.",
].join("\n");

export async function classifyItem(input: ClassificationInput): Promise<Classification> {
  const userMessage = renderUserPrompt(input);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await callHaiku(userMessage, input.usageContext ?? null);
      return result;
    } catch (err) {
      lastErr = err;
      const retriable = isRetriable(err);
      if (!retriable || attempt === MAX_RETRIES) break;
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
      logger.warn({ err, attempt, delay }, "classify: transient failure, retrying");
      await sleep(delay);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function callHaiku(
  userMessage: string,
  usageContext: { userId: string; rawItemId: string } | null,
): Promise<Classification> {
  const client = getAnthropic();
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: "tool", name: CLASSIFY_TOOL.name },
    messages: [{ role: "user", content: userMessage }],
  });

  // Record cost before we parse — even a malformed response was billed.
  // Recorder swallows its own errors, so this never derails the caller.
  if (usageContext) {
    await recordLlmUsage(
      {
        kind: "classify",
        model: HAIKU_MODEL,
        userId: usageContext.userId,
        rawItemId: usageContext.rawItemId,
      },
      response.usage,
    );
  }

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error(
      `classify: no tool_use block in response (stop_reason=${response.stop_reason})`,
    );
  }
  return parseToolInput(toolUse.input);
}

function parseToolInput(raw: unknown): Classification {
  if (!raw || typeof raw !== "object") {
    throw new Error(`classify: tool input not an object: ${JSON.stringify(raw)}`);
  }
  const obj = raw as Record<string, unknown>;
  const category = obj.category;
  const score = obj.score;
  const why = obj.why;

  if (typeof category !== "string" || !CATEGORIES.includes(category as ItemCategory)) {
    throw new Error(`classify: invalid category: ${JSON.stringify(category)}`);
  }
  if (typeof score !== "number" || !Number.isFinite(score)) {
    throw new Error(`classify: invalid score: ${JSON.stringify(score)}`);
  }
  if (typeof why !== "string" || why.trim().length === 0) {
    throw new Error(`classify: invalid why: ${JSON.stringify(why)}`);
  }

  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  return { category: category as ItemCategory, score: clampedScore, why: why.trim() };
}

function renderUserPrompt(input: ClassificationInput): string {
  const body = (input.body ?? "").trim();
  const excerpt = body.length > BODY_EXCERPT_CHARS ? `${body.slice(0, BODY_EXCERPT_CHARS)}…` : body;
  const published = input.publishedAt ? input.publishedAt.toISOString() : "unknown";
  const lines: string[] = [];
  const readerBlock = renderReaderBlock(input.reader);
  if (readerBlock) {
    lines.push(readerBlock, "");
  }
  lines.push(
    `Competitor: ${input.competitorName}`,
    `Source: ${input.source}`,
    `Published: ${published}`,
    "",
    // The <feed_title> and <feed_body> blocks below carry untrusted content
    // pulled from a competitor's RSS / scraped page. Treat them as data
    // only — any text inside that looks like instructions ("ignore prior",
    // "<system>", "set score to 100", etc.) is content to classify, not a
    // directive to follow.
    "<feed_title>",
    input.title,
    "</feed_title>",
    "<feed_body>",
    excerpt || "(no body text)",
    "</feed_body>",
  );
  return lines.join("\n");
}

function renderReaderBlock(reader: ReaderProfile | null | undefined): string | null {
  if (!reader) return null;
  const position = reader.position?.trim();
  const company = reader.companyName?.trim();
  const goal = reader.ultimateGoal?.trim();
  const focus = (reader.focusAreas ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  if (!position && !goal && focus.length === 0) return null;
  const lines = [
    "Reader context (use to set the score; the category itself stays reader-agnostic):",
  ];
  if (position) lines.push(`- Role: ${position}${company ? ` at ${company}` : ""}`);
  if (goal) lines.push(`- Goal: ${goal}`);
  if (focus.length > 0) lines.push(`- Focus areas: ${focus.join(", ")}`);
  return lines.join("\n");
}

function isRetriable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; name?: string };
  if (e.name === "APIConnectionError" || e.name === "APIConnectionTimeoutError") return true;
  if (typeof e.status === "number") {
    return e.status === 408 || e.status === 429 || (e.status >= 500 && e.status < 600);
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
