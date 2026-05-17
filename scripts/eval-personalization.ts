import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { synthesizeDigest, type SynthesisInputItem } from "~/lib/synthesize";
import { classifyItem } from "~/lib/classify";
import { logger } from "~/lib/logger";
import { shutdownPosthog } from "~/lib/posthog";

// Eval evidence for #35.
//
// Calls Haiku (classify) + Sonnet (synthesize) twice against the same fixture
// items: once with no reader profile (the "generic" baseline that shipped
// before #35), once with a personalized reader. Snapshots both runs to
// /tmp/eval-generic-<userId>.md and /tmp/eval-personalized-<userId>.md so
// the diff is eyeball-able. Not a passing/failing test — proof that the
// prompts actually move under reader context.
//
//   ANTHROPIC_API_KEY=sk-ant-... pnpm tsx scripts/eval-personalization.ts

const USER_SLUG = "fte-iso-b";

const READER = {
  position: "Head of Product",
  companyName: "Linear",
  ultimateGoal:
    "Defend Linear's enterprise positioning against Notion and Asana while shipping AI-native workflows",
  focusAreas: ["enterprise pricing", "AI features", "positioning shifts"],
};

const ITEMS: Array<Omit<SynthesisInputItem, "category" | "score" | "why">> = [
  {
    rawItemId: "11111111-1111-1111-1111-111111111111",
    competitorName: "Notion",
    source: "rss",
    url: "https://www.notion.so/blog/notion-ai-agents",
    title: "Notion launches AI agents for cross-doc workflows",
    body: "Notion is launching AI agents that can read across docs, databases, and projects to draft project briefs, summarize meeting notes, and update task statuses on the user's behalf. Available on Business and Enterprise plans; Enterprise gets a higher monthly token allowance and admin controls over which workspaces agents can access.",
    publishedAt: new Date(),
  },
  {
    rawItemId: "22222222-2222-2222-2222-222222222222",
    competitorName: "Asana",
    source: "firecrawl",
    url: "https://asana.com/pricing",
    title: "Pricing diff: Enterprise+ tier introduced at $35/user/month",
    body: "Asana introduced a new Enterprise+ tier at $35 per user per month. Adds AI-powered portfolio reporting, custom data residency (EU/US), and dedicated success management. Existing Enterprise tier remains at $24.99 with reduced AI quota.",
    publishedAt: new Date(),
  },
  {
    rawItemId: "33333333-3333-3333-3333-333333333333",
    competitorName: "ClickUp",
    source: "rss",
    url: "https://clickup.com/blog/2026-recap",
    title: "ClickUp: 2026 community recap",
    body: "It was an incredible year for the ClickUp community. Thanks to everyone who built, shipped, and templated with us. Here are some of the moments we loved most.",
    publishedAt: new Date(),
  },
];

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.fatal("ANTHROPIC_API_KEY is unset — cannot run eval without a key");
    process.exit(1);
  }

  logger.info("eval: classifying items twice (generic + personalized)");
  const genericClassified: SynthesisInputItem[] = [];
  const personalizedClassified: SynthesisInputItem[] = [];

  for (const item of ITEMS) {
    const generic = await classifyItem({
      competitorName: item.competitorName,
      source: item.source,
      title: item.title,
      body: item.body,
      publishedAt: item.publishedAt,
    });
    const personalized = await classifyItem({
      competitorName: item.competitorName,
      source: item.source,
      title: item.title,
      body: item.body,
      publishedAt: item.publishedAt,
      reader: READER,
    });

    if (generic.category !== "noise") {
      genericClassified.push({
        ...item,
        category: generic.category,
        score: generic.score,
        why: generic.why,
      });
    }
    if (personalized.category !== "noise") {
      personalizedClassified.push({
        ...item,
        category: personalized.category,
        score: personalized.score,
        why: personalized.why,
      });
    }

    logger.info(
      {
        title: item.title,
        generic,
        personalized,
        scoreDelta: personalized.score - generic.score,
      },
      "eval: classify result",
    );
  }

  logger.info("eval: synthesizing twice");
  const { items: genericOutput } = await synthesizeDigest({
    userName: USER_SLUG,
    items: genericClassified,
  });
  const { items: personalizedOutput } = await synthesizeDigest({
    userName: USER_SLUG,
    reader: READER,
    items: personalizedClassified,
  });

  const genericPath = `/tmp/eval-generic-${USER_SLUG}.md`;
  const personalizedPath = `/tmp/eval-personalized-${USER_SLUG}.md`;
  await writeSnapshot(genericPath, "Generic (no reader)", genericClassified, genericOutput);
  await writeSnapshot(
    personalizedPath,
    "Personalized (reader: Head of Product @ Linear)",
    personalizedClassified,
    personalizedOutput,
    READER,
  );

  logger.info(
    { genericPath, personalizedPath },
    "eval: snapshots written — diff and eyeball impactNote",
  );
}

async function writeSnapshot(
  path: string,
  label: string,
  items: SynthesisInputItem[],
  output: Array<{ rawItemId: string; headline: string; snippet: string; impactNote: string }>,
  reader?: typeof READER,
): Promise<void> {
  const lines: string[] = [];
  lines.push(`# ${label}`);
  lines.push("");
  if (reader) {
    lines.push("## Reader profile");
    lines.push("");
    lines.push(`- Role: ${reader.position} at ${reader.companyName}`);
    lines.push(`- Goal: ${reader.ultimateGoal}`);
    lines.push(`- Focus areas: ${reader.focusAreas.join(", ")}`);
    lines.push("");
  }
  lines.push("## Digest");
  lines.push("");
  const byId = new Map(items.map((i) => [i.rawItemId, i]));
  for (const s of output) {
    const meta = byId.get(s.rawItemId);
    if (!meta) continue;
    lines.push(`### ${meta.competitorName} · ${meta.category} (score ${meta.score})`);
    lines.push(`**${s.headline}**`);
    lines.push("");
    lines.push(s.snippet);
    lines.push("");
    lines.push(`> ${s.impactNote}`);
    lines.push("");
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join("\n"), "utf8");
}

main()
  .catch((err) => {
    logger.fatal({ err }, "eval failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownPosthog();
  });
