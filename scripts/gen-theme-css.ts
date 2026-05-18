#!/usr/bin/env tsx
//
// gen-theme-css — emits src/styles/_theme.generated.css from src/design/tokens.ts.
//
// Why: tokens.ts is the single source of truth for brand. The Tailwind @theme
// block previously restated those values in CSS and asked humans to keep them
// in sync — exactly the failure mode CLAUDE.md's "single SoT" rule prohibits.
// Tailwind v4 reads @theme from CSS at build-time to generate utilities, so
// the values *must* live in a CSS file; this script makes that file a
// derivative artifact of tokens.ts.
//
// Run manually via `pnpm theme:gen`. Also runs as `predev` / `prebuild`. A
// vitest assertion (src/design/tokens.test.ts) re-runs `buildThemeCss()` and
// fails if the checked-in output drifts.
//
// The exposed @theme subset is intentional:
//   - all colors and fonts from tokens.ts
//   - only the brand radii (card, cardLg, pill) — radii.sm/md are JS-only
//     values for inline email styles; emitting them as --radius-* would be
//     dead, since shadcn's @theme inline block overrides --radius-sm/md.

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { colors, fonts, radii } from "../src/design/tokens";

const camelToKebab = (s: string) => s.replace(/([A-Z])/g, "-$1").toLowerCase();

const OUTPUT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/styles/_theme.generated.css",
);

export function buildThemeCss(): string {
  const colorLines = Object.entries(colors).map(([k, v]) => `  --color-${camelToKebab(k)}: ${v};`);
  const fontLines = Object.entries(fonts).map(([k, v]) => `  --font-${camelToKebab(k)}: ${v};`);
  const themeRadii = { card: radii.card, "card-lg": radii.cardLg, pill: radii.pill };
  const radiusLines = Object.entries(themeRadii).map(([k, v]) => `  --radius-${k}: ${v};`);

  return [
    "/*",
    " * GENERATED FROM src/design/tokens.ts — DO NOT EDIT BY HAND.",
    " * Run `pnpm theme:gen` to regenerate. CI fails on drift.",
    " */",
    "@theme {",
    ...colorLines,
    "",
    ...fontLines,
    "",
    ...radiusLines,
    "}",
    "",
  ].join("\n");
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  writeFileSync(OUTPUT_PATH, buildThemeCss());
  process.stdout.write(`wrote ${OUTPUT_PATH}\n`);
}
