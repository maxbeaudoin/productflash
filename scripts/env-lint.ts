#!/usr/bin/env tsx
//
// env-lint — cross-checks .env / .env.example / .env.production against the
// schema in src/shared/server/env-keys.ts. Run via `pnpm env:lint`. Exit 0 = clean,
// exit 1 = at least one error.
//
// Rules enforced:
//   1. Every key in .env.example must appear in ENV_KEYS (and vice versa)
//      — catches typos + schema drift.
//   2. Every key in .env.example must carry a `# @public`, `# @private`
//      or `# @secret` tag on the line immediately above its definition.
//   3. Every @public + @private key MUST appear in .env.production (value may be
//      empty — see INGEST_SCHEDULE_ENABLED — but the line must exist so
//      the operator sees it's tracked).
//   4. Every @secret key MUST NOT appear in .env.production with a non-empty
//      value (committing secrets defeats the whole point).
//   5. Every key in .env.production must appear in .env.example — catches
//      operator typos that would silently no-op at runtime.
//   6. If .env exists locally: every key in .env must appear in
//      .env.example (typo guard), AND every key in ENV_REQUIRED_IN_PROD
//      should have a non-empty value (warning, not error — dev may not
//      have Resend creds yet).
//   7. Every key in the schema must be referenced somewhere under src/,
//      scripts/, or tests/ (warning — catches vars that became dead
//      code, like ADMIN_USER without a /admin login route).
//
// Output: per-file sections, ❌ for errors, ⚠ for warnings, ✓ for clean.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { ENV_KEYS, ENV_REQUIRED_IN_PROD } from "../src/shared/server/env-keys";

const ROOT = process.cwd();
const ENV_FILE = resolve(ROOT, ".env");
const ENV_EXAMPLE_FILE = resolve(ROOT, ".env.example");
const ENV_PROD_FILE = resolve(ROOT, ".env.production");

type Tag = "public" | "private" | "secret";

interface ExampleEntry {
  key: string;
  tag: Tag | null;
  line: number;
}

// Parse .env.example line-by-line so we can pick up the `# @secret` /
// `# @public` annotation that dotenv strips. Convention: the tag must sit
// on its own comment line directly above the KEY=value line. A blank line
// resets the pending tag so a tag on one block doesn't bleed into the next.
function parseExample(path: string): ExampleEntry[] {
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const entries: ExampleEntry[] = [];
  let pendingTag: Tag | null = null;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();
    if (trimmed === "") {
      pendingTag = null;
      continue;
    }
    if (trimmed.startsWith("#")) {
      const body = trimmed.slice(1).trim();
      if (body === "@public") pendingTag = "public";
      else if (body === "@private") pendingTag = "private";
      else if (body === "@secret") pendingTag = "secret";
      // any other comment is documentation — leave pendingTag alone so
      // a multi-line description above a tag still works:
      //   # Some explanation...
      //   # @secret
      //   FOO=
      continue;
    }
    const match = /^([A-Z_][A-Z0-9_]*)\s*=/.exec(trimmed);
    if (match?.[1]) {
      entries.push({ key: match[1], tag: pendingTag, line: i + 1 });
      pendingTag = null;
    }
  }
  return entries;
}

function readEnvFile(path: string): Record<string, string> {
  return parseDotenv(readFileSync(path, "utf8"));
}

// Result accumulator — collected per-file so the report has stable structure.
interface Report {
  errors: string[];
  warnings: string[];
}
const newReport = (): Report => ({ errors: [], warnings: [] });

// --- Rule checks -----------------------------------------------------------

function checkSchemaVsExample(example: ExampleEntry[]): Report {
  const r = newReport();
  const exampleKeys = new Set(example.map((e) => e.key));
  const schemaKeys: Set<string> = new Set(ENV_KEYS);

  for (const key of schemaKeys) {
    if (!exampleKeys.has(key)) {
      r.errors.push(`schema declares ${key} but .env.example is missing it`);
    }
  }
  for (const e of example) {
    if (!schemaKeys.has(e.key)) {
      r.errors.push(`.env.example:${e.line} declares ${e.key} but the schema doesn't know it`);
    }
  }
  return r;
}

function checkExampleTags(example: ExampleEntry[]): Report {
  const r = newReport();
  for (const e of example) {
    if (e.tag === null) {
      r.errors.push(
        `.env.example:${e.line} ${e.key} has no @public / @private / @secret tag — env-lint can't classify it`,
      );
    }
  }
  return r;
}

function checkProd(example: ExampleEntry[], prod: Record<string, string>): Report {
  const r = newReport();
  const tagByKey = new Map(example.map((e) => [e.key, e.tag]));
  const exampleKeys = new Set(example.map((e) => e.key));

  for (const e of example) {
    if (e.tag === "public" || e.tag === "private") {
      if (!(e.key in prod)) {
        r.errors.push(
          `.env.production is missing @${e.tag} key ${e.key} (defined in .env.example)`,
        );
      }
    } else if (e.tag === "secret") {
      const value = prod[e.key];
      if (value !== undefined && value !== "") {
        r.errors.push(
          `.env.production has a non-empty value for @secret key ${e.key} — secrets must live in Railway, not git`,
        );
      } else if (value === "") {
        r.warnings.push(
          `.env.production declares @secret key ${e.key} with an empty value — harmless but noisy; remove the line`,
        );
      }
    }
  }
  for (const key of Object.keys(prod)) {
    if (!exampleKeys.has(key)) {
      r.errors.push(`.env.production has ${key} which isn't declared in .env.example (typo?)`);
    } else if (!tagByKey.get(key)) {
      // already reported by checkExampleTags — skip the duplicate
    }
  }
  return r;
}

