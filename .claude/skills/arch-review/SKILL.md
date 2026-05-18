---
name: arch-review
description: >
  Perform a read-only architecture and code-quality audit of a TypeScript
  web/SaaS codebase. Covers SOLID (as applicable), DRY/KISS/YAGNI/POLA,
  file-structure compliance, module coupling & cohesion, colocation,
  client/server/isomorphism boundaries, abstraction discipline, naming
  consistency, type-safety hygiene, and error-handling patterns. Produces
  one ranked report with severity, finding kind (Violation vs Smell),
  evidence (file:line), and a concrete remediation. Use whenever the user
  asks for an "arch review", "architecture audit", "code-quality review",
  "SOLID check", "code smells", "structure review", "DRY/KISS audit", or
  similar. Never modifies code — read-only by contract.
allowed-tools: Bash(rg:*), Bash(grep:*), Bash(find:*), Bash(ls:*), Bash(wc:*), Bash(cat:*), Bash(sort:*), Bash(uniq:*), Bash(head:*), Bash(tail:*), Bash(awk:*), Bash(sed:*), Bash(jq:*), Bash(node:*), Bash(npm:*), Bash(pnpm:*), Bash(git:*), Read, Write
---

# Architecture & Code-Quality Review

A read-only, end-to-end architecture audit for modern TypeScript web apps
(TanStack Start / Next / Remix + React + ORM). The skill is **methodology,
not magic**: walk the phases below, gather concrete `file:line` evidence,
then emit one ranked report.

This skill is the architectural peer to `security-audit` (vulns) and
`test-coverage` (test pyramid health). It deliberately stays in its lane:
**structure, abstraction, and code-quality** — not security, not testing.
If a finding is primarily a vuln or a test gap, point to the relevant
skill instead of duplicating.

## Operating contract

1. **Read-only.** Do not edit application code.
2. **Evidence-first.** Every finding cites `path/to/file.ts:LINE` and a
   short excerpt. No vague claims like "this module feels coupled."
3. **Judgment over checklists.** SOLID/DRY/KISS/YAGNI/POLA are heuristics,
   not laws. A "violation" is only a finding when it has a concrete cost:
   bugs slipping through, change amplification, reader confusion, dead
   code carrying maintenance tax. If you can't articulate the cost, don't
   raise it.
4. **Respect the rule of three.** Two similar blocks of code are not
   duplication — they're a coincidence. Three is a pattern worth
   extracting (and even then, only if the abstraction is cleaner than the
   repetition). Don't recommend premature DRYing.
5. **No false confidence.** When a finding requires runtime tracing to
   confirm (e.g., does this module actually get imported at startup?), say
   so explicitly under "Verification needed."
6. **Severity discipline.** Use the rubric below; do not inflate. A
   stylistic preference is Info, not High.

## Severity rubric

Arch findings rarely have an "exploit." Severity reflects the **cost of
not fixing it** — bugs that will land, change amplification when the area
is touched, onboarding tax for new contributors. Bias toward the higher
of likelihood and impact when they disagree.

| Severity     | Definition                                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Critical** | Structural failure that blocks change or breaks a core invariant. E.g., server-only code reachable from the client bundle; circular dep across layer boundaries; a project-level rule from CLAUDE.md actively broken. |
| **High**     | Concrete change amplification or footgun. E.g., a god module everyone has to edit; an abstraction that leaks; duplicated business rule in 3+ places that has already drifted; tight cross-feature coupling.           |
| **Medium**   | Meaningful smell with localized impact. E.g., premature abstraction with a single implementer; naming inconsistency across a public surface; a too-broad type that costs every caller a cast.                         |
| **Low**      | Defense-in-depth or readability gain. E.g., a long function that would split cleanly; minor colocation drift; a redundant `useMemo`.                                                                                  |
| **Info**     | Hygiene/observation; not a problem but worth noting. E.g., one stray `TODO`, a single `any` in a generated file.                                                                                                      |

## Finding kinds

Tag each finding so the reader can scan at a glance:

- `[Kind: Violation]` — clear breach of an **explicit** rule: a project
  convention in CLAUDE.md, a framework constraint (e.g., importing a
  server-only module from a client component), a documented invariant
  in the repo. These are objective; the rule is named.
- `[Kind: Smell]` — pattern that's **usually** wrong but context-dependent
  (god class, manager-class name, abstract base with one impl, deep
  prop-drilling). Requires judgment; argue the cost in-place.

## Audit phases

