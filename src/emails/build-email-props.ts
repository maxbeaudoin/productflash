import { asc, desc, eq } from "drizzle-orm";
import { digestItems, digests, rawItems, users as usersTable } from "~/db/schema";
import type { DigestTag } from "~/design/tokens";
import { getDb } from "~/lib/db";
import { deriveDigestPeriod } from "~/lib/digest-period";
import { requireEnv } from "~/lib/env";
import { signFeedbackToken } from "~/lib/feedback-token";
import type { DigestEmailItem, DigestEmailProps } from "./DigestEmail";

// Loads one digest + its items from the database and shapes them into the
// `DigestEmail` props. Pure data layer — caller decides how to render/send.
// Throws if the digest doesn't exist; returns `null` if the user is missing
// (orphaned digest after a user delete — should be impossible given the
// `ON DELETE CASCADE` on `digests.user_id`, but the guard keeps the send
// path defensive).

export interface LoadedDigest {
  digestId: string;
  userId: string;
  email: string;
  status: string;
  itemCount: number;
  sentAt: Date | null;
  props: DigestEmailProps;
  subject: string;
}

export async function loadDigestForEmail(digestId: string): Promise<LoadedDigest | null> {
  const db = getDb();

  const [digest] = await db.select().from(digests).where(eq(digests.id, digestId)).limit(1);
  if (!digest) return null;

  const [user] = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      name: usersTable.name,
      status: usersTable.status,
    })
    .from(usersTable)
    .where(eq(usersTable.id, digest.userId))
    .limit(1);
  if (!user) return null;

  const rows = await db
    .select({
      id: digestItems.id,
      category: digestItems.category,
      headline: digestItems.headline,
      snippet: digestItems.snippet,
      impactNote: digestItems.impactNote,
      occurredAt: digestItems.occurredAt,
      sourceUrl: rawItems.url,
    })
    .from(digestItems)
    .innerJoin(rawItems, eq(digestItems.rawItemId, rawItems.id))
    .where(eq(digestItems.digestId, digest.id))
    .orderBy(desc(digestItems.score), asc(digestItems.createdAt));

  const period = deriveDigestPeriod({
    periodStart: digest.periodStart ? digest.periodStart.toISOString() : null,
    periodEnd: digest.periodEnd ? digest.periodEnd.toISOString() : null,
  });

  const headerLabel = headerLabelFor(period.kind);
  const greeting = greetingFor(rows.length, period.kind, period.daysBack);
  const recipientName = (user.name ?? user.email.split("@")[0]).trim();

  const baseUrl = requireEnv("BETTER_AUTH_URL").replace(/\/$/, "");

  const items: DigestEmailItem[] = rows.map((r) => ({
    id: r.id,
    category: r.category as DigestTag,
    headline: r.headline,
    snippet: r.snippet,
    impactNote: r.impactNote,
    sourceUrl: r.sourceUrl,
    occurredAtLabel: formatOccurredAt(r.occurredAt),
    feedbackUrls: {
      up: `${baseUrl}/r/${r.id}/up?t=${signFeedbackToken(r.id, "up")}`,
      down: `${baseUrl}/r/${r.id}/down?t=${signFeedbackToken(r.id, "down")}`,
    },
  }));

  const props: DigestEmailProps = {
    recipientName,
    headerLabel,
    rangeLabel: period.rangeLabel,
    greeting,
    items,
    trackingPixelUrl: `${baseUrl}/api/email/open/${digest.id}.gif`,
    appDigestUrl: `${baseUrl}/app/digests/${digest.id}`,
  };

  return {
    digestId: digest.id,
    userId: user.id,
    email: user.email,
    status: user.status,
    itemCount: digest.itemCount,
    sentAt: digest.sentAt,
    props,
    subject: buildSubject(period.kind, period.daysBack, rows.length),
  };
}

function buildSubject(
  kind: "catchup" | "daily" | "unknown",
  daysBack: number | null,
  itemCount: number,
): string {
  if (itemCount === 0) return "Product Flash · Quiet on the wires today";
  if (kind === "catchup") {
    const window = daysBack && daysBack >= 2 ? `past ${daysBack} days` : "past week";
    return `Product Flash · Catch-up brief — ${window}`;
  }
  const today = new Date().toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `Product Flash · Today's brief — ${today}`;
}

function headerLabelFor(kind: "catchup" | "daily" | "unknown"): string {
  if (kind === "catchup") return "catch-up brief";
  return "daily brief";
}

function greetingFor(
  count: number,
  kind: "catchup" | "daily" | "unknown",
  daysBack: number | null,
): string {
  if (kind === "catchup") {
    const window = daysBack && daysBack >= 2 ? `the past ${daysBack} days` : "the past week";
    if (count === 0) return `Your competitors went quiet across ${window}.`;
    if (count === 1) return `Here's the one thing that mattered in ${window}.`;
    return `Here's what mattered in ${window} — ${countWord(count).toLowerCase()} items worth your attention.`;
  }
  if (count === 0) return "Nothing notable overnight. Back tomorrow.";
  if (count === 1) return "One thing mattered overnight.";
  return `${countWord(count)} things mattered overnight.`;
}

function countWord(n: number): string {
  const words = [
    "Zero",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
  ];
  return words[n] ?? String(n);
}

function formatOccurredAt(occurred: Date | null): string | null {
  if (!occurred) return null;
  return occurred.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Re-exported for tests / preview scripts that want to short-circuit the DB
// load and feed synthetic props in.
export type { DigestEmailItem, DigestEmailProps } from "./DigestEmail";
