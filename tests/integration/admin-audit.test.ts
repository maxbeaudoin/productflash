import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { adminAudit, users } from "~/db/schema";
import { startTestDb, truncateAll, type TestDb } from "./setup";

// Tests target the `admin_audit` table contract directly — there is no
// shared `writeAudit` helper any more (PF-60 inlined the insert at every
// callsite to keep server-only imports out of the client bundle; see the
// long-form note in `routes/admin/users/$userId.tsx`). The shape the route
// handlers actually run is the SQL below, mirrored at each callsite.

vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await truncateAll(h.pool);
});

async function seedAdmin(): Promise<{ adminId: string; userId: string }> {
  const [admin] = await h.db
    .insert(users)
    .values({ email: "admin@test.local", role: "admin" })
    .returning();
  const [user] = await h.db.insert(users).values({ email: "u@test.local" }).returning();
  return { adminId: admin!.id, userId: user!.id };
}

describe("admin_audit table contract — PF-60", () => {
  test("insert persists actor/target/action/payload + stamps created_at", async () => {
    const { adminId, userId } = await seedAdmin();

    await h.db.insert(adminAudit).values({
      actorId: adminId,
      targetKind: "user",
      targetId: userId,
      action: "fte_rerun_enqueued",
      payload: { runId: "abc", enqueued: true },
    });

    const rows = await h.db.select().from(adminAudit).where(eq(adminAudit.actorId, adminId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      targetKind: "user",
      targetId: userId,
      action: "fte_rerun_enqueued",
    });
    expect(rows[0]!.payload).toEqual({ runId: "abc", enqueued: true });
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  test("per-target select returns newest-first and excludes other targets", async () => {
    const { adminId, userId } = await seedAdmin();
    const [other] = await h.db.insert(users).values({ email: "other@test.local" }).returning();

    await h.db.insert(adminAudit).values({
      actorId: adminId,
      targetKind: "user",
      targetId: userId,
      action: "fte_rerun_enqueued",
    });
    // Tick to guarantee a strictly-newer second insert. Postgres timestamps
    // are microsecond-resolution but Date.now ticks at ms — being explicit
    // keeps the order assertion robust on fast hardware.
    await new Promise((r) => setTimeout(r, 5));
    await h.db.insert(adminAudit).values({
      actorId: adminId,
      targetKind: "user",
      targetId: userId,
      action: "fast_path_enqueued",
    });
    await h.db.insert(adminAudit).values({
      actorId: adminId,
      targetKind: "user",
      targetId: other!.id,
      action: "fte_rerun_enqueued",
    });

    const rows = await h.db
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.targetKind, "user"), eq(adminAudit.targetId, userId)))
      .orderBy(desc(adminAudit.createdAt));

    expect(rows).toHaveLength(2);
    expect(rows[0]!.action).toBe("fast_path_enqueued");
    expect(rows[1]!.action).toBe("fte_rerun_enqueued");
    expect(rows.every((r) => r.targetId === userId)).toBe(true);
  });

  test("deleting the actor leaves audit rows with actor_id=null (set null FK)", async () => {
    const { adminId, userId } = await seedAdmin();
    await h.db.insert(adminAudit).values({
      actorId: adminId,
      targetKind: "user",
      targetId: userId,
      action: "invite_issued",
    });

    await h.db.delete(users).where(eq(users.id, adminId));

    const rows = await h.db
      .select()
      .from(adminAudit)
      .where(and(eq(adminAudit.targetKind, "user"), eq(adminAudit.targetId, userId)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBeNull();
  });
});
