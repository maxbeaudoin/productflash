import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { adminAudit, competitors, users, waitlist } from "~/db/schema";
import { requireAdminSession } from "~/features/auth/server/session";
import { getDb } from "~/shared/server/db";
import type { AdminAuditPayload, AdminAuditRow, AdminAuditTargetKind } from "../shared/types";

// Tuned to the cohort. With 3 actions per FTE re-run + ad-hoc invites, even
// a chatty week stays well under 500. If we outgrow this, switch to cursor
// pagination rather than raising the cap.
const GLOBAL_LIMIT = 500;
// Per-target detail surfaces lean to recent — the operator wants "what
// happened to THIS row lately", not the full history. PoC scale.
const PER_TARGET_LIMIT = 50;

type Raw = {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  targetKind: string;
  targetId: string;
  action: string;
  payload: unknown;
  createdAt: Date;
};

function toRow(r: Raw, label: string | null): AdminAuditRow {
  return {
    id: r.id,
    actorId: r.actorId,
    actorEmail: r.actorEmail,
    targetKind: r.targetKind,
    targetId: r.targetId,
    targetLabel: label,
    action: r.action,
    payload: (r.payload ?? {}) as AdminAuditPayload,
    createdAt: r.createdAt.toISOString(),
  };
}

// Resolves a human-readable label for each `targetId` in one batched query
// per kind. Keeps the loader to a fixed ~4 round trips regardless of result
// size. Unknown target_kind values yield `null` — the UI renders the raw
// uuid in that case.
async function labelTargets(rows: Raw[]): Promise<Map<string, string>> {
  const db = getDb();
  const labels = new Map<string, string>();
  const byKind = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = byKind.get(r.targetKind) ?? new Set<string>();
    set.add(r.targetId);
    byKind.set(r.targetKind, set);
  }

  const userIds = byKind.get("user");
  if (userIds && userIds.size > 0) {
    const list = Array.from(userIds) as [string, ...string[]];
    const rs = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, list));
    for (const u of rs) labels.set(`user:${u.id}`, u.email);
  }

  const waitlistIds = byKind.get("waitlist");
  if (waitlistIds && waitlistIds.size > 0) {
    const list = Array.from(waitlistIds) as [string, ...string[]];
    const rs = await db
      .select({ id: waitlist.id, email: waitlist.email })
      .from(waitlist)
      .where(inArray(waitlist.id, list));
    for (const w of rs) labels.set(`waitlist:${w.id}`, w.email);
  }

  const competitorIds = byKind.get("competitor");
  if (competitorIds && competitorIds.size > 0) {
    const list = Array.from(competitorIds) as [string, ...string[]];
    const rs = await db
      .select({ id: competitors.id, name: competitors.name })
      .from(competitors)
      .where(inArray(competitors.id, list));
    for (const c of rs) labels.set(`competitor:${c.id}`, c.name);
  }

  return labels;
}

export const listAdminAudit = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ rows: AdminAuditRow[] }> => {
    await requireAdminSession();
    const db = getDb();

    const raw: Raw[] = await db
      .select({
        id: adminAudit.id,
        actorId: adminAudit.actorId,
        actorEmail: users.email,
        targetKind: adminAudit.targetKind,
        targetId: adminAudit.targetId,
        action: adminAudit.action,
        payload: adminAudit.payload,
        createdAt: adminAudit.createdAt,
      })
      .from(adminAudit)
      .leftJoin(users, eq(users.id, adminAudit.actorId))
      .orderBy(desc(adminAudit.createdAt))
      .limit(GLOBAL_LIMIT);

    const labels = await labelTargets(raw);
    return {
      rows: raw.map((r) => toRow(r, labels.get(`${r.targetKind}:${r.targetId}`) ?? null)),
    };
  },
);

const perTargetInput = z.object({
  targetKind: z.enum(["user", "waitlist", "competitor"]),
  targetId: z.string().uuid(),
});

export const listAuditForTarget = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => perTargetInput.parse(data))
  .handler(async ({ data }): Promise<{ rows: AdminAuditRow[] }> => {
    await requireAdminSession();
    const db = getDb();

    const raw: Raw[] = await db
      .select({
        id: adminAudit.id,
        actorId: adminAudit.actorId,
        actorEmail: users.email,
        targetKind: adminAudit.targetKind,
        targetId: adminAudit.targetId,
        action: adminAudit.action,
        payload: adminAudit.payload,
        createdAt: adminAudit.createdAt,
      })
      .from(adminAudit)
      .leftJoin(users, eq(users.id, adminAudit.actorId))
      .where(
        and(eq(adminAudit.targetKind, data.targetKind), eq(adminAudit.targetId, data.targetId)),
      )
      .orderBy(desc(adminAudit.createdAt))
      .limit(PER_TARGET_LIMIT);

    const labels = await labelTargets(raw);
    return {
      rows: raw.map((r) => toRow(r, labels.get(`${r.targetKind}:${r.targetId}`) ?? null)),
    };
  });

// Server-side helper for routes that already have a target uuid in hand and
// want to skip an extra createServerFn round-trip. Same query as
// listAuditForTarget but callable directly inside a loader handler.
export async function loadAuditForTarget(
  targetKind: AdminAuditTargetKind,
  targetId: string,
): Promise<AdminAuditRow[]> {
  const db = getDb();
  const raw: Raw[] = await db
    .select({
      id: adminAudit.id,
      actorId: adminAudit.actorId,
      actorEmail: users.email,
      targetKind: adminAudit.targetKind,
      targetId: adminAudit.targetId,
      action: adminAudit.action,
      payload: adminAudit.payload,
      createdAt: adminAudit.createdAt,
    })
    .from(adminAudit)
    .leftJoin(users, eq(users.id, adminAudit.actorId))
    .where(and(eq(adminAudit.targetKind, targetKind), eq(adminAudit.targetId, targetId)))
    .orderBy(desc(adminAudit.createdAt))
    .limit(PER_TARGET_LIMIT);

  const labels = await labelTargets(raw);
  return raw.map((r) => toRow(r, labels.get(`${r.targetKind}:${r.targetId}`) ?? null));
}
