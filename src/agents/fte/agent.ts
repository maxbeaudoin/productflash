import type Anthropic from '@anthropic-ai/sdk'
import { eq } from 'drizzle-orm'
import { users as usersTable } from '~/db/schema'
import { getAnthropic, SONNET_MODEL } from '~/lib/anthropic'
import { getDb } from '~/lib/db'
import { logger } from '~/lib/logger'
import { emitFteDelta, writeFteEvent } from './events'
import {
  executeTool,
  FTE_TOOLS,
  hasUserCompetitor,
  isProfileSaved,
} from './tools'

// FTE agent loop (#28).
//
// Sonnet drives a tool-use loop with two classes of tools:
//   1. Server tools (web_search_20250305) — the API handles these internally,
//      we just see server_tool_use + web_search_tool_result blocks in the
//      response stream and stream them out as events for the UI.
//   2. Client tools (fetch_url, discover_rss, add_competitor, save_profile)
//      — we resolve each tool_use block ourselves, post a tool_result, and
//      let the loop continue.
//
// Termination: loop ends when the model returns stop_reason='end_turn' (no
// more tool calls), or when MAX_ITERATIONS or MAX_TOOL_CALLS trips. Either
// way we flip `users.status` to 'active' iff save_profile was called at
// least once AND the user has at least one competitor linked — the
// onboarding UI (#29) shouldn't promote a half-finished run.

const MAX_ITERATIONS = 14
const MAX_TOOL_CALLS = 40
const MAX_OUTPUT_TOKENS = 4096
const WEB_SEARCH_MAX_USES = 6

export interface FteSignupHints {
  email: string
  companyUrl: string | null
  position: string | null
  ultimateGoal: string | null
}

export interface FteRunInput {
  userId: string
  runId: string
  signup: FteSignupHints
}

export interface FteRunResult {
  iterations: number
  clientToolCalls: number
  serverToolCalls: number
  finishedReason:
    | 'end_turn'
    | 'max_iterations'
    | 'max_tool_calls'
    | 'error'
    | 'unknown'
  statusFlippedActive: boolean
}

// Anthropic SDK 0.40 doesn't type web_search yet; the tool params shape is
// stable per the public API docs, so we cast at the wire boundary and treat
// unknown response blocks as opaque pass-throughs in conversation history.
type WebSearchTool = {
  type: 'web_search_20250305'
  name: 'web_search'
  max_uses: number
}

interface UnknownBlock {
  type: string
  [key: string]: unknown
}

type AnyContentBlock = Anthropic.ContentBlock | UnknownBlock

const SYSTEM_PROMPT = [
  'You are the FTE (first time experience) onboarding agent for Product Flash, a daily competitive-intel digest for SaaS product leaders.',
  '',
  'Your job: given the minimal signup info (email, company URL, role, goal), build the user a tight competitive map. Concretely, by the end of the run:',
  '  1. Identify 3–8 real, relevant competitors for the user. Prefer direct competitors over adjacent categories. Skip anyone too large/diffuse to be a real comparison.',
  '  2. For each competitor, register them with add_competitor — supply a real homepage URL and a discovered RSS feed URL when possible.',
  '  3. Call save_profile once at the end with a refined position, company name, ultimate goal, and 3–6 focus_areas tags.',
  '',
  'Method:',
  '  - Start by fetching the user\'s company homepage to understand what they do. If the company URL is missing, use the email domain.',
  '  - Use web_search to find competitor names (e.g. "Linear alternatives", "competitors of <product>").',
  '  - For each plausible competitor, fetch their homepage to verify positioning and confirm they\'re a real fit. Don\'t add a competitor you haven\'t verified.',
  '  - Run discover_rss for each verified competitor BEFORE add_competitor, so the rss_url field is populated whenever a feed exists.',
  '  - Be concise in your reasoning between tool calls — the user is watching the event stream and reads short status lines.',
  '',
  'Hard rules:',
  '  - Never invent a competitor you have not seen evidence of in a fetched page or search result.',
  '  - Never call save_profile before you have added at least 3 competitors.',
  '  - Stop adding competitors once you have 8. Quality over quantity.',
  '  - Do not include the user\'s own company as a competitor.',
  '  - End the run by calling save_profile, then stop. Do not chat after that — just stop.',
].join('\n')

