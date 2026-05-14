import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropic, SONNET_MODEL } from './anthropic'
import { logger } from './logger'

// Sonnet-driven per-user digest synthesis. Takes the top-N scored items for
// a single user and produces a small set of editorial { headline, snippet,
// impactNote } tuples ready to render in the daily email.
//
// One Sonnet call per user/day — passing all candidate items together lets
// the model order, de-duplicate themes, and tune impact notes against the
// full set rather than re-deriving context for each item independently. Cost
// shape: ~2-4k input + ~1k output ≈ $0.02/user/day at Sonnet rates, matching
// SCOPE.md §9.
//
// We use Anthropic's tool_use mechanism with tool_choice forced to a single
// tool — the model must return a JSON object that matches the tool's
// input_schema. The rawItemId field round-trips so we can map each synthesis
// result back to its source raw_item without relying on output ordering.

export type SynthesisCategory = 'launch' | 'pricing' | 'feature' | 'positioning'

export interface SynthesisInputItem {
  rawItemId: string
  competitorName: string
  source: string
  url: string
  title: string
  body: string | null
  publishedAt: Date | null
  category: SynthesisCategory
  score: number
  why: string
}

export interface SynthesisInput {
  userName: string
  items: SynthesisInputItem[]
}

export interface SynthesizedItem {
  rawItemId: string
  headline: string
  snippet: string
  impactNote: string
}

const BODY_EXCERPT_CHARS = 800
const MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 750
const MAX_OUTPUT_TOKENS = 2048

const SYNTHESIZE_TOOL: Anthropic.Tool = {
  name: 'record_digest',
  description:
    'Record the synthesized digest items for one user. Each input item produces one output item; preserve rawItemId verbatim so the caller can join back.',
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            rawItemId: {
              type: 'string',
              description:
                'The rawItemId from the corresponding input item. Echo it back exactly — do not modify or invent.',
            },
            headline: {
              type: 'string',
              description:
                'Tight, declarative headline (≤ 16 words). Lead with the competitor name and the action they took. Past tense. No marketing fluff, no questions, no clickbait.',
            },
            snippet: {
              type: 'string',
              description:
                'One short sentence (≤ 30 words) giving the load-bearing detail a competing PM needs. Plain English, no marketing language, no editorializing.',
            },
            impactNote: {
              type: 'string',
              description:
                'One sentence (≤ 25 words) explaining why this matters for the reader\'s product/positioning. Reference the category implication — e.g. "Pricing pressure on…", "Reframes the…", "Worth raising in…". Concrete, never generic.',
            },
          },
          required: ['rawItemId', 'headline', 'snippet', 'impactNote'],
        },
      },
    },
    required: ['items'],
  },
}

const SYSTEM_PROMPT = [
  'You are the editorial voice of Product Flash, a daily competitive-intel digest for SaaS product leaders.',
  '',
  'Tone: terse, declarative, op-ed-page-of-an-industry-newsletter. Past tense, plain English, no marketing language, no hedging, no "we think". Picture an editor who has 3 minutes of the reader\'s attention before their first coffee.',
  '',
  'For each input item, produce exactly three fields:',
  '  1. headline — declarative, ≤ 16 words, leads with the competitor + the move (e.g. "Mixpanel shipped session replay — bundled into Growth tier at no cost.").',
  '  2. snippet — one ≤ 30-word sentence with the load-bearing detail. No spin, no analyst-speak.',
  '  3. impactNote — one ≤ 25-word sentence on why the reader should care. Tie it to category (launch / pricing / feature / positioning) and competitive surface. Be specific, never generic.',
  '',
  'Hard rules:',
  '- Preserve every input rawItemId verbatim in your output.',
  '- One output item per input item — never merge, drop, or invent items.',
  '- Never fabricate facts beyond what the input body supports. If something is uncertain, frame it as observed ("Reframes positioning toward…") rather than asserted.',
  '- No emojis, no bullet lists inside fields, no markdown.',
  '- Always call the record_digest tool — never reply in prose.',
].join('\n')

