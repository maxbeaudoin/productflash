import { expect, test } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { users, waitlist } from "~/db/schema";
import { signInviteToken } from "~/lib/invite-token";

// F-004 — the single point of failure for beta growth. Sign-up runs with
// `disableSignUp: true` (private beta), so the invite token is the only
// path into a users row. If verification regresses, no new beta user can
// join until a developer notices.

const TEST_EMAIL = "beta+e2e@example.com";

let pool: Pool;

test.beforeAll(() => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("e2e: DATABASE_URL not set by global-setup");
  pool = new Pool({ connectionString: url, max: 2 });
});

test.afterAll(async () => {
  await pool.end();
});

test.beforeEach(async () => {
  // Each test starts from a clean slate — Better Auth tables included,
  // so a previous run's session can't leak in.
  await pool.query(
    "TRUNCATE TABLE users, waitlist, accounts, sessions, verifications RESTART IDENTITY CASCADE",
  );
});

test("invite-gated signup: valid token → form submits → /app with session", async ({ page }) => {
  const db = drizzle(pool);

  // Seed a waitlist row exactly as #34's admin /admin/waitlist endpoint
  // would — then hand-issue an invite token for that row.
  const [row] = await db
    .insert(waitlist)
    .values({
      email: TEST_EMAIL,
      position: "Head of Product",
      companyUrl: "https://example.com",
    })
    .returning();
  const token = signInviteToken({ id: row!.id, email: row!.email });

  // 1. Visit the invite URL. Loader should verify the token, look up the
  //    waitlist row, and pre-seed the form. Wait for the hydration marker
  //    (`data-hydrated` stamped by __root.tsx's useEffect) before clicking
  //    — otherwise the click on submit can fire BEFORE the onSubmit
  //    handler is bound, triggering a native form POST that strips the
  //    search params. Deterministic; much faster than networkidle.
  await page.goto(`/signup?invite=${encodeURIComponent(token)}`);
  await page.locator('html[data-hydrated="true"]').waitFor();

  // 2. Email field is rendered, pre-filled, and read-only.
  const emailField = page.locator('input[type="email"]');
  await expect(emailField).toHaveValue(TEST_EMAIL);
  await expect(emailField).toHaveAttribute("readonly");

  // 3. Defaults from the waitlist row are pre-seeded (#37 — pre-fill /signup).
  const urlField = page.locator('input[type="url"]');
  await expect(urlField).toHaveValue("https://example.com");
  const positionField = page.locator('input[type="text"]').first();
  await expect(positionField).toHaveValue("Head of Product");

  // 4. Fill the goal field (required, no default).
  await page
    .locator("textarea")
    .fill("Catch every competitor launch and pricing change so I can react before my CEO asks.");

  // 5. Submit. The handler upserts the user, enqueues FTE, mints a one-shot
  //    verify URL, and the client navigates to it — Better Auth's verify
  //    route consumes the row and lands a session cookie.
  await page.locator('button[type="submit"]').click();

  // 6. After the auto-sign-in chain, we should land somewhere under /app.
  //    Onboarding for a freshly-created user. 10s is generous for the
  //    upsert → enqueue FTE → mint verify URL → Better Auth verify chain;
  //    a healthy run completes in well under 2s. If we're past 10s the
  //    chain is broken — fail fast rather than waiting out 30s.
  await page.waitForURL(/\/app(\/.*)?$/, { timeout: 10_000 });

  // 7. Session cookie is set.
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((c) => /session/i.test(c.name));
  expect(sessionCookie, "expected a session cookie after sign-in").toBeDefined();
  expect(sessionCookie?.httpOnly).toBe(true);

  // 8. The users row exists with the form inputs persisted and status=onboarding.
  const [user] = await db.select().from(users).where(eq(users.email, TEST_EMAIL)).limit(1);
  expect(user).toBeDefined();
  expect(user!.position).toBe("Head of Product");
  expect(user!.companyUrl).toBe("https://example.com");
  expect(user!.status).toBe("onboarding");
});

test("tampered invite token → invite gate, no users row created", async ({ page }) => {
  const db = drizzle(pool);
  const [row] = await db
    .insert(waitlist)
    .values({ email: TEST_EMAIL, position: "PM", companyUrl: "https://example.com" })
    .returning();
  const token = signInviteToken({ id: row!.id, email: row!.email });

  // Flip the last few signature bytes — token loses verification.
  const tampered = token.slice(0, -3) + (token.endsWith("AAA") ? "BBB" : "AAA");

  await page.goto(`/signup?invite=${encodeURIComponent(tampered)}`);

  // The InviteGate renders instead of the form.
  await expect(page.getByText(/Private beta/i)).toBeVisible();
  await expect(page.locator('input[type="email"]')).toHaveCount(0);

  // No user row created.
  const found = await db.select().from(users).where(eq(users.email, TEST_EMAIL));
  expect(found).toHaveLength(0);
});
