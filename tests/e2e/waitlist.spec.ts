import { expect, test } from "@playwright/test";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { waitlist } from "~/db/schema";

// Top-of-funnel for the entire private beta. If the landing form or
// POST /api/waitlist regresses, new beta interest is silently dropped —
// no error surfaces because the failure is between visitor and DB.

const TEST_EMAIL = "Beta+Waitlist@Example.com";
const LOWER_EMAIL = TEST_EMAIL.toLowerCase();

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
  await pool.query("TRUNCATE TABLE waitlist RESTART IDENTITY CASCADE");
});

test("landing form: visitor submits → row written with lowercased email + source", async ({
  page,
}) => {
  const db = drizzle(pool);

  // Land on /, scroll the CTA into view so the form is interactable, then
  // fill it as a real visitor would.
  await page.goto("/", { waitUntil: "networkidle" });

  const form = page.locator("form").filter({ has: page.getByLabel("Email") });
  await form.scrollIntoViewIfNeeded();

  await form.getByLabel("Email").fill(TEST_EMAIL);
  await form.getByLabel("Role").fill("Head of Product");
  // Bare-domain submission exercises client-side normalizeUrl end-to-end.
  // The stored value tolerates either the normalized form (verify failed,
  // silent fallback) or a www. canonical (HEAD verify followed a redirect).
  await form.getByLabel("Company URL").fill("acme.com");

  await form.getByRole("button", { name: /join the waitlist/i }).click();

  // Success view replaces the form.
  await expect(page.getByText(/Got it — we'll be in touch\./i)).toBeVisible();

  // Row persisted with email lowercased, optional fields captured, and
  // source set to the CTASection's identifier — that field is how we'll
  // attribute conversions if we add more entry points later.
  const rows = await db.select().from(waitlist).where(eq(waitlist.email, LOWER_EMAIL));
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.email).toBe(LOWER_EMAIL);
  expect(row.position).toBe("Head of Product");
  expect(row.companyUrl).toMatch(/^https:\/\/(www\.)?acme\.com$/);
  expect(row.source).toBe("cta-section");
});

test("duplicate email: second submission is a no-op via onConflictDoNothing", async ({
  request,
}) => {
  const db = drizzle(pool);

  const first = await request.post("/api/waitlist", {
    data: {
      email: LOWER_EMAIL,
      position: "Product Manager",
      companyUrl: "https://first.example",
      source: "cta-section",
    },
  });
  expect(first.status()).toBe(200);

  // Second submission with the same email but different values. Endpoint
  // should still return 200 (idempotent UX — no leaking that the email is
  // taken) and the original row must remain untouched.
  const second = await request.post("/api/waitlist", {
    data: {
      email: LOWER_EMAIL,
      position: "Founder / CEO",
      companyUrl: "https://second.example",
      source: "cta-section",
    },
  });
  expect(second.status()).toBe(200);

  const rows = await db.select().from(waitlist).where(eq(waitlist.email, LOWER_EMAIL));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.position).toBe("Product Manager");
  expect(rows[0]!.companyUrl).toBe("https://first.example");
});

test("invalid email: server rejects with 400 invalid_email, no row written", async ({
  request,
}) => {
  const db = drizzle(pool);

  const res = await request.post("/api/waitlist", {
    data: { email: "not-an-email", source: "cta-section" },
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { ok: boolean; error: string };
  expect(body.ok).toBe(false);
  expect(body.error).toBe("invalid_email");

  const rows = await db.select().from(waitlist);
  expect(rows).toHaveLength(0);
});

test("invalid url: structurally broken URL → 400 invalid_url (server-side defensive guard)", async ({
  request,
}) => {
  // Client-side normalizeUrl short-circuits this case before POST. The server
  // returns invalid_url anyway when called directly (e.g. via curl) so the
  // contract is unambiguous.
  const db = drizzle(pool);

  const res = await request.post("/api/waitlist", {
    data: { email: "ok@example.com", companyUrl: "not a url", source: "cta-section" },
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { ok: boolean; error: string };
  expect(body.error).toBe("invalid_url");

  const rows = await db.select().from(waitlist);
  expect(rows).toHaveLength(0);
});

test("bare domain via API: server normalizes acme.com → https://acme.com (verify may fall back)", async ({
  request,
}) => {
  const db = drizzle(pool);
  const email = "bare-domain@example.com";

  const res = await request.post("/api/waitlist", {
    data: { email, companyUrl: "acme.com", source: "cta-section" },
  });
  expect(res.status()).toBe(200);

  const rows = await db.select().from(waitlist).where(eq(waitlist.email, email));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.companyUrl).toMatch(/^https:\/\/(www\.)?acme\.com$/);
});
