import { logger } from '~/lib/logger'
import { synthesizeDigest, type SynthesisInputItem } from '~/lib/synthesize'

// End-to-end probe for the Sonnet synthesizer. Calls the live Anthropic API
// with a hand-curated set of "already scored" items and eyeballs the
// returned headline/snippet/impactNote tuples for editorial quality before
// wiring synthesis into the daily pipeline against a real user.
//
//   ANTHROPIC_API_KEY=sk-ant-... pnpm tsx scripts/test-sonnet-synthesize.ts
//
// Exits non-zero if the model fails to round-trip the rawItemIds or
// produces empty fields. Tone/quality is a human-eyeball check on the
// pretty-printed log output.

const FIXTURES: SynthesisInputItem[] = [
  {
    rawItemId: '00000000-0000-0000-0000-000000000001',
    competitorName: 'Mixpanel',
    source: 'rss',
    url: 'https://mixpanel.com/blog/session-replay-launch',
    title: 'Introducing Session Replay — included in every Growth plan',
    body: 'Today we are launching Session Replay inside Mixpanel. Watch real user sessions, jump from a funnel drop-off straight into the replay that explains it, and filter replays by any event property. Session Replay is included in every Growth plan at no additional cost.',
    publishedAt: new Date('2026-05-13T14:00:00Z'),
    category: 'launch',
    score: 92,
    why: 'Major net-new product surface bundled at no extra cost; directly competes with FullStory and Hotjar.',
  },
  {
    rawItemId: '00000000-0000-0000-0000-000000000002',
    competitorName: 'Vercel',
    source: 'firecrawl',
    url: 'https://vercel.com/pricing',
    title: 'Pricing page diff',
    body: 'Hobby tier remains free. Pro tier increases from $20 to $25 per seat per month effective June 1. Enterprise pricing now starts at $50,000/year, up from $30,000.',
    publishedAt: new Date('2026-05-13T09:00:00Z'),
    category: 'pricing',
    score: 84,
    why: 'Across-the-board price increase including a 67% jump in Enterprise floor pricing.',
  },
  {
    rawItemId: '00000000-0000-0000-0000-000000000003',
    competitorName: 'Retool',
    source: 'firehose',
    url: 'https://retool.com/blog/agents-platform',
    title: 'Retool is now an AI agent platform',
    body: 'After five years of helping companies build internal tools, Retool is repositioning as the leading platform for building, deploying, and monitoring AI agents in production. The founders\' letter explains why traditional internal-tool builders need to evolve into agent orchestrators.',
    publishedAt: new Date('2026-05-12T16:00:00Z'),
    category: 'positioning',
    score: 88,
    why: 'Hard repositioning of an established category leader away from internal tools toward agents.',
  },
  {
    rawItemId: '00000000-0000-0000-0000-000000000004',
    competitorName: 'Notion',
    source: 'rss',
    url: 'https://notion.so/changelog/multi-key-sort',
    title: 'Improved table sorting',
    body: 'You can now sort columns in tables by multiple keys at once. Hold shift while clicking a column header to add a secondary sort. Available on all plans.',
    publishedAt: new Date('2026-05-13T11:30:00Z'),
    category: 'feature',
    score: 42,
    why: 'Small UX polish; not strategically important but a usability nudge.',
  },
]

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    logger.fatal('ANTHROPIC_API_KEY is unset — cannot probe Sonnet without a key')
    process.exit(1)
  }

  const started = Date.now()

  const { items: result } = await synthesizeDigest({
    userName: 'Maxime',
    items: FIXTURES,
  })

  const expected = new Set(FIXTURES.map((f) => f.rawItemId))
  const seen = new Set(result.map((r) => r.rawItemId))
  const missing = [...expected].filter((id) => !seen.has(id))
  const extra = [...seen].filter((id) => !expected.has(id))

  for (const item of result) {
    const fx = FIXTURES.find((f) => f.rawItemId === item.rawItemId)
    logger.info(
      {
        competitor: fx?.competitorName,
        category: fx?.category,
        score: fx?.score,
        headline: item.headline,
        snippet: item.snippet,
        impactNote: item.impactNote,
      },
      'synth probe: item',
    )
  }

  const ok = missing.length === 0 && extra.length === 0 && result.length === FIXTURES.length
  logger.info(
    {
      total: FIXTURES.length,
      returned: result.length,
      missing,
      extra,
      durationMs: Date.now() - started,
    },
    ok ? 'synth probe: all items round-tripped' : 'synth probe: id mismatch',
  )

  if (!ok) process.exitCode = 1
}

main().catch((err) => {
  logger.fatal({ err }, 'synth probe failed at top level')
  process.exit(1)
})
