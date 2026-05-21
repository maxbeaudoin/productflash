// One-shot smoke for the OTEL bootstrap (PF-103). Imports otel, emits a
// top-level span, fires a real Haiku call so OpenInference's Anthropic
// instrumentation produces a child span with input/output/tokens, waits for
// the batch processor to flush, exits.
//
// Talks to real Anthropic + Langfuse — not wired into package.json, run
// manually with OTEL_ENABLED=1 + ANTHROPIC_API_KEY + LANGFUSE_*.

import "~/shared/server/otel";
import { getAnthropic, HAIKU_MODEL } from "~/shared/server/anthropic";
import { shutdownOtel } from "~/shared/server/otel";
import { withSpan } from "~/shared/server/tracer";

async function main() {
  await withSpan(
    "otel-smoke",
    async () => {
      const client = getAnthropic();
      const resp = await client.messages.create({
        model: HAIKU_MODEL,
        max_tokens: 64,
        messages: [
          {
            role: "user",
            content: "Reply with exactly: ok",
          },
        ],
      });
      const text = resp.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      console.log("haiku said:", text.trim());
    },
    { "trigger.source": "manual-smoke" },
  );
  console.log("ok span + haiku call emitted");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownOtel();
  });
