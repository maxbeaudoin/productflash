// OTEL bootstrap must come first — see src/shared/server/otel.ts (PF-103).
import "~/shared/server/otel";

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { runDiscoveryAgent, type DiscoveryEvent } from "~/agents/discovery/agent";
import { competitors as competitorsTable, competitorSources } from "~/db/schema";
import { getDb, getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { shutdownOtel } from "~/shared/server/otel";
import { withSpan } from "~/shared/server/tracer";

// Manual trigger for the source-discovery agent (PF-95 / PF-93 phase 2).
// Bypasses pg-boss so we can iterate on the agent loop before phase 5 wires it
// up. Mirrors scripts/run-fte.ts style — print transcript to stdout, exit
// non-zero on hard failure.
//
// Usage:
//   pnpm tsx scripts/run-discovery.ts --competitor-id <uuid>
//   pnpm tsx scripts/run-discovery.ts --name "Smallpdf" --homepage https://smallpdf.com

const HELP = `
discovery: per-competitor source-discovery agent

Usage:
  pnpm discovery:run --competitor-id <uuid>
  pnpm discovery:run --name "Smallpdf" --homepage https://smallpdf.com

Either pass an existing competitor's id, or pass --name + --homepage. With
--name + --homepage, the competitor is upserted on homepage_url (idempotent).
`;

interface ResolvedCompetitor {
  id: string;
  name: string;
  homepageUrl: string;
}

async function resolveCompetitor(args: {
  competitorId?: string;
  name?: string;
  homepage?: string;
}): Promise<ResolvedCompetitor> {
  const db = getDb();

  if (args.competitorId) {
    const [row] = await db
      .select({
        id: competitorsTable.id,
        name: competitorsTable.name,
        homepageUrl: competitorsTable.homepageUrl,
      })
      .from(competitorsTable)
      .where(eq(competitorsTable.id, args.competitorId));
    if (!row) throw new Error(`No competitor with id=${args.competitorId}`);
    return row;
  }

  if (!args.name || !args.homepage) {
    throw new Error("must pass --competitor-id, or both --name and --homepage");
  }
  if (!/^https?:\/\//i.test(args.homepage)) {
    throw new Error("--homepage must be a fully-qualified http(s) URL");
  }

  // Upsert by homepage_url unique. Update name only — never trample rss_url
  // (it's preserved by phase-1 migration until phase-4 watcher refactor).
  const [row] = await db
    .insert(competitorsTable)
    .values({ name: args.name, homepageUrl: args.homepage })
    .onConflictDoUpdate({
      target: competitorsTable.homepageUrl,
      set: { name: sql`excluded.name` },
    })
    .returning({
      id: competitorsTable.id,
      name: competitorsTable.name,
      homepageUrl: competitorsTable.homepageUrl,
    });
  if (!row) throw new Error("competitor upsert returned no row");
  return row;
}

function renderEvent(ev: DiscoveryEvent): string {
  switch (ev.kind) {
    case "run_started":
      return `▶ discovery: ${ev.input.competitorName} (${ev.input.homepageUrl})`;
    case "iteration":
      return `  · iteration ${ev.n}`;
    case "planner_text":
      return `  💭 ${ev.text}`;
    case "tool_use":
      return `  🔧 ${ev.name} ${JSON.stringify(ev.input)}`;
    case "tool_result": {
      const marker = ev.isError ? "✖" : "✓";
      return `  ${marker} ${ev.name} → ${JSON.stringify(ev.payload)}`;
    }
    case "server_tool_use":
      return `  🌐 ${ev.name} ${JSON.stringify(ev.input)}`;
    case "server_tool_result":
      return `  🌐 ${ev.summary.count} results · ${ev.summary.urls.slice(0, 3).join(" ")}`;
    case "error":
      return `  ‼ error: ${ev.message}`;
    case "run_finished":
      return `■ finished (${ev.result.finishedReason}) — ${ev.result.sourcesRecorded} new source(s), ${ev.result.clientToolCalls} client tool calls, ${ev.result.serverToolCalls} server tool calls`;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "competitor-id": { type: "string" },
      name: { type: "string" },
      homepage: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help || positionals.length > 0) {
    console.log(HELP.trim());
    process.exit(values.help ? 0 : 1);
  }

  const competitor = await resolveCompetitor({
    competitorId: values["competitor-id"],
    name: values.name,
    homepage: values.homepage,
  });

  const runId = randomUUID();
  console.log(`discovery run ${runId} — ${competitor.name} (${competitor.homepageUrl})`);

  const result = await withSpan(
    "discovery-run",
    () =>
      runDiscoveryAgent(
        {
          competitorId: competitor.id,
          competitorName: competitor.name,
          homepageUrl: competitor.homepageUrl,
          runId,
        },
        (ev) => console.log(renderEvent(ev)),
      ),
    {
      "trigger.source": "manual",
      "discovery.competitor_id": competitor.id,
      "discovery.competitor_name": competitor.name,
      "discovery.run_id": runId,
    },
  );

  // Read back what's now in competitor_sources so the operator can see the
  // post-state at a glance.
  const rows = await getDb()
    .select({
      id: competitorSources.id,
      sourceType: competitorSources.sourceType,
      urlOrHandle: competitorSources.urlOrHandle,
      status: competitorSources.status,
      agentRationale: competitorSources.agentRationale,
    })
    .from(competitorSources)
    .where(eq(competitorSources.competitorId, competitor.id));

  console.log(`\ncompetitor_sources for ${competitor.name}:`);
  if (rows.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of rows) {
      console.log(
        `  [${r.sourceType}] ${r.urlOrHandle} · ${r.status} · ${r.agentRationale ?? "—"}`,
      );
    }
  }

  if (
    result.finishedReason === "error" ||
    (result.sourcesRecorded === 0 && result.finishedReason === "max_tool_calls")
  ) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    logger.fatal({ err }, "discovery run failed");
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownOtel();
    await getPool().end();
  });
