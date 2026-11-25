ALTER TABLE "users" ADD COLUMN "email_undelivered" text;--> statement-breakpoint
ALTER TABLE "organization_invitations" ADD COLUMN "undelivered" text;