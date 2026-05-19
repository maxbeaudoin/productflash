import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  competitors,
  digestItems,
  digests,
  feedback,
  rawItems,
  userCompetitors,
  users,
} from "~/db/schema";
import { getDb, getPool } from "~/shared/server/db";
import { signFeedbackToken } from "~/shared/server/feedback-token";
import { logger } from "~/shared/server/logger";

// End-to-end probe for the GET /r/:digestItemId/:rating endpoint.
//
//   pnpm tsx scripts/test-feedback-endpoint.ts http://localhost:3000
//
// Seeds a throwaway user + digest item, signs a token, then exercises the
// happy path + tamper cases against a running dev server. Cleans up after.

const BASE = process.argv[2] ?? "http://localhost:3000";

async function main() {
  const db = getDb();

  const email = `feedback-probe-${Date.now()}@example.test`;
  const homepage = `https://feedback-probe-${Date.now()}.example.test`;
  const [user] = await db.insert(users).values({ email, name: "Probe", tz: "UTC" }).returning();
  const [competitor] = await db
    .insert(competitors)
    .values({ name: "ProbeCo", homepageUrl: homepage })
    .returning();
  await db.insert(userCompetitors).values({ userId: user.id, competitorId: competitor.id });
  const [raw] = await db
    .insert(rawItems)
    .values({
      competitorId: competitor.id,
      source: "rss",
      sourceId: `probe-${randomUUID()}`,
      url: `${homepage}/post`,
      title: "Probe post",
      body: "Body",
    })
    .returning();
  const [digest] = await db.insert(digests).values({ userId: user.id, itemCount: 1 }).returning();
  const [item] = await db
    .insert(digestItems)
    .values({
      userId: user.id,
      digestId: digest.id,
      rawItemId: raw.id,
      category: "launch",
      headline: "Probe headline",
      snippet: "Probe snippet",
      score: 80,
    })
    .returning();

  logger.info({ digestItemId: item.id }, "seeded probe digest item");

  const cleanup = async () => {
    await db.delete(feedback).where(eq(feedback.userId, user.id));
    await db.delete(digestItems).where(eq(digestItems.id, item.id));
    await db.delete(digests).where(eq(digests.id, digest.id));
    await db.delete(rawItems).where(eq(rawItems.id, raw.id));
    await db.delete(userCompetitors).where(eq(userCompetitors.userId, user.id));
    await db.delete(competitors).where(eq(competitors.id, competitor.id));
    await db.delete(users).where(eq(users.id, user.id));
  };

  const cases: Array<{ name: string; ok: boolean; detail: string }> = [];

  try {
    const upToken = signFeedbackToken(item.id, "up");
    const downToken = signFeedbackToken(item.id, "down");

    // 1. Happy path: GET /r/:id/up?t=<sig> → 302 to /r/thanks?rating=up
    {
      const res = await fetch(`${BASE}/r/${item.id}/up?t=${upToken}`, { redirect: "manual" });
      const loc = res.headers.get("location") ?? "";
      cases.push({
        name: "up + valid token → 302 thanks",
        ok: res.status === 302 && loc === "/r/thanks?rating=up",
        detail: `status=${res.status} location=${loc}`,
      });
      const [row] = await db.select().from(feedback).where(eq(feedback.userId, user.id));
      cases.push({
        name: "feedback row inserted (rating=up)",
        ok: !!row && row.rating === "up" && row.digestItemId === item.id,
        detail: row ? `rating=${row.rating}` : "no row",
      });
    }

    // 2. Idempotent flip: same user re-rates down → row updates, no duplicate.
    //    Down redirect now carries digestItemId + token so the thanks page
    //    can host the optional "what was wrong?" comment form (#PF-62).
    {
      const res = await fetch(`${BASE}/r/${item.id}/down?t=${downToken}`, { redirect: "manual" });
      const loc = res.headers.get("location") ?? "";
      cases.push({
        name: "down (re-rate) → 302 with digestItemId + token for the comment form",
        ok:
          res.status === 302 &&
          loc.includes("rating=down") &&
          loc.includes(`digestItemId=${item.id}`) &&
          loc.includes(`t=${encodeURIComponent(downToken)}`),
        detail: `status=${res.status} location=${loc}`,
      });
      const rows = await db.select().from(feedback).where(eq(feedback.userId, user.id));
      cases.push({
        name: "still one feedback row, rating flipped to down",
        ok: rows.length === 1 && rows[0].rating === "down",
        detail: `count=${rows.length} rating=${rows[0]?.rating}`,
      });
    }

    // 2b. Comment endpoint (#PF-62): POST /r/:id/comment attaches a
    //     "what was wrong?" follow-up to the existing 👎 row.
    {
      const res = await fetch(`${BASE}/r/${item.id}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: "Pricing detail was off", token: downToken }),
      });
      cases.push({
        name: "comment + down token + existing 👎 row → 204",
        ok: res.status === 204,
        detail: `status=${res.status}`,
      });
      const [row] = await db.select().from(feedback).where(eq(feedback.userId, user.id));
      cases.push({
        name: "feedback row updated with comment + commented_at",
        ok: row?.comment === "Pricing detail was off" && row?.commentedAt instanceof Date,
        detail: `comment=${row?.comment ?? "null"} commentedAt=${row?.commentedAt ?? "null"}`,
      });
    }

    // 2c. Up token cannot authorize a comment (token binds to "down").
    {
      const res = await fetch(`${BASE}/r/${item.id}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: "should fail", token: upToken }),
      });
      cases.push({
        name: "comment + up token → 400 invalid signature",
        ok: res.status === 400,
        detail: `status=${res.status}`,
      });
    }

    // 2d. Flipping back to 👍 clears any saved comment (admin shouldn't
    //     see a complaint attached to a like).
    {
      const res = await fetch(`${BASE}/r/${item.id}/up?t=${upToken}`, { redirect: "manual" });
      cases.push({
        name: "flip 👎 → 👍 → 302",
        ok: res.status === 302,
        detail: `status=${res.status}`,
      });
      const [row] = await db.select().from(feedback).where(eq(feedback.userId, user.id));
      cases.push({
        name: "comment + commented_at cleared after flip to up",
        ok: row?.rating === "up" && row?.comment === null && row?.commentedAt === null,
        detail: `rating=${row?.rating} comment=${row?.comment} commentedAt=${row?.commentedAt}`,
      });
    }

    // 3. Missing token → 400
    {
      const res = await fetch(`${BASE}/r/${item.id}/up`, { redirect: "manual" });
      cases.push({
        name: "missing token → 400",
        ok: res.status === 400,
        detail: `status=${res.status}`,
      });
    }

    // 4. Tampered token (up token used on down) → 400
    {
      const res = await fetch(`${BASE}/r/${item.id}/down?t=${upToken}`, { redirect: "manual" });
      cases.push({
        name: "up token replayed on down → 400",
        ok: res.status === 400,
        detail: `status=${res.status}`,
      });
    }

    // 5. Garbage token → 400
    {
      const res = await fetch(`${BASE}/r/${item.id}/up?t=not-a-real-signature`, {
        redirect: "manual",
      });
      cases.push({
        name: "garbage token → 400",
        ok: res.status === 400,
        detail: `status=${res.status}`,
      });
    }

    // 6. Invalid rating → 400
    {
      const res = await fetch(`${BASE}/r/${item.id}/sideways?t=${upToken}`, {
        redirect: "manual",
      });
      cases.push({
        name: "invalid rating → 400",
        ok: res.status === 400,
        detail: `status=${res.status}`,
      });
    }

    // 7. Unknown digest item (valid uuid, no row) → 404
    {
      const ghostId = randomUUID();
      const ghostToken = signFeedbackToken(ghostId, "up");
      const res = await fetch(`${BASE}/r/${ghostId}/up?t=${ghostToken}`, { redirect: "manual" });
      cases.push({
        name: "unknown digest_item_id → 404",
        ok: res.status === 404,
        detail: `status=${res.status}`,
      });
    }

    // 8. Thanks page renders 200 + has body text
    {
      const res = await fetch(`${BASE}/r/thanks?rating=up`);
      const body = await res.text();
      cases.push({
        name: "thanks page renders",
        ok: res.status === 200 && body.toLowerCase().includes("thanks"),
        detail: `status=${res.status} bodyLen=${body.length}`,
      });
    }
  } finally {
    await cleanup();
  }

  const passed = cases.filter((c) => c.ok).length;
  console.log("");
  console.log(`Results: ${passed}/${cases.length} passed`);
  for (const c of cases) {
    console.log(`${c.ok ? "✅" : "❌"} ${c.name} — ${c.detail}`);
  }
  if (passed < cases.length) process.exitCode = 1;
}

main()
  .catch((err) => {
    logger.fatal({ err }, "probe crashed");
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
