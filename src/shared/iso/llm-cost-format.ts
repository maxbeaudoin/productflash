// Pure formatter for cost_micro_usd values. Lives in its own module so the
// admin UI can import it without pulling in the server-only side of
// llm-cost.ts (pino, drizzle, pg, Anthropic SDK).

export function formatUsd(microUsd: number): string {
  const usd = microUsd / 1_000_000;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
