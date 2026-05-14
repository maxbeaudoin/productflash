CREATE TABLE "competitor_pricing_snapshots" (
	"competitor_id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"scraped_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "competitor_pricing_snapshots" ADD CONSTRAINT "competitor_pricing_snapshots_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;