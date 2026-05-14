import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropic, HAIKU_MODEL } from './anthropic'
import { logger } from './logger'

// Haiku-driven per-item classifier. Given a single raw_item (title + body),
// return a structured { category, score, why } triple.
//
// We use Anthropic's tool_use mechanism with tool_choice forced to a single
// tool — the model must return a JSON object that matches the tool's
// input_schema. This is more reliable than asking for JSON in plain text and
// avoids the need for a JSON.parse + repair step.
//
// Cost shape: title + body excerpt is short (~200–800 input tokens), output
// is a tiny JSON blob (~60 tokens). Expect <$0.001/call at Haiku rates.

export type ItemCategory = 'launch' | 'pricing' | 'feature' | 'positioning' | 'noise'

export interface ClassificationInput {
  competitorName: string
  source: string
  title: string
  body: string | null
  publishedAt: Date | null
}

export interface Classification {
  category: ItemCategory
  score: number
  why: string
}

const BODY_EXCERPT_CHARS = 1200
const MAX_RETRIES = 2
const RETRY_BASE_DELAY_MS = 500

const CATEGORIES: ItemCategory[] = ['launch', 'pricing', 'feature', 'positioning', 'noise']

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'record_classification',
  description:
    'Record the category, importance score (0-100), and one-line rationale for a competitor news item.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: CATEGORIES,
        description:
          'launch = new product/major release; pricing = pricing or packaging change; feature = incremental feature shipped; positioning = messaging/branding/strategy shift; noise = recap, hiring, fluff, off-topic, or anything a product leader would not act on.',
      },
      score: {
        type: 'integer',
        minimum: 0,
        maximum: 100,
        description:
          'How load-bearing this item is for a competing SaaS product leader. 0 = ignore, 50 = mildly interesting, 80+ = must-read this week, 95+ = "stop everything".',
      },
      why: {
        type: 'string',
        description:
          'One short sentence (<= 25 words) explaining the score from a competing PM\'s perspective. No marketing language.',
      },
    },
    required: ['category', 'score', 'why'],
  },
}

const SYSTEM_PROMPT = [
  'You are the editorial filter for Product Flash, a daily competitive-intel digest for SaaS product leaders.',
  'Read one news item about a competitor and classify it on two axes:',
  '  1. category: launch | pricing | feature | positioning | noise',
  '  2. score (0-100): how much a competing PM should care today',
  '',
  'Calibration:',
  '- noise items (recaps, year-in-review, "we are hiring", podcast appearances, generic thought-leadership, off-topic) score 0-15.',
  '- minor feature polish scores 20-40.',
  '- meaningful shipped feature scores 50-70.',
  '- new product / pricing change / repositioning scores 75-95.',
  '- only score 95+ for a launch that visibly reshapes the category.',
  '',
  'Always call the record_classification tool — never reply in prose.',
].join('\n')

export async function classifyItem(input: ClassificationInput): Promise<Classification> {
  const userMessage = renderUserPrompt(input)

  let lastErr: unknown
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await callHaiku(userMessage)
      return result
    } catch (err) {
      lastErr = err
      const retriable = isRetriable(err)
      if (!retriable || attempt === MAX_RETRIES) break
      const delay = RETRY_BASE_DELAY_MS * 2 ** attempt
      logger.warn({ err, attempt, delay }, 'classify: transient failure, retrying')
      await sleep(delay)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

async function callHaiku(userMessage: string): Promise<Classification> {
  const client = getAnthropic()
  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 256,
    system: SYSTEM_PROMPT,
    tools: [CLASSIFY_TOOL],
    tool_choice: { type: 'tool', name: CLASSIFY_TOOL.name },
    messages: [{ role: 'user', content: userMessage }],
  })

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  )
  if (!toolUse) {
    throw new Error(`classify: no tool_use block in response (stop_reason=${response.stop_reason})`)
  }
  return parseToolInput(toolUse.input)
}

function parseToolInput(raw: unknown): Classification {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`classify: tool input not an object: ${JSON.stringify(raw)}`)
  }
  const obj = raw as Record<string, unknown>
  const category = obj.category
  const score = obj.score
  const why = obj.why

  if (typeof category !== 'string' || !CATEGORIES.includes(category as ItemCategory)) {
    throw new Error(`classify: invalid category: ${JSON.stringify(category)}`)
  }
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error(`classify: invalid score: ${JSON.stringify(score)}`)
  }
  if (typeof why !== 'string' || why.trim().length === 0) {
    throw new Error(`classify: invalid why: ${JSON.stringify(why)}`)
  }

  const clampedScore = Math.max(0, Math.min(100, Math.round(score)))
  return { category: category as ItemCategory, score: clampedScore, why: why.trim() }
}

function renderUserPrompt(input: ClassificationInput): string {
  const body = (input.body ?? '').trim()
  const excerpt =
    body.length > BODY_EXCERPT_CHARS ? `${body.slice(0, BODY_EXCERPT_CHARS)}…` : body
  const published = input.publishedAt ? input.publishedAt.toISOString() : 'unknown'
  return [
    `Competitor: ${input.competitorName}`,
    `Source: ${input.source}`,
    `Published: ${published}`,
    `Title: ${input.title}`,
    '',
    'Body:',
    excerpt || '(no body text)',
  ].join('\n')
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
