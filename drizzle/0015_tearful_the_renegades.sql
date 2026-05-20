-- PF-101: drop Product Hunt + Firehose ingestion paths. raw_items rows
-- ingested from the dropped sources are removed before the enum is rebuilt
-- so the USING cast never sees an unknown value.
DELETE FROM "raw_items" WHERE "source" IN ('ph', 'firehose');--> statement-breakpoint
ALTER TABLE "raw_items" ALTER COLUMN "source" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."source_type";--> statement-breakpoint
CREATE TYPE "public"."source_type" AS ENUM('rss', 'firecrawl', 'webpage');--> statement-breakpoint
ALTER TABLE "raw_items" ALTER COLUMN "source" SET DATA TYPE "public"."source_type" USING "source"::"public"."source_type";--> statement-breakpoint
ALTER TABLE "competitors" DROP COLUMN "ph_slug";
