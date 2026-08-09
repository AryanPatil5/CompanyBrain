-- ==========================================================
-- Company Brain: Retire Apache AGE (ADR-T4, Phase 0 Task 3)
-- Run this in Supabase / PostgreSQL SQL Editor
-- Drops the AGE graph namespace + extension on databases where
-- migration 022 previously enabled them. Idempotent; safe to
-- run on instances that never had AGE.
-- ==========================================================

do $$
begin
  -- Drop the AGE graph namespace if the extension is present
  begin
    perform ag_catalog.drop_graph_if_exists('company_knowledge_graph', true);
  exception
    when others then
      null;
  end;

  -- Remove the AGE extension entirely (relational tables are the system of record)
  begin
    drop extension if exists age;
  exception
    when others then
      null;
  end;
end $$;

-- Reset search_path in case 022 left it pointing at ag_catalog
set search_path = "$user", public;
