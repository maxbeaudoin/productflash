// One-shot smoke for the OTEL bootstrap (PF-103). Imports otel, emits a span,
// waits briefly for the batch processor to flush, exits. Lives under
// scripts/ rather than tests/ because it talks to a real exporter when
// OTEL_ENABLED=1 and would be flaky in CI. Not wired into package.json.

import "~/shared/server/otel";
import { withSpan } from "~/shared/server/tracer";

async function main() {
  await withSpan(
    "smoke",
    async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "done";
    },
    { test: 1 },
  );
  await new Promise((r) => setTimeout(r, 800));
  console.log("ok span emitted");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
