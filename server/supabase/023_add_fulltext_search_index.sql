-- ==========================================================
-- Company Brain: Full-Text Search TSVector Column & GIN Index
-- Run this in Supabase / PostgreSQL SQL Editor
-- ==========================================================

-- 1. Add tsvector column 'fts' to skills_sops
alter table public.skills_sops
  add column if not exists fts tsvector;

-- 2. Populate existing rows
update public.skills_sops
set fts = to_tsvector('english', coalesce(title, '') || ' ' || coalesce(trigger_condition, '') || ' ' || coalesce(category, ''));

-- 3. Create GIN index for ultra-fast sparse keyword retrieval
create index if not exists idx_skills_sops_fts on public.skills_sops using gin(fts);

-- 4. Create trigger function to automatically maintain fts vector on INSERT/UPDATE
create or replace function public.skills_sops_fts_trigger()
returns trigger
language plpgsql
as $$
begin
  new.fts := to_tsvector('english', coalesce(new.title, '') || ' ' || coalesce(new.trigger_condition, '') || ' ' || coalesce(new.category, ''));
  return new;
end;
$$;

drop trigger if exists skills_sops_fts_update on public.skills_sops;

create trigger skills_sops_fts_update
before insert or update on public.skills_sops
for each row execute function public.skills_sops_fts_trigger();
