// Shared types for the admin-audit feature. Lives under `shared/` (not
// `server/`) because the UI components in `ui/` consume the row shape;
// keeping types isomorphic dodges a circular import the other way.

export type AdminAuditTargetKind = "user" | "waitlist" | "competitor";

// Plain string, not an enum, so adding a new action (PF-66/67/68) doesn't
// need a schema migration — `action` is `text` in the DB by design. The
// UI's pretty-printer falls back to the raw token for unknown actions.
export type AdminAuditAction = string;

// Concrete JSON union — TanStack Start's loader/serverFn return-type guard
// rejects `unknown`, so `Record<string, unknown>` would block compilation
// on the loaders that ship this row to the client.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type AdminAuditPayload = { [key: string]: JsonValue };

export type AdminAuditRow = {
  id: string;
  actorId: string | null;
  actorEmail: string | null;
  targetKind: AdminAuditTargetKind | string;
  targetId: string;
  targetLabel: string | null;
  action: AdminAuditAction;
  payload: AdminAuditPayload;
  createdAt: string;
};
