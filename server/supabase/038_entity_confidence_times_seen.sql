-- Phase 3 (N5): entity/relationship confidence is now DERIVED from sighting
-- volume instead of a hardcoded 1.0. Additive: existing rows default to one
-- sighting, so no data migration is required.
--
-- Merge semantics (entityResolver): confidence = GREATEST(prev, derived) where
-- derived = min(0.7 + 0.05 * (times_seen - 1), 0.95); times_seen bumps per
-- sighting. Repeated corroboration across documents raises confidence toward
-- the cap; a single mention stays at the 0.7 LLM-extraction baseline.

alter table public.entities
  add column if not exists times_seen integer not null default 1;

alter table public.entity_relationships
  add column if not exists times_seen integer not null default 1;
