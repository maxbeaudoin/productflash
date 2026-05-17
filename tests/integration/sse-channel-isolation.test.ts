import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Client } from 'pg'
import { deltaChannelFor, eventsChannelFor } from '~/agents/fte/events'
import { startTestDb, type TestDb } from './setup'

// F-011 — per-user LISTEN/NOTIFY isolation.
//
// The FTE onboarding SSE endpoint (src/routes/api/onboarding/stream.ts)
// relies on per-user Postgres channels as a defense-in-depth boundary:
// even if the server-side `userId` filter ever has a bug, the LISTEN
// physically cannot receive another user's stream because they're on
// different channel names.
//
// This test pins that property at the database layer — directly LISTEN
// for two users against a real Postgres, NOTIFY on user A's channel,
// assert A receives and B does NOT. The SSE route is a thin wrapper
// over these primitives; the isolation property is what makes the
// route safe.

let h: TestDb
let userAClient: Client
let userBClient: Client
let publisher: Client

const USER_A = '11111111-1111-1111-1111-111111111111'
const USER_B = '22222222-2222-2222-2222-222222222222'

beforeAll(async () => {
  h = await startTestDb()

  // Three separate connections: two listeners + one publisher. LISTEN +
  // NOTIFY on the same connection still delivers (Postgres allows
  // self-notify), so a single client wouldn't prove isolation between
  // *different* listeners.
  userAClient = new Client({ connectionString: h.url })
  userBClient = new Client({ connectionString: h.url })
  publisher = new Client({ connectionString: h.url })
  await Promise.all([userAClient.connect(), userBClient.connect(), publisher.connect()])

  await userAClient.query(`LISTEN "${eventsChannelFor(USER_A)}"`)
  await userAClient.query(`LISTEN "${deltaChannelFor(USER_A)}"`)
  await userBClient.query(`LISTEN "${eventsChannelFor(USER_B)}"`)
  await userBClient.query(`LISTEN "${deltaChannelFor(USER_B)}"`)
})

afterAll(async () => {
  await Promise.all([userAClient?.end(), userBClient?.end(), publisher?.end()])
  await h?.stop()
})

type PgNotification = { channel: string; payload?: string }

// Wait for ONE notification on the given client, with a timeout. If no
// notification arrives, resolves to null — caller asserts on that.
function nextNotification(client: Client, timeoutMs: number): Promise<PgNotification | null> {
  return new Promise((resolve) => {
    const onNotification = (msg: PgNotification) => {
      cleanup()
      resolve(msg)
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)
    function cleanup() {
      clearTimeout(timer)
      client.removeListener('notification', onNotification)
    }
    client.on('notification', onNotification)
  })
}

describe('SSE channel isolation — F-011', () => {
  test('NOTIFY on user A events channel → A receives, B does NOT', async () => {
    const aPromise = nextNotification(userAClient, 2000)
    const bPromise = nextNotification(userBClient, 1500)

    await publisher.query(
      `NOTIFY "${eventsChannelFor(USER_A)}", 'run-1:row-abc'`,
    )

    const [aMsg, bMsg] = await Promise.all([aPromise, bPromise])

    expect(aMsg, "user A should have received their own channel's notification").not.toBeNull()
    expect(aMsg!.channel).toBe(eventsChannelFor(USER_A))
    expect(aMsg!.payload).toBe('run-1:row-abc')

    expect(bMsg, "user B's listener must NOT receive user A's notification").toBeNull()
  })

  test('NOTIFY on user A delta channel → A receives, B does NOT', async () => {
    const aPromise = nextNotification(userAClient, 2000)
    const bPromise = nextNotification(userBClient, 1500)

    await publisher.query(
      `NOTIFY "${deltaChannelFor(USER_A)}", '{"u":"${USER_A}","r":"run-1","k":"text_delta","d":"hello"}'`,
    )

    const [aMsg, bMsg] = await Promise.all([aPromise, bPromise])

    expect(aMsg).not.toBeNull()
    expect(aMsg!.channel).toBe(deltaChannelFor(USER_A))
    expect(bMsg).toBeNull()
  })

  test('NOTIFY on user B channel → B receives, A does NOT (symmetric)', async () => {
    // Cross-check: the isolation goes both ways. A bug that wired both
    // users to A's channel would pass the previous tests but fail this.
    const aPromise = nextNotification(userAClient, 1500)
    const bPromise = nextNotification(userBClient, 2000)

    await publisher.query(
      `NOTIFY "${eventsChannelFor(USER_B)}", 'run-2:row-xyz'`,
    )

    const [aMsg, bMsg] = await Promise.all([aPromise, bPromise])

    expect(bMsg).not.toBeNull()
    expect(bMsg!.channel).toBe(eventsChannelFor(USER_B))
    expect(bMsg!.payload).toBe('run-2:row-xyz')
    expect(aMsg).toBeNull()
  })

  test('channel name embeds the full userId (long-form UUID, not a hash)', async () => {
    // Production sanity: if anyone ever refactors eventsChannelFor to
    // hash/shorten the userId, two users could collide. Pin the format.
    const ch = eventsChannelFor(USER_A)
    expect(ch).toBe(`fte_events:${USER_A}`)
    expect(ch).toContain(USER_A)
    // Total length stays under Postgres' 63-char identifier cap.
    expect(ch.length).toBeLessThanOrEqual(63)

    const deltaCh = deltaChannelFor(USER_A)
    expect(deltaCh).toBe(`fte_events_delta:${USER_A}`)
    expect(deltaCh.length).toBeLessThanOrEqual(63)
  })

  test('NOTIFY on a third-party (un-LISTENed) channel is ignored by everyone', async () => {
    // Defense-in-depth: if a future bug causes the agent to NOTIFY on a
    // channel with a typo or wrong prefix, neither listener should
    // receive it. Postgres's filtering already guarantees this — we pin
    // it as the third leg of the isolation contract.
    const aPromise = nextNotification(userAClient, 1500)
    const bPromise = nextNotification(userBClient, 1500)

    await publisher.query(`NOTIFY "fte_events_typo:${USER_A}", 'should-be-ignored'`)

    const [aMsg, bMsg] = await Promise.all([aPromise, bPromise])
    expect(aMsg).toBeNull()
    expect(bMsg).toBeNull()
  })
})
