CREATE TABLE "item_scores" (
	"user_id" uuid NOT NULL,
	"raw_item_id" uuid NOT NULL,
	"category" "item_category" NOT NULL,
	"score" integer NOT NULL,
	"why" text NOT NULL,
	"scored_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_scores_user_id_raw_item_id_pk" PRIMARY KEY("user_id","raw_item_id")
);
--> statement-breakpoint
ALTER TABLE "item_scores" ADD CONSTRAINT "item_scores_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_scores" ADD CONSTRAINT "item_scores_raw_item_id_raw_items_id_fk" FOREIGN KEY ("raw_item_id") REFERENCES "public"."raw_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_scores_user_score_idx" ON "item_scores" USING btree ("user_id","score");