-- 031_usage_meters_detail.sql
-- Phase 0 Task 10: cost-meter scaffold — extend usage_meters so every LLM
-- request records provider, model, prompt/completion/total tokens, estimated
-- cost, latency, workspaceId, correlationId, and timestamp.
-- Backward compatible: all new columns nullable with defaults; the existing
-- (workspace_id, resource, period, units, cost_cents) contract is unchanged.

ALTER TABLE usage_meters
    ADD COLUMN IF NOT EXISTS provider VARCHAR(64),
    ADD COLUMN IF NOT EXISTS model VARCHAR(128),
    ADD COLUMN IF NOT EXISTS prompt_tokens INTEGER,
    ADD COLUMN IF NOT EXISTS completion_tokens INTEGER,
    ADD COLUMN IF NOT EXISTS total_tokens INTEGER,
    ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
    ADD COLUMN IF NOT EXISTS correlation_id VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_usage_meters_workspace_period
    ON usage_meters (workspace_id, period DESC);
