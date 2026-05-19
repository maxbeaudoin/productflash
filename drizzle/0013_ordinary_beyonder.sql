CREATE TYPE "public"."competitor_source_extraction_mode" AS ENUM('feed_poll', 'snapshot_diff', 'list_extract', 'post_stream');--> statement-breakpoint
CREATE TYPE "public"."competitor_source_kind" AS ENUM('rss', 'webpage', 'x', 'linkedin', 'youtube');--> statement-breakpoint
CREATE TYPE "public"."competitor_source_status" AS ENUM('active', 'failing', 'disabled');--> statement-breakpoint
CREATE TABLE "competitor_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"competitor_id" uuid NOT NULL,
	"source_type" "competitor_source_kind" NOT NULL,
	"extraction_mode" "competitor_source_extraction_mode",
	"url_or_handle" text NOT NULL,
	"status" "competitor_source_status" DEFAULT 'active' NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_content_hash" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitor_sources_competitor_type_url_unique" UNIQUE("competitor_id","source_type","url_or_handle")
);
--> statement-breakpoint
ALTER TABLE "raw_items" ADD COLUMN "competitor_source_id" uuid;--> statement-breakpoint
ALTER TABLE "competitor_sources" ADD CONSTRAINT "competitor_sources_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "competitor_sources_competitor_status_idx" ON "competitor_sources" USING btree ("competitor_id","status");--> statement-breakpoint
ALTER TABLE "raw_items" ADD CONSTRAINT "raw_items_competitor_source_id_competitor_sources_id_fk" FOREIGN KEY ("competitor_source_id") REFERENCES "public"."competitor_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- PF-94 backfill: synthesize one `rss` competitor_source row for every
-- competitor that still carries a legacy `rss_url`. Idempotent via the
-- (competitor_id, source_type, url_or_handle) unique constraint.
INSERT INTO "competitor_sources" ("competitor_id", "source_type", "extraction_mode", "url_or_handle", "status")
SELECT "id", 'rss', 'feed_poll', "rss_url", 'active'
FROM "competitors"
WHERE "rss_url" IS NOT NULL
ON CONFLICT ("competitor_id", "source_type", "url_or_handle") DO NOTHING;--> statement-breakpoint
-- PF-94 backfill: point existing rss-sourced raw_items at the synthetic
-- source row for their competitor. Safe to re-run; only fills NULLs.
UPDATE "raw_items" ri
SET "competitor_source_id" = cs."id"
FROM "competitor_sources" cs
WHERE ri."source" = 'rss'
  AND ri."competitor_source_id" IS NULL
  AND cs."competitor_id" = ri."competitor_id"
  AND cs."source_type" = 'rss';