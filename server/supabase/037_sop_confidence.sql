-- Phase 3 (B2): persist the SOP extraction confidence score.
--
-- The extractor (services/extractor.ts) computes ExtractedSOP.confidence_score
-- (manual-trust 0.95, crawled = genuine procedural clarity, 0.4 acceptance
-- gate) but the value was dropped at every skills_sops INSERT site. This
-- additive column stores it. Claim-level confidence (knowledge_claims.confidence)
-- has different semantics (how explicitly a chunk supports the claim) and
-- already exists from migration 036 — no claim-side DDL needed here.

alter table public.skills_sops
  add column if not exists confidence_score numeric not null default 0.5
    check (confidence_score >= 0 and confidence_score <= 1);
