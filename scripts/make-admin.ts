import { sql } from "drizzle-orm";
import { getDb, getPool } from "~/shared/server/db";
import { logger } from "~/shared/server/logger";
import { users } from "~/db/schema";

// Bootstraps the first admin in an environment where `disableSignUp: true`
// blocks the normal self-serve path. Idempotent: if the email already has a
// row, just promotes role to 'admin'; otherwise inserts a fresh row with
// `email_verified: true` so the magic-link sign-in at /login works
// immediately. Run via:
//   pnpm tsx scripts/make-admin.ts you@example.com
//   railway run --service web pnpm tsx scripts/make-admin.ts you@example.com

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    console.error("usage: tsx scripts/make-admin.ts <email>");
    process.exit(1);
  }

  const db = getDb();
  try {
    const result = await db
      .insert(users)
      .values({ email, emailVerified: true, role: "admin" })
      .onConflictDoUpdate({
        target: users.email,
        set: { role: "admin", emailVerified: true, updatedAt: sql`now()` },
      })
      .returning({ id: users.id, email: users.email, role: users.role });

    const row = result[0];
    logger.info({ id: row.id, email: row.email, role: row.role }, "admin upserted");
    console.log(`✓ ${row.email} is now an admin (id=${row.id}).`);
    console.log(`  Sign in at /login with that email to receive a magic link.`);
  } finally {
    await getPool().end();
  }
}

main().catch((err) => {
  logger.fatal({ err }, "make-admin failed");
  process.exit(1);
});