export async function synthesizeDigest(input: SynthesisInput): Promise<SynthesizedItem[]> {
  if (input.items.length === 0) {
    return []
  }

  const userMessage = renderUserPrompt(input)
  const expectedIds = new Set(input.items.map((i) => i.rawItemId))

  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await callSonnet(userMessage, expectedIds)
      return result
    } catch (err) {
      lastErr = err
      const retriable = isRetriable(err)
      if (!retriable || attempt === MAX_RETRIES) break
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt
      logger.warn({ err, attempt, delay }, 'synthesize: transient failure, retrying')
      await sleep(delay)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function callSonnet(
  userMessage: string,
  expectedIds: Set<string>,
): Promise<SynthesizedItem[]> {
  const client = getAnthropic()
  const response = await client.messages.create({
    model: SONNET_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [SYNTHESIZE_TOOL],
    tool_choice: { type: 'tool', name: SYNTHESIZE_TOOL.name },
    messages: [{ role: 'user', content: userMessage }],
  })

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  )
  if (!toolUse) {
    throw new Error(
      `synthesize: no tool_use block in response (stop_reason=${response.stop_reason})`,
    )
  }
  return parseToolInput(toolUse.input, expectedIds)
}

function parseToolInput(raw: unknown, expectedIds: Set<string>): SynthesizedItem[] {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`synthesize: tool input not an object: ${JSON.stringify(raw)}`)
  }
  const obj = raw as Record<string, unknown>
  const items = obj.items
  if (!Array.isArray(items)) {
    throw new Error(`synthesize: items field not an array: ${JSON.stringify(items)}`)
  }

  const seen = new Set<string>()
  const out: SynthesizedItem[] = []
  for (const entry of items) {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`synthesize: item not an object: ${JSON.stringify(entry)}`)
    }
    const e = entry as Record<string, unknown>
    const rawItemId = e.rawItemId
    const headline = e.headline
    const snippet = e.snippet
    const impactNote = e.impactNote

    if (typeof rawItemId !== 'string' || !expectedIds.has(rawItemId)) {
      throw new Error(`synthesize: invalid or unexpected rawItemId: ${JSON.stringify(rawItemId)}`)
    }
    if (seen.has(rawItemId)) {
      throw new Error(`synthesize: duplicate rawItemId in output: ${rawItemId}`)
    }
    if (typeof headline !== 'string' || headline.trim().length === 0) {
      throw new Error(`synthesize: invalid headline for ${rawItemId}: ${JSON.stringify(headline)}`)
    }
    if (typeof snippet !== 'string' || snippet.trim().length === 0) {
      throw new Error(`synthesize: invalid snippet for ${rawItemId}: ${JSON.stringify(snippet)}`)
    }
    if (typeof impactNote !== 'string' || impactNote.trim().length === 0) {
      throw new Error(
        `synthesize: invalid impactNote for ${rawItemId}: ${JSON.stringify(impactNote)}`,
      )
    }

    seen.add(rawItemId)
    out.push({
      rawItemId,
      headline: headline.trim(),
      snippet: snippet.trim(),
      impactNote: impactNote.trim(),
    })
  }

  return out
}

function renderUserPrompt(input: SynthesisInput): string {
  const lines: string[] = []
  lines.push(`Reader: ${input.userName}`)
  lines.push(`Items: ${input.items.length}`)
  lines.push('')
  lines.push('Synthesize each item into a digest entry. Preserve rawItemId verbatim.')
  lines.push('')

  input.items.forEach((item, i) => {
    const body = (item.body ?? '').trim()
    const excerpt =
      body.length > BODY_EXCERPT_CHARS ? `${body.slice(0, BODY_EXCERPT_CHARS)}…` : body
    const published = item.publishedAt ? item.publishedAt.toISOString() : 'unknown'

    lines.push(`--- Item ${i + 1} ---`)
    lines.push(`rawItemId: ${item.rawItemId}`)
    lines.push(`competitor: ${item.competitorName}`)
    lines.push(`category: ${item.category}`)
    lines.push(`score: ${item.score}`)
    lines.push(`classifier_rationale: ${item.why}`)
    lines.push(`source: ${item.source}`)
    lines.push(`url: ${item.url}`)
    lines.push(`published: ${published}`)
    lines.push(`title: ${item.title}`)
    lines.push('body:')
    lines.push(excerpt || '(no body text)')
    lines.push('')
  })

  return lines.join('\n')
}

function isRetriable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: number; name?: string }
  if (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError') return true
  if (typeof e.status === 'number') {
    return e.status === 408 || e.status === 429 || (e.status >= 500 && e.status < 600)
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