Work these in order. Don't skip phases even if early ones look clean —
different classes of issue surface in different phases.

### Phase 1 — Recon

Build a mental map before judging anything.

```bash
# Repo shape
find src -type d | head -80
find src -type f \( -name '*.ts' -o -name '*.tsx' \) | wc -l

# Framework + key deps + scripts
cat package.json | jq '.scripts, .dependencies, .devDependencies'

# Project rules: CLAUDE.md, AGENTS.md, README, ADRs, contributing docs
ls CLAUDE.md AGENTS.md README.md docs/ 2>/dev/null
fd -t f 'adr|architecture|conventions|structure' docs/ 2>/dev/null

# Tooling that encodes structure: eslint, depcruise, tsconfig paths, biome
cat tsconfig.json 2>/dev/null | jq '.compilerOptions.paths // {}'
ls .eslintrc* eslint.config.* .dependency-cruiser.* biome.* 2>/dev/null
```

Note: **read the project's CLAUDE.md and any architecture docs first.**
Many "violations" are only violations relative to a stated rule —
without the rule, the call becomes opinion. If the project documents a
feature-folder layout, a "design tokens are the single source of truth"
rule, or a "no Y from layer X" constraint, those become Violations when
broken. Without them, the same code is at most a Smell.

### Phase 2 — File structure & module boundaries

Does the layout match the stated convention?

```bash
# Top-level src layout (feature folders vs technical layers)
find src -maxdepth 2 -type d | sort

# Hot spots: which directories have the most files? (often god folders)
find src -type f \( -name '*.ts' -o -name '*.tsx' \) | awk -F/ '{print $2"/"$3}' | sort | uniq -c | sort -rn | head -20

# "utils" / "helpers" / "common" / "shared" — usually junk drawers
find src -type d \( -name 'utils' -o -name 'helpers' -o -name 'common' -o -name 'shared' -o -name 'lib' -o -name 'misc' \)

# Files that don't match any stated module boundary (e.g., loose files at src/ root)
find src -maxdepth 1 -type f
```

Look for:

- **Layout drift.** Project claims feature folders (`src/features/*`) but
  half the code is in `src/lib`, `src/utils`, `src/components/<feature>`
  scattered across the tree. Pick a few features and check whether
  everything they own lives together.
- **God folders.** One folder that's eating everything. Often `utils/`,
  `lib/`, or `components/` with 40+ unrelated files. Junk-drawer naming
  is a tell.
- **Misplaced files.** Server-only code under `src/components/`,
  components under `src/lib/`, types living far from their use site.
- **Empty or near-empty modules.** Folders with one file, exported only
  to satisfy some long-dead structure.

### Phase 3 — SOLID, as it actually applies

SOLID was designed for class-heavy OO. In a TS + React codebase, only
parts translate cleanly. Apply them at the **module/function/component**
level, not by trying to find classes.

- **SRP (Single Responsibility).** Does each module/component/function
  have one reason to change? Tells: components that fetch + transform +
  render + handle errors; service files that mix HTTP, DB, and business
  rules; hooks that do five unrelated things.
  ```bash
  # Big files often = SRP violations. Look at the top of the list.
  find src -type f \( -name '*.ts' -o -name '*.tsx' \) -not -name '*.test.*' \
    -exec wc -l {} + | sort -rn | head -20
  # Functions with many parameters often pack multiple concerns.
  rg -n 'function\s+\w+\([^)]{120,}\)|\(\s*\{[^}]{200,}\}\s*\)' src/
  ```
- **OCP (Open/Closed).** Are extension points (strategy maps, plugin
  registries) defined where they pay off, or is every new case a
  `switch` edit in core code? Don't manufacture extension points
  speculatively — flag the missing one only if the cost is concrete.
- **LSP (Liskov Substitution).** Relevant when inheritance or
  interface-typed dependencies exist. Tells: subclass methods that throw
  `NotImplementedError`; interface implementers that violate the
  contract (sync-typed but async-thrown errors, etc.).
  ```bash
  rg -n 'extends\s+\w+|implements\s+\w+' src/
  rg -n 'throw new Error\(.*not implemented|not supported' src/
  ```
- **ISP (Interface Segregation).** Fat shared types/interfaces force
  callers to depend on fields they don't use. Tells: a `User` type with
  40 fields used everywhere; props types with optional grab-bags; DTOs
  reused across server and client when they should be narrowed.
  ```bash
  rg -n 'interface\s+\w+\s*\{|^type\s+\w+\s*=' src/ | head -40
  ```
