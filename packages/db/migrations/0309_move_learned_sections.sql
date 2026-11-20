-- Agents' "## Learned" sections become memory (ADR 0017 §6, amended): one job per workspace that has one. The job
-- (`memory.move_learned`, `moveLearnedSections`) needs the app's rules and search indexing; this queues it once.
INSERT INTO "outbox" ("id", "org_id", "kind", "payload", "dedupe_key")
SELECT gen_random_uuid(), a."org_id", 'memory.move_learned', jsonb_build_object('orgId', a."org_id"), 'memory.move_learned:' || a."org_id"
FROM (SELECT DISTINCT "org_id" FROM "agents" WHERE "deleted_at" IS NULL AND "instructions" ~ '(^|\n)##[ \t]+Learned[ \t]*(\n|$)') a
ON CONFLICT ("dedupe_key") DO NOTHING;
