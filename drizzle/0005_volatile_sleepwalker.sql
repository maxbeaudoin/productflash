ALTER TYPE "public"."user_status" ADD VALUE 'onboarding' BEFORE 'active';--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "position" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "company_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "company_url" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "ultimate_goal" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "focus_areas" text[];--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "profile_confirmed_at" timestamp with time zone;