- **DIP (Dependency Inversion).** Do high-level modules depend on
  abstractions, or do they reach down into concretions? Tells: a job
  module imports a specific HTTP client; a route handler imports a
  specific email provider; cross-feature imports skip the public
  interface.
  ```bash
  # Cross-feature imports (often a DIP / boundary violation)
  rg -n "from\s+['\"](\.\./){2,}" src/
  ```

For each principle, **only flag where the cost is concrete** — a fat
type that every consumer narrows manually, a switch statement that's
been edited five times in the last quarter, a god component that
everyone keeps touching.

### Phase 4 — DRY (and anti-DRY)

DRY is **about knowledge, not characters.** Two functions that look
alike but encode different rules should stay separate; two that encode
the same rule should be one.

- **Real duplication.** Same business rule (pricing formula, validation
  schema, permission check, prompt template) implemented in N places.
  When the rule changes, all N must change — and one will be missed.
  ```bash
  # Heuristic: identical multi-line code blocks. jscpd if available.
  which jscpd && jscpd src --threshold 0 --min-lines 8 --min-tokens 70 --reporters console 2>/dev/null | head -80
  # Manual smell hunts
  rg -n 'function\s+(format|validate|parse|compute|calculate|build)\w+' src/ | sort
  rg -n 'z\.object\(\{' src/ | wc -l   # are Zod schemas duplicated?
  ```
- **False DRY (premature abstraction).** An abstraction with one caller,
  or a base class/util that flattens away meaningful differences. Often
  worse than the duplication it replaces — it couples unrelated
  consumers through a shared shape.
  ```bash
  # Find "abstract" / "Base" / "Manager" / "Helper" suffixes — common
  # premature-abstraction markers in TS too.
  rg -n 'abstract\s+class|class\s+\w+(Base|Manager|Helper|Service)\b' src/
  ```
- **Single source of truth violations.** Constants/config redefined in
  multiple places (env defaults, tokens, brand colors, magic strings).
  Project rules often name the SoT explicitly (e.g., this repo's
  `src/design/tokens.ts`); compare against the rule.

### Phase 5 — KISS / YAGNI (over-engineering)

Complexity that doesn't pay rent. The cost is real — every layer is
read, debugged, and onboarded onto.

- **Speculative generality.** Code parameterized for cases that don't
  exist: factories with one product, hooks with options that all
  callers pass the same value for, abstract interfaces with one impl.
  ```bash
  rg -n 'interface\s+\w+\s*\{' src/ | awk -F: '{print $1}' | sort -u | while read f; do
    iface=$(rg -o 'interface\s+(\w+)' "$f" -r '$1' | head -1)
    [ -n "$iface" ] && [ "$(rg -c "implements\s+$iface\b|:\s*$iface\b" src/ 2>/dev/null)" = "1" ] && \
      echo "Single-impl interface: $f → $iface"
  done
  ```
- **Wrapper towers.** A util wraps a lib that wraps another lib for no
  added behavior. Stack traces dive through three files to reach the
  real call. Flag adapter layers with zero transformation.
- **Feature-flag / config-knob bloat.** Booleans that no caller toggles,
  options objects with defaults nobody overrides.
  ```bash
  rg -n 'enable\w+:\s*(true|false)|disable\w+:\s*(true|false)' src/ | head
  ```
- **Dead code.** Unused exports, unreachable branches, commented-out
  blocks.
  ```bash
  which knip && knip --no-progress 2>/dev/null | head -80
  # Or quick triage: exports nothing imports
  rg -n '^\s*export\s+(async\s+)?(function|const|class)\s+(\w+)' src/ -r '$3' \
    | sort -u > /tmp/_exports.txt
  # ... then check each name's import count (slow on big repos; sample)
  ```
- **Half-finished abstractions.** A pattern started, applied to 2 cases,
  then abandoned. Worse than no pattern — the next contributor doesn't
  know which to follow.

### Phase 6 — Coupling & cohesion

Cohesion = how related the contents of a module are to each other.
Coupling = how dependent modules are on each other's internals.

