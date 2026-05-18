import { classifyItem } from "~/features/digest/server/classify";
import { logger } from "~/shared/server/logger";

// End-to-end probe for the Haiku classifier. Calls the live Anthropic API
// with a handful of fixture items spanning the category space — useful for
// eyeballing whether the prompt and rubric produce sensible categories +
// scores before wiring the daily job into a real user's pipeline.
//
//   ANTHROPIC_API_KEY=sk-ant-... pnpm tsx scripts/test-haiku-classify.ts
//
// Exits non-zero if any fixture round-trips with an obviously broken
// classification (parse error, off-axis category, score outside 0-100).

interface Fixture {
  label: string;
  competitorName: string;
  source: string;
  title: string;
  body: string;
  expectedCategoryOneOf: string[];
}

const FIXTURES: Fixture[] = [
  {
    label: "clear launch",
    competitorName: "Linear",
    source: "rss",
    title: "Introducing Linear for Customer Support",
    body: "Today we are launching Linear for Customer Support, a new product that brings customer tickets directly into the same workspace your engineering team already uses. Connect Zendesk, Intercom, or email, route tickets to the right engineer, and resolve issues 4x faster.",
    expectedCategoryOneOf: ["launch"],
  },
  {
    label: "pricing change",
    competitorName: "Vercel",
    source: "firecrawl",
    title: "Pricing page diff",
    body: "Hobby tier remains free. Pro tier increases from $20 to $25 per seat per month effective May 1. Enterprise pricing now starts at $50,000/year (previously $30,000).",
    expectedCategoryOneOf: ["pricing"],
  },
  {
    label: "incremental feature",
    competitorName: "Notion",
    source: "rss",
    title: "Improved table sorting",
    body: "You can now sort columns in tables by multiple keys at once. Hold shift while clicking a column header to add a secondary sort. Works on all plans.",
    expectedCategoryOneOf: ["feature"],
  },
  {
    label: "positioning shift",
    competitorName: "Retool",
    source: "firehose",
    title: "Retool is now an AI agent platform",
    body: "After five years of helping companies build internal tools, we are repositioning Retool as the leading platform for building, deploying, and monitoring AI agents in production. Read the founders' letter explaining why.",
    expectedCategoryOneOf: ["positioning", "launch"],
  },
  {
    label: "noise",
    competitorName: "Figma",
    source: "rss",
    title: "Our 2025 year in review",
    body: "It was an incredible year for the Figma community. Thank you to everyone who shipped, prototyped, and collaborated with us. Here are some highlights from our community.",
    expectedCategoryOneOf: ["noise"],
  },
];

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.fatal("ANTHROPIC_API_KEY is unset — cannot probe Haiku without a key");
    process.exit(1);
  }

  let pass = 0;
  let fail = 0;
  const started = Date.now();

  for (const fx of FIXTURES) {
    try {
      const result = await classifyItem({
        competitorName: fx.competitorName,
        source: fx.source,
        title: fx.title,
        body: fx.body,
        publishedAt: new Date(),
      });

      const categoryMatch = fx.expectedCategoryOneOf.includes(result.category);
      const scoreSane = result.score >= 0 && result.score <= 100;
      const ok = categoryMatch && scoreSane;

      logger.info(
        {
          label: fx.label,
          got: result,
          expectedCategoryOneOf: fx.expectedCategoryOneOf,
          categoryMatch,
          ok,
        },
        ok ? "classify probe: pass" : "classify probe: unexpected classification",
      );
      if (ok) pass++;
      else fail++;
    } catch (err) {
      fail++;
      logger.error({ err, label: fx.label }, "classify probe: threw");
    }
  }

  logger.info(
    { pass, fail, total: FIXTURES.length, durationMs: Date.now() - started },
    "classify probe: summary",
  );
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  logger.fatal({ err }, "classify probe failed at top level");
  process.exit(1);
});
