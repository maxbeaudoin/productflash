import {
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

export const userStatus = pgEnum('user_status', ['pending', 'active', 'paused'])
export const sourceType = pgEnum('source_type', ['rss', 'ph', 'firehose', 'firecrawl'])
export const itemCategory = pgEnum('item_category', [
  'launch',
  'pricing',
  'feature',
  'positioning',
  'noise',
])
export const feedbackRating = pgEnum('feedback_rating', ['up', 'down'])

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  tz: text('tz').notNull(),
  status: userStatus('status').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const competitors = pgTable(
  'competitors',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    homepageUrl: text('homepage_url').notNull(),
    rssUrl: text('rss_url'),
    phSlug: text('ph_slug'),
    pricingUrl: text('pricing_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('competitors_homepage_url_unique').on(t.homepageUrl)],
)

export const userCompetitors = pgTable(
  'user_competitors',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    competitorId: uuid('competitor_id')
      .notNull()
      .references(() => competitors.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.competitorId] })],
)

export const rawItems = pgTable(
  'raw_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    competitorId: uuid('competitor_id')
      .notNull()
      .references(() => competitors.id, { onDelete: 'cascade' }),
    source: sourceType('source').notNull(),
    sourceId: text('source_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('raw_items_source_source_id_unique').on(t.source, t.sourceId),
    index('raw_items_competitor_ingested_idx').on(t.competitorId, t.ingestedAt),
  ],
)

export const digests = pgTable(
  'digests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    itemCount: integer('item_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('digests_user_created_idx').on(t.userId, t.createdAt)],
)

export const digestItems = pgTable(
  'digest_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    digestId: uuid('digest_id')
      .notNull()
      .references(() => digests.id, { onDelete: 'cascade' }),
    rawItemId: uuid('raw_item_id')
      .notNull()
      .references(() => rawItems.id, { onDelete: 'cascade' }),
    category: itemCategory('category').notNull(),
    headline: text('headline').notNull(),
    snippet: text('snippet').notNull(),
    impactNote: text('impact_note'),
    score: integer('score').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('digest_items_digest_idx').on(t.digestId)],
)

export const competitorPricingSnapshots = pgTable('competitor_pricing_snapshots', {
  competitorId: uuid('competitor_id')
    .primaryKey()
    .references(() => competitors.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  contentHash: text('content_hash').notNull(),
  scrapedAt: timestamp('scraped_at', { withTimezone: true }).notNull().defaultNow(),
})

export const feedback = pgTable(
  'feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    digestItemId: uuid('digest_item_id')
      .notNull()
      .references(() => digestItems.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: feedbackRating('rating').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('feedback_user_item_unique').on(t.userId, t.digestItemId)],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Competitor = typeof competitors.$inferSelect
export type NewCompetitor = typeof competitors.$inferInsert
export type RawItem = typeof rawItems.$inferSelect
export type NewRawItem = typeof rawItems.$inferInsert
export type DigestItem = typeof digestItems.$inferSelect
export type NewDigestItem = typeof digestItems.$inferInsert
export type Digest = typeof digests.$inferSelect
export type NewDigest = typeof digests.$inferInsert
export type Feedback = typeof feedback.$inferSelect
export type NewFeedback = typeof feedback.$inferInsert
export type CompetitorPricingSnapshot = typeof competitorPricingSnapshots.$inferSelect
export type NewCompetitorPricingSnapshot = typeof competitorPricingSnapshots.$inferInsert
