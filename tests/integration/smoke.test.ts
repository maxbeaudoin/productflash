import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { eq } from 'drizzle-orm'
import { users } from '~/db/schema'
import { ping, startTestDb, truncateAll, type TestDb } from './setup'

// Validates the harness end-to-end before any "real" integration test
// trusts it: container boots, migrations apply, drizzle schema imports
// resolve, truncate clears state between tests.

describe('integration harness — smoke', () => {
  let h: TestDb

  beforeAll(async () => {
    h = await startTestDb()
  })

  afterAll(async () => {
    await h.stop()
  })

  beforeEach(async () => {
    await truncateAll(h.pool)
  })

  test('container responds to a trivial query', async () => {
    expect(await ping(h.db)).toBe(1)
  })

  test('migrations created the users table and we can insert + select', async () => {
    const [inserted] = await h.db
      .insert(users)
      .values({ email: 'smoke@example.com', name: 'Smoke Test', tz: 'UTC' })
      .returning()
    expect(inserted!.email).toBe('smoke@example.com')

    const [fetched] = await h.db.select().from(users).where(eq(users.id, inserted!.id)).limit(1)
    expect(fetched?.email).toBe('smoke@example.com')
  })

  test('truncateAll wipes state — previous test row is gone', async () => {
    const rows = await h.db.select().from(users)
    expect(rows).toEqual([])
  })
})
