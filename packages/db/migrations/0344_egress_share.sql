ALTER TABLE "machines" ADD COLUMN "egress_share" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ALTER COLUMN "egress_share" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "egress_share_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "egress_via" jsonb;