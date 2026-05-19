import { adminAudit } from "~/db/schema";
import { getDb } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import type { AdminAuditAction, AdminAuditPayload, AdminAuditTargetKind } from "../shared/types";

// Single insert path used by every admin server function. Writes are best-
// effort: a failed audit insert must not roll back the actual mutation (the
// mutation is the user-visible work; the audit is forensic context), but it
// MUST log so we can detect a silently broken audit table during dogfood.
export async function writeAudit(input: {
  actorId: string;
  targetKind: AdminAuditTargetKind;
  targetId: string;
  action: AdminAuditAction;
  payload?: AdminAuditPayload;
}): Promise<void> {
  try {
    const db = getDb();
    await db.insert(adminAudit).values({
      actorId: input.actorId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      action: input.action,
      payload: input.payload ?? {},
    });
  } catch (err) {
    logger.error(
      {
        err: err instanceof Error ? err.message : String(err),
        actorId: input.actorId,
        targetKind: input.targetKind,
        targetId: input.targetId,
        action: input.action,
      },
      "admin_audit_write_failed",
    );
  }
}
