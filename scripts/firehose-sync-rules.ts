import { competitors, type Competitor } from "~/db/schema";
import { getDb, getPool } from "~/shared/server/db";
import { requireEnv } from "~/shared/server/env";
import { logger } from "~/shared/server/logger";

// Reconcile Firehose rules with the competitors table.
//
//   pnpm tsx scripts/firehose-sync-rules.ts             # dry-run by default
//   pnpm tsx scripts/firehose-sync-rules.ts --apply     # actually mutate
//
// One rule per competitor. Mapping is carried in Firehose's `tag` field:
// we set tag = competitor.id (UUID). At adapter time, query_id → tag → competitor.
//
// We only touch rules whose tag matches one of our competitor UUIDs OR
// matches the UUID shape of a competitor we used to have. Manual rules
// added in the Firehose UI (tag empty or arbitrary string) are left alone.
//
// Re-run this script whenever competitors change.

const FIREHOSE_BASE = "https://api.firehose.com/v1";
const ORG_RULE_LIMIT = 25;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FirehoseRule {
  id: string;
  value: string;
  tag?: string | null;
  nsfw?: boolean;
  quality?: boolean;
}

interface ListRulesResponse {
  data: FirehoseRule[];
  meta?: { count?: number };
}

interface RuleMutationResponse {
  data: FirehoseRule;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const token = requireEnv("FIREHOSE_TAP_TOKEN");

  const db = getDb();
  const rows = await db.select().from(competitors);
  logger.info({ count: rows.length }, "sync: loaded competitors");

  const targetByTag = new Map<string, string>();
  for (const c of rows) {
    targetByTag.set(c.id, buildLuceneQuery(c));
  }

  const existing = await listRules(token);
  logger.info({ count: existing.length }, "sync: fetched existing rules");

  // Partition existing rules:
  //   - managed: tag is one of our competitor.ids (current OR stale UUID)
  //   - external: no tag, or tag is not a UUID (someone added via UI)
  // We only ever mutate `managed` rules.
  const managed = existing.filter((r) => typeof r.tag === "string" && UUID_RE.test(r.tag));
  const external = existing.filter((r) => !managed.includes(r));

  const existingByTag = new Map<string, FirehoseRule>();
  for (const r of managed) existingByTag.set(r.tag as string, r);

  const toCreate: Array<{ tag: string; value: string }> = [];
  const toUpdate: Array<{ id: string; tag: string; value: string }> = [];
  const toDelete: FirehoseRule[] = [];

  for (const [tag, value] of targetByTag) {
    const found = existingByTag.get(tag);
    if (!found) {
      toCreate.push({ tag, value });
    } else if (found.value !== value) {
      toUpdate.push({ id: found.id, tag, value });
    }
  }

  for (const r of managed) {
    if (!targetByTag.has(r.tag as string)) toDelete.push(r);
  }

  // Pre-flight: if total after sync would exceed the org rule limit, bail.
  const totalAfter = existing.length - toDelete.length + toCreate.length;
  if (totalAfter > ORG_RULE_LIMIT) {
    logger.fatal(
      {
        totalAfter,
        limit: ORG_RULE_LIMIT,
        existing: existing.length,
        external: external.length,
        toCreate: toCreate.length,
        toDelete: toDelete.length,
      },
      `sync: rules-after-sync (${totalAfter}) would exceed Firehose org limit (${ORG_RULE_LIMIT}). ` +
        `Reduce competitor count, remove rules manually added in the Firehose UI (${external.length} external), ` +
        `or ask Firehose support for a limit raise.`,
    );
    process.exit(1);
  }

  logger.info(
    {
      create: toCreate.length,
      update: toUpdate.length,
      delete: toDelete.length,
      external: external.length,
      totalAfter,
      apply,
    },
    apply ? "sync: applying changes" : "sync: DRY RUN (pass --apply to mutate)",
  );

  if (!apply) {
    for (const r of toCreate) logger.info({ tag: r.tag, value: r.value }, "sync: would create");
    for (const r of toUpdate)
      logger.info({ id: r.id, tag: r.tag, value: r.value }, "sync: would update");
    for (const r of toDelete) logger.info({ id: r.id, tag: r.tag }, "sync: would delete");
    return;
  }

  let created = 0;
  let updated = 0;
  let deleted = 0;
  for (const r of toCreate) {
    await createRule(token, r.value, r.tag);
    created++;
  }
  for (const r of toUpdate) {
    await updateRule(token, r.id, r.value, r.tag);
    updated++;
  }
  for (const r of toDelete) {
    await deleteRule(token, r.id);
    deleted++;
  }

  logger.info({ created, updated, deleted, totalAfter, limit: ORG_RULE_LIMIT }, "sync: done");
}

function buildLuceneQuery(c: Competitor): string {
  const phrase = escapeLucenePhrase(c.name);
  const domain = extractDomain(c.homepageUrl);
  // title-phrase OR domain-match — the two strongest signals we can express
  // without a competitor-specific tuning pass. `language:en` keeps the v1
  // signal-to-noise ratio sane; international expansion is a later concern.
  return `(title:"${phrase}" OR domain:${domain}) AND language:en`;
}

function escapeLucenePhrase(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function extractDomain(homepageUrl: string): string {
  const u = new URL(homepageUrl);
  return u.hostname.replace(/^www\./, "");
}

async function listRules(token: string): Promise<FirehoseRule[]> {
  const res = await fetch(`${FIREHOSE_BASE}/rules`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok)
    throw new Error(`GET /rules: HTTP ${res.status} — ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as ListRulesResponse;
  return json.data ?? [];
}

async function createRule(token: string, value: string, tag: string): Promise<FirehoseRule> {
  const res = await fetch(`${FIREHOSE_BASE}/rules`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ value, tag }),
  });
  if (!res.ok)
    throw new Error(`POST /rules: HTTP ${res.status} — ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as RuleMutationResponse;
  logger.info({ id: json.data.id, tag, value }, "sync: created");
  return json.data;
}

async function updateRule(
  token: string,
  id: string,
  value: string,
  tag: string,
): Promise<FirehoseRule> {
  const res = await fetch(`${FIREHOSE_BASE}/rules/${id}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ value, tag }),
  });
  if (!res.ok)
    throw new Error(`PUT /rules/${id}: HTTP ${res.status} — ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as RuleMutationResponse;
  logger.info({ id, tag, value }, "sync: updated");
  return json.data;
}

async function deleteRule(token: string, id: string): Promise<void> {
  const res = await fetch(`${FIREHOSE_BASE}/rules/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(
      `DELETE /rules/${id}: HTTP ${res.status} — ${await res.text().catch(() => "")}`,
    );
  }
  logger.info({ id }, "sync: deleted");
}

main()
  .catch((err) => {
    logger.fatal({ err }, "sync failed");
    process.exit(1);
  })
  .finally(() => getPool().end());
