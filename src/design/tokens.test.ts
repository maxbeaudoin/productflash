import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { buildThemeCss } from "../../scripts/gen-theme-css";

describe("brand tokens → _theme.generated.css", () => {
  // Regenerates the @theme block in memory and compares to the checked-in
  // CSS. Fails if anyone edits tokens.ts without running `pnpm theme:gen`,
  // or hand-edits the generated file. This is the guardrail that lets us
  // keep tokens.ts as the single SoT for brand values.
  test("checked-in CSS matches generator output", () => {
    const checkedIn = readFileSync(resolve(__dirname, "../styles/_theme.generated.css"), "utf8");
    expect(checkedIn).toBe(buildThemeCss());
  });
});
