import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { adminAudit, users } from "~/db/schema";
import { startTestDb, truncateAll, type TestDb } from "./setup";

vi.mock("~/shared/server/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const dbHolder = vi.hoisted(() => ({
  db: null as unknown as TestDb["db"],
  pool: null as unknown as TestDb["pool"],
}));
vi.mock("~/shared/server/db", () => ({
  getDb: () => dbHolder.db,
  getPool: () => dbHolder.pool,
}));

const { writeAudit } = await import("~/features/admin-audit/server/audit");
const { loadAuditForTarget } = await import("~/features/admin-audit/server/fns");

let h: TestDb;

beforeAll(async () => {
  h = await startTestDb();
  dbHolder.db = h.db;
  dbHolder.pool = h.pool;
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

describe("writeAudit + loadAuditForTarget — PF-60", () => {
  test("inserts a row with the supplied actor/target/action/payload", async () => {
    const { adminId, userId } = await seedAdmin();

    await writeAudit({
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

  test("loadAuditForTarget filters by (kind, id) and orders newest-first", async () => {
    const { adminId, userId } = await seedAdmin();
    const [other] = await h.db.insert(users).values({ email: "other@test.local" }).returning();

    await writeAudit({
      actorId: adminId,
      targetKind: "user",
      targetId: userId,
      action: "fte_rerun_enqueued",
    });
    // Tick to guarantee a strictly-newer second insert (Postgres timestamps
    // are microsecond-resolution but Date.now ticks at ms — being explicit
    // here keeps the order assertion robust on fast hardware).
    await new Promise((r) => setTimeout(r, 5));
    await writeAudit({
      actorId: adminId,
      targetKind: "user",
      targetId: userId,
      action: "fast_path_enqueued",
    });
    await writeAudit({
      actorId: adminId,
      targetKind: "user",
      targetId: other!.id,
      action: "fte_rerun_enqueued",
    });

    const rows = await loadAuditForTarget("user", userId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.action).toBe("fast_path_enqueued");
    expect(rows[1]!.action).toBe("fte_rerun_enqueued");
    expect(rows.every((r) => r.targetId === userId)).toBe(true);
    expect(rows[0]!.actorEmail).toBe("admin@test.local");
    expect(rows[0]!.targetLabel).toBe("u@test.local");
  });

  test("deleting the actor leaves audit rows with actor_id=null (set null FK)", async () => {
    const { adminId, userId } = await seedAdmin();
    await writeAudit({
      actorId: adminId,
      targetKind: "user",
      targetId: userId,
      action: "invite_issued",
    });

    await h.db.delete(users).where(eq(users.id, adminId));

    const rows = await loadAuditForTarget("user", userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorId).toBeNull();
    expect(rows[0]!.actorEmail).toBeNull();
  });

  test("write failure swallowed (mutation must not roll back when audit fails)", async () => {
    // Pass a non-uuid for actorId — Postgres rejects the insert. Helper
    // should log + return, NOT throw.
    await expect(
      writeAudit({
        actorId: "not-a-uuid",
        targetKind: "user",
        targetId: "11111111-1111-1111-1111-111111111111",
        action: "invite_issued",
      }),
    ).resolves.toBeUndefined();
  });
});
