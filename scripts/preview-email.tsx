import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { render } from '@react-email/components'
import { eq } from 'drizzle-orm'
import { digests, users } from '~/db/schema'
import { DigestEmail } from '~/emails/DigestEmail'
import { loadDigestForEmail } from '~/emails/build-email-props'
import { getDb, getPool } from '~/lib/db'
import { logger } from '~/lib/logger'

// Renders one digest to HTML for visual inspection without sending. Writes
// the HTML to /tmp so the file can be opened in any browser.
//
//   pnpm email:preview                       # newest digest in DB
//   pnpm email:preview <digestId>            # specific digest
//   pnpm email:preview --email <address>     # newest digest for a user

async function main() {
  const args = process.argv.slice(2)

  let digestId: string
  const emailFlag = args.indexOf('--email')
  if (emailFlag !== -1) {
    const email = args[emailFlag + 1]
    if (!email) throw new Error('--email requires a value')
    digestId = await resolveLatestDigestFor(email)
  } else {
    const positional = args.find((a) => !a.startsWith('--'))
    digestId = positional ?? (await resolveLatestDigest())
  }

  const loaded = await loadDigestForEmail(digestId)
  if (!loaded) throw new Error(`digest ${digestId} not found`)

  const html = await render(DigestEmail(loaded.props))
  const text = await render(DigestEmail(loaded.props), { plainText: true })

  const outDir = '/tmp'
  const htmlPath = join(outDir, `digest-${digestId}.html`)
  const textPath = join(outDir, `digest-${digestId}.txt`)
  await writeFile(htmlPath, html, 'utf8')
  await writeFile(textPath, text, 'utf8')

  logger.info(
    {
      digestId,
      email: loaded.email,
      subject: loaded.subject,
      itemCount: loaded.itemCount,
      htmlPath,
      textPath,
    },
    'email preview written',
  )
}

async function resolveLatestDigest(): Promise<string> {
  const db = getDb()
  const rows = await db
    .select({ id: digests.id })
    .from(digests)
    .orderBy(digests.createdAt)
  if (rows.length === 0) throw new Error('no digests in DB')
  return rows[rows.length - 1].id
}

async function resolveLatestDigestFor(email: string): Promise<string> {
  const db = getDb()
  const rows = await db
    .select({ id: digests.id })
    .from(digests)
    .innerJoin(users, eq(users.id, digests.userId))
    .where(eq(users.email, email))
    .orderBy(digests.createdAt)
  if (rows.length === 0) throw new Error(`no digest found for ${email}`)
  return rows[rows.length - 1].id
}

main()
  .catch((err) => {
    logger.fatal({ err }, 'email preview failed')
    process.exitCode = 1
  })
  .finally(async () => {
    await getPool().end()
  })