// Files that *declare* env vars rather than consume them — they trivially
// match every key name and would always make the unused-check pass.
const USAGE_SCAN_IGNORES = new Set([
  resolve(ROOT, "src/shared/server/env.ts"),
  resolve(ROOT, "src/shared/server/env-keys.ts"),
  resolve(ROOT, "scripts/env-lint.ts"),
]);

const USAGE_SCAN_ROOTS = ["src", "scripts", "tests"];

function* walkCode(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const path = join(dir, name);
    let s;
    try {
      s = statSync(path);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      yield* walkCode(path);
    } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) {
      yield path;
    }
  }
}

function checkUnused(): Report {
  const r = newReport();
  // Build one big corpus instead of N greps. ~few MB; fast enough.
  const chunks: string[] = [];
  for (const root of USAGE_SCAN_ROOTS) {
    for (const file of walkCode(resolve(ROOT, root))) {
      if (USAGE_SCAN_IGNORES.has(file)) continue;
      try {
        chunks.push(readFileSync(file, "utf8"));
      } catch {
        // unreadable — skip
      }
    }
  }
  const corpus = chunks.join("\n");
  for (const key of ENV_KEYS) {
    const re = new RegExp(`\\b${key}\\b`);
    if (!re.test(corpus)) {
      r.warnings.push(
        `${key} is declared in the schema but never referenced under src/ scripts/ tests/ — dead var?`,
      );
    }
  }
  return r;
}

function checkLocal(example: ExampleEntry[], local: Record<string, string>): Report {
  const r = newReport();
  const exampleKeys = new Set(example.map((e) => e.key));
  for (const key of Object.keys(local)) {
    if (!exampleKeys.has(key)) {
      r.errors.push(`.env has ${key} which isn't declared in .env.example (typo?)`);
    }
  }
  for (const key of ENV_REQUIRED_IN_PROD) {
    const value = local[key];
    if (value === undefined || value === "") {
      r.warnings.push(
        `.env has no value for ${key} — required in production; a Railway deploy with this state will fail fast`,
      );
    }
  }
  return r;
}

// --- Pretty printing -------------------------------------------------------

const isTTY = process.stdout.isTTY;
const RED = isTTY ? "\x1b[31m" : "";
const YEL = isTTY ? "\x1b[33m" : "";
const GRN = isTTY ? "\x1b[32m" : "";
const DIM = isTTY ? "\x1b[2m" : "";
const RST = isTTY ? "\x1b[0m" : "";

function printSection(title: string, r: Report) {
  if (r.errors.length === 0 && r.warnings.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`${GRN}✓${RST} ${title}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.log(`${title}`);
  for (const e of r.errors) {
    // eslint-disable-next-line no-console
    console.log(`  ${RED}❌${RST} ${e}`);
  }
  for (const w of r.warnings) {
    // eslint-disable-next-line no-console
    console.log(`  ${YEL}⚠${RST}  ${w}`);
  }
}

// --- Main ------------------------------------------------------------------

function main(): number {
  if (!existsSync(ENV_EXAMPLE_FILE)) {
    // eslint-disable-next-line no-console
    console.error(`${RED}❌${RST} .env.example not found at ${ENV_EXAMPLE_FILE}`);
    return 1;
  }
  if (!existsSync(ENV_PROD_FILE)) {
    // eslint-disable-next-line no-console
    console.error(`${RED}❌${RST} .env.production not found at ${ENV_PROD_FILE}`);
    return 1;
  }

  const example = parseExample(ENV_EXAMPLE_FILE);
  const prod = readEnvFile(ENV_PROD_FILE);
  const local = existsSync(ENV_FILE) ? readEnvFile(ENV_FILE) : null;

  // eslint-disable-next-line no-console
  console.log(
    `${DIM}env-lint — checking .env.example, .env.production${local ? ", .env" : ""}${RST}`,
  );

  const schemaR = checkSchemaVsExample(example);
  const tagR = checkExampleTags(example);
  const prodR = checkProd(example, prod);
  const localR = local ? checkLocal(example, local) : null;
  const unusedR = checkUnused();

  printSection("schema ↔ .env.example", schemaR);
  printSection(".env.example tags", tagR);
  printSection(".env.production", prodR);
  if (localR) printSection(".env (local)", localR);
  printSection("schema usage", unusedR);

  const reports = [schemaR, tagR, prodR, unusedR, ...(localR ? [localR] : [])];
  const totalErrors = reports.reduce((n, r) => n + r.errors.length, 0);
  const totalWarnings = reports.reduce((n, r) => n + r.warnings.length, 0);

  // eslint-disable-next-line no-console
  console.log("");
  if (totalErrors === 0 && totalWarnings === 0) {
    // eslint-disable-next-line no-console
    console.log(`${GRN}env-lint: all clean${RST}`);
    return 0;
  }
  // eslint-disable-next-line no-console
  console.log(
    `env-lint: ${RED}${totalErrors} error(s)${RST}, ${YEL}${totalWarnings} warning(s)${RST}`,
  );
  return totalErrors > 0 ? 1 : 0;
}

process.exit(main());
