import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { users } from "~/db/schema";
import { startTestDb, truncateAll, type TestDb } from "./setup";

// Guards the private-beta send gate: Better Auth's magic-link plugin
// calls our sendMagicLink unconditionally at /sign-in/magic-link
// (disableSignUp only fires at verify time). If our `deliverMagicLink`
// stops checking the users table before sending, an uninvited email
// triggers a real Resend send — burns quota, leaks beta existence, and
// opens an email-bomb vector. This test fails if that regression ships.

// Required env BEFORE the auth module evaluates. Better Auth reads
// BETTER_AUTH_SECRET (>=32 chars) at construction; RESEND_API_KEY must
// be truthy so deliverMagicLink's dev-only "no key — printed only"
// short-circuit doesn't mask the suppression branch we're testing.
process.env.NODE_ENV = "test";
process.env.BETTER_AUTH_SECRET = "test-better-auth-secret-xxxxxxxxxxxxxxxxxx";
process.env.RESEND_API_KEY = "test-resend-key";

// The Resend constructor is replaced with a class whose instances expose
// `emails.send` as a Vitest spy. A class (not an arrow factory) is
// required because Better Auth calls `new Resend(...)` — arrows aren't
// constructable.
const resendSend = vi.fn().mockResolvedValue({ data: { id: "msg-1" }, error: null });
vi.mock("resend", () => ({
  Resend: class FakeResend {
    emails = { send: resendSend };
  },
}));

vi.mock("~/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// `getDb()` runs at auth.ts module-load time inside drizzleAdapter, so the
// dbHolder must be populated BEFORE the `await import("~/lib/auth")` below.
// Top-level await on startTestDb() handles that ordering — the container
// boots once per test file, then auth.ts evaluates with the live handle.
const dbHolder = vi.hoisted(() => ({
  db: null as unknown as TestDb["db"],
  pool: null as unknown as TestDb["pool"],
}));
vi.mock("~/lib/db", () => ({
  getDb: () => dbHolder.db,
  getPool: () => dbHolder.pool,
}));

const _h: TestDb = await startTestDb();
dbHolder.db = _h.db;
dbHolder.pool = _h.pool;

const { auth } = await import("~/lib/auth");

let h: TestDb;

beforeAll(() => {
  h = _h;
});

afterAll(async () => {
  await h.stop();
});

beforeEach(async () => {
  await truncateAll(h.pool);
  resendSend.mockClear();
});

describe("magic-link send guard — private beta", () => {
  test("uninvited email: endpoint returns success but Resend is NOT called", async () => {
    // No users row — this email isn't on the beta.
    const res = await auth.api.signInMagicLink({
      body: { email: "stranger@example.com", callbackURL: "/app" },
      headers: new Headers(),
    });

    // Endpoint MUST report success regardless — otherwise an attacker can
    // enumerate beta membership by response shape or timing.
    expect(res.status).toBe(true);
    expect(resendSend).not.toHaveBeenCalled();
  });

  test("invited email: Resend.emails.send is called exactly once with that recipient", async () => {
    // Mirror the admin invite shape from src/routes/admin/waitlist.tsx.
    await h.db.insert(users).values({ email: "invited@example.com", status: "pending" });

    const res = await auth.api.signInMagicLink({
      body: { email: "invited@example.com", callbackURL: "/app" },
      headers: new Headers(),
    });

    expect(res.status).toBe(true);
    expect(resendSend).toHaveBeenCalledTimes(1);
    expect(resendSend.mock.calls[0]?.[0]).toMatchObject({ to: "invited@example.com" });
  });

  test("invited email lookup is case-insensitive (lowercase normalized)", async () => {
    // Better Auth normalizes the email at sign-in, and admin invite stores
    // it lowercased — our guard must match the same shape, otherwise a
    // legit user typing "Invited@Example.com" gets silently suppressed.
    await h.db.insert(users).values({ email: "casey@example.com", status: "pending" });

    const res = await auth.api.signInMagicLink({
      body: { email: "Casey@Example.com", callbackURL: "/app" },
      headers: new Headers(),
    });

    expect(res.status).toBe(true);
    expect(resendSend).toHaveBeenCalledTimes(1);
  });
});
