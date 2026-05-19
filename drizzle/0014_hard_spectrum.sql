ALTER TYPE "public"."source_type" ADD VALUE 'webpage';--> statement-breakpoint
CREATE INDEX "raw_items_competitor_source_idx" ON "raw_items" USING btree ("competitor_source_id");