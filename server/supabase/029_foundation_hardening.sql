-- 029_foundation_hardening.sql
-- Drop Apache AGE RPC and create necessary indexes/tables for Phase 0

-- Drop the dead AGE RPC function (ADR-T4 executed in Phase 0)
DROP FUNCTION IF EXISTS execute_cypher_query;

-- Add graph traversal index for performance in relational graph system-of-record
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_graph_edges_workspace_source_target
ON graph_edges (workspace_id, source_id, target_id);

-- Create usage_meters table for cost tracking (ADR-T12 scaffold pulled forward)
CREATE TABLE IF NOT EXISTS usage_meters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL,
    resource VARCHAR(100) NOT NULL,
    period TIMESTAMP NOT NULL,
    units DOUBLE PRECISION NOT NULL,
    cost_cents INTEGER NOT NULL,
    alert_threshold INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Add schema_migrations compatibility notes
-- This ensures migration runner can track Phase 0 migrations
INSERT INTO schema_migrations (version, applied_at, checksum)
VALUES ('029', NOW(), 'foundation_hardening')
ON CONFLICT (version) DO NOTHING;