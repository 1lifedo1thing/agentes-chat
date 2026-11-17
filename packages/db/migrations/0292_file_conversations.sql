ALTER TYPE "public"."channel_kind" ADD VALUE 'file';--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "conversation_channel_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD COLUMN "conversation_root_id" uuid;--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_conversation_channel_id_channels_id_fk" FOREIGN KEY ("conversation_channel_id") REFERENCES "public"."channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_conversation_channel_id_index" ON "artifacts" USING btree ("conversation_channel_id");