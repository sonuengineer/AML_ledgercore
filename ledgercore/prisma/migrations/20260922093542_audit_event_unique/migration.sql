-- Make the audit consumer idempotent at the database level.
--
-- Deduplicate first: earlier redeliveries may already have written duplicates
-- before this constraint existed. Keeps the oldest row of each group.
DELETE FROM audit_event a
 USING audit_event b
 WHERE a.entity_id = b.entity_id
   AND a.action = b.action
   AND a.request_id IS NOT DISTINCT FROM b.request_id
   AND a.occurred_at > b.occurred_at;

CREATE UNIQUE INDEX IF NOT EXISTS "audit_event_entity_id_action_request_id_key"
  ON "audit_event" (entity_id, action, request_id);
