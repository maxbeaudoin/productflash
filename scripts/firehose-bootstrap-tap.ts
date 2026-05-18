import { requireEnv } from "~/shared/server/env";

// One-off bootstrap for the Firehose tap.
//
//   pnpm tsx scripts/firehose-bootstrap-tap.ts
//
// What this does:
//   1. POST https://api.firehose.com/v1/taps with the management key
//      (FIREHOSE_MANAGEMENT_KEY, fhm_... prefix).
//   2. Prints the resulting tap id and tap token to YOUR terminal.
//   3. You paste the tap token into .env as FIREHOSE_TAP_TOKEN.
//
// Run this exactly once per environment (dev / prod). The Firehose API
// returns the full tap token only at creation time — if you lose it you'll
// have to recreate the tap. If a tap already exists, the API will still
// 201 a new one (Firehose allows multiple taps per org), but you almost
// certainly want a single tap; check your dashboard before re-running.
//
// Output goes straight to stdout in your terminal, NOT through any
// intermediary that would land in transcripts.

const FIREHOSE_TAPS_ENDPOINT = "https://api.firehose.com/v1/taps";
const TAP_NAME = "productflash";

interface CreateTapResponse {
  data?: {
    id?: string;
    name?: string;
    token_prefix?: string;
    created_at?: string;
  };
  token?: string;
  // Errors come back with a different envelope; we just stringify the body.
}

async function main() {
  const managementKey = requireEnv("FIREHOSE_MANAGEMENT_KEY");

  const res = await fetch(FIREHOSE_TAPS_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${managementKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ name: TAP_NAME }),
  });

  const text = await res.text();
  if (!res.ok) {
    process.stderr.write(`firehose tap create failed: HTTP ${res.status}\n${text}\n`);
    process.exit(1);
  }

  let parsed: CreateTapResponse;
  try {
    parsed = JSON.parse(text) as CreateTapResponse;
  } catch {
    process.stderr.write(`firehose tap create returned non-JSON body:\n${text}\n`);
    process.exit(1);
  }

  const id = parsed.data?.id;
  const name = parsed.data?.name;
  const prefix = parsed.data?.token_prefix;
  const token = parsed.token;

  if (!id || !token) {
    process.stderr.write(`firehose tap create response missing id or token; body was:\n${text}\n`);
    process.exit(1);
  }

  // Direct stdout writes — no logger here so the secret doesn't get tagged
  // into structured logs that might get shipped somewhere.
  process.stdout.write("\n");
  process.stdout.write("Tap created.\n");
  process.stdout.write(`  id:           ${id}\n`);
  process.stdout.write(`  name:         ${name ?? TAP_NAME}\n`);
  process.stdout.write(`  token_prefix: ${prefix ?? "(none)"}\n`);
  process.stdout.write("\n");
  process.stdout.write("Add this line to .env (the token is shown ONCE — copy it now):\n");
  process.stdout.write("\n");
  process.stdout.write(`FIREHOSE_TAP_TOKEN=${token}\n`);
  process.stdout.write("\n");
}

main().catch((err) => {
  process.stderr.write(
    `firehose bootstrap failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
