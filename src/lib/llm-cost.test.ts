import { describe, expect, test } from 'vitest'
import { HAIKU_MODEL, SONNET_MODEL } from './anthropic'
import { computeCostMicroUsd } from './llm-cost'

// Published Anthropic rates (USD per million tokens) the function's table is
// built from. Re-stating them here makes the expected values self-evident
// and catches accidental edits to PRICING in llm-cost.ts.
const SONNET = { in: 3.0, out: 15.0, cacheWrite: 3.75, cacheRead: 0.3 }
const HAIKU = { in: 1.0, out: 5.0, cacheWrite: 1.25, cacheRead: 0.1 }

describe('computeCostMicroUsd', () => {
  test('sonnet input + output tokens convert to micro-USD', () => {
    // 1M input @ $3 + 500k output @ $15 = $3 + $7.5 = $10.50 = 10_500_000 µUSD.
    const cost = computeCostMicroUsd(SONNET_MODEL, {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
    } as never)
    expect(cost).toBe(10_500_000)
  })

  test('haiku input + output tokens convert to micro-USD', () => {
    // 1M input @ $1 + 500k output @ $5 = $1 + $2.5 = $3.50 = 3_500_000 µUSD.
    const cost = computeCostMicroUsd(HAIKU_MODEL, {
      input_tokens: 1_000_000,
      output_tokens: 500_000,
    } as never)
    expect(cost).toBe(3_500_000)
  })

  test('cache write + read tokens are priced separately from regular input', () => {
    // 1M cache writes @ $3.75 + 1M cache reads @ $0.3 on sonnet.
    const cost = computeCostMicroUsd(SONNET_MODEL, {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    } as never)
    expect(cost).toBe(4_050_000) // $4.05
  })

  test('web_search requests bill at $10 per 1000 ($0.01 per request)', () => {
    // 10 web search requests → $0.10 → 100_000 µUSD.
    const cost = computeCostMicroUsd(SONNET_MODEL, {
      input_tokens: 0,
      output_tokens: 0,
      server_tool_use: { web_search_requests: 10 },
    } as never)
    expect(cost).toBe(100_000)
  })

  test('zero usage → zero cost', () => {
    expect(computeCostMicroUsd(SONNET_MODEL, {} as never)).toBe(0)
    expect(
      computeCostMicroUsd(SONNET_MODEL, {
        input_tokens: 0,
        output_tokens: 0,
      } as never),
    ).toBe(0)
  })

  test('unknown model id returns 0 (does not throw — accounting is best-effort)', () => {
    const cost = computeCostMicroUsd('claude-fictional-99', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    } as never)
    expect(cost).toBe(0)
  })

  test('costs are integers (rounded micro-USD, never fractional)', () => {
    // 123 input tokens on sonnet = 123/1M * $3 = $0.000369 = 369 µUSD.
    const cost = computeCostMicroUsd(SONNET_MODEL, {
      input_tokens: 123,
      output_tokens: 0,
    } as never)
    expect(Number.isInteger(cost)).toBe(true)
    expect(cost).toBe(369)
  })

  test('locally re-deriving the formula matches the function output', () => {
    // Sanity check: if the PRICING table ever drifts from published rates,
    // this is the one test that compares against an externally-stated value
    // rather than an internal constant. Update both ends in lockstep.
    const usage = {
      input_tokens: 1500,
      output_tokens: 800,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 1000,
    }
    const expected = Math.round(
      ((1500 * SONNET.in + 800 * SONNET.out + 200 * SONNET.cacheWrite + 1000 * SONNET.cacheRead) /
        1_000_000) *
        1_000_000,
    )
    expect(computeCostMicroUsd(SONNET_MODEL, usage as never)).toBe(expected)
  })
})