```bash
# Most-imported files: high fan-in concentrates change risk.
rg -no "from\s+['\"]([^'\"]+)['\"]" src/ -r '$1' | sort | uniq -c | sort -rn | head -20

# Most-importing files: high fan-out often = orchestrator. Check if it
# should be split.
for f in $(find src -name '*.ts' -o -name '*.tsx' | head -200); do
  c=$(rg -c "^import\b" "$f" 2>/dev/null || echo 0)
  echo "$c $f"
done | sort -rn | head -20

# Circular deps (if madge available)
which madge && madge --circular --extensions ts,tsx src/ 2>/dev/null

# Layer-direction violations (depends on your layering)
rg -n "from\s+['\"]\.\./\.\./features/" src/features/        # cross-feature
rg -n "from\s+['\"].*\/routes\/" src/lib/ src/db/ 2>/dev/null # lower→upper
```

Look for:

- **Circular imports.** Always a finding. Often hides a missing
  third module that should own the shared piece.
- **Cross-feature reaches.** `features/foo` importing from
  `features/bar/internals`. If features need to share, surface it via
  a public boundary (`features/bar/index.ts`) or a lower shared layer.
- **High fan-out, low cohesion.** A file that imports 20+ things from
  10+ folders — usually an orchestrator that's grown beyond one
  responsibility.
- **High fan-in on a "kitchen sink" module.** Everything imports from
  `src/lib/index.ts` — change risk concentrates there.
- **Layer-direction inversion.** Domain importing from UI; data layer
  importing from route handlers. Stated in CLAUDE.md or ADRs? →
  Violation. Otherwise → Smell with a cost argument.

### Phase 7 — Colocation

Things that change together should live together. Things that don't,
shouldn't.

- **State near its owner.** Component-local state in the component;
  feature state in the feature; global state only when actually
  shared. Flag global stores that hold one feature's data.
- **Types near their use.** Types used in one feature shouldn't live in
  a global `types/` folder; types that cross boundaries should.
  ```bash
  find src -type d -name 'types' -o -name 'interfaces' -o -name 'models'
  ```
- **Tests near code.** Per CLAUDE.md, unit tests should be colocated
  (`src/foo/bar.ts` → `src/foo/bar.test.ts`). Spot-check that the
  convention is followed.
  ```bash
  # Code files without a sibling .test.* (sampled, not exhaustive)
  find src -name '*.ts' -not -name '*.test.*' -not -name 'index.ts' | head -40 | while read f; do
    base="${f%.ts}"
    [ -f "${base}.test.ts" ] || echo "no sibling test: $f"
  done
  ```
- **Styles near components.** If using CSS modules or Tailwind +
  component files, are styles colocated or scattered into a global
  `styles/` tree?
- **Server functions near the routes that call them.** TanStack Start
  / Next server actions feel best colocated with their entry point;
  flag wholesale moves to a `src/server/` dump.

Colocation is a **default, not a law.** Sometimes a thing genuinely
belongs in a shared layer. Argue the cost when flagging.

### Phase 8 — Client / server / isomorphism

Modern meta-frameworks blur the boundary. Mis-locating code here
either ships server secrets to the browser, ships heavy server deps
into the client bundle, or breaks isomorphic rendering.

- **Server-only imports in client code.** `fs`, `pg`, `drizzle`,
  `@anthropic-ai/sdk`, the database client, the auth secret — any of
  these reached from a component, hook, or `*.client.*` file is a
  Violation.
  ```bash
  # Sample client surface
  rg -n '"use client"' src/
  # Server-only modules accidentally reachable from those files
  rg -nB1 "import .* from ['\"](node:fs|pg|drizzle-orm/node-postgres|@anthropic-ai/sdk|server-only)['\"]" src/
  ```
