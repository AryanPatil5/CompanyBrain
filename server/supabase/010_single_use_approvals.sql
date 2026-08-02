-- ============================================
-- Company Brain: Single-Use Execution Approvals
-- Run this in Supabase SQL Editor
-- ============================================

alter table public.pending_approvals
  add column if not exists consumed_at timestamptz default null;
