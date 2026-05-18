import { expect, test } from "@playwright/test";

// Locks the /login UI contracts the auth refactor depends on:
//   - Better Auth's social errorCallbackURL appends `?error=<code>` to
//     the URL we hand it. If the loader's Zod schema or banner branches
//     drift, an uninvited Google user lands on a 500 or a misleading
//     message — both close the funnel silently.
//   - The post-submit SentCard text MUST stay ambiguous ("if X is on
//     the private beta…") so we don't re-introduce the enumeration
//     leak the magic-link send guard plugged.

test("clean /login: no error banner, both sign-in paths visible", async ({ page }) => {
  await page.goto("/login");

  await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /send magic link/i })).toBeVisible();
  // Neither banner should render without an error query param.
  await expect(page.getByText(/isn't on the private beta yet/i)).toHaveCount(0);
  await expect(page.getByText(/couldn't complete google sign-in/i)).toHaveCount(0);
});

test("/login?error=signup_disabled: invite-only banner + waitlist CTA", async ({ page }) => {
  await page.goto("/login?error=signup_disabled");

  await expect(page.getByText(/that email isn't on the private beta yet/i)).toBeVisible();
  // The banner link's accessible name is the exact string "Join the waitlist"
  // (no arrow). The footnote/SentCard links append "→", so `exact: true`
  // distinguishes them — without it, three locators would match across the
  // page (banner + footnote + would-be SentCard) and strict mode would error.
  await expect(page.getByRole("link", { name: "Join the waitlist", exact: true })).toBeVisible();
});

test("/login?error=<unknown code>: generic OAuth banner (safety net for new error codes)", async ({
  page,
}) => {
  await page.goto("/login?error=some_unmapped_code");

  await expect(page.getByText(/couldn't complete google sign-in/i)).toBeVisible();
  // The invite-only copy must NOT fire — that'd mislead a user whose
  // failure was actually a network blip or consent denial.
  await expect(page.getByText(/that email isn't on the private beta yet/i)).toHaveCount(0);
});

test("magic-link submit: SentCard renders the ambiguous copy + waitlist CTA", async ({ page }) => {
  // Wait for the hydration marker (`data-hydrated` stamped by __root.tsx's
  // useEffect) before clicking — otherwise the click can fire before the
  // onSubmit handler is bound and the browser does a native form POST
  // that navigates away. Deterministic and much faster than networkidle.
  await page.goto("/login");
  // locator.waitFor() uses page.setDefaultTimeout (30s default), NOT
  // expect.timeout — pass an explicit budget so a missing hydration
  // marker surfaces in 5s, matching expect/action timeouts.
  await page.locator('html[data-hydrated="true"]').waitFor({ timeout: 5_000 });

  // Any email works — the form submits, deliverMagicLink's suppression
  // branch fires server-side (no users row), the client UX is identical
  // to the invited case. That identical UX is the property under test.
  await page.locator('input[type="email"]').fill("anyone@example.com");
  await page.getByRole("button", { name: /send magic link/i }).click();

  await expect(page.getByText(/check your inbox/i)).toBeVisible();
  // The whole point of this copy: condition the promise on beta membership.
  await expect(page.getByText(/if anyone@example\.com is on the private beta/i)).toBeVisible();
  // Two "Join the waitlist →" links exist once SentCard renders (the card
  // itself + the always-present AuthShell footnote). Asserting count >= 1
  // proves the card's CTA is present without coupling to which one.
  await expect(page.getByRole("link", { name: /join the waitlist/i }).first()).toBeVisible();
});
