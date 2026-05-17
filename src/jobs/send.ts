import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render } from "@react-email/components";
import { eq, sql } from "drizzle-orm";
import { Resend } from "resend";
import { digests, users as usersTable } from "~/db/schema";
import { DigestEmail } from "~/emails/DigestEmail";
import { loadDigestForEmail } from "~/emails/build-email-props";
import { getDb } from "~/lib/db";
import { env, requireEnv } from "~/lib/env";
import { logger } from "~/lib/logger";
import { captureServerEvent } from "~/lib/posthog";

// Read the brand-mark PNG once at module load. Attached to every digest send
// as a CID inline image — Gmail/Apple Mail/Outlook all fetch from the email's
// own MIME parts (no public URL required), so this works identically in dev
// and prod. Regenerate with `pnpm tsx scripts/gen-brand-mark.ts`.
const BRAND_MARK_PNG = readBrandMarkPng();
const BRAND_MARK_CID = "brand-mark";

function readBrandMarkPng(): Buffer {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/jobs → src/emails/assets
  return readFileSync(join(here, "..", "emails", "assets", "brand-mark.png"));
}

// Daily-digest send pipeline.
//
// The cron path that fans out per-TZ ships with #17. For now this module
// exposes:
//   - SEND_QUEUE for pg-boss (one job per digest, singleton on digestId so a
//     replay never sends twice).
//   - runSendForDigest(digestId): the job handler. Idempotent — bails if
//     digests.sent_at is already set, or if the user is not 'active'.
//   - runSendForUnsent(): manual entry point used by `pnpm send:run`. Finds
//     every unsent digest for an active user and runs them inline. No
//     queueing — keeps the dev workflow synchronous and observable.

export const SEND_QUEUE = "send-run";

let _resend: Resend | undefined;
function getResend(): Resend {
  if (!_resend) _resend = new Resend(requireEnv("RESEND_API_KEY"));
  return _resend;
}

export interface SendOptions {
  // When true, skip the actual Resend call and just render. Useful for
  // smoke-testing the loader + template wiring without burning send quota.
  // Default: false.
  dryRun?: boolean;
  // When true, send even if digests.sent_at is already set. Used by manual
  // re-send workflows. Default: false.
  force?: boolean;
}

export interface SendResult {
  digestId: string;
  status:
    | "sent"
    | "skipped-already-sent"
    | "skipped-inactive"
    | "skipped-empty"
    | "dry-run"
    | "failed-no-resend-key";
  email?: string;
  resendId?: string;
  itemCount?: number;
}

export async function runSendForDigest(
  digestId: string,
  options: SendOptions = {},
): Promise<SendResult> {
  const db = getDb();
  const loaded = await loadDigestForEmail(digestId);
  if (!loaded) {
    throw new Error(`send: digest ${digestId} not found`);
  }

  if (loaded.sentAt && !options.force) {
    logger.info(
      { digestId, sentAt: loaded.sentAt.toISOString(), email: loaded.email },
      "send: digest already sent — skipping (force=false)",
    );
    return { digestId, status: "skipped-already-sent", email: loaded.email };
  }

  if (loaded.status !== "active") {
    logger.info(
      { digestId, userStatus: loaded.status, email: loaded.email },
      "send: user not active — skipping",
    );
    return { digestId, status: "skipped-inactive", email: loaded.email };
  }

  // Empty digests intentionally still send — the "nothing notable" template
  // is part of the product promise (SCOPE.md §9). The skip-empty branch is
  // here so a future override can opt out for a quieter beta.
  // For now we let zero-item digests flow through.

  const html = await render(DigestEmail(loaded.props));
  const text = await render(DigestEmail(loaded.props), { plainText: true });

  if (options.dryRun) {
    logger.info({ digestId, email: loaded.email, htmlBytes: html.length }, "send: dry-run");
    return { digestId, status: "dry-run", email: loaded.email, itemCount: loaded.itemCount };
  }

  // Without a Resend key we treat it as a soft failure rather than throwing —
  // dev environments often run the worker without one, and we'd rather log +
  // continue than crash the queue. The send is NOT recorded as sent_at, so a
  // later run with a key set will retry naturally.
  if (!env.RESEND_API_KEY) {
    logger.warn(
      { digestId, email: loaded.email },
      "send: RESEND_API_KEY unset — skipping send (digest stays unsent)",
    );
    return { digestId, status: "failed-no-resend-key", email: loaded.email };
  }

  const { data, error } = await getResend().emails.send({
    from: env.RESEND_FROM,
    to: loaded.email,
    subject: loaded.subject,
    html,
    text,
    // Surface the digest_id on the email's metadata so Resend webhooks
    // (later: opens, clicks, bounces) can correlate back without parsing
    // URLs. Custom headers are pass-through in Resend's API.
    headers: { "X-PF-Digest-ID": digestId },
    tags: [
      { name: "kind", value: "digest" },
      { name: "digest_id", value: digestId },
    ],
    attachments: [
      {
        filename: "brand-mark.png",
        content: BRAND_MARK_PNG,
        contentType: "image/png",
        inlineContentId: BRAND_MARK_CID,
      },
    ],
  });

  if (error) {
    logger.error(
      { digestId, email: loaded.email, err: error },
      "send: Resend rejected — digest stays unsent for retry",
    );
    throw new Error(`Resend send failed: ${error.message}`);
  }

  await db
    .update(digests)
    .set({ sentAt: sql`now()` })
    .where(eq(digests.id, digestId));

  captureServerEvent(loaded.userId, "digest_sent", {
    digest_id: digestId,
    item_count: loaded.itemCount,
    resend_id: data?.id,
  });

  logger.info(
    { digestId, email: loaded.email, resendId: data?.id, itemCount: loaded.itemCount },
    "send: digest sent",
  );

  return {
    digestId,
    status: "sent",
    email: loaded.email,
    resendId: data?.id,
    itemCount: loaded.itemCount,
  };
}

// Batch entry point — finds every unsent digest for an active user and runs
// them inline. Per-TZ scheduling lands with #17; until then this is how a
// manual `pnpm send:run` flushes the queue.
export async function runSendForUnsent(options: SendOptions = {}): Promise<{
  attempted: number;
  results: SendResult[];
}> {
  const db = getDb();
  const rows = await db
    .select({ id: digests.id })
    .from(digests)
    .innerJoin(usersTable, eq(usersTable.id, digests.userId))
    .where(sql`${digests.sentAt} IS NULL AND ${usersTable.status} = 'active'`)
    .orderBy(digests.createdAt);

  if (rows.length === 0) {
    logger.info("send: no unsent digests for active users");
    return { attempted: 0, results: [] };
  }

  logger.info({ count: rows.length }, "send: dispatching unsent digests");

  const results: SendResult[] = [];
  for (const row of rows) {
    try {
      results.push(await runSendForDigest(row.id, options));
    } catch (err) {
      logger.error({ err, digestId: row.id }, "send: digest failed — continuing batch");
      results.push({ digestId: row.id, status: "failed-no-resend-key" as const });
    }
  }
  return { attempted: rows.length, results };
}

// Pg-boss job payload — one digest per job, singletonKey on digest_id at
// send-time to guarantee no double-send if the queue is replayed.
export interface SendJobData {
  digestId: string;
}