export async function runFteAgent(input: FteRunInput): Promise<FteRunResult> {
  const { userId, runId, signup } = input
  const client = getAnthropic()

  await writeFteEvent({
    userId,
    runId,
    kind: 'run_started',
    payload: {
      email: signup.email,
      company_url: signup.companyUrl,
      position: signup.position,
      ultimate_goal: signup.ultimateGoal,
    },
  })

  const tools = [
    ...FTE_TOOLS,
    // SDK doesn't have a type for the web_search server tool yet; the API
    // accepts the shape below verbatim. Single double-cast keeps the
    // rest of the call typed.
    {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: WEB_SEARCH_MAX_USES,
    } as unknown as Anthropic.Tool,
  ]

  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: renderInitialUserMessage(signup),
    },
  ]

  let iterations = 0
  let clientToolCalls = 0
  let serverToolCalls = 0
  let finishedReason: FteRunResult['finishedReason'] = 'unknown'

  try {
    outer: while (iterations < MAX_ITERATIONS) {
      iterations++
      await writeFteEvent({
        userId,
        runId,
        kind: 'iteration',
        payload: { n: iterations },
      })

      // Streaming mode: durable block-level rows still land in fte_events via
      // the per-block loop below (driven by finalMessage), but sub-block
      // deltas — text chars as the model types them, partial tool_input json —
      // ride the fte_events_delta NOTIFY channel for the live UI. A single
      // promise chain serializes the deltas so the consumer sees them in
      // arrival order; deltas are best-effort and never block the agent.
      const stream = client.messages.stream({
        model: SONNET_MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      })

      let deltaChain: Promise<unknown> = Promise.resolve()
      const enqueueDelta = (kind: 'text_delta' | 'tool_input_delta', delta: string) => {
        deltaChain = deltaChain.then(() =>
          emitFteDelta({ userId, runId, kind, delta }),
        )
      }

      stream.on('text', (delta) => {
        if (delta.length > 0) enqueueDelta('text_delta', delta)
      })
      stream.on('inputJson', (partial) => {
        if (partial.length > 0) enqueueDelta('tool_input_delta', partial)
      })
      stream.on('contentBlock', (block) => {
        const kind = (block as { type: string }).type
        // Heads-up event so the frontend can open a new line / spinner before
        // the matching durable event lands. Empty delta carries only the
        // boundary signal.
        deltaChain = deltaChain.then(() =>
          emitFteDelta({ userId, runId, kind: 'block_start', delta: '', blockKind: kind }),
        )
      })

      const response = await stream.finalMessage()
      await deltaChain.catch(() => {
        // Deltas are best-effort — see emitFteDelta. Any rejection was already
        // logged by the emitter.
      })

      const blocks = response.content as AnyContentBlock[]

      // Echo the assistant turn into history verbatim so the next iteration
      // has full context (including any server-tool blocks the API returned).
      messages.push({
        role: 'assistant',
        content: blocks as unknown as Anthropic.ContentBlockParam[],
      })

      // Stream every block out as an event + collect client tool_use blocks
      // to resolve for the next user turn.
      const toolUses: Array<{ id: string; name: string; input: unknown }> = []

      for (const block of blocks) {
        if (block.type === 'text') {
          const text = (block as Anthropic.TextBlock).text.trim()
          if (text.length > 0) {
            await writeFteEvent({
              userId,
              runId,
              kind: 'planner_text',
              payload: { text },
            })
          }
        } else if (block.type === 'thinking') {
          // We don't enable extended thinking in this request, but be defensive.
          await writeFteEvent({
            userId,
            runId,
            kind: 'planner_thinking',
            payload: { hidden: true },
          })
        } else if (block.type === 'tool_use') {
          const tu = block as Anthropic.ToolUseBlock
          toolUses.push({ id: tu.id, name: tu.name, input: tu.input })
          await writeFteEvent({
            userId,
            runId,
            kind: 'tool_use',
            payload: { id: tu.id, name: tu.name, input: tu.input },
          })
        } else if (block.type === 'server_tool_use') {
          serverToolCalls++
          const b = block as UnknownBlock
          await writeFteEvent({
            userId,
            runId,
            kind: 'server_tool_use',
            payload: {
              id: b.id,
              name: b.name,
              input: b.input,
            },
          })
        } else if (block.type === 'web_search_tool_result') {
          const b = block as UnknownBlock
          await writeFteEvent({
            userId,
            runId,
            kind: 'server_tool_result',
            payload: {
              tool_use_id: b.tool_use_id,
              // Result content can be large; record only top-level result
              // count + URLs so the frontend stays light.
              summary: summarizeWebSearchResult(b.content),
            },
          })
        } else {
          await writeFteEvent({
            userId,
            runId,
            kind: 'planner_text',
            payload: { unknown_block_type: (block as UnknownBlock).type },
          })
        }
      }

      if (response.stop_reason === 'end_turn' && toolUses.length === 0) {
        finishedReason = 'end_turn'
        break outer
      }

      if (clientToolCalls + toolUses.length > MAX_TOOL_CALLS) {
        finishedReason = 'max_tool_calls'
        break outer
      }

      // Execute client tool calls + collect tool_results in the same order.
      const resultBlocks: Anthropic.ToolResultBlockParam[] = []
      for (const tu of toolUses) {
        clientToolCalls++
        const result = await executeTool({ userId, runId }, tu.name, tu.input)
        await writeFteEvent({
          userId,
          runId,
          kind: result.isError ? 'tool_error' : 'tool_result',
          payload: { id: tu.id, name: tu.name, ...result.payload },
        })
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: result.content,
          is_error: result.isError,
        })
      }

      if (resultBlocks.length === 0) {
        // Model returned no tool_use blocks but stop_reason wasn't end_turn —
        // treat as effectively finished (e.g. max_tokens). Bail.
        finishedReason = response.stop_reason === 'end_turn' ? 'end_turn' : 'unknown'
        break outer
      }

      messages.push({ role: 'user', content: resultBlocks })

      if (iterations >= MAX_ITERATIONS) {
        finishedReason = 'max_iterations'
        break outer
      }
    }

    if (finishedReason === 'unknown' && iterations >= MAX_ITERATIONS) {
      finishedReason = 'max_iterations'
    }
  } catch (err) {
    finishedReason = 'error'
    logger.error({ err, userId, runId }, 'fte: agent loop threw')
    await writeFteEvent({
      userId,
      runId,
      kind: 'error',
      payload: { message: describeError(err) },
    })
  }

  // Only promote to 'active' when both conditions hold so a half-finished
  // run doesn't push a user into the daily digest path with no profile.
  const profileSaved = await isProfileSaved(userId)
  const hasCompetitor = await hasUserCompetitor(userId)
  const statusFlippedActive = profileSaved && hasCompetitor

  if (statusFlippedActive) {
    await getDb()
      .update(usersTable)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(usersTable.id, userId))
  }

  await writeFteEvent({
    userId,
    runId,
    kind: 'run_finished',
    payload: {
      finished_reason: finishedReason,
      iterations,
      client_tool_calls: clientToolCalls,
      server_tool_calls: serverToolCalls,
      status_flipped_active: statusFlippedActive,
      profile_saved: profileSaved,
      has_competitor: hasCompetitor,
    },
  })

  logger.info(
    {
      userId,
      runId,
      finishedReason,
      iterations,
      clientToolCalls,
      serverToolCalls,
      statusFlippedActive,
    },
    'fte: run complete',
  )

  return {
    iterations,
    clientToolCalls,
    serverToolCalls,
    finishedReason,
    statusFlippedActive,
  }
}

function renderInitialUserMessage(signup: FteSignupHints): string {
  return [
    'A new user just signed up. Build their competitive map and profile.',
    '',
    'Signup info:',
    `  email: ${signup.email}`,
    `  company_url: ${signup.companyUrl ?? '(not provided — infer from email domain)'}`,
    `  position: ${signup.position ?? '(not provided)'}`,
    `  ultimate_goal: ${signup.ultimateGoal ?? '(not provided)'}`,
    '',
    'Start by fetching the company homepage. Then research competitors, verify each one with fetch_url, discover their RSS feeds, register them with add_competitor, and finish by calling save_profile.',
  ].join('\n')
}

function summarizeWebSearchResult(content: unknown): {
  count: number
  urls: string[]
} {
  if (!Array.isArray(content)) {
    return { count: 0, urls: [] }
  }
  const urls: string[] = []
  for (const entry of content) {
    if (entry && typeof entry === 'object') {
      const url = (entry as Record<string, unknown>).url
      if (typeof url === 'string') urls.push(url)
    }
  }
  return { count: content.length, urls: urls.slice(0, 10) }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