- **Public-prefix mistakes.** In Vite, only `VITE_*` env vars ship to
  the browser. In Next, only `NEXT_PUBLIC_*`. Any server key prefixed
  for the client is a Critical. (This overlaps with `security-audit`
  Phase 6 — call it out here too, since structural fix lives in this
  skill's wheelhouse: move the value behind a server boundary.)
  ```bash
  rg -n 'VITE_|NEXT_PUBLIC_' src/ .env* 2>/dev/null
  ```
- **Isomorphism breaks.** Code that calls `window` / `document` /
  `localStorage` at module top level, breaking SSR. Or code that
  assumes Node globals (`process.env.X` at top level) in a file that
  also runs in the browser.
  ```bash
  rg -n '^(?!.*typeof window).*\bwindow\.|\bdocument\.|\blocalStorage\.' src/ | head -30
  ```
- **Server functions / actions called from the wrong layer.** A
  `createServerFn` reached from a server file directly (bypassing the
  client-side typed wrapper) defeats the framework's invariants.
- **Shared modules with conditional environment forks.** `if (typeof
  window === 'undefined') { ... } else { ... }` in a "shared" util is
  usually two modules pretending to be one. Split.

### Phase 9 — POLA & API consistency

Principle of Least Astonishment: a reader should be able to predict the
next file's shape from the previous one.

- **Naming consistency.** Pick a convention and stick: `kebab-case.ts`
  vs `camelCase.ts` vs `PascalCase.tsx`. `useFoo` for hooks,
  `<Foo />` for components, verbs for functions, nouns for types.
  ```bash
  # Mixed-case audit
  find src -type f \( -name '*.ts' -o -name '*.tsx' \) | awk -F/ '{print $NF}' | rg '[A-Z]' | head -20
  find src -type f \( -name '*.ts' -o -name '*.tsx' \) | awk -F/ '{print $NF}' | rg -v '[A-Z]' | head -20
  ```
- **Public-surface uniformity.** Within one layer, do similar things
  look similar? E.g., all route handlers return `Response`, except one
  that returns a plain object. All Zod schemas in `src/schemas/` use
  `.strict()`, except three. Spot the outliers; either bring them in
  line or document the exception.
- **Argument ordering / shape.** Some functions take `(id, opts)`,
  others take `({ id, ...opts })`. Pick one for similar APIs.
- **Error shape.** All errors are `Error` subclasses, except some
  return `{ ok: false, error }`. Mixed result shapes force every
  caller to branch.

POLA findings are cheap to produce and easy to over-flag. **Bias
toward listing the dominant pattern + the outliers**, not every minor
naming nit.

### Phase 10 — Type-safety hygiene

The type system is the cheapest test you have. Holes in it leak into
runtime bugs.

```bash
# `any` and `as` casts (high signal; ignore generated files)
rg -n ':\s*any\b|\bas\s+any\b' src/ | rg -v '\.d\.ts:'
rg -n '\bas\s+\w+(\[\])?\s*[;,)]|\bas\s+unknown\s+as\b' src/ | head -40

# @ts-ignore / @ts-expect-error / @ts-nocheck
rg -n '@ts-(ignore|expect-error|nocheck)' src/

# Non-null assertions at boundaries (often hides null bugs)
rg -n '!\s*\.|!\s*\[' src/ | head -40

# tsconfig: strict on?
cat tsconfig.json 2>/dev/null | jq '.compilerOptions | {strict, noImplicitAny, strictNullChecks, noUncheckedIndexedAccess}'
```

Flag:

- `any` on a public function signature (forces every caller to lose
  types).
- `as Foo` casts that bypass validation at a boundary that should be
  parsed (Zod / `safeParse`).
- `@ts-ignore` without a comment explaining why.
- `strict: false` or specific flags off — usually inherited cruft.
- DTOs that don't match the DB schema, forcing casts at the boundary.

### Phase 11 — Error handling & boundaries

Consistency here is worth more than cleverness.

- **Throw vs return.** Is the codebase "throw and let it bubble" or
  "return a Result type"? Mixed within one layer = footgun. Flag
  layers that mix.
- **Caught-and-swallowed errors.** `try { ... } catch {}` — silently
  hides bugs.
  ```bash
  rg -nB1 -A2 'catch\s*\([^)]*\)\s*\{\s*\}' src/
  rg -nB1 -A4 'catch\s*\([^)]*\)\s*\{[^}]*//' src/ | head -40
  ```
- **Logging vs handling.** `catch (e) { logger.error(e); throw e; }`
  in three places = a missing middleware. Repeated "log and rethrow"
  is a tell.
- **Boundary discipline.** External calls (LLM, email, HTTP) should
  fail in one predictable shape. Are retries / timeouts owned by a
  single adapter, or sprinkled at each call site?
- **User-visible vs internal errors.** Are user-facing error messages
  produced near the UI (translatable, generic), and engineer-facing
  detail kept server-side? Or are raw DB errors making it to the
  browser?

### Phase 12 — Project-specific rules

Re-read CLAUDE.md / AGENTS.md / ADRs from Phase 1 and check each
stated rule against the code:

- "X is the single source of truth" → grep for parallel sources.
- "Use Y for Z" → grep for things doing Z without Y.
- "Deferred / explicitly out of scope" → grep for sneaking-back-in.
- "Public beta only" / "no self-serve" / similar feature gates → check
  the surfaces that would violate them.

Each rule broken = Violation, severity proportional to the rule's
weight. Each rule honored everywhere = a "no findings" sentence in
the report (positive signal is signal).

## Report format

Emit a single markdown report. Structure:

````markdown
# Architecture Review — <project> (<YYYY-MM-DD>)

## Executive summary

- N findings: X Critical, Y High, Z Medium, W Low, V Info
  (V violations · S smells)
- Top three risks (one line each)
- Overall verdict (1–2 sentences on structural health and whether the
  codebase is paying down or accruing complexity debt)

## Scope & methodology

- What was reviewed (paths, commit SHA)
- What was NOT reviewed (runtime behavior, perf, tests — handled by
  other skills)
- Tools/commands used
- Project rules consulted (CLAUDE.md, ADRs, etc.)

## Structural snapshot

| Aspect              | Observation                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| Layout              | Feature-folder / layered / mixed / drift                                     |
| Hot folders         | `src/X` (N files), `src/Y` (M files)                                         |
| Largest files       | `path:LOC` × top 3                                                           |
| Highest fan-in      | `path` (imported by N)                                                       |
| Highest fan-out     | `path` (imports M)                                                           |
| Circular deps       | none / N cycles                                                              |
| Type strictness     | strict: on/off, `any` count                                                  |
| Client/server split | clean / known leaks at `path:line`                                           |

## Findings (ranked, Critical → Info)

Use stable IDs (`F-001`, `F-002` …) and tag each finding with kind:

- `[Kind: Violation]` — clear breach of an explicit rule.
- `[Kind: Smell]` — context-dependent; argue the cost in-place.

### F-001 — <Short title> [Severity: High] [Kind: Violation]

**Where:** `src/foo/bar.ts:42–58` (and `src/baz/qux.ts:101–112`)
**Rule:** `CLAUDE.md`: "`src/design/tokens.ts` is the single source of
truth for brand."
**What:**

> ```ts
> // 3–10 line excerpt of the offending code
> ```
>
> Two call sites hard-code the same color/spacing/string that the
> stated rule says lives in tokens.

**Why it matters:** Concrete cost — when the brand changes, three
files must change; one will be missed. Already drifted between
`bar.ts` (hex `#0a1`) and `qux.ts` (hex `#0b1`).

**Recommendation:** Replace literals with `tokens.color.brand`;
remove the local constants.

**Verification needed (if any):** N/A.

### F-002 — <Short title> [Severity: Medium] [Kind: Smell]

**Where:** `src/lib/foo-helper.ts:1–80`
**What:**

> ```ts
> // 3–10 line excerpt
> ```
>
> `FooHelperManager` is an abstract base with a single concrete
> implementation. Every method either throws `NotImplementedError` or
> just defers to the subclass.

**Why it matters:** Speculative generality. The base adds a layer to
every stack trace and onboarding pass; no second implementation has
materialized in 9 months of history. Reads cost more than the (zero)
extensibility benefit pays for.

**Recommendation:** Inline the subclass; delete the base. If a second
implementation appears later, extract then.

**Verification needed (if any):** Confirm no external package extends
the base (search `extends FooHelperManager` repo-wide).

### F-003 — …
````

Order findings strictly by severity, then by likelihood of regression
(blast radius × change frequency). Use stable IDs so they can be
referenced in follow-up PRs.

**Positive signal is signal.** If a layer is clean — "Sampled N of M
feature modules; all use the public boundary, no cross-feature
reaches" — say so explicitly. Absence of findings in a section
prevents future re-audits from chasing the same ghosts.

## Anti-patterns to avoid in the report

- ❌ "This module is coupled." → ✅ "`src/lib/email.ts:14` imports
  directly from `src/features/digest/internals/...`; flipping a future
  Resend → SES swap will require edits across both layers."
- ❌ "DRY violation: similar code in foo.ts and bar.ts." → ✅ Show
  the duplicated **business rule** and the drift it's already produced
  (or argue why drift is inevitable).
- ❌ Listing every `any` in the codebase. → ✅ "Three `any`s on
  public function signatures at `file:line`; remaining N are inside
  test fixtures and not load-bearing."
- ❌ Recommending an abstraction without showing the rule of three is
  satisfied.
- ❌ "Consider splitting this file" with no cost argument. The reader
  needs to know **why** — what bug, what change tax, what reader
  confusion.
- ❌ Marking everything High to look thorough. Follow the rubric. An
  inconsistent function-naming style is Low, not High.
- ❌ Re-auditing tests or vulns. If you find one, point to the
  relevant skill and move on.
- ❌ Style nits dressed up as architecture (tabs-vs-spaces, import
  ordering, brace placement). Linters/formatters own those.
